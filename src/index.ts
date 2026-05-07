/**
 * @jogi/classifier - lean prompt-first document classifier.
 *
 * One Gemini call sees the whole file and returns final segments. Local code
 * only does geometry cleanup: duplicate collapse, exact same-range conflict
 * resolution, and PDF gap fill. No local OCR, anchors, page ledger, or doctype
 * detector.
 */

import { PDFDocument } from 'pdf-lib'

export interface Doctype {
    label: string
    definition?: string
    dateHint?: string
    freq?: 'once' | 'monthly' | 'annual'
    contains?: string[]
}
export type DoctypesMap = Record<string, Doctype>

export interface Segment {
    id: string
    start?: number
    end?: number
    confidence: number
    docdate?: string | null
    partId?: 'front' | 'back'
}

export interface ClassifyOptions {
    candidateIds?: string[]
    model?: string
}

export type GeminiCall = (params: { model: string; contents: any; config?: any }) => Promise<any>
export interface ClassifierConfig { doctypes: DoctypesMap; geminiCall: GeminiCall }

const CONFIG_KEY = Symbol.for('@jogi/classifier.config')
const g = globalThis as unknown as Record<symbol, ClassifierConfig | undefined>

export function configure(c: ClassifierConfig): void { g[CONFIG_KEY] = c }
function getConfig(): ClassifierConfig {
    const c = g[CONFIG_KEY]
    if (!c) throw new Error('@jogi/classifier: configure({ doctypes, geminiCall }) was not called')
    return c
}
export function getDoctypesMap(): DoctypesMap { return getConfig().doctypes }
export function getDoctypes(): Array<Doctype & { id: string }> {
    return Object.entries(getConfig().doctypes).map(([id, dt]) => ({ ...dt, id }))
}

export const NO_CLASIFICADO = 'no-clasificado'
const DEFAULT_MODEL = 'gemini-2.5-flash'

export async function classify(buffer: Buffer, mimetype: string, opts: ClassifyOptions = {}): Promise<Segment[]> {
    const all = getDoctypes()
    const types = opts.candidateIds?.length ? all.filter(d => opts.candidateIds!.includes(d.id)) : all
    if (types.length === 0) return []

    const isPdf = mimetype === 'application/pdf'
    const totalPages = isPdf ? await pageCount(buffer) : 1
    const raw = await aiCall(buffer, mimetype, types, isPdf, opts.model ?? DEFAULT_MODEL)
    const merged = mergeDuplicates(raw)
    const resolved = resolveSameRangeConflicts(merged)
    return isPdf ? fillGaps(resolved, totalPages) : resolved
}

async function pageCount(buf: Buffer): Promise<number> {
    return (await PDFDocument.load(Uint8Array.from(buf), { ignoreEncryption: true })).getPageCount()
}

function promptFor(types: Array<Doctype & { id: string }>, isPdf: boolean): string {
    const list = types.map(t => {
        const bits = [`${t.id}: ${t.definition || t.label}`]
        if (t.freq) bits.push(`freq=${t.freq}`)
        if (t.contains?.length) bits.push(`contains=[${t.contains.join(', ')}]`)
        if (t.dateHint) bits.push(`docdate: ${t.dateHint}`)
        return `- ${bits.join(' | ')}`
    }).join('\n')

    return `You are classifying a Chilean document upload.

Return only documents that are physically present as their own visible document, form, certificate, statement, card, or report.
Do NOT classify a doctype merely because its name, topic, or supporting data is mentioned inside another document.
Prefer omission over guessing. If a page is uncertain, omit it; uncovered PDF pages will become no-clasificado.

${isPdf ? `PDF range rules:
- "start" and "end" are 1-indexed inclusive page ranges.
- One physical/logical document gets one row spanning all its pages.
- Multi-page certificates/reports/cards remain one row; do not split by page.
- Multiple recurring instances, such as monthly liquidaciones or annual SII forms, get separate rows with disjoint ranges and their own docdate.
- Do not return two different non-container doctypes for the exact same page range. Choose the one best supported by visible title/issuer/layout.
- Container PDFs such as carpeta-tributaria may return the container plus actual child documents, but children need their exact visible ranges inside the container.
` : ''}Cedula rule:
- If both faces of cedula-identidad are visible in one ${isPdf ? 'page' : 'image'}, return two cedula-identidad rows with different partId ("front" and "back").
- If only one face is visible, return one row with that partId when clear.

Date rule:
- "docdate" is YYYY-MM-DD for the period/emission date the document corresponds to, not access/download date.

Output:
- JSON only: {"documents":[...]}.
- Omit entries with confidence < 0.5.
- Do not use filenames as evidence.

Doctypes:
${list}`
}

