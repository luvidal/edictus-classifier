/**
 * Manual corpus harness for @edictus/classifier.
 *
 * Runs the classifier against a curated set of real Chilean documents and
 * checks expected segments per file. NOT a CI test — needs a real Gemini API
 * key and a local corpus folder.
 *
 *   GEMINI_API_KEY=...
 *   JOGI_DOCTYPES=/path/to/doctypes.json
 *   CORPUS_ROOT=/Users/avd/Downloads/docs
 *   npm run corpus -- [--only=substr] [--model=gemini-2.5-flash]
 */

import 'dotenv/config'
import * as fs from 'fs'
import * as path from 'path'
import { GoogleGenAI } from '@google/genai'
import { classify, configure, type Segment, type DoctypesMap } from '../src/index'

const DOCTYPES_PATH = process.env.JOGI_DOCTYPES
    || '/Users/avd/GitHub/jogi/data/doctypes.json'
const ROOT = process.env.CORPUS_ROOT || '/Users/avd/Downloads/docs'
const API_KEY = process.env.GEMINI_API_KEY
if (!API_KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1) }
if (!fs.existsSync(DOCTYPES_PATH)) { console.error(`doctypes.json missing at ${DOCTYPES_PATH}`); process.exit(1) }
if (!fs.existsSync(ROOT)) { console.error(`corpus root missing at ${ROOT}`); process.exit(1) }

const doctypes = JSON.parse(fs.readFileSync(DOCTYPES_PATH, 'utf8')) as DoctypesMap
const ai = new GoogleGenAI({ apiKey: API_KEY })

configure({
    doctypes,
    geminiCall: async ({ model, contents, config }) => ai.models.generateContent({ model, contents, config }),
})

interface ExpectedSegment { id: string; start?: number; end?: number; partId?: 'front' | 'back' }
interface Case { file: string; must?: ExpectedSegment[]; expect?: string[]; extraAllowed?: string[]; note?: string }

