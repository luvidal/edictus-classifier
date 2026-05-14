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
import * as fs from 'fs'
import * as path from 'path'
import { classify, configure, getClassifierFingerprint, getClassifierProfile, getDoctypes, NO_CLASIFICADO, type DoctypesMap, type GeminiCall } from '../src/index'
import { promptFor } from '../src/prompt'

const DOCTYPES: DoctypesMap = {
    'cedula-identidad': { label: 'Cédula', freq: 'once' },
    'liquidaciones-sueldo': { label: 'Liquidación de sueldo', freq: 'monthly', dateHint: 'período del sueldo' },
    'carpeta-tributaria': {
        label: 'Carpeta tributaria',
        freq: 'annual',
        contains: ['declaracion-anual-impuestos', 'resumen-boletas-sii'],
    },
    'compraventa-propiedad': { label: 'Compraventa', freq: 'once' },
    'deuda-consumo': { label: 'Consumo', freq: 'once' },
    'cartola-banco': { label: 'Cartola', freq: 'once' },
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

    it('embeds the deterministic generation profile internally', async () => {
        let observed: any
        configure({
            doctypes: DOCTYPES,
            geminiCall: async params => {
                observed = params.config
                return { text: '{"documents":[]}' }
            },
        })
        await classify(Buffer.from('fake'), 'image/png')
        expect(observed).toMatchObject({
            temperature: 0,
            topP: 0.1,
            seed: 1,
            candidateCount: 1,
            thinkingConfig: { thinkingBudget: 1024 },
            responseMimeType: 'application/json',
        })
    })

    it('always calls Gemini Pro (no host override)', async () => {
        let observedModel = ''
        configure({
            doctypes: DOCTYPES,
            geminiCall: async params => {
                observedModel = params.model
                return { text: '{"documents":[]}' }
            },
        })
        await classify(Buffer.from('fake'), 'image/png')
        expect(observedModel).toBe('gemini-2.5-pro')
        expect(getClassifierProfile()).toEqual({ model: 'gemini-2.5-pro' })
    })

    it('sends the dominant-upload prompt policy', async () => {
        let prompt = ''
        configure({
            doctypes: DOCTYPES,
            geminiCall: async params => {
                prompt = (params.contents[0]?.parts ?? []).find((p: any) => p.text)?.text ?? ''
                return { text: '{"documents":[]}' }
            },
        })
        await classify(await makePdf(1), 'application/pdf')
        expect(prompt).toContain('Classify the upload by the dominant standalone document it represents')
        expect(prompt).toContain('do not mine internal pages for every possible doctype')
        expect(prompt).toContain('Long legal packets and certified notarial deed copies are dominant-document uploads')
    })

    it('no longer hardcodes the debt/account distinctions prose', async () => {
        // The "Debt/account distinctions" prose moved out of prompt code into
        // per-doctype tieBreaker entries in the catalog.
        let prompt = ''
        configure({
            doctypes: DOCTYPES,
            geminiCall: async params => {
                prompt = (params.contents[0]?.parts ?? []).find((p: any) => p.text)?.text ?? ''
                return { text: '{"documents":[]}' }
            },
        })
        await classify(await makePdf(1), 'application/pdf')
        expect(prompt).not.toContain('Debt/account distinctions')
        expect(prompt).not.toContain('an interior clause page from a notarial deed is not enough')
    })
})

describe('promptFor — classifier block rendering', () => {
    // Tiny hand-written fixture conforming to the frozen `classifier` schema.
    // Does NOT depend on the host catalog.
    const FIXTURE: Array<import('../src/index').Doctype & { id: string }> = [
        {
            id: 'deuda-consumo',
            label: 'Deuda de consumo',
            definition: 'Estado de cuenta de un crédito de consumo o tarjeta de crédito.',
            freq: 'once',
            classifier: {
                useWhen: ['documento enfocado en una cuenta de crédito de consumo o tarjeta'],
                signals: ["título 'Estado de Cuenta'", 'número de tarjeta, CAE, pago mínimo'],
                rejectWhen: ['reporte consolidado con varios productos a la vez'],
                tieBreaker: [
                    { vs: 'cartola-banco', rule: 'tarjeta puntual = deuda-consumo; posición consolidada = cartola-banco' },
                ],
            },
        },
        {
            id: 'cartola-banco',
            label: 'Cartola banco',
            definition: 'Cartola o reporte de posición consolidada de un banco.',
            classifier: {
                useWhen: ['reporte que muestra varios productos del banco a la vez'],
                signals: ['tabla con hipotecarios + consumo + líneas + tarjetas'],
                rejectWhen: ['estado de cuenta de una sola tarjeta'],
                tieBreaker: [
                    { vs: 'deuda-consumo', rule: 'posición consolidada = cartola-banco; tarjeta puntual = deuda-consumo' },
                ],
            },
        },
        // Doctype with no classifier block — must fall back to definition||label.
        { id: 'cedula-identidad', label: 'Cédula', definition: 'Cédula de identidad chilena.' },
        { id: 'padron', label: 'Padrón vehicular' },
    ]

    it('renders useWhen / signals / rejectWhen / vs bullets for a classifier block', () => {
        const out = promptFor(FIXTURE, true)
        expect(out).toContain('- deuda-consumo: Estado de cuenta de un crédito de consumo o tarjeta de crédito. | freq=once')
        expect(out).toContain('    useWhen: documento enfocado en una cuenta de crédito de consumo o tarjeta')
        expect(out).toContain("    signals: título 'Estado de Cuenta'")
        expect(out).toContain('    rejectWhen: reporte consolidado con varios productos a la vez')
        expect(out).toContain('    vs cartola-banco: tarjeta puntual = deuda-consumo; posición consolidada = cartola-banco')
    })

    it('falls back to definition||label for a doctype with no classifier block', () => {
        const out = promptFor(FIXTURE, false)
        expect(out).toContain('- cedula-identidad: Cédula de identidad chilena.')
        expect(out).toContain('- padron: Padrón vehicular')
        // No indented hint lines were emitted for the fallback doctypes.
        expect(out).not.toMatch(/cedula-identidad[^\n]*\n {4}useWhen/)
    })

    it('preserves the load-bearing dominant-document rule', () => {
        const out = promptFor(FIXTURE, true)
        expect(out).toContain('Classify the upload by the dominant standalone document it represents')
        expect(out).toContain('do not mine internal pages for every possible doctype')
        expect(out).toContain('A lone interior page without the container title/header should be classified by its visible standalone content')
    })
})

