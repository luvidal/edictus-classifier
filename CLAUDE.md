# @jogi/classifier

Lean AI-first document classifier satellite for Jogi. One Gemini call → segments → geometry cleanup.

## Operating memory

- Read this file before editing; it is the canonical module contract.
- Parent Jogi context lives in `../jogi`; use cases are there and doctypes are in `../jogi/data/doctypes.json`. Do not modify `../jogi` unless the PM explicitly asks.
- Keep code simple and minimal; add LOC only when necessary.

## Contract

1. **One library entry point**: `classify(buffer, mimetype, opts?)`. The only call-time input besides bytes/mimetype is `opts.candidateIds?: string[]`. No `model`, no `generationConfig`, no `Doc2Fields`-style field extraction.
2. **Host-injected dependencies**: `configure({ doctypes, geminiCall })` is the only setup. The main app owns Gemini auth and passes an already-authenticated caller; do not add `geminiKey`/`apiKey` config fields, raw API-key handling, or AI SDK runtime deps to `src/`.
3. **Satellite owns the AI knobs**. Model (`gemini-2.5-pro`), generation profile (`temperature: 0, topP: 0.1, seed: 1, candidateCount: 1, thinkingConfig.thinkingBudget: 1024`), prompt, and response schema all live here. The host never overrides them at call time. Surface introspection via `getClassifierFingerprint()` and `getClassifierProfile()` — the host uses both for cache keys and telemetry.
4. **Algorithm is frozen**. Do not add per-page calls, local OCR, page ledgers, anchor regexes, deterministic doctype detectors, patchy post-processing, or "smart" merging without explicit approval. If a doctype mis-classifies, fix the doctype `definition`/`classifier`/`contains`/`freq` in the host's `doctypes.yaml`, or surface a prompt change for review.
9. **Doctype `classifier` block**. Each doctype may carry an optional `classifier: { useWhen, signals, rejectWhen, tieBreaker }` block (authored in the host's `doctypes.yaml`). `promptFor()` renders it as telegraphic bullets; doctypes with no block fall back to `id: definition||label`. `configure()` runs boot validation — required fields present, every `tieBreaker.vs` resolves to a real id, every A→B pair has a reciprocal B→A — and throws on a broken catalog (defense-in-depth over the host's `build-doctypes.ts`, which auto-mirrors reciprocals). The old hardcoded "Debt/account distinctions" prose is gone from `src/prompt.ts`; it now lives as `tieBreaker` entries on `deuda-consumo`, `cartola-banco`, `deuda-hipotecaria`, and `compraventa-propiedad`.
5. **Runtime deps**: `pdf-lib` only. No sharp, no AWS, no `@google/genai` in `src/`; `@google/genai` is allowed only in manual harnesses/playground.
6. **Output is sorted segments**. PDF gaps are filled with `no-clasificado` (id constant exported as `NO_CLASIFICADO`) except uncovered blank/near-blank scanner-artifact pages, which attach to the immediately preceding single non-part document; leading blanks remain `no-clasificado`.
7. **Confidence floor**: segments below `0.5` are dropped at parse time.
8. **Fingerprint is content-derived**. `getClassifierFingerprint()` returns a 12-char sha256 over the static prompt template, response-schema shape, and generation profile. README/test/comment changes leave it untouched; prompt/schema/profile edits each move it.

## Code rules

- Keep `src/index.ts` focused on orchestration/cleanup; prompt text lives in `src/prompt.ts`.
- No `@/` imports — relative paths only.
- No Sentry, no host-specific logger. If the AI call throws, let it throw — host wraps.
- Tests under `tests/`. Vitest for unit smoke (`*.test.ts`). Corpus/groundtruth/sweep harnesses are manual, not CI.

## Build

- `npm run build` — tsup ESM + CJS + types into `dist/`.
- `npm test` — Vitest smoke (no API key required).
- `npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --skipLibCheck dev/server.ts tests/groundtruth.ts tests/param-sweep.ts` — manual typecheck for `dev/` + harness files.
- `npm run corpus` / `npm run groundtruth` / `npm run param-sweep` — manual harnesses; need Gemini credentials, `JOGI_DOCTYPES`, `CORPUS_ROOT`.
- `npm run playground` — local HTML dropzone at `http://localhost:4177`.

## Evaluation notes