const CASES: Case[] = [
    { file: 'gloria/Padrón TOYOTA.pdf', must: [{ id: 'padron', start: 1, end: 2 }], note: '2-page padron must stay one segment' },
    { file: '_reqdocs/padrón mazda.pdf', must: [{ id: 'padron', start: 1, end: 1 }] },
    { file: '_reqdocs/padrón ford.jpeg', must: [{ id: 'padron' }] },
    { file: '_reqdocs/padrón suzuki sx4.png', must: [{ id: 'padron' }] },
    { file: '_reqdocs/matrimonio.pdf', must: [{ id: 'certificado-matrimonio', start: 1, end: 1 }] },
    { file: '_reqdocs/nacimiento.pdf', must: [{ id: 'cert-nacimiento-hijo', start: 1, end: 1 }] },
    { file: 'miguel/NoMatrimonio.pdf', must: [{ id: 'certificado-no-matrimonio', start: 1, end: 1 }] },
    { file: 'evaluacion/Carpeta.pdf', must: [{ id: 'carpeta-tributaria', start: 1, end: 12 }], extraAllowed: ['declaracion-anual-impuestos', 'resumen-boletas-sii', 'avaluo-fiscal'] },
    { file: 'evucina/Carpeta Tributaria.pdf', must: [{ id: 'carpeta-tributaria', start: 1, end: 12 }], extraAllowed: ['declaracion-anual-impuestos', 'resumen-boletas-sii', 'avaluo-fiscal'] },
    { file: '_cedulas/cedula evucina front.jpeg', must: [{ id: 'cedula-identidad', partId: 'front' }] },
    { file: '_cedulas/cedula evucina back.jpeg', must: [{ id: 'cedula-identidad', partId: 'back' }] },
    { file: '_cedulas/cedula daniela.pdf', must: [{ id: 'cedula-identidad', start: 1, end: 1, partId: 'front' }, { id: 'cedula-identidad', start: 1, end: 1, partId: 'back' }] },
    {
        file: '_cedulas/cedula miguel.pdf',
        must: [
            { id: 'cedula-identidad', start: 1, end: 1, partId: 'front' },
            { id: 'cedula-identidad', start: 1, end: 1, partId: 'back' },
            { id: 'certificado-no-matrimonio', start: 2, end: 2 },
        ],
    },
    { file: '_cedulas/cedula nicole.png', must: [{ id: 'cedula-identidad' }], extraAllowed: ['cedula-identidad'] },
    { file: '_cedulas/cedula luis ok.jpg', must: [{ id: 'cedula-identidad' }], extraAllowed: ['cedula-identidad'] },
    { file: 'gloria/Carnet Frente.pdf', must: [{ id: 'cedula-identidad', start: 1, end: 1, partId: 'front' }] },
    { file: 'gloria/LiqSueldo 01-2026 Empresa Constructora Bravo e Izquierdo Limitada.pdf', must: [{ id: 'liquidaciones-sueldo', start: 1, end: 1 }] },
    { file: '_reqdocs/liquidaciones 02 a 10 a.pdf', expect: ['liquidaciones-sueldo'] },
    { file: '_reqdocs/liquidación peluda.pdf', expect: ['liquidaciones-sueldo'] },
    { file: '_reqdocs/liqsueldo.webp', must: [{ id: 'liquidaciones-sueldo' }] },
    { file: 'evaluacion/DAI 2024.pdf', expect: ['resumen-boletas-sii', 'declaracion-anual-impuestos', 'carpeta-tributaria'] },
    { file: 'evaluacion/DAI 2025.pdf', must: [{ id: 'carpeta-tributaria', start: 1, end: 4 }], extraAllowed: ['declaracion-anual-impuestos', 'resumen-boletas-sii', 'avaluo-fiscal'] },
    { file: 'evaluacion/Boletas 2024.pdf', must: [{ id: 'resumen-boletas-sii', start: 1, end: 1 }], extraAllowed: ['avaluo-fiscal'] },
    { file: 'evaluacion/Boletas 2025.pdf', must: [{ id: 'resumen-boletas-sii', start: 1, end: 1 }], extraAllowed: ['avaluo-fiscal'] },
    { file: 'evaluacion/Boletas 2026.pdf', must: [{ id: 'resumen-boletas-sii', start: 1, end: 1 }], extraAllowed: ['avaluo-fiscal'] },
    { file: '_reqdocs/boletasanual.pdf', must: [{ id: 'resumen-boletas-sii', start: 1, end: 1 }], extraAllowed: ['avaluo-fiscal'] },
    { file: '_reqdocs/F22Compacto.pdf', must: [{ id: 'declaracion-anual-impuestos', start: 1, end: 2 }] },
    { file: 'gloria/CMF.pdf', must: [{ id: 'informe-deuda' }] },
    { file: 'gloria/Cartola Banco Itaú Chile.pdf', must: [{ id: 'cartola-banco', start: 1, end: 1 }] },
    { file: 'gloria/Avalúo.pdf', expect: [], note: 'mislabeled file — court filing' },
    { file: '_reqdocs/avaluo-fiscal.pdf', must: [{ id: 'avaluo-fiscal', start: 1, end: 1 }] },
    { file: 'gloria/VentaProp La Florida.pdf', must: [{ id: 'compraventa-propiedad', start: 1, end: 1 }] },
    { file: 'evaluacion/Hipo Santander.pdf', must: [{ id: 'deuda-hipotecaria', start: 1, end: 1 }], extraAllowed: ['informe-credito'] },
    { file: '_reqdocs/HIP Scotiabank La Villa 042026 (2).pdf', must: [{ id: 'deuda-hipotecaria', start: 1, end: 1 }], extraAllowed: ['informe-credito'] },
    { file: 'gloria/AFP.pdf', must: [{ id: 'cotizaciones-afp', start: 1, end: 2 }] },
    { file: '_reqdocs/certificado afp.pdf', must: [{ id: 'cotizaciones-afp', start: 1, end: 2 }] },
    { file: '_reqdocs/contrato arriendo.pdf', must: [{ id: 'contrato-arriendo', start: 1, end: 7 }] },
    { file: 'gloria/Antigüedad Bravo e Izquierdo Limitada..pdf', must: [{ id: 'certificado-antiguedad', start: 1, end: 1 }] },
    { file: '_reqdocs/balance.pdf', expect: ['balance-general', 'estado-resultados', 'estado-financiero'] },
    { file: 'gloria/Inv Santander.pdf', must: [{ id: 'inversiones', start: 1, end: 1 }] },
    { file: '_reqdocs/cta rara.png', expect: ['cuenta-ahorro', 'cartola-banco'] },
    {
        file: '_reqdocs/yulian.pdf',
        expect: ['cedula-identidad'],
        extraAllowed: ['certificado-no-matrimonio', 'cotizaciones-afp', 'certificado-antiguedad', 'liquidaciones-sueldo', 'informe-deuda', 'cartola-banco', 'deuda-consumo', 'cuenta-ahorro'],
    },
    { file: 'gloria/pago tajeta santander.png', expect: [], note: 'unrelated payment screenshot' },
]