async function aiCall(buf: Buffer, mimetype: string, types: Array<Doctype & { id: string }>, isPdf: boolean, model: string): Promise<Segment[]> {
    const ids = types.map(t => t.id)
    const itemProps: Record<string, unknown> = {
        id: { type: 'STRING', enum: ids },
        confidence: { type: 'NUMBER', minimum: 0, maximum: 1 },
        docdate: { type: 'STRING', nullable: true },
        partId: { type: 'STRING', enum: ['front', 'back'], nullable: true },
    }
    const required = ['id', 'confidence']
    if (isPdf) {
        itemProps.start = { type: 'INTEGER', minimum: 1 }
        itemProps.end = { type: 'INTEGER', minimum: 1 }
        required.push('start', 'end')
    }

    const r = await getConfig().geminiCall({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mimetype, data: buf.toString('base64') } }, { text: promptFor(types, isPdf) }] }],
        config: {
            responseMimeType: 'application/json',
            responseSchema: {
                type: 'OBJECT',
                properties: { documents: { type: 'ARRAY', items: { type: 'OBJECT', properties: itemProps, required } } },
                required: ['documents'],
            },
        },
    })
    const text = (r?.text || r?.candidates?.[0]?.content?.parts?.map?.((p: any) => p?.text || '').join?.('') || '')
        .replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()
    const docs = (JSON.parse(text || '{"documents":[]}')?.documents ?? []) as Segment[]
    return docs.filter(d => validSegment(d, isPdf))
}

function validSegment(d: Segment, isPdf: boolean): boolean {
    return !!d.id
        && typeof d.confidence === 'number'
        && d.confidence >= 0.5
        && (!isPdf || (Number.isInteger(d.start) && Number.isInteger(d.end) && d.start! >= 1 && d.end! >= d.start!))
}

function mergeDuplicates(segs: Segment[]): Segment[] {
    const out: Segment[] = []
    const used = new Set<number>()
    for (let i = 0; i < segs.length; i++) {
        if (used.has(i)) continue
        let cur = { ...segs[i] }
        for (let j = i + 1; j < segs.length; j++) {
            const o = segs[j]
            if (used.has(j) || o.id !== cur.id || (o.partId ?? null) !== (cur.partId ?? null)) continue
            const identicalRange = o.start === cur.start && o.end === cur.end
            const overlaps = cur.start != null && o.start != null && o.start <= cur.end! && o.end! >= cur.start
            const samePeriod = (o.docdate ?? null) === (cur.docdate ?? null)
            if (!identicalRange && !(overlaps && samePeriod)) continue
            if (o.confidence > cur.confidence) cur = { ...o, start: cur.start, end: cur.end }
            cur.start = cur.start != null ? Math.min(cur.start, o.start!) : o.start
            cur.end = cur.end != null ? Math.max(cur.end, o.end!) : o.end
            cur.confidence = Math.max(cur.confidence, o.confidence)
            used.add(j)
        }
        out.push(cur)
    }
    return out.sort(sortSegments)
}

function resolveSameRangeConflicts(segs: Segment[]): Segment[] {
    const groups = new Map<string, Segment[]>()
    for (const s of segs) {
        const key = `${s.start ?? ''}|${s.end ?? ''}|${s.partId ?? ''}`
        groups.set(key, [...(groups.get(key) ?? []), s])
    }
    return [...groups.values()].map(list =>
        list.length === 1 ? list[0] : list.reduce((best, s) => s.confidence > best.confidence ? s : best),
    ).sort(sortSegments)
}

function fillGaps(segs: Segment[], totalPages: number): Segment[] {
    const covered = new Set<number>()
    for (const s of segs) {
        if (s.start == null || s.end == null) continue
        for (let p = s.start; p <= s.end; p++) covered.add(p)
    }
    const gaps: Segment[] = []
    let run: number | null = null
    for (let p = 1; p <= totalPages + 1; p++) {
        if (p <= totalPages && !covered.has(p)) run ??= p
        else if (run != null) { gaps.push({ id: NO_CLASIFICADO, start: run, end: p - 1, confidence: 1 }); run = null }
    }
    return [...segs, ...gaps].sort(sortSegments)
}

function sortSegments(a: Segment, b: Segment): number {
    return (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0) || a.id.localeCompare(b.id)
}
