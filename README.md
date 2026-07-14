# @edictus/classifier

Lean prompt-first document classifier for Chilean documents. Extracted from Jogi to isolate the AI-first classification path from the legacy per-page detector pipeline.

## How it works

One Gemini call sees the whole file (PDF or image) and returns final segments. Local code only does geometry cleanup:

1. **mergeDuplicates** — collapse overlapping same-id segments into a single span.
2. **resolveSameRangeConflicts** — when two doctypes claim the exact same page range + partId, keep the higher-confidence one.
3. **fillGaps** — any uncovered PDF page range becomes a `no-clasificado` segment.

No local OCR, no anchors, no page ledger, no doctype detector. Approximately 200 LOC of code, plus the prompt.

## Inputs / outputs

```ts
classify(buffer: Buffer, mimetype: string, opts?: ClassifyOptions): Promise<Segment[]>
getClassifierFingerprint(): string
getClassifierProfile(): { model: string }
```

- **buffer** — PDF or image bytes.
- **mimetype** — `'application/pdf'` | `'image/jpeg'` | `'image/png'` | `'image/webp'`.
- **opts.candidateIds** — optional whitelist; if set, only these doctypes are sent to the model.

The model (`gemini-2.5-pro`) and the deterministic generation profile (`temperature: 0`, `topP: 0.1`, `seed: 1`, `candidateCount: 1`, `thinkingConfig.thinkingBudget: 1024`) are owned by this package. The host does not pass them at call time.

Model-choice note (2026-05): keep Pro as the correctness baseline for scanned/image-only Chilean PDFs until fixtures prove otherwise. Gemini 3.5 Flash is the first replacement candidate to benchmark; Flash-Lite-class models are too risky as the authority for classification because prior Jogi tests lost OCR/table fidelity.

`getClassifierFingerprint()` is a stable 12-char sha256 over the static prompt template, response-schema shape, and generation profile. Fold it into host cache keys so prompt/profile/schema edits invalidate cleanly. `getClassifierProfile()` returns `{ model }` for telemetry. README/test/comment edits leave the fingerprint untouched.

Each `Segment` has `id`, `confidence`, optional `start`/`end` (1-indexed inclusive PDF page range), optional `docdate` (`YYYY-MM-DD`), optional `partId` (`'front'` | `'back'` for cedula).

## Configure (host-injected)

The library has no AI SDK as a runtime dependency. The host provides the doctypes catalog and a Gemini caller:

```ts
import { configure, classify } from '@edictus/classifier'
import doctypes from './data/doctypes.json'
import { geminiGenerate } from './lib/server/gemini'

configure({ doctypes, geminiCall: geminiGenerate })

const segments = await classify(pdfBuffer, 'application/pdf')
```

The main app owns Gemini authentication. Keep API keys, Vertex credentials,
quotas, retries, logging, and auth refresh in the host's `geminiGenerate`
implementation; this package only receives the already-authenticated
`geminiCall` function.

Correct:

```ts
configure({ doctypes, geminiCall })
```

Do not add raw secrets to this package's config:

```ts
// Not supported.
configure({ doctypes, geminiCall, geminiKey })
```

`geminiCall` signature:

```ts
type GeminiCall = (params: { model: string; contents: any; config?: any }) => Promise<any>
```

The library handles JSON parsing, schema enforcement (`responseMimeType: 'application/json'` + `responseSchema`), and code-fence stripping.

## Host transition guide

When migrating a host app from direct Gemini calls to `@edictus/classifier`, move only the classification prompt/cleanup into this package. Leave auth and transport in the host:

```ts
// Host app code, not @edictus/classifier/src.
import { GoogleGenAI } from '@google/genai'
import { configure as configureClassifier } from '@edictus/classifier'
import doctypes from './data/doctypes.json'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

configureClassifier({
  doctypes,
  geminiCall: ({ model, contents, config }) =>
    ai.models.generateContent({ model, contents, config }),
})
```

For Vertex AI, build `geminiCall` with the host's existing Vertex auth instead of an API key. Either way, this package receives only the function.

## Parent Jogi upload use case

To make `../jogi` use this classifier, treat it as a classification-only
satellite. It should replace the upload classifier decision, not the parent
app's auth, caching, persistence, field extraction, PDF splitting, or linking.

1. Pin this package by commit SHA in `../jogi/package.json`:

```json
"@edictus/classifier": "github:luvidal/edictus-classifier#<40-char-sha>"
```

Build and commit this package before choosing the SHA, because the parent
installs the packed `dist/` output.

2. Configure it once from a server-only parent init such as
`../jogi/lib/server/docsinit.ts`:

```ts
import { configure as configureClassifier } from '@edictus/classifier'
import doctypes from '@/data/doctypes.json'
import { geminiGenerate } from './gemini'

configureClassifier({ doctypes, geminiCall: geminiGenerate })
```

Do not wire this from shared/browser-reachable modules if doing so would pull
server Gemini auth into a client bundle.