describe('boot validation — configure() rejects a broken catalog', () => {
    it('rejects a tieBreaker.vs that is not a real doctype id', () => {
        expect(() => configure({
            doctypes: {
                'deuda-consumo': {
                    label: 'Deuda',
                    classifier: { useWhen: [], signals: [], rejectWhen: [], tieBreaker: [{ vs: 'ghost-doctype', rule: 'x' }] },
                },
            },
            geminiCall: async () => ({ text: '{"documents":[]}' }),
        })).toThrow(/not a real doctype id/)
    })

    it('rejects a non-reciprocal tieBreaker (A→B with no B→A)', () => {
        expect(() => configure({
            doctypes: {
                'deuda-consumo': {
                    label: 'Deuda',
                    classifier: { useWhen: [], signals: [], rejectWhen: [], tieBreaker: [{ vs: 'cartola-banco', rule: 'x' }] },
                },
                'cartola-banco': {
                    label: 'Cartola',
                    classifier: { useWhen: [], signals: [], rejectWhen: [], tieBreaker: [] },
                },
            },
            geminiCall: async () => ({ text: '{"documents":[]}' }),
        })).toThrow(/no reciprocal/)
    })

    it('rejects a classifier block missing a required field', () => {
        expect(() => configure({
            doctypes: {
                'deuda-consumo': {
                    label: 'Deuda',
                    // signals omitted
                    classifier: { useWhen: [], rejectWhen: [], tieBreaker: [] } as any,
                },
            },
            geminiCall: async () => ({ text: '{"documents":[]}' }),
        })).toThrow(/classifier\.signals must be an array/)
    })

    it('accepts a doctype with no classifier block', () => {
        expect(() => configure({
            doctypes: { 'cedula-identidad': { label: 'Cédula' } },
            geminiCall: async () => ({ text: '{"documents":[]}' }),
        })).not.toThrow()
    })

    it('accepts a catalog with reciprocal tieBreaker pairs', () => {
        expect(() => configure({
            doctypes: {
                'deuda-consumo': {
                    label: 'Deuda',
                    classifier: { useWhen: [], signals: [], rejectWhen: [], tieBreaker: [{ vs: 'cartola-banco', rule: 'x' }] },
                },
                'cartola-banco': {
                    label: 'Cartola',
                    classifier: { useWhen: [], signals: [], rejectWhen: [], tieBreaker: [{ vs: 'deuda-consumo', rule: 'x' }] },
                },
            },
            geminiCall: async () => ({ text: '{"documents":[]}' }),
        })).not.toThrow()
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
                const doctypesList = promptText.split('Doctypes:\n')[1] ?? ''
                observed = Object.keys(DOCTYPES).filter(id => doctypesList.includes(id))
                return { text: '{"documents":[]}' }
            },
        })
        await classify(Buffer.from('fake'), 'image/jpeg', { candidateIds: ['cedula-identidad'] })
        expect(observed).toEqual(['cedula-identidad'])
    })
})

describe('getClassifierFingerprint', () => {
    it('returns a stable 12-char hex string', () => {
        const fp = getClassifierFingerprint()
        expect(fp).toMatch(/^[0-9a-f]{12}$/)
        expect(getClassifierFingerprint()).toBe(fp)
    })

    it('is deterministic across cosmetic recomputations', () => {
        // Calling twice in the same process must return the identical value;
        // the host folds this into cache keys, so any drift here invalidates
        // the production slice cache for no reason.
        const a = getClassifierFingerprint()
        const b = getClassifierFingerprint()
        expect(a).toBe(b)
    })
})

describe('groundtruth saved-actual comparison', () => {
    it('flags extra unmatched ranges even when the id is expected elsewhere', async () => {
        const root = path.resolve('out/test-groundtruth-corpus')
        const outPath = path.resolve('out/test-groundtruth-extra-range.json')
        const actualPath = path.resolve('out/test-groundtruth-extra-range-actual.json')
        await fs.promises.mkdir(root, { recursive: true })
        await fs.promises.writeFile(path.join(root, 'CLASSIFICATION.md'), [
            '| File | doc_type_id | Range |',
            '| --- | --- | --- |',
            '| doc.pdf | inversiones | 1 |',
        ].join('\n'))
        await fs.promises.writeFile(actualPath, JSON.stringify({
            results: [{
                file: 'doc.pdf',
                actual: [
                    { id: 'inversiones', start: 1, end: 1, confidence: 1 },
                    { id: 'inversiones', start: 2, end: 2, confidence: 1 },
                ],
            }],
        }))
        process.env.CORPUS_ROOT = root
        const { runGroundtruthComparison } = await import('./groundtruth')
        const result = await runGroundtruthComparison({
            files: new Set(['doc.pdf']),
            outPath,
            actualPath,
            label: 'extra-range-test',
        })
        expect(result.passCount).toBe(0)
        expect(result.results[0].error).toContain('unexpected inversiones@2..2')
    })
})
