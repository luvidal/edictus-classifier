import 'dotenv/config'
import * as childProcess from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import { promisify } from 'util'
import { GoogleGenAI } from '@google/genai'
import { classify, configure, type ClassifyOptions, type DoctypesMap, type GeminiCall } from '../src/index'

const PORT = Number(process.env.PORT || 4177)
const ROOT = path.resolve(__dirname)
const CORPUS_ROOT = path.resolve(process.env.CORPUS_ROOT || 'corpus')
const PDF_PAGE_CACHE = path.resolve('out/corpus-review-pages')
const PDFTOPPM = process.env.PDFTOPPM || 'pdftoppm'
const PDFTOTEXT = process.env.PDFTOTEXT || 'pdftotext'
const REVIEW_THRESHOLD = Number(process.env.CORPUS_REVIEW_THRESHOLD || 90)
const DOCTYPES_PATH = process.env.JOGI_DOCTYPES || '/Users/avd/GitHub/jogi/data/doctypes.json'
const execFile = promisify(childProcess.execFile)

interface UploadItem {
    path?: string
    name: string
    type?: string
    data: string
}

type PlaygroundClassifyOptions = ClassifyOptions & {
    model?: string
    generationConfig?: Record<string, unknown>
}

interface ExpectedSegment {
    id: string
    start?: number
    end?: number
    partId?: 'front' | 'back'
    inspectionConfidence?: number
}

interface ManifestAnnotation {
    classificationFile: string
    expected: ExpectedSegment[]
    minInspectionConfidence: number | null
}

interface ManifestFile {
    relPath: string
    sourceGroup: string
    sha256_16: string
    sizeBytes: number
    mimetype: string | null
    supported: boolean
    pages: number | null
    annotation: ManifestAnnotation | null
    duplicateOf: string | null
}

interface CorpusManifest {
    generatedAt?: string
    root?: string
    summary?: Record<string, unknown>
    files?: ManifestFile[]
}

interface RangeInfo {
    start: number | null
    end: number | null
    label: string
    source: 'annotation' | 'suggested' | 'unknown'
    confidence: 'exact' | 'high' | 'medium' | 'unknown'
    needsReview: boolean
    note?: string
}

const pdfTextCache = new Map<string, string[]>()

function geminiCall(): GeminiCall {
    const apiKey = process.env.GEMINI_API_KEY
    const project = process.env.GOOGLE_CLOUD_PROJECT
    const location = process.env.GOOGLE_CLOUD_LOCATION
    const ai = apiKey
        ? new GoogleGenAI({ apiKey })
        : project && location
            ? new GoogleGenAI({ vertexai: true, project, location } as any)
            : null
    if (!ai) throw new Error('Set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT + GOOGLE_CLOUD_LOCATION')
    return ({ model, contents, config }) => ai.models.generateContent({ model, contents, config })
}

let configured = false

function configureClassifier(): void {
    if (configured) return
    if (!fs.existsSync(DOCTYPES_PATH)) throw new Error(`doctypes.json missing at ${DOCTYPES_PATH}`)
    configure({
        doctypes: JSON.parse(fs.readFileSync(DOCTYPES_PATH, 'utf8')) as DoctypesMap,
        geminiCall: geminiCall(),
    })
    configured = true
}

function mimetypeFor(name: string, provided?: string): string {
    if (provided) return provided
    const ext = path.extname(name).toLowerCase()
    if (ext === '.pdf') return 'application/pdf'
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
    if (ext === '.png') return 'image/png'
    if (ext === '.webp') return 'image/webp'
    return 'application/octet-stream'
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', chunk => {
            body += chunk
            if (body.length > 80 * 1024 * 1024) {
                reject(new Error('Request too large'))
                req.destroy()
            }
        })
        req.on('end', () => resolve(body))
        req.on('error', reject)
    })
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value, null, 2))
}

function parseNumberParam(raw: string | null, fallback: number): number {
    if (raw == null || raw.trim() === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) ? n : fallback
}

