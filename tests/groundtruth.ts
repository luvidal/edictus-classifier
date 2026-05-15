/**
 * Compare @jogi/classifier against CLASSIFICATION.md files.
 *
 *   npm run groundtruth -- [--only=substr] [--out=out/groundtruth.json]
 *   npm run groundtruth -- --actual=out/sweep.json --out=out/groundtruth-from-sweep.json
 *   npm run groundtruth -- --no-dedupe  # only when measuring duplicate-call variance
 *
 * The classifier model and generation profile are satellite-owned (see
 * `src/index.ts`); `classify()` only accepts `{ candidateIds? }`. There are no
 * `--model` / `--temperature` / `--topP` / `--seed` / `--thinkingBudget` flags —
 * a normal run is labeled `satellite-default-profile`.
 *
 * Auth: the harness prefers the production-like Vertex path. When
 * `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` are set it uses Vertex; it
 * only falls back to the `GEMINI_API_KEY` AI Studio endpoint when Vertex is not
 * configured (or `JOGI_GROUNDTRUTH_PROVIDER=ai-studio` is set). The AI Studio
 * endpoint is more 503-prone and is NOT production-like.
 */

import 'dotenv/config'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { GoogleGenAI } from '@google/genai'
import { classify, configure, NO_CLASIFICADO, type DoctypesMap, type GeminiCall, type Segment } from '../src/index'

const ROOT = process.env.CORPUS_ROOT || '/Users/avd/Downloads/docs'
const DOCTYPES_PATH = process.env.JOGI_DOCTYPES || '/Users/avd/GitHub/jogi/data/doctypes.json'

interface ExpectedSegment {
    id: string
    start?: number
    end?: number
    partId?: 'front' | 'back'
    inspectionConfidence?: number
}

interface GroundtruthCase {
    file: string
    absPath: string
    expected: ExpectedSegment[]
    source: string
    minInspectionConfidence: number | null
}

export interface Result {
    file: string
    source: string
    expected: ExpectedSegment[]
    actual: Array<Pick<Segment, 'id' | 'start' | 'end' | 'confidence' | 'partId' | 'docdate'>>
    pass: boolean
    durationMs: number
    error?: string
    reusedFrom?: string
    sha256_16?: string
}

interface CachedClassification {
    file: string
    sha256_16: string
    segments?: Segment[]
    error?: string
}

/**
 * Build the Gemini caller. Prefers the production-like Vertex path:
 *   - `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` present => Vertex.
 *   - otherwise `GEMINI_API_KEY` => AI Studio fallback (more 503-prone, not
 *     production-like; emits a warning).
 * `JOGI_GROUNDTRUTH_PROVIDER=ai-studio|vertex` forces a provider; the default
 * is Vertex whenever it is configured, even if `GEMINI_API_KEY` is also set.
 */
function geminiCall(): GeminiCall {
    const apiKey = process.env.GEMINI_API_KEY
    const project = process.env.GOOGLE_CLOUD_PROJECT
    const location = process.env.GOOGLE_CLOUD_LOCATION
    const override = process.env.JOGI_GROUNDTRUTH_PROVIDER
    const vertexReady = !!(project && location)
    const useAiStudio = override === 'ai-studio' || (override !== 'vertex' && !vertexReady)

    if (useAiStudio) {
        if (!apiKey) throw new Error('AI Studio selected but GEMINI_API_KEY is not set')
        console.warn('WARNING: using GEMINI_API_KEY / AI Studio endpoint; production uses Vertex and this endpoint may be more 503-prone.')
        const ai = new GoogleGenAI({ apiKey })
        return ({ model, contents, config }) => ai.models.generateContent({ model, contents, config })
    }
    if (!vertexReady) throw new Error('Set GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION (Vertex) or GEMINI_API_KEY (AI Studio fallback)')
    const ai = new GoogleGenAI({ vertexai: true, project, location } as any)
    return ({ model, contents, config }) => ai.models.generateContent({ model, contents, config })
}

function ensureConfigured(): void {
    if (!fs.existsSync(DOCTYPES_PATH)) throw new Error(`doctypes.json missing at ${DOCTYPES_PATH}`)
    configure({ doctypes: JSON.parse(fs.readFileSync(DOCTYPES_PATH, 'utf8')) as DoctypesMap, geminiCall: geminiCall() })
}

