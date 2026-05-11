# @jogi/classifier

Lean AI-first document classifier satellite for Jogi. One Gemini call → segments → 3-pass geometry cleanup.

## Operating memory

- Read this file before editing; it is the canonical module contract.
- Parent Jogi context lives in `../jogi`; use cases are there and doctypes are in `../jogi/data/doctypes.json`. Do not modify `../jogi` unless the PM explicitly asks.
- Keep code simple and minimal; add LOC only when necessary.

## Contract

1. **One library entry point**: `classify(buffer, mimetype, opts?)`. No `Doc2Fields`-style field extraction here — that stays in `@jogi/docs`.
2. **Host-injected dependencies**: `configure({ doctypes, geminiCall })` is the only setup. The main app owns Gemini auth and passes an already-authenticated caller; do not add `geminiKey`/`apiKey` config fields, raw API-key handling, or AI SDK runtime deps to `src/`.
3. **Algorithm is frozen**. Do not add per-page calls, local OCR, page ledgers, anchor regexes, deterministic doctype detectors, patchy post-processing, or "smart" merging without explicit approval. If a doctype mis-classifies, fix the doctype `definition`/`contains`/`freq` in the host's `doctypes.json`, or surface a prompt change for review.
4. **Runtime deps**: `pdf-lib` only. No sharp, no AWS, no `@google/genai` in `src/`; `@google/genai` is allowed only in manual harnesses/playground.
5. **Output is sorted segments**. PDF gaps are filled with `no-clasificado` (id constant exported as `NO_CLASIFICADO`).
6. **Confidence floor**: segments below `0.5` are dropped at parse time.

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
- Default classifier model is `gemini-2.5-pro`; callers may still override `opts.model` for experiments.
- The latest difficult 11-case sweep is not solved: best Flash result is `4/11`; best Pro result is `7/11` with deterministic parameters plus `thinkingBudget: 1024`.
- Pro deterministic fixed the legal-packet range failures in the 11-case suite; remaining failures are short-file labels plus `Hipo Banco.pdf` false-positive `compraventa-propiedad`.
- Broader Pro deterministic validation on `~/Downloads/docs` is `177/197` strict pass in `out/validation-tune1-20260511-160556.json` (May 11 second sweep with the consolidated-position rule applied). The May 11 first sweep (`out/validation-ship-20260511-143643.json`) and May 8 baseline (`out/full-pro-deterministic-20260508-rerun.json`) are preserved as prior trend points. Remaining errors are strict range clipping, container-child policy, and disputed labels (DAI / Inv Santander).
- Production was running the un-tuned 0.1.0 prompt from Apr 21 (jogi@753b8af3) through May 11 because the tuning was authored locally but never published. Fix shipped May 11 as classifier@9088bd4b, pinned by jogi@fb38e48a. Consolidated-position rule added in a follow-up.
- Full-catalog PDF prompt is about 17.6k chars / roughly 4.4k tokens; the doctype block is about 85% of it. Prefer `candidateIds` narrowing plus full-catalog fallback over blindly shortening definitions.
- Pro is roughly 4x Flash input cost for normal prompts and up to about 8x for prompts over 200k tokens; output is tiny JSON, so input dominates.
- Do not add local dominance/range rules without PM approval; prefer parent-side `candidateIds`, prompt/doctypes, or ground-truth review first.

## Consumer integration

Consumed by Jogi via GitHub SHA pin (never `#main`, never `file:`):

```json
"@jogi/classifier": "github:luvidal/jogi-classifier#<40-char-sha>"
```

Host wiring should live in a server-only parent init such as `lib/server/docsinit.ts` (`configureClassifier({ doctypes, geminiCall })`) and be gated behind a rollout env flag in `lib/domain/upload/classify.ts`. Do not wire classifier auth from shared/browser-reachable doctype modules. If the host uses `GEMINI_API_KEY` or Vertex auth, wrap it inside the host's `geminiCall`; do not pass raw secrets to this library.

## Behavior bar

- Unit tests must stay green without API credentials.
- Manual sweeps should compare against `~/Downloads/docs/**/CLASSIFICATION.md` and report pass rate plus error classes.
- Treat deterministic Gemini params as classification hygiene, not a proven fix.
- Prefer prompt, definitions, and model comparison before changing algorithmic cleanup.
