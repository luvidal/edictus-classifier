import type { Doctype } from './index'

/**
 * Renders one doctype's `classifier` block as telegraphic bullets the model can
 * scan fast. Falls back to a single `id: definition||label` line for any
 * doctype with no `classifier` block.
 *
 * The per-doctype `tieBreaker` entries carry the pairwise distinctions that
 * used to be hardcoded as the "Debt/account distinctions" prose in this file;
 * that prose now lives in the catalog (host `doctypes.yaml`) as `tieBreaker`
 * rules on the debt-family doctypes.
 */
function renderDoctype(t: Doctype & { id: string }): string {
    const meta: string[] = []
    if (t.freq) meta.push(`freq=${t.freq}`)
    if (t.contains?.length) meta.push(`contains=[${t.contains.join(', ')}]`)
    if (t.dateHint) meta.push(`docdate: ${t.dateHint}`)
    const metaLine = meta.length ? ` | ${meta.join(' | ')}` : ''

    const c = t.classifier
    if (!c) return `- ${t.id}: ${t.definition || t.label}${metaLine}`

    const lines = [`- ${t.id}: ${t.definition || t.label}${metaLine}`]
    const sub = (label: string, items: string[]) => {
        for (const it of items) lines.push(`    ${label}: ${it}`)
    }
    sub('useWhen', c.useWhen)
    sub('signals', c.signals)
    sub('rejectWhen', c.rejectWhen)
    for (const tb of c.tieBreaker) lines.push(`    vs ${tb.vs}: ${tb.rule}`)
    return lines.join('\n')
}

export function promptFor(types: Array<Doctype & { id: string }>, isPdf: boolean): string {
    const list = types.map(renderDoctype).join('\n')

    return `You are classifying a Chilean document upload.

Return only documents that are physically present as their own visible document, form, certificate, statement, card, or report.
Classify the upload by the dominant standalone document it represents; do not mine internal pages for every possible doctype.
Do NOT classify a doctype merely because its name, topic, or supporting data is mentioned inside another document.
Do NOT classify loose interior excerpts, clauses, annex pages, tables, or fragments unless they have their own visible title/header/issuer as a standalone document.
Prefer omission over guessing. If a page is uncertain, omit it; uncovered PDF pages will become no-clasificado.

${isPdf ? `PDF range rules:
- "start" and "end" are 1-indexed inclusive page ranges.
- One physical/logical document gets one row spanning all its pages.
- Multi-page certificates/reports/cards remain one row; do not split by page.
- Multiple recurring instances, such as monthly liquidaciones or annual SII forms, get separate rows with disjoint ranges and their own docdate.
- Do not return two different non-container doctypes for the exact same page range. Choose the one best supported by visible title/issuer/layout.
- Container PDFs such as carpeta-tributaria return a single row whose page range covers the pages actually present in this upload when the upload presents as that container (visible title/cover/header or multiple consecutive container pages); do not emit child documents (F22, boletas, etc.) inside that container. Do not extrapolate the range beyond the last visible page (a 4-page extract of a carpeta is @1..4, not @1..12). A lone interior page without the container title/header should be classified by its visible standalone content.
- Long legal packets and certified notarial deed copies are dominant-document uploads: return one compraventa-propiedad row for the whole packet/reproduced range unless the file clearly contains separate uploaded requirements. Do not carve out mortgage clauses, SII tables, certificates, appraisals, bank-looking annexes, or signatures inside that deed as separate documents.
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
Each doctype is one line "id: definition", optionally followed by indented hints:
- useWhen: this doctype IS the dominant standalone document
- signals: literal visual cues printed on the page (titles, logos, chrome)
- rejectWhen: when NOT to use it
- vs <other-id>: how to decide between this doctype and a look-alike one
${list}`
}
