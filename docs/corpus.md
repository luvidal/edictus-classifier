# Classifier Corpus

Real documents are ignored by git. The active corpus is split by the two ways
this package is tested:

```text
corpus/
  per-file/
  per-solicitud/
  archive/
```

Only `per-file` and `per-solicitud` are active paid-test roots. `archive` is
kept for recovery/history and is skipped by the harnesses.

## Per-File Corpus

Use this for direct `classify(buffer, mimetype)` regression tests where one file
equals one classifier call:

```text
corpus/per-file/
  CLASSIFICATION.md
  files/<descriptive-filename>
```

Current shape:

```text
35 supported files
74 expected rows
0 duplicate groups
0 review-queue files
Inspection %: all >= 90
```

The subset is intentionally small and high-signal. It covers:

- many cédula shapes: front-only, back-only, composite PDF, composite image,
  expired ID, and a PDF that also contains `certificado-no-matrimonio`
- multi-document bundles: Yulian dossier and Astreide bundle
- SII edge cases: full `carpeta-tributaria`, DAI filename traps, real F22,
  boletas, and multi-role avalúo
- credit and bank traps: CMF range case, mortgage notice, consumer credit,
  credit-card statement named as cartola, savings-account photo, bank-statement
  screenshot, DAP investment
- hard visual formats: noisy salary scan, mobile screenshots, long legal packet,
  vehicle padrón photo/PDF, marriage/birth certificates, rent contract, balance

Run only this suite with:

```sh
npm run corpus:manifest:per-file
npm run groundtruth:per-file -- --out=out/per-file-groundtruth.json
```

The classifier model and generation profile are satellite-owned (`src/index.ts`):
`gemini-2.5-pro`, `temperature: 0`, `topP: 0.1`, `seed: 1`, `candidateCount: 1`,
`thinkingBudget: 1024`. `classify()` only accepts `{ candidateIds? }`, so the old
`--model` / `--temperature` / `--topP` / `--seed` / `--candidateCount` /
`--thinkingBudget` CLI flags are obsolete and have been removed — a normal run is
labeled `satellite-default-profile`.

## Per-Solicitud Corpus

Use this for parent Jogi solicitud-folder behavior where the grouping matters.
It mirrors the files and expected rows involved in the parent upload/linking
process; it is not the first quality gate for the standalone satellite
classifier path.

```text
corpus/per-solicitud/
  evucina-carpeta-personal/
  yulian-titular/
  astreide-marie/
```

Current shape:

```text
59 supported files
74 expected rows
0 duplicate groups
0 review-queue files
Inspection %: all >= 90
```

Folders:

```text
evucina-carpeta-personal  34 files  37 rows  100% closest replay of Evucina's folder upload from Jogi DB/S3 state
yulian-titular            13 files  13 rows  100% clean standard solicitud with a misleading Santander cartola filename
astreide-marie            12 files  24 rows  100% bundle plus extracted files, useful for folder duplicate/coverage behavior
```

The current manifest has no review queue. Earlier Evucina rows generated from
Jogi state have been visually corrected enough for manifest-gated paid runs.

Run only this suite with:

```sh
npm run corpus:manifest:per-solicitud
npm run groundtruth:per-solicitud:trusted -- --out=out/per-solicitud-trusted-groundtruth.json
npm run groundtruth:per-solicitud -- --out=out/per-solicitud-groundtruth.json
```

Use `groundtruth:per-solicitud:trusted` when preserving the >=90% safety gate.
With the current manifest it should include all per-solicitud rows; use the full
`groundtruth:per-solicitud` script when you deliberately want no inspection
filter at all.

## Auth — use the production-like Vertex path

Production classifies through Vertex (the parent's `lib/server/gemini.ts`). The
ground-truth harness now prefers Vertex automatically:

- `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` present → Vertex (default).
- otherwise `GEMINI_API_KEY` → AI Studio fallback, which prints a warning and is
  **not** production-like (the AI Studio endpoint is more 503-prone).

You do **not** need to unset `GEMINI_API_KEY` before a paid run. As long as
`GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` are set (e.g. via the parent's
`.env.local`), the harness uses Vertex even when `GEMINI_API_KEY` is also
present. `JOGI_GROUNDTRUTH_PROVIDER=ai-studio|vertex` can force a provider.

Recommended Vertex paid command:

```sh
DOTENV_CONFIG_PATH=/Users/avd/GitHub/jogi/.env.local npm run groundtruth:per-file -- --out=out/per-file-groundtruth.json
```

Previous 503-heavy runs likely hit AI Studio because the old harness checked
`GEMINI_API_KEY` first and preferred the consumer endpoint over Vertex. Those
runs should not be treated as production-like validation.

## Cost Rules

Use the per-suite scripts for paid runs. `groundtruth:all` scans both active
corpora and is only for deliberate combined runs.

The ground-truth runner dedupes by `mimetype + sha256` by default. Duplicate
files are still scored against their own expected rows, but only the first
byte-identical file is sent to Gemini. Use `--no-dedupe` only when deliberately
measuring repeat-call variance.

`CLASSIFICATION.md` rows include `Inspection %`. This is confidence in the local
ground-truth annotation, not model confidence:

```text
>= 90  visually inspected / stable enough for paid regression
<  90  human review queue
```

The manifest exposes review candidates in `reviewQueue`.
The ground-truth runner also supports `--minInspection=90` to skip files whose
expected rows are not trusted yet.

## Legacy Corpus History

The full first import was moved out of the active corpus to:

```text
corpus/archive/full-import-20260513/
```

That archive is ignored and should not be used for paid runs. It is retained so
we can recover source files and annotations without re-copying Downloads or S3.

Last full-import manifest before the split:

```text
258 supported files
234 annotated supported files
24 unannotated supported files
325 expected rows
39 duplicate groups
83 duplicate files
0 manifest problems
```

Old broad validation results that informed the curated subset:

```text
out/validation-tune1-20260511-160556.json      177/197 pass
out/regrade-post-gt-corrections-20260511.json 180/197 pass
```

Failure themes preserved in `per-file`:

- CMF range clipping: `cmf morante.pdf`
- multi-doc bundles with embedded CMF pages: Astreide/Bathold style dossiers
- carpeta tributaria emitting child rows in addition to the container
- misleading DAI filenames whose visible content is boletas or carpeta fragment
- long legal packets split into partial legal, no-clasificado, avalúo, and other
  embedded sections
- bank/credit filename traps: cartola-looking credit-card statements and
  savings-account photos
- cédula front/back/composite false positives and omissions

`a-personal/` was removed. It only contained empty UUID directories matching the
Jogi stored-state mirror and had no files to classify.