3. In the parent's classify path, use the satellite only for the non-forced
Gemini classify call:

```ts
import { classify as classifySegments, NO_CLASIFICADO } from '@edictus/classifier'

const segments = await classifySegments(buffer, mimetype, {
  candidateIds: candidateDoctypes,
})

const classifiedDocs = segments.map(s => ({
  doc_type_id: s.id === NO_CLASIFICADO ? null : s.id,
  start: s.start,
  end: s.end,
  confidence: s.confidence,
  docdate: s.docdate,
  partId: s.partId,
  data: {},
}))
```

Model and generation profile live inside this package and are non-overridable
at call time. Keep forced-doctype uploads and field extraction in the parent.
If a flow needs immediate fields, run the parent's extraction path after the
classifier picks a doctype; this package intentionally does not return field
data.

4. Use `candidateIds` with product context:

- Requirement slots that already know the expected family should pass a narrow
  candidate list.
- Debt-family slots should exclude broad `compraventa-propiedad`; this is the
  current best simple fix for `Hipo Banco.pdf`-style false positives.
- Legal/compraventa uploads should keep the full catalog context, because narrow
  legal candidate probes regressed long-packet ranges.
- For narrowed requirement slots, an all-`no-clasificado` PDF result, or an
  empty image result, can be a real negative. Do not blindly retry full catalog
  for debt slots, or the fallback can reintroduce the `compraventa-propiedad`
  false positive.

5. Cache keys and metrics in the parent fold `getClassifierFingerprint()` plus
the candidate set. The fingerprint moves on every prompt / profile / schema
edit and stays stable across README/test/comment changes, so satellite cosmetic
releases don't invalidate cached classifications.

## Doctype shape

```ts
interface Doctype {
    label: string
    definition?: string
    dateHint?: string
    freq?: 'once' | 'monthly' | 'annual'
    contains?: string[]
    classifier?: {
        useWhen: string[]      // when this doctype IS the dominant standalone document
        signals: string[]      // literal visual cues on the page (titles, logos, chrome)
        rejectWhen: string[]   // when NOT to use it
        tieBreaker: { vs: string; rule: string }[]  // pairwise look-alike distinctions
    }
}
```

- **definition** — used in the prompt instead of `label` if present.
- **freq** — drives the prompt's recurring-instances rule (multiple monthly liquidaciones get separate rows).
- **contains** — lists child doctype IDs that may appear inside this container (e.g. `carpeta-tributaria` contains `declaracion-anual-impuestos`, `resumen-boletas-sii`).
- **dateHint** — guidance on what the `docdate` represents for this doctype.
- **classifier** — optional structured classification hints, authored in the host's `doctypes.yaml`. `promptFor()` renders each block as telegraphic bullets (`useWhen` / `signals` / `rejectWhen` / `vs <id>`); doctypes with no `classifier` block fall back to a single `id: definition||label` line. `tieBreaker.vs` must resolve to a real doctype id and pairs must be reciprocal — the host build (`build-doctypes.ts`) auto-mirrors reciprocals, and `configure()` re-validates required fields, dangling `vs`, and reciprocity as defense-in-depth (throws on a broken catalog). The "Debt/account distinctions" prose that used to be hardcoded in the prompt now lives as `tieBreaker` entries on the debt-family doctypes.

## Runtime dependencies

Only `pdf-lib` (page count for gap fill). No AWS, no sharp, no AI SDK. Linux-portable.

## Manual corpus harness

Manual harnesses run against real Chilean documents. They are not CI because they upload local corpus files to Gemini.
The paid-test corpus is split into `corpus/per-file` and
`corpus/per-solicitud`; see [docs/corpus.md](docs/corpus.md) for the active
fixture contract and legacy corpus history.

```bash
# .env for manual tools only, not library runtime:
# GEMINI_API_KEY=... or GOOGLE_CLOUD_PROJECT=... + GOOGLE_CLOUD_LOCATION=...
npm run corpus:manifest:per-file
npm run corpus:manifest:per-solicitud

npm run groundtruth:per-file -- --out=out/per-file-groundtruth.json
npm run groundtruth:per-solicitud:trusted -- --out=out/per-solicitud-trusted-groundtruth.json
npm run groundtruth:per-solicitud -- --out=out/per-solicitud-groundtruth.json
npm run param-sweep
```

`param-sweep` writes to `out/param-sweep/<timestamp>/` and compares:

- `baseline-defaults`
- `deterministic` (`temperature: 0`, `topP: 0.1`, `seed: 1`, `candidateCount: 1`)
- `deterministic-think-1024` (`temperature: 0`, `topP: 0.1`, `thinkingBudget: 1024`)

## Playground

Run a local browser dropzone for files or folders:

```bash
npm run playground
```

Open `http://localhost:4177`. The browser sends file bytes to the local Node server, and the server calls `classify()`. Gemini credentials stay server-side.

## Status

Pre-1.0. Keep the classifier prompt-first and lean. Prefer measured prompt/doctype/model changes over local detectors or page-ledger logic.