function mimetypeFor(filename: string, bytes?: Buffer): string | null {
    const ext = path.extname(filename).toLowerCase()
    if (ext === '.pdf') return 'application/pdf'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    if (bytes || fs.existsSync(filename)) {
        bytes ??= fs.readFileSync(filename)
        if (bytes.subarray(0, 4).toString('utf8') === '%PDF') return 'application/pdf'
        if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
        if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
        if (bytes.subarray(0, 4).toString('utf8') === 'RIFF' && bytes.subarray(8, 12).toString('utf8') === 'WEBP') return 'image/webp'
    }
    return null
}

export function findClassificationFiles(): string[] {
    const out: string[] = []
    function walk(dir: string) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name)
            if (e.isDirectory()) {
                if (e.name === 'archive' || e.name === '_archive') continue
                walk(p)
            }
            else if (e.name === 'CLASSIFICATION.md') out.push(p)
        }
    }
    walk(ROOT)
    return out.sort()
}

function splitRow(line: string): string[] {
    return line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim())
}

function parseRange(raw: string): { start?: number; end?: number } {
    const text = raw.trim()
    if (!text || text === '-' || text === '—') return {}
    const m = /^(\d+)\s*(?:-|–|—)\s*(\d+)$/.exec(text) || /^(\d+)$/.exec(text)
    if (!m) return {}
    const start = Number(m[1])
    const end = Number(m[2] ?? m[1])
    return Number.isInteger(start) && Number.isInteger(end) ? { start, end } : {}
}

function parseInspectionConfidence(row: Record<string, string>): number | undefined {
    const raw = row['inspection %']
        ?? row['inspection confidence']
        ?? row['review %']
        ?? row['review confidence']
        ?? row['confidence %']
        ?? row.confidence
        ?? ''
    const text = raw.replace(/%/g, '').trim()
    if (!text || text === '-' || text === '—') return undefined
    const n = Number(text)
    return Number.isFinite(n) ? n : undefined
}

