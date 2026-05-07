# @jogi/classifier

Lean AI-first document classifier. One Gemini call → segments → 3-pass geometry cleanup.

## Contract

1. **One library entry point**: `classify(buffer, mimetype, opts?)`. No `Doc2Fields`-style field extraction here — that stays in `@jogi/docs`.
2. **Host-injected dependencies**: `configure({ doctypes, geminiCall })` is the only setup. No AI SDK as runtime dep.
3. **Algorithm is frozen**. Do not add per-page calls, anchors, detectors, or "smart" merging. If a doctype mis-classifies, fix the doctype `definition`/`contains`/`freq` in the host's `doctypes.json`, or surface a prompt change for review.
4. **Runtime deps**: `pdf-lib` only. No sharp, no AWS, no `@google/genai`.
5. **Output is sorted segments**. PDF gaps are filled with `no-clasificado` (id constant exported as `NO_CLASIFICADO`).
6. **Confidence floor**: segments below `0.5` are dropped at parse time.

## Code rules

- ≤200 LOC for `src/index.ts`. Decompose into siblings only on hard exceed.
- No `@/` imports — relative paths only.
- No Sentry, no host-specific logger. If the AI call throws, let it throw — host wraps.
- Tests under `tests/`. Vitest for unit smoke (`*.test.ts`). The corpus harness (`tests/corpus.ts`) is manual, not CI.

## Build

- `npm run build` — tsup ESM + CJS + types into `dist/`.
- `npm test` — Vitest smoke (no API key required).
- `npm run corpus` — manual harness; needs `GEMINI_API_KEY`, `JOGI_DOCTYPES`, `CORPUS_ROOT`.

## Consumer integration

Consumed by Jogi via GitHub SHA pin (never `#main`, never `file:`):

```json
"@jogi/classifier": "github:luvidal/jogi-classifier#<40-char-sha>"
```

Host wiring lives in `lib/domain/doctypes.ts` (`configureClassifier({ doctypes, geminiCall })`) and is gated behind `CLASSIFIER_V2` env flag in `lib/domain/upload/classify.ts`.

## Behavior bar

- 43/43 strict-mode pass on the curated corpus (see `tests/corpus.ts`).
- 194/194 content-correct on the full `~/Downloads/docs` sweep.
- Strict assertions tolerate model jitter through `extraAllowed` per case — that is *test data*, not algorithm relaxation.