- Current debugging context lives in `docs/classifier-testing-notes.md`; read it before changing prompt, definitions, model, or sweep cases.
- Legacy trend JSON copied from Jogi's removed `tests/opus` sandbox lives in `docs/artifacts/opus/`.
- Keep new manual run artifacts under gitignored `out/`; do not overwrite or delete archived trend data.
- Doctype YAML refactor guard: pre-YAML snapshot lives at `docs/artifacts/doctype-yaml-refactor/doctypes.pre-yaml-20260514.json`; after generated `../jogi/data/doctypes.json` changes, run `npm run doctype:regression`. Before relying on `classifier`-only catalog tuning for cache invalidation, fix the host cache key because current `@jogi/docs.getPromptVersion()` hashes expanded doctypes and drops unknown fields such as `classifier`.
- Parent planning context: `../jogi/docs/plans/classification-mega-refactor.md` is the relevant host-side quality plan. It treats quality as satellite prompt/schema/profile + `data/doctypes.json` + host pipeline interactions + model variance. Use it for host fixture/integration-harness context, not as approval to add classifier-side local detectors.
- The resolved Evucina/Yulian incident plan is `../jogi/docs/plans/crooked.md`. Relevant outcome: fresh user uploads stopped deriving classifier candidates from `request.requirements`, container-fallback narrowing stayed, no-clasificado request-row dedupe was added, and cédula composite work belonged to `@jogi/docs`; no `@jogi/classifier` algorithm work was needed for that incident.
- Immediate satellite corpus gate before paid Gemini runs: validate the per-file manifest first with `npm run corpus:manifest:per-file`. `corpus/per-solicitud` mirrors parent Jogi solicitud-folder behavior; use it for parent-process context, not as the first satellite classifier quality gate.
- For visual inspection/debugging of per-file failures, use the local HTML review tool: run the dev server with `CORPUS_ROOT=corpus/per-file` and open `http://localhost:4177/review`. Because the curated per-file corpus is now all 100% inspection confidence, set `Trust at/below` to `100` and click Refresh to show all rows. This is the preferred way to inspect corpus rows and previews before changing prompt or annotations.
- Classifier model (`gemini-2.5-pro`) and generation profile (`temperature: 0, topP: 0.1, seed: 1, candidateCount: 1, thinkingBudget: 1024`) are embedded internally; `classify()` only accepts `{ candidateIds? }`. The `tests/groundtruth.ts` CLI generation flags (`--model`, `--temperature`, etc.) are obsolete and removed; a normal run is labeled `satellite-default-profile`. Truly free-form param experiments live in `dev/` and bypass `classify()`.
- `tests/groundtruth.ts` prefers the production-like Vertex path: `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` → Vertex (default), else `GEMINI_API_KEY` → AI Studio fallback (warns; more 503-prone, not production-like). No need to unset `GEMINI_API_KEY` when the Vertex env vars are present. See `docs/corpus.md` "Auth".
- Current curated per-file baseline: `out/per-file-groundtruth-20260513-161822.json`, regraded after the Astreide parser + CMF annotation fixes as `out/per-file-groundtruth-20260513-161822-regrade-astreide-cmf-fix.json`, is `33/35` strict pass on `corpus/per-file` with parent `../jogi/.env.local` credentials. The active per-file and per-solicitud manifests each have 74 expected rows. Failures: Maat final-page range clip and Scotiabank cartola-vs-deuda label. Astreide now passes; the earlier "3 cedulas" display was a corpus parser bug, and the CMF report is one `informe-deuda@14..15`.
- CMF `informe-deuda` reports may include an optional explanatory/glossary page titled "Entendiendo mi Informe de Deuda". Treat it as part of the same CMF report when present, keep it inside the same segment range, and still classify it as `informe-deuda` if an extracted file contains only that page.
- The latest difficult 11-case sweep is not solved: best Flash result is `4/11`; best Pro result is `7/11` with deterministic parameters plus `thinkingBudget: 1024`.
- Pro deterministic fixed the legal-packet range failures in the 11-case suite; remaining failures are short-file labels plus `Hipo Banco.pdf` false-positive `compraventa-propiedad`.
- Broader Pro deterministic validation on `~/Downloads/docs` is `177/197` strict pass in `out/validation-tune1-20260511-160556.json` (May 11 second sweep with the consolidated-position rule applied). The May 11 first sweep (`out/validation-ship-20260511-143643.json`) and May 8 baseline (`out/full-pro-deterministic-20260508-rerun.json`) are preserved as prior trend points. Remaining errors are strict range clipping, container-child policy, and disputed labels (DAI / Inv Santander).
- Production was running the un-tuned 0.1.0 prompt from Apr 21 (jogi@753b8af3) through May 11 because the tuning was authored locally but never published. Fix shipped May 11 as classifier@9088bd4b, pinned by jogi@fb38e48a. Consolidated-position rule added in a follow-up.
- Full-catalog PDF prompt is about 17.6k chars / roughly 4.4k tokens; the doctype block is about 85% of it. Prefer `candidateIds` narrowing plus full-catalog fallback over blindly shortening definitions.
- Pro is roughly 4x Flash input cost for normal prompts and up to about 8x for prompts over 200k tokens; output is tiny JSON, so input dominates.
- Do not add local dominance/range rules without PM approval; the approved exception is the generic blank-page attachment rule above. Prefer parent-side `candidateIds`, prompt/doctypes, or ground-truth review first.

## Consumer integration

Consumed by Jogi via GitHub SHA pin (never `#main`, never `file:`):

```json
"@jogi/classifier": "github:luvidal/jogi-classifier#<40-char-sha>"
```

Host wiring should live in a server-only parent init such as `lib/server/docsinit.ts` (`configureClassifier({ doctypes, geminiCall })`) and be gated behind a rollout env flag in `lib/domain/upload/classify.ts`. Do not wire classifier auth from shared/browser-reachable doctype modules. If the host uses `GEMINI_API_KEY` or Vertex auth, wrap it inside the host's `geminiCall`; do not pass raw secrets to this library.

When bumping the pin in jogi, use `npm run update:classifier` (or plain `npm install @jogi/classifier@github:luvidal/jogi-classifier#<sha>` with no extra flags). Do **not** pass `--legacy-peer-deps`: it switches npm to a resolution algorithm that prunes ~750 lines of transitive deps (webpack, terser, ajv, @webassemblyjs/*, etc.) from `package-lock.json`, which then breaks Render's `npm ci` with EUSAGE / "Missing: ... from lock file" and crashes the deploy at build time. This bug bit twice on May 11 (fb38e48a and 9cab162f); the fix is to restore the lockfile from the last known-good commit and re-install without the flag.

## Behavior bar

- Unit tests must stay green without API credentials.
- Manual sweeps should compare against `~/Downloads/docs/**/CLASSIFICATION.md` and report pass rate plus error classes.
- Treat deterministic Gemini params as classification hygiene, not a proven fix.
- Prefer prompt, definitions, and model comparison before changing algorithmic cleanup.
