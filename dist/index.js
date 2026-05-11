'use strict';

var pdfLib = require('pdf-lib');

// src/index.ts

// src/prompt.ts
function promptFor(types, isPdf) {
  const list = types.map((t) => {
    const bits = [`${t.id}: ${t.definition || t.label}`];
    if (t.freq) bits.push(`freq=${t.freq}`);
    if (t.contains?.length) bits.push(`contains=[${t.contains.join(", ")}]`);
    if (t.dateHint) bits.push(`docdate: ${t.dateHint}`);
    return `- ${bits.join(" | ")}`;
  }).join("\n");
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
` : ""}Cedula rule:
- If both faces of cedula-identidad are visible in one ${isPdf ? "page" : "image"}, return two cedula-identidad rows with different partId ("front" and "back").
- If only one face is visible, return one row with that partId when clear.

Debt/account distinctions:
- Bank-issued credit-card statements ("Estado de Cuenta ... Tarjeta de Cr\xE9dito", card number, CAE, billed amount, minimum payment, purchases) are deuda-consumo, not cartola-banco.
- Consolidated bank debt-position reports showing multiple product types at once (mortgages + consumer credit + credit lines + credit cards summary in the same view) are cartola-banco, not deuda-consumo \u2014 even when an individual row has a balance and maturity date. Reserve deuda-consumo for documents focused on a specific consumer credit or credit-card account.
- Mortgage/consumer debt doctypes require a standalone bank statement/certificate/detail or portal page for that credit; an interior clause page from a notarial deed is not enough.

Date rule:
- "docdate" is YYYY-MM-DD for the period/emission date the document corresponds to, not access/download date.

Output:
- JSON only: {"documents":[...]}.
- Omit entries with confidence < 0.5.
- Do not use filenames as evidence.

Doctypes:
${list}`;
}

// src/index.ts
var CONFIG_KEY = /* @__PURE__ */ Symbol.for("@jogi/classifier.config");
var g = globalThis;
function configure(c) {
  g[CONFIG_KEY] = c;
}
function getConfig() {
  const c = g[CONFIG_KEY];
  if (!c) throw new Error("@jogi/classifier: configure({ doctypes, geminiCall }) was not called");
  return c;
}
function getDoctypesMap() {
  return getConfig().doctypes;
}
function getDoctypes() {
  return Object.entries(getConfig().doctypes).map(([id, dt]) => ({ ...dt, id }));
}
var NO_CLASIFICADO = "no-clasificado";
var DEFAULT_MODEL = "gemini-2.5-pro";
async function classify(buffer, mimetype, opts = {}) {
  const all = getDoctypes();
  const types = opts.candidateIds?.length ? all.filter((d) => opts.candidateIds.includes(d.id)) : all;
  if (types.length === 0) return [];
  const isPdf = mimetype === "application/pdf";
  const totalPages = isPdf ? await pageCount(buffer) : 1;
  const raw = await aiCall(buffer, mimetype, types, isPdf, opts.model ?? DEFAULT_MODEL, opts.generationConfig);
  const merged = mergeDuplicates(raw);
  const resolved = resolveSameRangeConflicts(merged);
  return isPdf ? fillGaps(resolved, totalPages) : resolved;
}
async function pageCount(buf) {
  return (await pdfLib.PDFDocument.load(Uint8Array.from(buf), { ignoreEncryption: true })).getPageCount();
}
async function aiCall(buf, mimetype, types, isPdf, model, generationConfig) {
  const ids = types.map((t) => t.id);
  const itemProps = {
    id: { type: "STRING", enum: ids },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
    docdate: { type: "STRING", nullable: true },
    partId: { type: "STRING", enum: ["front", "back"], nullable: true }
  };
  const required = ["id", "confidence"];
  if (isPdf) {
    itemProps.start = { type: "INTEGER", minimum: 1 };
    itemProps.end = { type: "INTEGER", minimum: 1 };
    required.push("start", "end");
  }
  const r = await getConfig().geminiCall({
    model,
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mimetype, data: buf.toString("base64") } }, { text: promptFor(types, isPdf) }] }],
    config: {
      ...generationConfig ?? {},
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: { documents: { type: "ARRAY", items: { type: "OBJECT", properties: itemProps, required } } },
        required: ["documents"]
      }
    }
  });
  const text = (r?.text || r?.candidates?.[0]?.content?.parts?.map?.((p) => p?.text || "").join?.("") || "").replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  const docs = JSON.parse(text || '{"documents":[]}')?.documents ?? [];
  return docs.filter((d) => validSegment(d, isPdf));
}
function validSegment(d, isPdf) {
  return !!d.id && typeof d.confidence === "number" && d.confidence >= 0.5 && (!isPdf || Number.isInteger(d.start) && Number.isInteger(d.end) && d.start >= 1 && d.end >= d.start);
}
function mergeDuplicates(segs) {
  const out = [];
  const used = /* @__PURE__ */ new Set();
  for (let i = 0; i < segs.length; i++) {
    if (used.has(i)) continue;
    let cur = { ...segs[i] };
    for (let j = i + 1; j < segs.length; j++) {
      const o = segs[j];
      if (used.has(j) || o.id !== cur.id || (o.partId ?? null) !== (cur.partId ?? null)) continue;
      const identicalRange = o.start === cur.start && o.end === cur.end;
      const overlaps = cur.start != null && o.start != null && o.start <= cur.end && o.end >= cur.start;
      const samePeriod = (o.docdate ?? null) === (cur.docdate ?? null);
      if (!identicalRange && !(overlaps && samePeriod)) continue;
      if (o.confidence > cur.confidence) cur = { ...o, start: cur.start, end: cur.end };
      cur.start = cur.start != null ? Math.min(cur.start, o.start) : o.start;
      cur.end = cur.end != null ? Math.max(cur.end, o.end) : o.end;
      cur.confidence = Math.max(cur.confidence, o.confidence);
      used.add(j);
    }
    out.push(cur);
  }
  return out.sort(sortSegments);
}
function resolveSameRangeConflicts(segs) {
  const groups = /* @__PURE__ */ new Map();
  for (const s of segs) {
    const key = `${s.start ?? ""}|${s.end ?? ""}|${s.partId ?? ""}`;
    groups.set(key, [...groups.get(key) ?? [], s]);
  }
  return [...groups.values()].map(
    (list) => list.length === 1 ? list[0] : list.reduce((best, s) => s.confidence > best.confidence ? s : best)
  ).sort(sortSegments);
}
function fillGaps(segs, totalPages) {
  const covered = /* @__PURE__ */ new Set();
  for (const s of segs) {
    if (s.start == null || s.end == null) continue;
    for (let p = s.start; p <= s.end; p++) covered.add(p);
  }
  const gaps = [];
  let run = null;
  for (let p = 1; p <= totalPages + 1; p++) {
    if (p <= totalPages && !covered.has(p)) run ??= p;
    else if (run != null) {
      gaps.push({ id: NO_CLASIFICADO, start: run, end: p - 1, confidence: 1 });
      run = null;
    }
  }
  return [...segs, ...gaps].sort(sortSegments);
}
function sortSegments(a, b) {
  return (a.start ?? 0) - (b.start ?? 0) || (a.end ?? 0) - (b.end ?? 0) || a.id.localeCompare(b.id);
}

exports.NO_CLASIFICADO = NO_CLASIFICADO;
exports.classify = classify;
exports.configure = configure;
exports.getDoctypes = getDoctypes;
exports.getDoctypesMap = getDoctypesMap;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map