function isInside(root: string, target: string): boolean {
    const rel = path.relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function resolveCorpusPath(relPath: string): string {
    const target = path.resolve(CORPUS_ROOT, relPath)
    if (!isInside(CORPUS_ROOT, target)) throw new Error(`Path escapes corpus root: ${relPath}`)
    return target
}

function corpusFileUrl(relPath: string, page?: number): string {
    const query = new URLSearchParams({ path: relPath }).toString()
    return `/corpus-media?${query}${page ? `#page=${page}` : ''}`
}

function corpusPageUrl(relPath: string, page: number): string {
    return `/corpus-page?${new URLSearchParams({ path: relPath, page: String(page) }).toString()}`
}

function loadCorpusManifest(): { manifestPath: string; manifest: CorpusManifest } {
    const manifestPath = path.join(CORPUS_ROOT, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Corpus manifest missing at ${manifestPath}. Run npm run corpus:manifest first.`)
    }
    return { manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CorpusManifest }
}

function confidenceSortValue(value: number | null): number {
    return value == null ? -1 : value
}

function reviewReason(file: ManifestFile, threshold: number): 'missing-annotation' | 'low-confidence' | 'trusted' {
    if (!file.annotation) return 'missing-annotation'
    return confidenceSortValue(file.annotation.minInspectionConfidence) <= threshold ? 'low-confidence' : 'trusted'
}

function reviewRange(segment: ExpectedSegment): string {
    if (segment.start == null) return 'full file'
    return segment.end != null && segment.end !== segment.start ? `${segment.start}-${segment.end}` : `${segment.start}`
}

function rangeLabel(start: number | null, end: number | null): string {
    if (start == null || end == null) return '?'
    return start === end ? `${start}` : `${start}-${end}`
}

function rangeInfo(start: number | null, end: number | null, source: RangeInfo['source'], confidence: RangeInfo['confidence'], note?: string): RangeInfo {
    return { start, end, label: rangeLabel(start, end), source, confidence, needsReview: source === 'unknown' || confidence === 'unknown', ...(note ? { note } : {}) }
}

function fileTextCacheKey(target: string): string {
    const stat = fs.statSync(target)
    return `${target}\0${stat.size}\0${stat.mtimeMs}`
}

async function extractPdfTextPages(target: string, pages: number): Promise<string[]> {
    const key = fileTextCacheKey(target)
    const cached = pdfTextCache.get(key)
    if (cached) return cached
    const out: string[] = []
    for (let page = 1; page <= pages; page++) {
        try {
            const { stdout } = await execFile(PDFTOTEXT, ['-f', String(page), '-l', String(page), '-layout', target, '-'], { maxBuffer: 2 * 1024 * 1024 })
            out.push(stdout)
        } catch {
            out.push('')
        }
    }
    pdfTextCache.set(key, out)
    return out
}

function normalizedText(text: string): string {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').toLowerCase()
}

function pageGroups(pageTexts: string[], predicate: (text: string) => boolean): Array<{ start: number; end: number }> {
    const groups: Array<{ start: number; end: number }> = []
    let start: number | null = null
    for (let i = 0; i <= pageTexts.length; i++) {
        const matches = i < pageTexts.length && predicate(pageTexts[i])
        if (matches && start == null) start = i + 1
        else if (!matches && start != null) {
            groups.push({ start, end: i })
            start = null
        }
    }
    return groups
}

function f22Groups(pageTexts: string[]): Array<{ start: number; end: number }> {
    const groups: Array<{ start: number; end: number }> = []
    let start: number | null = null
    for (let i = 0; i < pageTexts.length; i++) {
        const text = normalizedText(pageTexts[i])
        const startsForm = /impuestos anuales a la renta|internos\s+form\.?\s*22/.test(text)
        const continuesForm = /folio\s*n|remanente de credito.*impuesto a pagar/.test(text)
        if (startsForm) {
            if (start != null) groups.push({ start, end: i })
            start = i + 1
        } else if (start != null && !continuesForm) {
            groups.push({ start, end: i })
            start = null
        }
    }
    if (start != null) groups.push({ start, end: pageTexts.length })
    return groups
}

function segmentOccurrenceIndex(segments: ExpectedSegment[], index: number): number {
    return segments.slice(0, index + 1).filter(segment => segment.id === segments[index].id).length - 1
}

async function inferRangesForFile(file: ManifestFile): Promise<RangeInfo[]> {
    const segments = file.annotation?.expected ?? []
    if (!segments.length) return []
    const pages = file.pages ?? null
    const pdf = file.mimetype === 'application/pdf' && pages != null
    const pageTexts = pdf ? await extractPdfTextPages(resolveCorpusPath(file.relPath), pages!) : []
    const boletasGroups = pdf
        ? pageGroups(pageTexts, text => {
            const normalized = normalizedText(text)
            return /boletas de honorarios electronicas emitidas/.test(normalized)
                || /boleta de prestacion de servicios de terceros electronicas recibidas/.test(normalized)
                || /honorario bruto.*retencion/.test(normalized)
        })
        : []
    const rentaGroups = pdf ? f22Groups(pageTexts) : []

    return segments.map((segment, index) => {
        if (segment.start != null && segment.end != null) return rangeInfo(segment.start, segment.end, 'annotation', 'exact')
        if (!pdf) return file.mimetype?.startsWith('image/')
            ? rangeInfo(1, 1, 'suggested', 'high', 'single image')
            : rangeInfo(null, null, 'unknown', 'unknown')
        if (pages === 1) return rangeInfo(1, 1, 'suggested', 'high', 'single-page PDF')
        if (segment.id === 'carpeta-tributaria') return rangeInfo(1, pages, 'suggested', 'high', 'SII carpeta container')
        if (segment.id === 'resumen-boletas-sii' && boletasGroups.length) {
            const group = boletasGroups[Math.min(segmentOccurrenceIndex(segments, index), boletasGroups.length - 1)]
            return rangeInfo(group.start, group.end, 'suggested', 'high', 'boletas honorarios section')
        }
        if (segment.id === 'declaracion-anual-impuestos' && rentaGroups.length) {
            const group = rentaGroups[Math.min(segmentOccurrenceIndex(segments, index), rentaGroups.length - 1)]
            return rangeInfo(group.start, group.end, 'suggested', 'high', 'Formulario 22 section')
        }
        if (segments.length === 1) return rangeInfo(1, pages, 'suggested', 'medium', 'single annotated document in PDF')
        return rangeInfo(null, null, 'unknown', 'unknown', 'multi-document PDF without an annotated or inferred interval')
    })
}

async function buildReviewEntry(file: ManifestFile, reason: 'missing-annotation' | 'low-confidence' | 'trusted') {
    const ranges = await inferRangesForFile(file)
    const segments = (file.annotation?.expected ?? []).map((segment, segmentIndex) => {
        const range = ranges[segmentIndex] ?? rangeInfo(null, null, 'unknown', 'unknown')
        const previewPage = range.start ?? segment.start ?? 1
        return {
            index: segmentIndex + 1,
            id: segment.id,
            interval: range.label,
            range: reviewRange(segment),
            start: range.start,
            end: range.end,
            partId: segment.partId ?? null,
            inspectionConfidence: segment.inspectionConfidence ?? null,
            rangeSource: range.source,
            rangeConfidence: range.confidence,
            rangeNote: range.note ?? null,
            needsReview: range.needsReview,
            fileUrl: corpusFileUrl(file.relPath, previewPage),
            previewUrl: file.mimetype === 'application/pdf' ? corpusPageUrl(file.relPath, previewPage) : corpusFileUrl(file.relPath),
        }
    })
    const needsReview = segments.length === 0 || segments.some(segment => segment.needsReview)
    return {
        relPath: file.relPath,
        sourceGroup: file.sourceGroup,
        mimetype: file.mimetype,
        pages: file.pages,
        sizeBytes: file.sizeBytes,
        sha256_16: file.sha256_16,
        duplicateOf: file.duplicateOf,
        reason,
        needsReview,
        minInspectionConfidence: file.annotation?.minInspectionConfidence ?? null,
        classificationFile: file.annotation?.classificationFile ?? null,
        fileUrl: corpusFileUrl(file.relPath),
        previewUrl: file.mimetype === 'application/pdf' ? corpusPageUrl(file.relPath, 1) : corpusFileUrl(file.relPath),
        segments,
    }
}

async function corpusReview(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const threshold = parseNumberParam(url.searchParams.get('threshold'), REVIEW_THRESHOLD)
    const limit = Math.max(1, parseNumberParam(url.searchParams.get('limit'), 200))
    const includeTrusted = url.searchParams.get('all') === '1'
    const hardOnly = url.searchParams.get('hard') === '1'
    const { manifestPath, manifest } = loadCorpusManifest()
    const files = (manifest.files ?? []).filter(file => file.supported)
    const candidates = files
        .map(file => ({ file, reason: reviewReason(file, threshold) }))
        .filter(({ reason }) => includeTrusted || reason !== 'trusted')
        .sort((a, b) => {
            const confidence = confidenceSortValue(a.file.annotation?.minInspectionConfidence ?? null)
                - confidenceSortValue(b.file.annotation?.minInspectionConfidence ?? null)
            if (confidence !== 0) return confidence
            const rowDelta = (b.file.annotation?.expected.length ?? 0) - (a.file.annotation?.expected.length ?? 0)
            if (rowDelta !== 0) return rowDelta
            return a.file.relPath.localeCompare(b.file.relPath)
        })

    const builtEntries = await Promise.all(candidates.map(({ file, reason }) => buildReviewEntry(file, reason)))
    const hardCandidates = builtEntries.filter(entry => entry.needsReview)
    const filteredEntries = hardOnly ? hardCandidates : builtEntries
    const entries = filteredEntries.slice(0, limit).map((entry, index) => ({ rank: index + 1, ...entry }))

    sendJson(res, 200, {
        root: CORPUS_ROOT,
        manifestPath,
        manifestGeneratedAt: manifest.generatedAt ?? null,
        threshold,
        limit,
        includeTrusted,
        hardOnly,
        totalSupportedFiles: files.length,
        totalCandidates: candidates.length,
        totalHardCandidates: hardCandidates.length,
        count: entries.length,
        summary: manifest.summary ?? {},
        entries,
    })
}

async function classifyUploads(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = JSON.parse(await readBody(req)) as {
        files?: UploadItem[]
        model?: string
        generationConfig?: Record<string, unknown>
    }
    const files = body.files ?? []
    if (!Array.isArray(files) || files.length === 0) {
        sendJson(res, 400, { error: 'No files provided' })
        return
    }
    configureClassifier()
    const results = []
    for (const file of files) {
        const started = Date.now()
        try {
            const buffer = Buffer.from(file.data, 'base64')
            const mimetype = mimetypeFor(file.name, file.type)
            if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mimetype)) {
                results.push({ path: file.path || file.name, pass: false, error: `Unsupported mimetype: ${mimetype}`, durationMs: 0 })
                continue
            }
            const classifyOptions: PlaygroundClassifyOptions = {
                ...(body.model ? { model: body.model } : {}),
                ...(body.generationConfig ? { generationConfig: body.generationConfig } : {}),
            }
            const segments = await classify(buffer, mimetype, classifyOptions)
            results.push({ path: file.path || file.name, mimetype, durationMs: Date.now() - started, segments })
        } catch (err) {
            results.push({ path: file.path || file.name, durationMs: Date.now() - started, error: String(err instanceof Error ? err.message : err) })
        }
    }
    sendJson(res, 200, { runAt: new Date().toISOString(), count: results.length, results })
}

function contentType(file: string): string {
    const lower = file.toLowerCase()
    if (lower.endsWith('.html')) return 'text/html; charset=utf-8'
    if (lower.endsWith('.js')) return 'text/javascript; charset=utf-8'
    if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
    if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
    if (lower.endsWith('.pdf')) return 'application/pdf'
    if (lower.endsWith('.png')) return 'image/png'
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
    if (lower.endsWith('.webp')) return 'image/webp'
    return 'application/octet-stream'
}

function contentDispositionFilename(target: string): string {
    const basename = path.basename(target)
    const fallback = basename
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/["\\]/g, '_')
    return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(basename)}`
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, target: string): void {
    const stat = fs.statSync(target)
    const sendBody = req.method !== 'HEAD'
    const headers = {
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'content-disposition': contentDispositionFilename(target),
        'content-type': contentType(target),
    }
    const range = req.headers.range
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!match) {
            res.writeHead(416, headers)
            res.end()
            return
        }
        const start = match[1] ? Number(match[1]) : 0
        const end = match[2] ? Number(match[2]) : stat.size - 1
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
            res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` })
            res.end()
            return
        }
        const boundedEnd = Math.min(end, stat.size - 1)
        res.writeHead(206, {
            ...headers,
            'content-length': boundedEnd - start + 1,
            'content-range': `bytes ${start}-${boundedEnd}/${stat.size}`,
        })
        if (sendBody) fs.createReadStream(target, { start, end: boundedEnd }).pipe(res)
        else res.end()
        return
    }
    res.writeHead(200, { ...headers, 'content-length': stat.size })
    if (sendBody) fs.createReadStream(target).pipe(res)
    else res.end()
}

function serveCorpusFile(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const relPath = url.searchParams.get('path')
    if (!relPath) {
        sendJson(res, 400, { error: 'Missing path' })
        return
    }
    const target = resolveCorpusPath(relPath)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        sendJson(res, 404, { error: 'Corpus file not found', path: relPath })
        return
    }
    serveFile(req, res, target)
}

async function renderPdfPage(target: string, page: number): Promise<string> {
    const stat = fs.statSync(target)
    const cacheKey = crypto.createHash('sha256')
        .update(`${target}\0${stat.size}\0${stat.mtimeMs}\0${page}`)
        .digest('hex')
        .slice(0, 24)
    const prefix = path.join(PDF_PAGE_CACHE, cacheKey)
    const png = `${prefix}.png`
    if (fs.existsSync(png)) return png
    fs.mkdirSync(PDF_PAGE_CACHE, { recursive: true })
    try {
        await execFile(PDFTOPPM, ['-f', String(page), '-l', String(page), '-r', '120', '-png', '-singlefile', target, prefix], { maxBuffer: 1024 * 1024 })
    } catch (err) {
        const details = (err as Error & { stderr?: string }).stderr?.trim()
        throw new Error(`failed to render PDF page with ${PDFTOPPM}${details ? `: ${details}` : ''}`)
    }
    if (!fs.existsSync(png)) throw new Error(`PDF page renderer did not write ${png}`)
    return png
}

async function serveCorpusPage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const relPath = url.searchParams.get('path')
    const page = parseNumberParam(url.searchParams.get('page'), 1)
    if (!relPath) {
        sendJson(res, 400, { error: 'Missing path' })
        return
    }
    if (!Number.isInteger(page) || page < 1) {
        sendJson(res, 400, { error: 'Invalid page' })
        return
    }
    const target = resolveCorpusPath(relPath)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        sendJson(res, 404, { error: 'Corpus file not found', path: relPath })
        return
    }
    if (path.extname(target).toLowerCase() !== '.pdf') {
        sendJson(res, 400, { error: 'Page rendering is only available for PDFs', path: relPath })
        return
    }
    serveFile(req, res, await renderPdfPage(target, page))
}

async function serveCorpusPageData(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const relPath = url.searchParams.get('path')
    const page = parseNumberParam(url.searchParams.get('page'), 1)
    if (!relPath) {
        sendJson(res, 400, { error: 'Missing path' })
        return
    }
    if (!Number.isInteger(page) || page < 1) {
        sendJson(res, 400, { error: 'Invalid page' })
        return
    }
    const target = resolveCorpusPath(relPath)
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        sendJson(res, 404, { error: 'Corpus file not found', path: relPath })
        return
    }
    if (path.extname(target).toLowerCase() !== '.pdf') {
        sendJson(res, 400, { error: 'Page rendering is only available for PDFs', path: relPath })
        return
    }
    const png = await renderPdfPage(target, page)
    sendJson(res, 200, { mimeType: 'image/png', data: fs.readFileSync(png).toString('base64') })
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const file = path.normalize(url.pathname === '/' ? 'index.html' : url.pathname === '/review' || url.pathname === '/review/' ? 'review.html' : url.pathname.slice(1))
    const target = path.resolve(ROOT, file)
    if (!isInside(ROOT, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404)
        res.end('Not found')
        return
    }
    res.writeHead(200, { 'content-type': contentType(target) })
    fs.createReadStream(target).pipe(res)
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/classify') {
        classifyUploads(req, res).catch(err => sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) }))
        return
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/corpus/review')) {
        corpusReview(req, res).catch(err => sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) }))
        return
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/corpus/page-data')) {
        serveCorpusPageData(req, res).catch(err => sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) }))
        return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (req.url?.startsWith('/corpus-media') || req.url?.startsWith('/api/corpus/file'))) {
        try {
            serveCorpusFile(req, res)
        } catch (err) {
            sendJson(res, 400, { error: String(err instanceof Error ? err.message : err) })
        }
        return
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url?.startsWith('/corpus-page')) {
        serveCorpusPage(req, res).catch(err => sendJson(res, 500, { error: String(err instanceof Error ? err.message : err) }))
        return
    }
    if (req.method === 'GET') {
        serveStatic(req, res)
        return
    }
    res.writeHead(405)
    res.end('Method not allowed')
})

server.listen(PORT, () => {
    console.log(`@jogi/classifier playground: http://localhost:${PORT}`)
    console.log(`corpus review: http://localhost:${PORT}/review`)
    console.log(`corpus root: ${CORPUS_ROOT}`)
    console.log(`doctypes: ${DOCTYPES_PATH}`)
})
