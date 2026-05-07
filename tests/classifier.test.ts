/**
 * Smoke tests for @jogi/classifier.
 *
 * No real Gemini call: geminiCall is stubbed to return canned responses.
 * Validates that configure() wiring, prompt assembly, schema validation,
 * post-processing (mergeDuplicates, resolveSameRangeConflicts, fillGaps)
 * and gap fill all behave as documented.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { classify, configure, getDoctypes, NO_CLASIFICADO, type DoctypesMap, type GeminiCall } from '../src/index'

const DOCTYPES: DoctypesMap = {
    'cedula-identidad': { label: 'Cédula', freq: 'once' },
    'liquidaciones-sueldo': { label: 'Liquidación de sueldo', freq: 'monthly', dateHint: 'período del sueldo' },
    'carpeta-tributaria': {
        label: 'Carpeta tributaria',
        freq: 'annual',
        contains: ['declaracion-anual-impuestos', 'resumen-boletas-sii'],
    },
    'declaracion-anual-impuestos': { label: 'F22', freq: 'annual' },
    'resumen-boletas-sii': { label: 'Resumen boletas', freq: 'annual' },
}

async function makePdf(pages: number): Promise<Buffer> {
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) doc.addPage([100, 100])
    return Buffer.from(await doc.save())
}

function stubGemini(documents: Array<Record<string, unknown>>): GeminiCall {
    return async () => ({ text: JSON.stringify({ documents }) })
}

describe('configure', () => {
    it('throws when classify() is called before configure()', async () => {
        // Reset the global symbol slot.
        const sym = Symbol.for('@jogi/classifier.config')
        ;(globalThis as any)[sym] = undefined
        await expect(classify(Buffer.from('x'), 'image/png')).rejects.toThrow(/configure/)
    })

    it('exposes doctypes after configure()', () => {
        configure({ doctypes: DOCTYPES, geminiCall: async () => ({ text: '{"documents":[]}' }) })
        const list = getDoctypes()
        expect(list.map(d => d.id)).toEqual(Object.keys(DOCTYPES))
    })
})

describe('classify (single-page image)', () => {
    beforeEach(() => {
        configure({ doctypes: DOCTYPES, geminiCall: stubGemini([]) })
    })

    it('returns the model output unmodified for an image', async () => {
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([{ id: 'cedula-identidad', confidence: 0.9, partId: 'front' }]),
        })
        const segs = await classify(Buffer.from('fake'), 'image/jpeg')
        expect(segs).toHaveLength(1)
        expect(segs[0]).toMatchObject({ id: 'cedula-identidad', confidence: 0.9, partId: 'front' })
    })

    it('drops segments with confidence < 0.5', async () => {
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([
                { id: 'cedula-identidad', confidence: 0.4 },
                { id: 'cedula-identidad', confidence: 0.8 },
            ]),
        })
        const segs = await classify(Buffer.from('fake'), 'image/jpeg')
        expect(segs).toHaveLength(1)
        expect(segs[0].confidence).toBe(0.8)
    })

    it('strips ```json fenced code blocks', async () => {
        configure({
            doctypes: DOCTYPES,
            geminiCall: async () => ({ text: '```json\n{"documents":[{"id":"cedula-identidad","confidence":0.7}]}\n```' }),
        })
        const segs = await classify(Buffer.from('fake'), 'image/png')
        expect(segs).toHaveLength(1)
    })
})

describe('classify (PDF)', () => {
    it('fills uncovered pages with no-clasificado', async () => {
        const pdf = await makePdf(5)
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([
                { id: 'liquidaciones-sueldo', start: 2, end: 2, confidence: 0.9 },
                { id: 'liquidaciones-sueldo', start: 4, end: 4, confidence: 0.9 },
            ]),
        })
        const segs = await classify(pdf, 'application/pdf')
        const ids = segs.map(s => `${s.id}@${s.start}..${s.end}`)
        expect(ids).toEqual([
            `${NO_CLASIFICADO}@1..1`,
            'liquidaciones-sueldo@2..2',
            `${NO_CLASIFICADO}@3..3`,
            'liquidaciones-sueldo@4..4',
            `${NO_CLASIFICADO}@5..5`,
        ])
    })

    it('keeps a single segment that covers all pages — no gap fill', async () => {
        const pdf = await makePdf(3)
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([
                { id: 'carpeta-tributaria', start: 1, end: 3, confidence: 0.95 },
            ]),
        })
        const segs = await classify(pdf, 'application/pdf')
        expect(segs).toHaveLength(1)
        expect(segs[0].id).toBe('carpeta-tributaria')
    })

    it('rejects malformed PDF segments without start/end', async () => {
        const pdf = await makePdf(2)
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([
                { id: 'liquidaciones-sueldo', confidence: 0.9 }, // missing start/end → invalid for PDF
            ]),
        })
        const segs = await classify(pdf, 'application/pdf')
        // Both pages become no-clasificado.
        expect(segs.every(s => s.id === NO_CLASIFICADO)).toBe(true)
    })

    it('mergeDuplicates collapses overlapping same-id ranges with same period', async () => {
        const pdf = await makePdf(4)
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([
                { id: 'carpeta-tributaria', start: 1, end: 3, confidence: 0.7, docdate: '2025-04-01' },
                { id: 'carpeta-tributaria', start: 2, end: 4, confidence: 0.85, docdate: '2025-04-01' },
            ]),
        })
        const segs = await classify(pdf, 'application/pdf')
        const real = segs.filter(s => s.id !== NO_CLASIFICADO)
        expect(real).toHaveLength(1)
        expect(real[0]).toMatchObject({ id: 'carpeta-tributaria', start: 1, end: 4, confidence: 0.85 })
    })

    it('resolveSameRangeConflicts keeps the higher-confidence id', async () => {
        const pdf = await makePdf(2)
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([
                { id: 'declaracion-anual-impuestos', start: 1, end: 2, confidence: 0.6 },
                { id: 'resumen-boletas-sii', start: 1, end: 2, confidence: 0.9 },
            ]),
        })
        const segs = await classify(pdf, 'application/pdf')
        const real = segs.filter(s => s.id !== NO_CLASIFICADO)
        expect(real).toHaveLength(1)
        expect(real[0].id).toBe('resumen-boletas-sii')
    })

    it('keeps two cedula-identidad rows with different partId on the same page', async () => {
        const pdf = await makePdf(1)
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([
                { id: 'cedula-identidad', start: 1, end: 1, partId: 'front', confidence: 0.95 },
                { id: 'cedula-identidad', start: 1, end: 1, partId: 'back', confidence: 0.92 },
            ]),
        })
        const segs = await classify(pdf, 'application/pdf')
        expect(segs).toHaveLength(2)
        expect(new Set(segs.map(s => s.partId))).toEqual(new Set(['front', 'back']))
    })
})

describe('candidateIds narrowing', () => {
    it('returns [] when candidateIds matches nothing', async () => {
        configure({
            doctypes: DOCTYPES,
            geminiCall: stubGemini([{ id: 'cedula-identidad', confidence: 0.9 }]),
        })
        const segs = await classify(Buffer.from('fake'), 'image/jpeg', { candidateIds: ['nonexistent-id'] })
        expect(segs).toEqual([])
    })

    it('passes only the matching subset to the model', async () => {
        let observed: string[] = []
        configure({
            doctypes: DOCTYPES,
            geminiCall: async params => {
                const promptText = (params.contents[0]?.parts ?? []).find((p: any) => p.text)?.text ?? ''
                observed = Object.keys(DOCTYPES).filter(id => promptText.includes(id))
                return { text: '{"documents":[]}' }
            },
        })
        await classify(Buffer.from('fake'), 'image/jpeg', { candidateIds: ['cedula-identidad'] })
        expect(observed).toEqual(['cedula-identidad'])
    })
})
