/**
 * Build a local-only manifest for real classifier corpus files.
 *
 * The manifest is intentionally written under the ignored corpus root because
 * it contains real filenames and source locations.
 *
 *   npm run corpus:manifest
 *   npm run corpus:manifest -- --root=corpus/per-file --check
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { PDFDocument } from 'pdf-lib'

const DEFAULT_ROOT = path.resolve(process.env.CORPUS_ROOT || 'corpus')
const DEFAULT_DOCTYPES = process.env.JOGI_DOCTYPES || '/Users/avd/GitHub/jogi/data/doctypes.json'
const NO_CLASIFICADO = 'no-clasificado'
const REVIEW_THRESHOLD = 90

interface Args {
    root: string
    out: string
    doctypesPath: string
    check: boolean
}

interface ExpectedSegment {
    id: string
    start?: number
    end?: number
    partId?: 'front' | 'back'
    inspectionConfidence?: number
}

interface Annotation {
    classificationFile: string
    rows: number
    expected: ExpectedSegment[]
    minInspectionConfidence: number | null
}

interface CorpusFile {
    assetId: string
    relPath: string
    sourceGroup: string
    sha256: string
    sha256_16: string
    sizeBytes: number
    mimetype: string | null
    supported: boolean
    pages: number | null
    annotation: Annotation | null
    duplicateOf: string | null
}

interface Problem {
    level: 'error' | 'warn'
    relPath: string
    message: string
}

interface ReviewQueueEntry {
    relPath: string
    reason: 'low-confidence' | 'missing-annotation'
    minInspectionConfidence: number | null
    classificationFile: string | null
    expected: ExpectedSegment[]
}

function parseArgs(argv: string[]): Args {
    let root = DEFAULT_ROOT
    let out: string | null = null
    let doctypesPath = DEFAULT_DOCTYPES
    let check = false
    for (const a of argv) {
        if (a.startsWith('--root=')) root = path.resolve(a.slice('--root='.length))
        else if (a.startsWith('--out=')) out = path.resolve(a.slice('--out='.length))
        else if (a.startsWith('--doctypes=')) doctypesPath = path.resolve(a.slice('--doctypes='.length))
        else if (a === '--check') check = true
    }
    return { root, out: out ?? path.join(root, 'manifest.json'), doctypesPath, check }
}

function walk(dir: string): string[] {
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === '.DS_Store' || e.name === 'manifest.json' || e.name === 'jogi-state.json' || e.name === 'replay-state.json') continue
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
            if (e.name === 'archive' || e.name === '_archive') continue
            out.push(...walk(p))
        }
        else out.push(p)
    }
    return out.sort((a, b) => a.localeCompare(b))
}

function splitRow(line: string): string[] {
    return line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map(c => c.trim())
}

function normalizeId(raw: string): string {
    return raw.replace(/`/g, '').replace(/^\((.+)\)$/, '$1').trim()
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

function parseClassificationFile(root: string, file: string, problems: Problem[]): Map<string, ExpectedSegment[]> {
    const md = fs.readFileSync(file, 'utf8')
    const dir = path.dirname(file)
    const byFile = new Map<string, ExpectedSegment[]>()
    let headers: string[] | null = null
    for (const line of md.split(/\r?\n/)) {
        if (!line.startsWith('|')) continue
        const cells = splitRow(line)
        if (cells.some(c => c === '---' || /^-+$/.test(c))) continue
        if (!headers && cells.map(c => c.toLowerCase()).includes('file')) {
            headers = cells
            continue
        }
        if (!headers) continue
        const row = Object.fromEntries(headers.map((h, i) => [h.toLowerCase(), cells[i] ?? '']))
        const filename = row.file
        if (!filename || filename === 'File') continue
        const expected = expectedFromRow(headers, cells)
        if (expected.length === 0) continue
        const absPath = resolveExistingPath(dir, filename)
        const relMd = path.relative(root, file)
        if (!absPath) {
            problems.push({ level: 'error', relPath: relMd, message: `row points to missing file: ${filename}` })
            continue
        }
        const rel = path.relative(root, absPath)
        byFile.set(rel, [...(byFile.get(rel) ?? []), ...expected])
    }
    return byFile
}

function mimetypeFor(file: string, bytes: Buffer): string | null {
    const ext = path.extname(file).toLowerCase()
    if (ext === '.pdf') return 'application/pdf'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    if (bytes.subarray(0, 4).toString('utf8') === '%PDF') return 'application/pdf'
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes.subarray(0, 4).toString('utf8') === 'RIFF' && bytes.subarray(8, 12).toString('utf8') === 'WEBP') return 'image/webp'
    return null
}

async function pageCount(file: string, mimetype: string, bytes: Buffer): Promise<number | null> {
    if (mimetype !== 'application/pdf') return 1
    const pdf = await PDFDocument.load(Uint8Array.from(bytes), { ignoreEncryption: true })
    return pdf.getPageCount()
}

function loadDoctypeIds(doctypesPath: string): Set<string> {
    if (!fs.existsSync(doctypesPath)) return new Set([NO_CLASIFICADO])
    const raw = JSON.parse(fs.readFileSync(doctypesPath, 'utf8')) as Record<string, unknown>
    return new Set([...Object.keys(raw), NO_CLASIFICADO])
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (!fs.existsSync(args.root)) throw new Error(`corpus root missing: ${args.root}`)

    const problems: Problem[] = []
    const doctypeIds = loadDoctypeIds(args.doctypesPath)
    const allFiles = walk(args.root)
    const classificationFiles = allFiles.filter(f => path.basename(f) === 'CLASSIFICATION.md')
    const annotations = new Map<string, Annotation>()

    for (const md of classificationFiles) {
        const parsed = parseClassificationFile(args.root, md, problems)
        for (const [relPath, expected] of parsed) {
            const prev = annotations.get(relPath)
            const mergedExpected = [...(prev?.expected ?? []), ...expected]
            annotations.set(relPath, {
                classificationFile: path.relative(args.root, md),
                rows: (prev?.rows ?? 0) + expected.length,
                expected: mergedExpected,
                minInspectionConfidence: minConfidence(mergedExpected),
            })
        }
    }

    const media: CorpusFile[] = []
    const byHash = new Map<string, CorpusFile[]>()
    const doctypeCounts = new Map<string, number>()

    for (const file of allFiles) {
        if (path.basename(file) === 'CLASSIFICATION.md' || path.extname(file).toLowerCase() === '.md') continue
        const bytes = fs.readFileSync(file)
        const mimetype = mimetypeFor(file, bytes)
        const supported = mimetype === 'application/pdf' || mimetype?.startsWith('image/') === true
        const relPath = path.relative(args.root, file)
        let pages: number | null = null
        if (supported && mimetype) {
            try {
                pages = await pageCount(file, mimetype, bytes)
            } catch (err) {
                problems.push({ level: 'error', relPath, message: `failed to read page count: ${String(err instanceof Error ? err.message : err)}` })
            }
        }
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
        const sha256_16 = sha256.slice(0, 16)
        const sourceGroup = relPath.split(path.sep)[0] || '.'
        const annotation = annotations.get(relPath) ?? null

        if (annotation) {
            for (const e of annotation.expected) {
                doctypeCounts.set(e.id, (doctypeCounts.get(e.id) ?? 0) + 1)
                if (!doctypeIds.has(e.id)) problems.push({ level: 'error', relPath, message: `unknown doctype id in annotation: ${e.id}` })
                if (e.inspectionConfidence == null) problems.push({ level: 'warn', relPath, message: `missing inspection confidence for ${e.id}` })
                else if (e.inspectionConfidence < 0 || e.inspectionConfidence > 100) problems.push({ level: 'error', relPath, message: `inspection confidence out of range for ${e.id}: ${e.inspectionConfidence}` })
                if (pages != null && (e.start != null || e.end != null)) {
                    if (e.start == null || e.end == null || e.start < 1 || e.end < e.start || e.end > pages) {
                        problems.push({ level: 'error', relPath, message: `invalid annotated range for ${e.id}: ${e.start ?? '?'}..${e.end ?? '?'} with ${pages} page(s)` })
                    }
                }
            }
        }

        const entry: CorpusFile = {
            assetId: `${sourceGroup}-${sha256_16}`,
            relPath,
            sourceGroup,
            sha256,
            sha256_16,
            sizeBytes: bytes.length,
            mimetype,
            supported,
            pages,
            annotation,
            duplicateOf: null,
        }
        media.push(entry)
        byHash.set(sha256, [...(byHash.get(sha256) ?? []), entry])
    }

    for (const group of byHash.values()) {
        if (group.length <= 1) continue
        const keeper = group.map(f => f.relPath).sort()[0]
        for (const f of group) if (f.relPath !== keeper) f.duplicateOf = keeper
    }

    const supportedFiles = media.filter(f => f.supported)
    const annotatedFiles = supportedFiles.filter(f => f.annotation)
    const unannotatedFiles = supportedFiles.filter(f => !f.annotation)
    const duplicateGroups = [...byHash.values()].filter(g => g.length > 1)
    const lowConfidenceRows = annotatedFiles.flatMap(f =>
        (f.annotation?.expected ?? [])
            .filter(e => (e.inspectionConfidence ?? -1) < REVIEW_THRESHOLD)
            .map(e => ({ relPath: f.relPath, expected: e })),
    )
    const reviewQueue: ReviewQueueEntry[] = supportedFiles
        .filter(f => !f.annotation || (f.annotation.minInspectionConfidence ?? -1) < REVIEW_THRESHOLD)
        .map(f => ({
            relPath: f.relPath,
            reason: f.annotation ? 'low-confidence' as const : 'missing-annotation' as const,
            minInspectionConfidence: f.annotation?.minInspectionConfidence ?? null,
            classificationFile: f.annotation?.classificationFile ?? null,
            expected: f.annotation?.expected ?? [],
        }))
        .sort((a, b) => a.relPath.localeCompare(b.relPath))
    for (const f of media.filter(f => !f.supported)) {
        problems.push({ level: 'warn', relPath: f.relPath, message: 'unsupported file type for classifier harness' })
    }

    const manifest = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        root: args.root,
        doctypesPath: args.doctypesPath,
        summary: {
            totalFiles: media.length,
            supportedFiles: supportedFiles.length,
            annotatedSupportedFiles: annotatedFiles.length,
            unannotatedSupportedFiles: unannotatedFiles.length,
            classificationFiles: classificationFiles.length,
            expectedRows: [...annotations.values()].reduce((sum, a) => sum + a.rows, 0),
            reviewThreshold: REVIEW_THRESHOLD,
            reviewQueueFiles: reviewQueue.length,
            lowConfidenceRows: lowConfidenceRows.length,
            duplicateGroups: duplicateGroups.length,
            duplicateFiles: duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0),
            problems: problems.length,
            errors: problems.filter(p => p.level === 'error').length,
            warnings: problems.filter(p => p.level === 'warn').length,
        },
        doctypeCounts: Object.fromEntries([...doctypeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
        unannotated: unannotatedFiles.map(f => f.relPath).sort(),
        reviewQueue,
        duplicates: duplicateGroups.map(group => ({
            sha256_16: group[0].sha256_16,
            files: group.map(f => f.relPath).sort(),
        })),
        problems,
        files: media.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    }

    fs.mkdirSync(path.dirname(args.out), { recursive: true })
    fs.writeFileSync(args.out, JSON.stringify(manifest, null, 2))

    console.log(`Corpus root: ${args.root}`)
    console.log(`Wrote ${args.out}`)
    console.log(`Supported files: ${supportedFiles.length}`)
    console.log(`Annotated supported files: ${annotatedFiles.length}`)
    console.log(`Unannotated supported files: ${unannotatedFiles.length}`)
    console.log(`Review threshold: ${REVIEW_THRESHOLD}%`)
    console.log(`Review queue files: ${reviewQueue.length}`)
    console.log(`Low-confidence rows: ${lowConfidenceRows.length}`)
    console.log(`Duplicate groups: ${duplicateGroups.length}`)
    console.log(`Problems: ${problems.length} (${problems.filter(p => p.level === 'error').length} errors, ${problems.filter(p => p.level === 'warn').length} warnings)`)
    if (unannotatedFiles.length) {
        console.log('\nUnannotated supported files:')
        for (const f of unannotatedFiles.map(f => f.relPath).sort()) console.log(`- ${f}`)
    }
    if (problems.length) {
        console.log('\nProblems:')
        for (const p of problems) console.log(`- ${p.level.toUpperCase()} ${p.relPath}: ${p.message}`)
    }
    if (args.check && problems.some(p => p.level === 'error')) process.exitCode = 1
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
