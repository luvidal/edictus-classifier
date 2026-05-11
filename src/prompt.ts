import type { Doctype } from './index'

export function promptFor(types: Array<Doctype & { id: string }>, isPdf: boolean): string {
    const list = types.map(t => {
        const bits = [`${t.id}: ${t.definition || t.label}`]
        if (t.freq) bits.push(`freq=${t.freq}`)
        if (t.contains?.length) bits.push(`contains=[${t.contains.join(', ')}]`)
        if (t.dateHint) bits.push(`docdate: ${t.dateHint}`)
        return `- ${bits.join(' | ')}`
    }).join('\n')

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
- Container PDFs such as carpeta-tributaria may return the container plus actual child documents, but children need their exact visible ranges inside the container.
- Long legal packets and certified notarial deed copies are dominant-document uploads: return one compraventa-propiedad row for the whole packet/reproduced range unless the file clearly contains separate uploaded requirements. Do not carve out mortgage clauses, SII tables, certificates, appraisals, bank-looking annexes, or signatures inside that deed as separate documents.
` : ''}Cedula rule:
- If both faces of cedula-identidad are visible in one ${isPdf ? 'page' : 'image'}, return two cedula-identidad rows with different partId ("front" and "back").
- If only one face is visible, return one row with that partId when clear.

Debt/account distinctions:
- Bank-issued credit-card statements ("Estado de Cuenta ... Tarjeta de Crédito", card number, CAE, billed amount, minimum payment, purchases) are deuda-consumo, not cartola-banco.
- Consolidated bank debt-position reports showing multiple product types at once (mortgages + consumer credit + credit lines + credit cards summary in the same view) are cartola-banco, not deuda-consumo — even when an individual row has a balance and maturity date. Reserve deuda-consumo for documents focused on a specific consumer credit or credit-card account.
- Mortgage/consumer debt doctypes require a standalone bank statement/certificate/detail or portal page for that credit; an interior clause page from a notarial deed is not enough.

Date rule:
- "docdate" is YYYY-MM-DD for the period/emission date the document corresponds to, not access/download date.

Output:
- JSON only: {"documents":[...]}.
- Omit entries with confidence < 0.5.
- Do not use filenames as evidence.

Doctypes:
${list}`
}