function mimetypeFor(filename: string): string | null {
    const ext = path.extname(filename).toLowerCase()
    if (ext === '.pdf') return 'application/pdf'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    return null
}

interface Result {
    file: string
    expected: string[]
    actual: Array<Pick<Segment, 'id' | 'start' | 'end' | 'confidence' | 'partId' | 'docdate'>>
    pass: boolean
    durationMs: number
    error?: string
}

async function runCase(c: Case, model?: string): Promise<Result> {
    const filePath = path.join(ROOT, c.file)
    const mt = mimetypeFor(filePath)
    const t0 = Date.now()
    if (!mt) return { file: c.file, expected: c.expect ?? [], actual: [], pass: false, durationMs: 0, error: 'unsupported mimetype' }
    if (!fs.existsSync(filePath)) return { file: c.file, expected: c.expect ?? [], actual: [], pass: false, durationMs: 0, error: 'file missing' }

    try {
        const segs = await classify(fs.readFileSync(filePath), mt, model ? { model } : undefined)
        const dt = Date.now() - t0
        const reasons: string[] = []
        const must = c.must ?? []
        const expectIds = c.expect ?? []

        for (const m of must) {
            const hit = segs.some(s =>
                s.id === m.id &&
                (m.start == null || s.start === m.start) &&
                (m.end == null || s.end === m.end) &&
                (m.partId == null || s.partId === m.partId),
            )
            if (!hit) reasons.push(`missing ${m.id}${m.start != null ? `@${m.start}..${m.end}` : ''}${m.partId ? `(${m.partId})` : ''}`)
        }

        if (must.length === 0 && expectIds.length > 0) {
            const segIds = segs.map(s => s.id)
            if (!expectIds.some(id => segIds.includes(id))) reasons.push(`expected one of [${expectIds.join(',')}]`)
        }

        const allowedIds = new Set<string>([
            ...must.map(m => m.id),
            ...expectIds,
            ...(c.extraAllowed ?? []),
            'no-clasificado',
        ])
        const noConstraint = must.length === 0 && expectIds.length === 0
        if (!noConstraint) {
            for (const s of segs) if (!allowedIds.has(s.id)) reasons.push(`rogue id: ${s.id}@${s.start}..${s.end}`)
        }

        return {
            file: c.file,
            expected: expectIds.length ? expectIds : must.map(m => `${m.id}${m.start != null ? `@${m.start}..${m.end}` : ''}`),
            actual: segs.map(s => ({ id: s.id, start: s.start, end: s.end, confidence: s.confidence, partId: s.partId, docdate: s.docdate })),
            pass: reasons.length === 0,
            durationMs: dt,
            error: reasons.length === 0 ? undefined : reasons.join('; '),
        }
    } catch (err) {
        return { file: c.file, expected: c.expect ?? [], actual: [], pass: false, durationMs: Date.now() - t0, error: String(err instanceof Error ? err.message : err) }
    }
}

function parseArgs(argv: string[]): { only: string | null; model: string | undefined } {
    let only: string | null = null
    let model: string | undefined
    for (const a of argv) {
        if (a.startsWith('--only=')) only = a.slice('--only='.length)
        else if (a.startsWith('--model=')) model = a.slice('--model='.length)
    }
    return { only, model }
}

async function main() {
    const { only, model } = parseArgs(process.argv.slice(2))
    const cases = only ? CASES.filter(c => c.file.toLowerCase().includes(only.toLowerCase())) : CASES
    console.log(`Running ${cases.length} cases${only ? ` (filter: ${only})` : ''}${model ? ` (model: ${model})` : ''}\n`)
    const results: Result[] = []
    for (const c of cases) {
        const r = await runCase(c, model)
        results.push(r)
        const tag = r.pass ? 'PASS' : 'FAIL'
        const segs = r.actual.map(a => `${a.id}${a.start != null ? `@${a.start}..${a.end}` : ''}${a.partId ? `(${a.partId})` : ''}`).join(', ')
        console.log(`${tag}  ${r.durationMs}ms  ${c.file}\n      → [${segs}]${r.error ? `  ERROR: ${r.error}` : ''}`)
    }
    const totalPass = results.filter(r => r.pass).length
    console.log(`\n${totalPass}/${results.length} pass (${(totalPass / results.length * 100).toFixed(0)}%)`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