function normalizeId(raw: string): string {
    return raw.replace(/`/g, '').replace(/^\((.+)\)$/, '$1').trim()
}

function partFromText(text: string): 'front' | 'back' | null {
    const t = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    if (/\bcedula\s+reves\b/.test(t)) return 'back'
    if (/\bcedula\s+frente\b/.test(t)) return 'front'
    if (/\bfrente\b/.test(t) && !/\breves\b|\breverso\b/.test(t)) return 'front'
    if (/\breves\b|\breverso\b/.test(t) && !/\bfrente\b/.test(t)) return 'back'
    return null
}

function isCompositeCedula(cells: Record<string, string>, id: string): boolean {
    if (id !== 'cedula-identidad') return false
    const text = Object.values(cells).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    return /frente\s*\+\s*reves/.test(text) || /\bcedula\s+compuesta\b|\bcompuesta\b/.test(text)
}

function resolveExistingPath(baseDir: string, relativeName: string): string | null {
    const parts = relativeName.split(/[\\/]/).filter(Boolean)
    let cur = baseDir
    for (const part of parts) {
        if (!fs.existsSync(cur)) return null
        const names = fs.readdirSync(cur)
        const hit = names.find(name => name === part)
            ?? names.find(name => name.normalize('NFC') === part.normalize('NFC'))
        if (!hit) return null
        cur = path.join(cur, hit)
    }
    return cur
}

function expectedFromRow(headers: string[], values: string[]): ExpectedSegment[] {
    const row = Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), values[i] ?? '']))
    const id = normalizeId(row.doc_type_id ?? '')
    if (!id || id === 'doc_type_id') return []
    const range = parseRange(row.range ?? '')
    const inspectionConfidence = parseInspectionConfidence(row)
    const confidence = inspectionConfidence == null ? {} : { inspectionConfidence }
    if (isCompositeCedula(row, id)) {
        return [
            { id, ...range, partId: 'front', ...confidence },
            { id, ...range, partId: 'back', ...confidence },
        ]
    }
    const part = partFromText(`${row.part ?? ''} ${row.notes ?? ''} ${row['short label'] ?? ''}`)
    return [{ id, ...range, ...(part ? { partId: part } : {}), ...confidence }]
}

function minConfidence(expected: ExpectedSegment[]): number | null {
    const values = expected.map(e => e.inspectionConfidence).filter((n): n is number => n != null)
    return values.length ? Math.min(...values) : null
}

export function parseClassificationFile(file: string): GroundtruthCase[] {
    const md = fs.readFileSync(file, 'utf8')
    const dir = path.dirname(file)
    const relSource = path.relative(ROOT, file)
    const byFile = new Map<string, ExpectedSegment[]>()
    let headers: string[] | null = null
    for (const line of md.split(/\r?\n/)) {
        if (!line.startsWith('|')) continue
        const cells = splitRow(line)
        if (cells.some(c => c === '---' || /^-+$/.test(c))) continue
        if (!headers && cells.map(c => c.toLowerCase()).includes('file')) { headers = cells; continue }
        if (!headers) continue
        const row = Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), cells[i] ?? '']))
        const filename = row.file
        if (!filename || filename === 'File') continue
        const expected = expectedFromRow(headers, cells)
        if (expected.length === 0) continue
        byFile.set(filename, [...(byFile.get(filename) ?? []), ...expected])
    }
    return [...byFile.entries()].map(([filename, expected]) => {
        const absPath = resolveExistingPath(dir, filename) ?? path.join(dir, filename)
        return { file: path.relative(ROOT, absPath), absPath, expected, source: relSource, minInspectionConfidence: minConfidence(expected) }
    })
}

function segmentMatches(actual: Segment, expected: ExpectedSegment): boolean {
    return actual.id === expected.id
        && (expected.start == null || actual.start === expected.start)
        && (expected.end == null || actual.end === expected.end)
        && (expected.partId == null || actual.partId === expected.partId)
}

function describeExpected(e: ExpectedSegment): string {
    return `${e.id}${e.start != null ? `@${e.start}..${e.end}` : ''}${e.partId ? `(${e.partId})` : ''}`
}

function describeActual(s: Pick<Segment, 'id' | 'start' | 'end' | 'partId'>): string {
    return `${s.id}${s.start != null ? `@${s.start}..${s.end}` : ''}${s.partId ? `(${s.partId})` : ''}`
}

async function runOne(
    c: GroundtruthCase,
    cache?: Map<string, CachedClassification>,
): Promise<Result> {
    const t0 = Date.now()
    if (!fs.existsSync(c.absPath)) return { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: 0, error: 'file missing' }
    const buffer = fs.readFileSync(c.absPath)
    const mt = mimetypeFor(c.absPath, buffer)
    if (!mt) return { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: 0, error: 'unsupported mimetype' }
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
    const sha256_16 = sha256.slice(0, 16)
    const cacheKey = `${mt}:${sha256}`
    const cached = cache?.get(cacheKey)
    if (cached?.segments) return { ...compareActual(c, cached.segments, 0), reusedFrom: cached.file, sha256_16 }
    if (cached?.error) {
        return {
            file: c.file,
            source: c.source,
            expected: c.expected,
            actual: [],
            pass: false,
            durationMs: 0,
            error: `reused failure from ${cached.file}: ${cached.error}`,
            reusedFrom: cached.file,
            sha256_16,
        }
    }
    try {
        const segs = await classify(buffer, mt)
        cache?.set(cacheKey, { file: c.file, sha256_16, segments: segs })
        return { ...compareActual(c, segs, Date.now() - t0), sha256_16 }
    } catch (err) {
        const error = String(err instanceof Error ? err.message : err)
        cache?.set(cacheKey, { file: c.file, sha256_16, error })
        return { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: Date.now() - t0, error, sha256_16 }
    }
}

function loadActuals(actualPath: string | null): Map<string, Segment[]> | null {
    if (!actualPath) return null
    const raw = JSON.parse(fs.readFileSync(actualPath, 'utf8'))
    const out = new Map<string, Segment[]>()
    for (const r of raw.results ?? []) if (typeof r.file === 'string') out.set(r.file, Array.isArray(r.actual) ? r.actual : [])
    return out
}

function compareActual(c: GroundtruthCase, segs: Segment[], durationMs = 0): Result {
    const actual = segs.map(s => ({ id: s.id, start: s.start, end: s.end, confidence: s.confidence, partId: s.partId, docdate: s.docdate }))
    const missing = c.expected.filter(e => !segs.some(s => segmentMatches(s, e)))
    const expectedIds = new Set(c.expected.map(e => e.id))
    const unexpected = segs.filter(s => {
        if (c.expected.some(e => segmentMatches(s, e))) return false
        return s.id !== NO_CLASIFICADO || expectedIds.has(NO_CLASIFICADO)
    })
    const pass = missing.length === 0 && unexpected.length === 0
    const errors = [
        ...missing.map(e => `missing ${describeExpected(e)}`),
        ...unexpected.map(s => `unexpected ${describeActual(s)}`),
    ]
    return { file: c.file, source: c.source, expected: c.expected, actual, pass, durationMs, error: errors.length ? errors.join('; ') : undefined }
}

// Classifier model + generation profile are satellite-owned and not
// overridable at call time, so a normal run carries a single fixed label.
const RUN_LABEL = 'satellite-default-profile'

function writeRun(outPath: string, label: string, results: Result[]): void {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    const reusedCount = results.filter(r => r.reusedFrom).length
    fs.writeFileSync(outPath, JSON.stringify({ runAt: new Date().toISOString(), label, reusedCount, results }, null, 2))
}

export async function runGroundtruthComparison(args: {
    only?: string | null
    files?: Set<string>
    outPath: string
    actualPath?: string | null
    label?: string
    dedupe?: boolean
    minInspection?: number | null
}): Promise<{ results: Result[]; passCount: number; total: number }> {
    const { only = null, files, outPath, actualPath = null, label = RUN_LABEL, dedupe = true, minInspection = null } = args
    const actuals = loadActuals(actualPath)
    if (!actuals) ensureConfigured()
    const cases = findClassificationFiles().flatMap(parseClassificationFile)
        .filter(c => !files || files.has(c.file))
        .filter(c => !only || c.file.toLowerCase().includes(only.toLowerCase()) || c.source.toLowerCase().includes(only.toLowerCase()))
        .filter(c => minInspection == null || (c.minInspectionConfidence != null && c.minInspectionConfidence >= minInspection))
    const cache = !actuals && dedupe ? new Map<string, CachedClassification>() : undefined
    console.log(`Running ${cases.length} groundtruth cases${only ? ` (filter: ${only})` : ''}${minInspection != null ? ` (inspection >= ${minInspection}%)` : ''}${actualPath ? ` (actual: ${actualPath})` : ''}${cache ? ' (dedupe: on)' : ''} (label: ${label})\n`)
    const results: Result[] = []
    for (const c of cases) {
        const r = actuals
            ? actuals.has(c.file)
                ? compareActual(c, actuals.get(c.file)!)
                : { file: c.file, source: c.source, expected: c.expected, actual: [], pass: false, durationMs: 0, error: 'no saved actual for file' }
            : await runOne(c, cache)
        results.push(r)
        const tag = r.pass ? 'PASS' : 'FAIL'
        console.log(`${tag}  ${r.durationMs}ms  ${r.file}${r.reusedFrom ? `\n      reused:  ${r.reusedFrom}` : ''}\n      expected: [${r.expected.map(describeExpected).join(', ')}]\n      actual:   [${r.actual.map(describeActual).join(', ')}]${r.error ? `\n      ERROR: ${r.error}` : ''}`)
        writeRun(outPath, label, results)
    }
    const passCount = results.filter(r => r.pass).length
    const reusedCount = results.filter(r => r.reusedFrom).length
    console.log(`\n${passCount}/${results.length} pass (${results.length ? (passCount / results.length * 100).toFixed(0) : '0'}%)`)
    if (cache) console.log(`${reusedCount} duplicate case(s) reused cached classification; ${results.length - reusedCount} unique case(s) classified or checked directly`)
    console.log(`Wrote ${outPath}`)
    return { results, passCount, total: results.length }
}

async function main() {
    let only: string | null = null
    let outPath = path.resolve('out/groundtruth.json')
    let actualPath: string | null = null
    let dedupe = true
    let minInspection: number | null = null
    for (const a of process.argv.slice(2)) {
        if (a.startsWith('--only=')) only = a.slice('--only='.length)
        else if (a.startsWith('--out=')) outPath = path.resolve(a.slice('--out='.length))
        else if (a.startsWith('--actual=')) actualPath = path.resolve(a.slice('--actual='.length))
        else if (a === '--no-dedupe') dedupe = false
        else if (a.startsWith('--minInspection=')) {
            const value = Number(a.slice('--minInspection='.length))
            if (Number.isFinite(value)) minInspection = value
        }
    }
    await runGroundtruthComparison({
        only,
        outPath,
        actualPath,
        dedupe,
        minInspection,
        label: RUN_LABEL,
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
    main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
