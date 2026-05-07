# @jogi/classifier

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
```

- **buffer** — PDF or image bytes.
- **mimetype** — `'application/pdf'` | `'image/jpeg'` | `'image/png'` | `'image/webp'`.
- **opts.candidateIds** — optional whitelist; if set, only these doctypes are sent to the model.
- **opts.model** — defaults to `gemini-2.5-flash`.

Each `Segment` has `id`, `confidence`, optional `start`/`end` (1-indexed inclusive PDF page range), optional `docdate` (`YYYY-MM-DD`), optional `partId` (`'front'` | `'back'` for cedula).

## Configure (host-injected)

The library has no AI SDK as a runtime dependency. The host provides the doctypes catalog and a Gemini caller:

```ts
import { configure, classify } from '@jogi/classifier'
import doctypes from './data/doctypes.json'
import { geminiGenerate } from './lib/server/gemini'

configure({ doctypes, geminiCall: geminiGenerate })

const segments = await classify(pdfBuffer, 'application/pdf')
```

`geminiCall` signature:

```ts
type GeminiCall = (params: { model: string; contents: any; config?: any }) => Promise<any>
```

The library handles JSON parsing, schema enforcement (`responseMimeType: 'application/json'` + `responseSchema`), and code-fence stripping.

## Doctype shape

```ts
interface Doctype {
    label: string
    definition?: string
    dateHint?: string
    freq?: 'once' | 'monthly' | 'annual'
    contains?: string[]
}
```

- **definition** — used in the prompt instead of `label` if present.
- **freq** — drives the prompt's recurring-instances rule (multiple monthly liquidaciones get separate rows).
- **contains** — lists child doctype IDs that may appear inside this container (e.g. `carpeta-tributaria` contains `declaracion-anual-impuestos`, `resumen-boletas-sii`).
- **dateHint** — guidance on what the `docdate` represents for this doctype.

## Runtime dependencies

Only `pdf-lib` (page count for gap fill). No AWS, no sharp, no AI SDK. Linux-portable.

## Manual corpus harness

`tests/corpus.ts` runs the classifier against a curated set of real Chilean documents and asserts strict expected segments per file. Not CI — needs a Gemini API key and a local corpus folder.

```bash
# .env: GEMINI_API_KEY=...
JOGI_DOCTYPES=/path/to/doctypes.json \
CORPUS_ROOT=/Users/avd/Downloads/docs \
  npm run corpus -- [--only=substr] [--model=gemini-2.5-flash]
```

The current bar: 43/43 strict pass on the curated corpus.

## Status

Pre-1.0. Algorithm is final — surface bugs upstream rather than patching the prompt or post-processing locally.
