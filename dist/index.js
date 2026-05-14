'use strict';

var crypto = require('crypto');
var pdfLib = require('pdf-lib');

// src/index.ts

// src/prompt.ts
function renderDoctype(t) {
  const meta = [];
  if (t.freq) meta.push(`freq=${t.freq}`);
  if (t.contains?.length) meta.push(`contains=[${t.contains.join(", ")}]`);
  if (t.dateHint) meta.push(`docdate: ${t.dateHint}`);
  const metaLine = meta.length ? ` | ${meta.join(" | ")}` : "";
  const c = t.classifier;
  if (!c) return `- ${t.id}: ${t.definition || t.label}${metaLine}`;
  const lines = [`- ${t.id}: ${t.definition || t.label}${metaLine}`];
  const sub = (label, items) => {
    for (const it of items) lines.push(`    ${label}: ${it}`);
  };
  sub("useWhen", c.useWhen);
  sub("signals", c.signals);
  sub("rejectWhen", c.rejectWhen);
  for (const tb of c.tieBreaker) lines.push(`    vs ${tb.vs}: ${tb.rule}`);
  return lines.join("\n");
}
function promptFor(types, isPdf) {
  const list = types.map(renderDoctype).join("\n");
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
` : ""}Cedula rule:
- If both faces of cedula-identidad are visible in one ${isPdf ? "page" : "image"}, return two cedula-identidad rows with different partId ("front" and "back").
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
${list}`;
}

// src/index.ts
var CONFIG_KEY = /* @__PURE__ */ Symbol.for("@jogi/classifier.config");
var g = globalThis;
function validateDoctypes(doctypes) {
  const ids = new Set(Object.keys(doctypes));
  const errors = [];
  for (const [id, dt] of Object.entries(doctypes)) {
    const c = dt.classifier;
    if (c === void 0) continue;
    for (const field of ["useWhen", "signals", "rejectWhen", "tieBreaker"]) {
      if (!Array.isArray(c[field])) errors.push(`${id}: classifier.${field} must be an array`);
    }
    if (!Array.isArray(c.tieBreaker)) continue;
    for (const tb of c.tieBreaker) {
      if (!tb || typeof tb.vs !== "string" || typeof tb.rule !== "string") {
        errors.push(`${id}: each tieBreaker needs string { vs, rule }`);
        continue;
      }
      if (tb.vs === id) errors.push(`${id}: tieBreaker.vs points at itself`);
      else if (!ids.has(tb.vs)) errors.push(`${id}: tieBreaker.vs "${tb.vs}" is not a real doctype id`);
      else {
        const reverse = doctypes[tb.vs].classifier?.tieBreaker?.some((r) => r.vs === id);
        if (!reverse) errors.push(`${id} \u2192 ${tb.vs} tieBreaker has no reciprocal ${tb.vs} \u2192 ${id} entry`);
      }
    }
  }
  if (errors.length) throw new Error(`@jogi/classifier: invalid doctype catalog:
  ${errors.join("\n  ")}`);
}
function configure(c) {
  validateDoctypes(c.doctypes);
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
var DEFAULT_GENERATION_CONFIG = {
  temperature: 0,
  topP: 0.1,
  seed: 1,
  candidateCount: 1,
  thinkingConfig: { thinkingBudget: 1024 }
};
async function classify(buffer, mimetype, opts = {}) {
  const all = getDoctypes();
  const types = opts.candidateIds?.length ? all.filter((d) => opts.candidateIds.includes(d.id)) : all;
  if (types.length === 0) return [];
  const isPdf = mimetype === "application/pdf";
  const totalPages = isPdf ? await pageCount(buffer) : 1;
  const raw = await aiCall(buffer, mimetype, types, isPdf);
  const merged = mergeDuplicates(raw);
  const resolved = resolveSameRangeConflicts(merged);
  return isPdf ? fillGaps(resolved, totalPages) : resolved;
}
async function pageCount(buf) {
  return (await pdfLib.PDFDocument.load(Uint8Array.from(buf), { ignoreEncryption: true })).getPageCount();
}
function buildResponseSchema(ids, isPdf) {
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
  return {
    type: "OBJECT",
    properties: { documents: { type: "ARRAY", items: { type: "OBJECT", properties: itemProps, required } } },
    required: ["documents"]
  };
}
async function aiCall(buf, mimetype, types, isPdf) {
  const ids = types.map((t) => t.id);
  const r = await getConfig().geminiCall({
    model: DEFAULT_MODEL,
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: mimetype, data: buf.toString("base64") } }, { text: promptFor(types, isPdf) }] }],
    config: {
      ...DEFAULT_GENERATION_CONFIG,
      responseMimeType: "application/json",
      responseSchema: buildResponseSchema(ids, isPdf)
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
var fingerprintCache = null;
function getClassifierFingerprint() {
  if (fingerprintCache !== null) return fingerprintCache;
  const promptTemplate = promptFor([], true) + "\0" + promptFor([], false);
  const schema = JSON.stringify([buildResponseSchema([], true), buildResponseSchema([], false)]);
  const profile = JSON.stringify(DEFAULT_GENERATION_CONFIG);
  fingerprintCache = crypto.createHash("sha256").update(promptTemplate + "\0" + schema + "\0" + profile).digest("hex").slice(0, 12);
  return fingerprintCache;
}
function getClassifierProfile() {
  return { model: DEFAULT_MODEL };
}

exports.NO_CLASIFICADO = NO_CLASIFICADO;
exports.classify = classify;
exports.configure = configure;
exports.getClassifierFingerprint = getClassifierFingerprint;
exports.getClassifierProfile = getClassifierProfile;
exports.getDoctypes = getDoctypes;
exports.getDoctypesMap = getDoctypesMap;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map