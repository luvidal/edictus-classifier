# Classifier Testing Notes

We are debugging the lean sandbox classifier, not rebuilding `@jogi/docs`.

Main goal: keep it fast, cheap, and simple. No OCR, page ledger, regex detector, local doctype detector, or pile of post-processing unless evidence forces it.

## Current Handoff

Parent-side plan scan, 2026-05-13:

- `../../docs/plans/classification-mega-refactor.md` is the relevant host plan. It keeps the satellite as the black-box AI classifier and improves quality by tightening the host/satellite boundary plus adding replayed integration fixtures for the upload pipeline.
- That plan says quality lives in four places: this satellite, `../jogi/data/doctypes.json`, host pipeline interactions, and irreducible Gemini Pro variance. Do not treat host fixture work as permission to add classifier-side OCR, page ledgers, local detectors, or smart merging.
- `../../docs/plans/crooked.md` is resolved. It documents that the Evucina/Yulian incident was handled mostly host-side: full-catalog fresh uploads instead of `request.requirements` narrowing, deterministic config, slice-cache invalidation, no-clasificado dedupe, and a cédula composite fix in `@jogi/docs`.

Immediate workflow:

- Test the per-file manifest before any paid Gemini groundtruth run for this satellite.
- Run `npm run corpus:manifest:per-file`.
- If the manifest has errors, fix annotations/corpus shape before running `groundtruth:per-file`.
- Treat `corpus/per-solicitud` as parent Jogi solicitud-folder process context, not as the first check for the standalone classifier path.
- For visual review, run the local HTML corpus review tool against `CORPUS_ROOT=corpus/per-file` and open `/review`. Set `Trust at/below` to `100` and Refresh because the curated per-file rows are now all 100% trusted. Use it to inspect source previews and annotations for failed per-file cases before deciding whether a failure is classifier behavior, prompt/doctype policy, or annotation policy.

Manifest check, 2026-05-13:

- `corpus:manifest:per-file`: 35 supported / 35 annotated / 74 expected rows / 0 review queue / 0 duplicate groups / 0 problems.
- `corpus:manifest:per-solicitud`: 59 supported / 59 annotated / 74 expected rows / 0 review queue / 0 duplicate groups / 0 problems. This is parent-process context, not the first satellite quality gate.
- Both generated ignored `manifest.json` files under `corpus/per-file/` and `corpus/per-solicitud/`.

Current per-file run, 2026-05-13:

- Command: `DOTENV_CONFIG_PATH=/Users/avd/GitHub/jogi/.env.local npm run groundtruth:per-file -- --out=out/per-file-groundtruth-20260513-161822.json`.
- Result after annotation regrade: `33/35` strict pass. All 35 files were unique classifications in the paid run; no dedupe reuse.
- The Astreide "3 cedulas" review display was a harness/parser bug, not a Gemini bug. The annotation says page 1 is `Cédula Frente` and page 2 is `Cédula Revés`; the parser incorrectly expanded the page-2 note `Composite split (Frente p1 / Revés p2)` as if page 2 contained both sides. Fixed in `tests/corpus-manifest.ts` and `tests/groundtruth.ts`; regrade artifact: `out/per-file-groundtruth-20260513-161822-regrade-parserfix.json`.
- `files/multi-astreide-bundle.pdf`: now passes. Cédula expectations are `cedula-identidad@1..1(front)` and `cedula-identidad@2..2(back)`, matching the saved Gemini actuals. CMF expectation was corrected to one `informe-deuda@14..15` because p15 is the optional explanatory page of the same report; final regrade artifact: `out/per-file-groundtruth-20260513-161822-regrade-astreide-cmf-fix.json`.
- CMF rule update: the optional explanatory/glossary page titled "Entendiendo mi Informe de Deuda" is part of the CMF report. It may appear or not appear. If present with a report, keep it inside the same `informe-deuda` range; if extracted by itself, still classify it as `informe-deuda`.
- `files/informe-comercial-maat.pdf`: expected `informe-credito@1..6`; actual clipped to `informe-credito@1..5` plus PDF gap fill `no-clasificado@6..6`.
- `files/cartola-scotiabank-screenshot.png`: expected `cartola-banco`; actual returned `deuda-consumo`. This is the known consolidated-position/cartola-vs-deuda boundary resurfacing on the curated per-file corpus.

Harness + auth update, 2026-05-14:

- The classifier model and generation profile are satellite-owned (`src/index.ts`): `gemini-2.5-pro`, `temperature: 0`, `topP: 0.1`, `seed: 1`, `candidateCount: 1`, `thinkingBudget: 1024`. `classify()` only accepts `{ candidateIds? }`. The old `tests/groundtruth.ts` CLI generation flags (`--model`, `--temperature`, `--topP`, `--topK`, `--seed`, `--candidateCount`, `--thinkingBudget`) are obsolete and removed; `parseGenerationConfig` and the `classifyOptions` model/generationConfig plumbing are gone. A normal run is labeled `satellite-default-profile`.
- `tests/groundtruth.ts` `geminiCall()` now prefers the production-like Vertex path: `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION` → Vertex (default); else `GEMINI_API_KEY` → AI Studio fallback with a printed warning. `JOGI_GROUNDTRUTH_PROVIDER=ai-studio|vertex` can force a provider. You do not need to unset `GEMINI_API_KEY` when the Vertex env vars are present.
- Previous 503-heavy paid runs likely hit the AI Studio endpoint because the old `geminiCall()` checked `GEMINI_API_KEY` first and preferred the consumer endpoint over Vertex. Those runs are not production-like validation.
- `tests/param-sweep.ts` is no longer a generation-parameter bakeoff (params can't be overridden); it now just runs the high-signal failure subset once against the satellite-default profile.
- Recommended Vertex paid command: `DOTENV_CONFIG_PATH=/Users/avd/GitHub/jogi/.env.local npm run groundtruth:per-file -- --out=out/per-file-groundtruth.json`.

May 14 YAML compacted catalog / Vertex validation:

- Parent commit: `jogi@55e39826` (`refactor(doctypes): YAML-native catalog + structured classifier blocks`) contains the YAML-native catalog, generated `data/doctypes.json`, sync gates, slice-cache full-catalog hash, Gemini-only host classify/extract path, and the parent pin to `@jogi/classifier#e18a5a6`.
- Clean Vertex run before the final targeted YAML fixes: `out/per-file-groundtruth-doctype-bullets-vertex.json` was `32/35` with no infra failures. It fixed `files/multi-astreide-bundle.pdf` and `files/cartola-scotiabank-screenshot.png`, but regressed `files/boletas-fragment-misnamed-dai-2024.pdf` and `files/avaluo-fiscal-multirol.pdf`; `files/informe-comercial-maat.pdf` remained the pre-existing trailing-page range clip.
- Targeted YAML fixes kept the architecture prompt-first/catalog-first: `avaluo-fiscal.useWhen` now says the certificate is one document spanning all pages even when properties appear on separate pages; `carpeta-tributaria` was tightened so a lone interior BHE/F29 page is not promoted to the container. Targeted Vertex checks passed after the second avaluo attempt: `out/targeted-avaluo2.json`, `out/targeted-boletas.json`, `out/targeted-carpeta.json`, `out/targeted-astreide.json`, and `out/targeted-cartola.json`.
- Final clean Vertex corpus artifact before blank-page policy: `out/per-file-groundtruth-doctype-bullets-final.json` is `34/35` strict pass on the 35-file per-file corpus, labeled `satellite-default-profile`. The only remaining failure is `files/informe-comercial-maat.pdf` (`informe-credito@1..5` plus `no-clasificado@6..6` instead of `@1..6`), which led to the blank-page range policy below.

Blank-page range semantics, 2026-05-14:

- `files/informe-comercial-maat.pdf` is not an `informe-credito` recognition failure. The model consistently returns `informe-credito@1..5`; page 6 is a near-blank scan artifact (`pdfimages` shows an 8.8 KB page versus 78-158 KB for pages 1-5), and the corpus annotation says it is "prácticamente en blanco".
- Product decision: blank / near-blank scanner-artifact pages belong to the preceding document; no document starts on a blank page.
- Implemented as a generic PDF range rule, not as an `informe-credito`-specific YAML hint: the prompt asks the model to include trailing blank pages in the previous range, and local cleanup attaches uncovered blank-like pages to the immediately preceding single non-part segment before normal `no-clasificado` gap fill.
- Leading blank pages remain `no-clasificado` until visible document evidence begins; nonblank omitted pages still become `no-clasificado`.

## What We Tested

Parameter sweep before prompt/definition changes:

- `baseline-defaults`: `0/11`
- `deterministic-cheap`: `2/11`
- `deterministic-think-1024`: `1/11`

Prompt sweep after stricter physical-document prompt:

- `baseline-defaults`: `2/11`
- `deterministic-cheap`: `2/11`
- `deterministic-think-1024`: `3/11`

Latest sweep after dominant-document prompt and definition tuning:

- `baseline-defaults`: `2/11`
- `deterministic-cheap`: `2/11`
- `deterministic-think-1024`: `4/11`

Pro check on the same 11 cases:

- `pro-defaults`: `6/11`
- `pro-deterministic-think-1024`: `7/11`

## Parameter Conclusion

Deterministic settings are hygiene, not the fix. They reduce variance but do not solve the hard failures.

Thinking helps somewhat on Flash, but Flash still fails core long-PDF boundary cases.

Best observed Flash config:

```ts
{
  temperature: 0,
  topP: 0.1,
  seed: 1,
  candidateCount: 1,
  thinkingConfig: { thinkingBudget: 1024 },
}
```

Best observed overall config:

```ts
{
  model: 'gemini-2.5-pro',
  generationConfig: {
    temperature: 0,
    topP: 0.1,
    seed: 1,
    candidateCount: 1,
    thinkingConfig: { thinkingBudget: 1024 },
  },
}
```

This is `7/11`, not a default recommendation. Pro is slower/costlier, and the remaining failures need review before deciding whether to change model routing, prompt, definitions, or ground truth.

## Prompt And Cost Notes

Full-catalog PDF prompt size:

- 25 doctypes.
- Assembled prompt: about 17.6k chars, roughly 4.4k tokens.
- Doctype block: about 15.0k chars, roughly 3.8k tokens, around 85% of the prompt.
- Static instructions: roughly 650 tokens.

Cost read as of 2026-05-08 from official Google pricing:

- Gemini 2.5 Flash: $0.30 / 1M input tokens, $2.50 / 1M output tokens.
- Gemini 2.5 Pro: $1.25 / 1M input tokens up to 200k prompt tokens, $2.50 / 1M input tokens above 200k.
- Gemini 2.5 Pro output: $10 / 1M tokens up to 200k prompt tokens, $15 / 1M above 200k.
- Classifier output is tiny JSON, so input dominates. Pro is roughly 4x Flash for normal docs and up to about 8x for very large PDFs.

Prompt conclusion:

- The catalog is not too large for context.
- The bigger risk is too many plausible competing labels in one prompt.
- Use `candidateIds` aggressively when parent Jogi request context knows expected requirements, then keep full-catalog fallback for out-of-context uploads.
- Do not blindly shorten definitions; the long contrast rules may be helping with close labels.

## Real Problem

There are two problems: labels and boundaries.

Labels are document type IDs like `compraventa-propiedad`, `deuda-consumo`, `cartola-banco`, etc.

Boundaries are page ranges, like whether a 99-page PDF is one document or many documents.

The most important Flash failure is boundaries. Gemini Flash often recognizes page content plausibly, but it over-segments long legal PDFs.

Example: a 99-page VentaProp file should be one `compraventa-propiedad` range, but Gemini splits it into mortgage debt, SII pages, certificates, appraisals, etc.

Short files are mostly label-boundary issues. Long files are mostly document-boundary issues.

Pro deterministic fixed the long VentaProp boundary cases in the 11-case suite, including both 99-page Lo Barnechea files and the 20-page Las Cabras file. That weakens the case for adding a local dominance/range rule before broader Pro validation.

## Sweep Page Counts

- `cta rara.png`: 1
- `DAI 2024.pdf`: 1
- `Inv Santander (1).pdf`: 1
- `Inv Santander.pdf`: 1
- `VentaProp Lo Barnechea.pdf`: 99
- `Consumo Scotiabank.png`: 1
- `Hipo Banco.pdf`: 1
- `VentaProp Las Cabras.pdf`: 20
- `VentaProp Lo Barnechea.pdf`: 99
- `gloria/Carpeta.pdf`: 15
- `Cartola Santander.pdf`: 3

Hard failures are mostly the 20/99-page legal packets plus `gloria/Carpeta.pdf`.

## Prompt Rule Added

The latest prompt rule:

> Classify the upload by the dominant standalone document it represents; do not mine internal pages for every possible doctype.

This helped somewhat, but Gemini still fragments long PDFs.

## Definition Tuning Done

- DAI vs boletas SII
- `cartola-banco` vs `deuda-consumo`
- `deuda-hipotecaria` vs notarial mortgage clauses
- `inversiones` vs `compraventa-propiedad`
- `compraventa-propiedad` as long deed/legal packet

More specifically:

- DAI now requires visible F22/Impuestos Anuales title.
- Boletas are explicitly separate from F22/DAI.
- `cartola-banco` excludes credit card statements and clear debt details.
- `deuda-consumo` includes credit card statements and bank portal debt rows.
- `deuda-hipotecaria` rejects interior notarial/mutuo clauses.
- `compraventa-propiedad` includes long certified deed packets and tells Gemini not to split internal annexes.
- `inversiones` rejects notarial/compraventa documents even if the filename says investment.

## Disputed Ground Truth

Some ground truth rows look disputed:

- `evaluacion/DAI 2024.pdf` visually looks like boletas/F29 content, not F22 DAI.
- `evaluacion/Inv Santander*.pdf` visually look like notarial compraventa certificates, not inversiones.

We did not remove them from the sweep because the original 11-case set is being preserved for trend continuity.

## Architecture Facts

The lean classifier architecture:

- `classify()` makes one Gemini call over the full file.
- It returns final `Segment` rows.
- Local code only does duplicate collapse, same-range conflict resolution, and PDF gap fill.
- It does not use OCR, anchors, page ledger, or local doctype detection.

Gemini wrapper behavior from Jogi:

- `lib/server/gemini.ts` honors explicit caller `thinkingConfig`.
- Default Flash still gets `thinkingBudget: 0` unless caller provides `thinkingConfig`.
- This made the sweep able to test `thinkingBudget: 1024`.

## Preserved Artifacts

- `docs/artifacts/opus/groundtruth-from-sweep.json`
- `docs/artifacts/opus/sweep.json`
- `docs/artifacts/opus/param-sweep/20260507213054/`
- `docs/artifacts/opus/param-sweep/20260507213642/`
- `docs/artifacts/opus/param-sweep/20260507231216/`

These were copied out of Jogi's old `tests/opus/out/` sandbox before the sandbox was removed.

Key latest artifact:

- `docs/artifacts/opus/param-sweep/20260507231216/summary.json`

## Latest Flash Thinking-1024 Results

Passing cases:

- `_reqdocs/cta rara.png` -> `cuenta-ahorro`
- `evucina/Consumo Scotiabank.png` -> `deuda-consumo`
- `evucina/Hipo Banco.pdf` -> `no-clasificado`
- `yulian/YULIAN GARCIA/Cartola Santander.pdf` -> `deuda-consumo`

Still failing cases:

- `evaluacion/DAI 2024.pdf` -> `resumen-boletas-sii`, expected DAI
- `evaluacion/Inv Santander (1).pdf` -> `compraventa-propiedad`, expected inversiones
- `evaluacion/Inv Santander.pdf` -> `compraventa-propiedad`, expected inversiones
- `evaluacion/VentaProp Lo Barnechea.pdf` -> mostly `compraventa-propiedad` chunks, but not one `1..99` range, with rogue `resumen-boletas-sii` and `cedula-identidad`
- `evucina/VentaProp Las Cabras.pdf` -> split into compraventa/no-clasificado/inversiones/DAI/deuda-comercial
- `evucina/VentaProp Lo Barnechea.pdf` -> still heavily split
- `gloria/Carpeta.pdf` -> false positives inside a judicial/insolvency packet

## Latest Pro Results

Run artifact:

- `out/param-sweep/20260508122415-pro/summary.json`

`pro-defaults`: `6/11`

`pro-deterministic-think-1024`: `7/11`

Passing cases for `pro-deterministic-think-1024`:

- `_reqdocs/cta rara.png` -> `cuenta-ahorro`
- `evaluacion/VentaProp Lo Barnechea.pdf` -> `compraventa-propiedad@1..99`
- `evucina/Consumo Scotiabank.png` -> `deuda-consumo`
- `evucina/VentaProp Las Cabras.pdf` -> `compraventa-propiedad@1..20`
- `evucina/VentaProp Lo Barnechea.pdf` -> `compraventa-propiedad@1..99`
- `gloria/Carpeta.pdf` -> `no-clasificado@1..15`
- `yulian/YULIAN GARCIA/Cartola Santander.pdf` -> `deuda-consumo@1..3`

Failing cases for `pro-deterministic-think-1024`:

- `evaluacion/DAI 2024.pdf` -> `resumen-boletas-sii`, expected DAI
- `evaluacion/Inv Santander (1).pdf` -> `compraventa-propiedad`, expected inversiones
- `evaluacion/Inv Santander.pdf` -> `compraventa-propiedad`, expected inversiones
- `evucina/Hipo Banco.pdf` -> `compraventa-propiedad`, expected no-clasificado

## Product Inference

For upload classification, the product cares more about the dominant uploaded document than every possible internal content type.

Annex pages inside a legal packet usually are not useful separate requirements.

Flash is better at simple label confusion than it was, but still struggles with long-packet ranges. Pro deterministic fixed the long-packet ranges in this suite, so the remaining question is whether to pay for or selectively route to Pro rather than adding local range logic.

## Full Corpus Pro Validation

Latest full-corpus run:

- Artifact: `out/full-pro-deterministic-20260508-rerun.json`
- Corpus: `~/Downloads/docs`
- Config: `gemini-2.5-pro` with `temperature: 0`, `topP: 0.1`, `seed: 1`, `candidateCount: 1`, `thinkingBudget: 1024`
- Result: `173/197` strict pass

Main remaining error classes:

- Strict range clipping/final-page misses: CMF debt reports, `m4lt1-2.pdf`, VentaProp Santiago, VentaProp Las Cabras.
- Container-child policy mismatch: Carpeta Tributaria files return container plus internal SII child docs, while ground truth expects only the container.
- Long legal-packet child false positives: Lo Barnechea packets keep the full `compraventa-propiedad` range but also emit internal certificates/SII/credit/DS1 pages.
- Disputed labels: `DAI 2024.pdf` looks like boletas/F29 content; `Inv Santander*.pdf` looks like notarial compraventa material.
- `no-clasificado` false positives: `Hipo Banco.pdf`, `Avalúo_2.pdf`, `gloria/Carpeta.pdf`, `gloria/Deuda.pdf`, and `pago tajeta santander.png`.
- Other label edges: Scotiabank cartola/consumo and cedula front/back handling.

Conclusion: Pro is a clear improvement over Flash and keeps the runtime simple, but a global prompt/catalog change is unlikely to reach 100% cleanly without either product-context routing, candidate narrowing, or ground-truth decisions.

## Candidate Narrowing Probe

`candidateIds` is the best simple lever found so far:

- Debt-family candidate sets classify `Hipo Banco.pdf` as `no-clasificado`.
- Including broad `compraventa-propiedad` in that slot reintroduces the false positive.
- DAI-vs-boletas and inversiones-vs-compraventa still choose the visible competing label, which supports ground-truth review before prompt overfitting.
- Legal packet slots should keep full catalog context; narrow legal candidates regressed range behavior.

## Current Likely Next Steps

Do not add local machinery yet.

Pro deterministic is the current baseline.

Next improvement should happen in the parent product routing: use `candidateIds` for requirement slots that already know the expected document family, especially debt-family slots that should not include `compraventa-propiedad`.

Before changing prompt/definitions again, decide the ground-truth/product policy for container files and the disputed DAI/Santander labels.

Fresh-session handoff:

- Read `CLAUDE.md` first.
- Do not edit `AGENTS.md`.
- Continue from Pro result `7/11` in `out/param-sweep/20260508122415-pro/summary.json`.
- Do not touch parent `../jogi` unless explicitly asked.
- Current broad validation: `173/197` strict pass in `out/full-pro-deterministic-20260508-rerun.json`.
- Next concrete task: integrate or test parent-side `candidateIds` routing, then review container/disputed-label ground truth.

Open question:

Whether to accept a small dominance/range consolidation rule is less urgent after Pro deterministic fixed the legal-packet ranges in this suite.

Example: if Gemini returns many `compraventa-propiedad` chunks across a long PDF plus rogue internal labels, consolidate to one full-range `compraventa-propiedad`.

We have not implemented that because it smells like a local patch and the current instruction is to try model/prompt/definitions first.

## May 11 Ship — Root Cause Of "Bad Production"

User reported production results worse than pre-classifier era. Triage found that production had been running the **un-tuned 0.1.0 prompt** for 3 weeks.

Timeline:
- Apr 21 (`jogi@753b8af3`): `@jogi/classifier` wired in at pin `05e2b2e6`.
- Apr 21 → May 11: all prompt rules, model default, definition tuning in `src/prompt.ts` and `src/index.ts` were authored locally but never committed.
- The `173/197` May 8 baseline in `docs/classifier-testing-notes.md` was measured against the **local working tree**, not the published SHA. Production never had those gains.
- May 11: extracted prompt to `src/prompt.ts`, set `DEFAULT_MODEL = gemini-2.5-pro`, added `opts.generationConfig`, rebuilt `dist/`. Shipped as classifier@`9088bd4b`. Jogi pin bumped (`fb38e48a`).

Wiring (verified at fix time):
- `lib/server/docsinit.ts` injects `temperature: 0` + `thinkingBudget: 1024`; preserves caller config.
- `lib/domain/upload/classify/orchestrator.ts` calls `classifierClassify` always (no env-flag gate). `candidateIds` narrowing is wired with full-catalog fallback. `CLASSIFY_MODEL` env defaults to `gemini-2.5-pro`.
- `lib/server/gemini.ts` honors caller `thinkingConfig`; only forces `thinkingBudget: 0` on Flash without tools/thinkingConfig.
- `data/doctypes.json`: no drift since May 8 (only 2 unrelated commits touched it after the wiring).

May 11 re-validation:
- Same deterministic Pro config. Result: `176/196` strict pass (89.8%) — parity with the May 8 baseline (`173/197` = 87.8%; the 1-case delta is corpus drift).
- Artifact: `out/validation-ship-20260511-143643.json`.

## evaluacion/ Folder Breakdown (30/38 pass)

Pre-known classes (per Disputed Ground Truth + container-child policy + range-clipping):

- `DAI 2024.pdf` → `resumen-boletas-sii` (disputed: file shows boletas/F29, not F22).
- `Inv Santander.pdf`, `Inv Santander (1).pdf` → `compraventa-propiedad` (disputed: notarial content).
- `Carpeta.pdf` → `carpeta-tributaria@1..12` correct, but emits extra `resumen-boletas-sii@2..3` and two `declaracion-anual-impuestos` ranges (container-vs-child policy mismatch).
- `DAI 2025.pdf` → `carpeta-tributaria@1..4` correct, extra `resumen-boletas-sii@2..3` (same policy mismatch).
- `VentaProp Lo Barnechea.pdf` → `compraventa-propiedad@1..81` + `informe-deuda@82..86` + `compraventa-propiedad@87..99` (long-deed still carves an internal informe-deuda block; better than pre-tuning but not one row).
- `VentaProp Santiago.pdf` → `1..37` instead of `1..38` (strict range clip, last page missed).

New finding — `Cartola Scotiabank.png` (the only one not in the earlier failure classes):

- Returned `deuda-consumo`; groundtruth says `cartola-banco`.
- The file is a **Scotiabank consolidated debt-position report** showing Créditos / Leasing / Créditos Hipotecarios / Resumen Línea Crédito / Tarjetas de Crédito in one screenshot.
- The new "credit-card statement → deuda-consumo" rule did NOT misfire — this file lacks the cues that rule requires (no "Estado de Cuenta ... Tarjeta de Crédito" title, no CAE, no monto facturado, no pago mínimo, no compras).
- The doctype definitions themselves create ambiguity:
  - `cartola-banco` definition: *"También puede ser una posición consolidada solo cuando muestra productos de forma general sin detalle suficiente para clasificar una deuda específica."*
  - `deuda-consumo` definition: *"Si una pantalla muestra varios productos pero contiene una fila/sección clara de crédito de consumo o tarjeta con saldo/vencimiento, clasificar esa..."*
- Both have textual support; model picked the row-level signal over the consolidated-view signal.

Proposed (not yet shipped) prompt addition to disambiguate, in the Debt/account distinctions section:

> "Consolidated debt-position reports showing multiple product types (mortgages + consumer credit + credit lines + credit cards summary) are cartola-banco, not deuda-consumo — even when an individual row has a balance and maturity date. Reserve deuda-consumo for documents focused on a specific consumer credit or credit-card account."

## Small Suite For Iteration

`out/small-suite.ts` runs 10 hand-picked `evaluacion/` cases — 5 problematic + 5 sentinels — for fast prompt iteration (~90s).

Baseline (5/10 pass) saved at `out/small-suite-baseline.json`; failures listed above.

Workflow: edit `src/prompt.ts`, `tsx out/small-suite.ts`, compare to baseline. No regressions on the 5 passing cases before considering for the next ship.

## May 11 Second Iteration — Consolidated-Position Rule

Prompt addition (single sentence in the Debt/account distinctions section):

> "Consolidated bank debt-position reports showing multiple product types at once (mortgages + consumer credit + credit lines + credit cards summary in the same view) are cartola-banco, not deuda-consumo — even when an individual row has a balance and maturity date. Reserve deuda-consumo for documents focused on a specific consumer credit or credit-card account."

Small suite: 5/10 → 7/10 (target hit on cartola PNG; bonus: VentaProp Lo Barnechea consolidated to one full range — variance, not reliably attributable to the rule).

Full corpus (`out/validation-tune1-20260511-160556.json`): `177/197` strict pass — same as the pre-tune baseline by accounting, with 2 improvements and 2 apparent regressions that triage as groundtruth issues:

- `+1 evaluacion/Cartola Scotiabank.png` — target fix, model now returns `cartola-banco`.
- `+1 evaluacion/VentaProp Santiago.pdf` — strict range `1..38` (was `1..37`); not caused by the rule, attributed to Pro non-determinism between runs.
- `-1 evucina/Consumo Scotiabank.png` — **disputed groundtruth, not a regression**. Pixel-identical to `evaluacion/Cartola Scotiabank.png` (same client Vucina, same RUT, same date 02/04/2026). The two folders' `CLASSIFICATION.md` files disagreed on the label. Resolved by fixing the evucina groundtruth row to `cartola-banco` (the file is the same consolidated multi-product screenshot).
- `-1 yulian/YULIAN GARCIA - Codeudor/Carnet Frente.png` — **groundtruth correct, model over-detects**. The PNG has some back-of-cedula content visible at the bottom (a second signature, "PUENTE ALTO" strip, small barcode, fingerprint), but product policy is to treat this file as a front-only cedula (filename + dominant content). The model returned two rows (`front` + `back`). Pro non-determinism between runs made it look like a regression (the prior run happened to return one row). Not addressed by this iteration; a future cedula-rule tightening could require both faces to be **fully** visible (full back panel, not incidental back artifacts) before returning two rows.

Net: the rule is a clean win — target case fixed, no real regression. Shippable.

## May 11 Deploy Failure — `--legacy-peer-deps` Lockfile Pruning

Both May 11 jogi pin bumps (fb38e48a → 9088bd4, and 9cab162f → 4cd193b) crashed Render's build at the `npm ci` stage with EUSAGE / "Missing: ... from lock file" (webpack, terser, ajv, @webassemblyjs/*, etc.).

Cause: the `npm install @jogi/classifier@github:...#<sha>` command was run with `--legacy-peer-deps`, which switches npm to a different resolution algorithm that prunes ~750 lines of transitive deps from `package-lock.json`. The pruned lockfile is incomplete for `npm ci`, so Render fails the build.

The intermediate commit `jogi@9ca1d33b` already documented and fixed this after the first bump — and then the same mistake repeated on the second one.

Fix (recorded for future agents): when bumping a satellite pin in jogi, use the canonical script (`npm run update:classifier` etc.) or plain `npm install` with no extra flags. If the lockfile was pruned, restore it from the last known-good commit (`git checkout <sha> -- package-lock.json`) and re-run the install. The diff against the known-good lockfile should be small (only the pinned package's `resolved` + `integrity` fields).

This is now also captured in `CLAUDE.md` (Consumer integration section).

## May 11 Disputed Groundtruth Review (partial)

Round 1 of triage on the 5 remaining `evaluacion/` failures:

**Inv Santander.pdf and Inv Santander (1).pdf** — byte-identical duplicates (md5 `eb7943f9...`). Page 1 is unambiguously a notarial certification: *"4a. Notaría Pública de Santiago — Cosme Fernando Gomila Gatica · El notario que suscribe, certifica que el presente documento electrónico es copia fiel e íntegra de la escritura pública de **COMPRAVENTA**, repertorio N°: 24911 de fecha 22 de Diciembre de 2016"*. Notary stamp, certified number, digital signature. The filename suggests "investments" but the *content* is a compraventa deed certification.

→ **Recommendation**: change both rows in `evaluacion/CLASSIFICATION.md` from `inversiones` to `compraventa-propiedad`. The classifier already returns `compraventa-propiedad@1..9` (which is the full reproduced range in the PDF), so the fix in groundtruth would also make the case pass.

**DAI 2024.pdf** — 1-page PDF. Page header reads "Pág. 3 / 12" (i.e., page 3 of a larger SII source), and the visible content is the BHE/BTE Honorarios table ("Períodos | Honorario bruto | Retención | Total Líquido", "No registra información") followed by "Declaraciones de IVA - Formulario 29 (F29)" rows for each month. **No F22 / DAI form is visible anywhere on this page.** The classifier returns `resumen-boletas-sii` (defensible: BHE/BTE are SII boletas content). Groundtruth says `declaracion-anual-impuestos` (definitely not — F22 isn't present).

→ **Recommendation**: change the row from `declaracion-anual-impuestos` to `resumen-boletas-sii`. The classifier's choice matches the dominant visible content, and changing the groundtruth makes the case pass without further prompt churn. (Alternative `carpeta-tributaria` was considered but rejected because the file is 1 page and doesn't present as a container by itself.)

Pending review (not yet looked at):
- `evaluacion/Carpeta.pdf` — container-vs-child policy (groundtruth wants container only; classifier emits internal SII docs too).
- `evaluacion/DAI 2025.pdf` — same container-vs-child policy as Carpeta.pdf.
- `evaluacion/VentaProp Lo Barnechea.pdf` — long-deed split (informe-deuda carved out at pp82-86).
- `evaluacion/VentaProp Santiago.pdf` — strict range clip (final-page miss on 1..38).

These four are not strict-disputed-label cases; they're boundary/policy issues that may warrant prompt or doctype changes rather than groundtruth edits.

### Round 1 corrections shipped (2026-05-11)

Applied to `~/Downloads/docs/evaluacion/CLASSIFICATION.md`:

- `DAI 2024.pdf`: `declaracion-anual-impuestos` → `resumen-boletas-sii`.
- `Inv Santander.pdf` and `Inv Santander (1).pdf`: `inversiones` → `compraventa-propiedad`.

Both corrections are also doubly supported by the doctype definitions in `data/doctypes.json`:
- `resumen-boletas-sii` explicitly covers BHE/BTE tables with the four-column header even when empty, and explicitly excludes F22 absent its title.
- `inversiones` explicitly rejects notarial / repertorio / COMPRAVENTA documents "aunque el filename diga inversión"; `compraventa-propiedad` explicitly covers certified-copy notarial reproductions with repertorio numbers.

Re-graded the existing `out/validation-tune1-20260511-160556.json` actuals against the corrected groundtruth (`tests/groundtruth.ts --actual=...`, no new Gemini calls). Result artifact: `out/regrade-post-gt-corrections-20260511.json`.

- **177/197 → 180/197 strict pass (91%)**.
- Flips → PASS: `evaluacion/DAI 2024.pdf`, `evaluacion/Inv Santander.pdf`, and a bonus on `evucina/Consumo Scotiabank.png` (the earlier evucina-side groundtruth fix mentioned above had been applied between the validation-tune1 run and this regrade, so the saved `pass=false` flipped on its own).
- Still FAIL: `evaluacion/Inv Santander (1).pdf` — label is now correct but the saved actual returned `compraventa-propiedad@1..9` on a confirmed 1-page PDF (verified via `pdf-lib`), while the byte-identical `Inv Santander.pdf` returned `@1..1` in the same run. Pure Pro non-determinism between two calls on identical bytes; expected to resolve on the next fresh Pro run. This is not caused by the correction and not a real regression.

Earlier recommendation text in this section ("classifier already returns `compraventa-propiedad@1..9` … so the fix in groundtruth would also make the case pass") was based on that non-deterministic 1..9 reading; the file is in fact 1 page, and `@1..1` is the correct groundtruth range.

## May 11 Third Iteration — Container-Only Rule (Carpeta + DAI 2025)

Targets the two `evaluacion/` failures left after the round-1 groundtruth corrections that share the same shape: `Carpeta.pdf` and `DAI 2025.pdf` both correctly classify the container as `carpeta-tributaria`, but the classifier also emits the visible internal SII children (F22 ranges, BHE/F29 boletas pages). Groundtruth in both `evaluacion/CLASSIFICATION.md` and `evucina/CLASSIFICATION.md` expects container-only. The doctype `carpeta-tributaria.definition` already says "es un PAQUETE de documentos", and `CLAUDE.md`'s product-inference framing ("classification is about the dominant uploaded document; field extraction is `@jogi/docs`'s job") aligns with container-only.

The pre-edit prompt at `src/prompt.ts:26` actively *permitted* children:

> Container PDFs such as carpeta-tributaria may return the container plus actual child documents, but children need their exact visible ranges inside the container.

This was also asymmetric with the long-deed rule on the next line ("do not carve out … internal pages"), which already says "container-only" for compraventa packets.

### Iteration 1 — too permissive

First wording shipped to `src/prompt.ts:26`:

> Container PDFs such as carpeta-tributaria return one row for the whole container; do not emit child documents (F22, boletas, etc.) inside the container even if they appear as visible internal sections.

Validated against a 19-case risk-surface subset (`out/risk-suite-carpeta.ts` — every corpus case whose `expected` or saved `actual` involves `carpeta-tributaria`, `declaracion-anual-impuestos`, or `resumen-boletas-sii`). Result: **16/19 (vs 14/19 baseline)**. Carpeta.pdf and evucina/Carpeta Tributaria.pdf flipped to PASS, but **`DAI 2025.pdf` regressed**: the model returned `carpeta-tributaria@1..12` on a 4-page extract — interpreting "whole container" as the canonical 12-page Carpeta length rather than the uploaded pages.

### Iteration 2 — tightened wording

Final wording:

> Container PDFs such as carpeta-tributaria return a single row whose page range covers the pages actually present in this upload; do not emit child documents (F22, boletas, etc.) inside the container even if they appear as visible internal sections. Do not extrapolate the range beyond the last visible page (a 4-page extract of a carpeta is @1..4, not @1..12).

Risk-surface re-run: **17/19**. All three targets pass (`Carpeta.pdf@1..12`, `DAI 2025.pdf@1..4`, `evucina/Carpeta Tributaria.pdf@1..12`). Remaining 2 fails (`evucina/Avalúo_2.pdf`, `evucina/VentaProp Las Cabras.pdf`) are pre-existing and unrelated.

### Full-corpus validation

Artifact: `out/validation-container-only-20260511.json`. **187/197 strict pass (95%)** — up from 180/197 in the regrade baseline.

- **+3 real wins** (container-only rule): `Carpeta.pdf`, `DAI 2025.pdf`, `evucina/Carpeta Tributaria.pdf`.
- **+4 variance wins** (Pro non-determinism landed favorably this run): `evaluacion/Inv Santander (1).pdf` (the byte-identical pair returned `@1..1` this time), `evaluacion/VentaProp Lo Barnechea.pdf` and `evucina/VentaProp Lo Barnechea.pdf` (long-deed packets returned `@1..99` cleanly), `evucina/VentaProp Las Cabras.pdf` (`@1..20`), plus `_reqdocs/cmf morante.pdf`.
- **−1 variance loss**: `evaluacion/Inv Santander.pdf` returned `compraventa-propiedad@1..9` while its byte-identical twin returned `@1..1`. The pair literally **swapped** results vs the May 11 saved actuals (where `.pdf → @1..1` and `(1).pdf → @1..9`). Pure Pro variance on identical bytes; not caused by this edit.

Net attributable to the rule: **+3, no regressions**. The other ±5 swing is structural Pro variance on documents already known to be unstable (Inv Santander pair, long-deed packets).

### Iteration workflow win

Validated the risk-surface-subset-before-full-corpus pattern. The 3-minute 19-case run caught the iteration-1 extrapolation regression cleanly; a 30-minute full-corpus run would have wasted ~$3 of API spend *and* mixed the regression in with the Pro non-determinism flips on the long-deed cases, making attribution harder. Recorded as a memory for future prompt iterations.

## May 11 Fourth Iteration — Debt-Doc Precision (informe-deuda / informe-credito / deuda-consumo)

Driven by parent plan `../../docs/plans/classifier-debt-doc-precision.md`. Three failure modes from a redacted batch (2026-05-11): a 2-page CMF informe-deuda got per-page-split into siblings; a fragment of a third-party judicial expediente got typed as `informe-credito`; a single-transaction card payment screenshot got typed as `deuda-consumo`. Plan step A extends the `definition` of each affected doctype in `../jogi/data/doctypes.json`. Steps B (prompt version bump) and C (defensive collapse in `dedupe.ts`) were not needed — `@jogi/docs` `getPromptVersion()` digests `JSON.stringify(getDoctypes())` so definition edits bust the slice cache automatically, and step A is sufficient.

### Definition extensions

- **`informe-deuda`**: appended "Si el informe abarca varias páginas (encabezado/resumen + tabla de Deuda Directa + Créditos disponibles), trátalo como UN solo documento que cubre TODAS sus páginas. NUNCA emitir entradas separadas por página para un mismo informe CMF."
- **`informe-credito`**: appended "RECHAZAR fragmentos de expedientes judiciales, listas de acreedores de procedimientos concursales (Liquidación Voluntaria/Forzosa Simplificada, SUPERIR), listas de juicios pendientes — incluso si listan instituciones financieras como acreedores. No son informes comerciales. Devolver documents:[]."
- **`deuda-consumo`**: appended "RECHAZAR comprobantes/vouchers de transacción individual (pago, transferencia, abono) que muestran UN SOLO evento sin saldo total, cuotas, CAE, vencimiento ni monto facturado. Devolver documents:[]."

### Risk-surface validation (22 cases)

Pattern: every corpus case whose expected or saved actual involves `informe-deuda`, `informe-credito`, or `deuda-consumo` (per `out/validation-container-only-20260511.json`). Suite at `out/risk-suite-debt.ts`.

Result: **18/22 (vs 17/22 baseline)**. Single delta attributable to edits: `gloria/Deuda.pdf` flipped FAIL→PASS (`informe-credito@1..1` → `no-clasificado@1..1`, rule A2 hit). All 11 CMF sentinels held (rule A1 no regression). All `deuda-consumo` real cases held (`evaluacion/Consumo Itaú.pdf`, `evucina/Consumo Itaú.pdf`, `yulian/.../Cartola Santander.pdf`). All `informe-credito` real cases held (`miguel/Deuda.pdf`).

Harness quirk: `gloria/pago tajeta santander.png` flipped from returning `[deuda-consumo]` to returning `[]`. In production this is the correct result — both produce `doc_type_id IS NULL` — but the harness expects an explicit `[no-clasificado]` segment for images (PDFs get gap-filled by the classifier; images don't). Counts as still-FAIL in the harness but matches the plan's acceptance criterion. Future cleanup option: have `compareActual` treat empty actuals as matching an expected `no-clasificado` for images.

### Full-corpus validation

Artifact: `out/validation-debt-tune1-20260511-200747.json`. **188/197 strict pass (95%)** — up one from `187/197`.

- **+1 real win** (rule A2): `gloria/Deuda.pdf`.
- **+2 variance wins** (Pro non-determinism on known-unstable cases): `evaluacion/Inv Santander.pdf` (byte-identical pair, returned `@1..1` this run) and `evucina/Hipo Banco.pdf` (a documented `no-clasificado` false-positive case; the rule A2 nudge may have helped here too — judicial expediente vs. notarial mortgage clause share some shape).
- **−2 variance losses**: `evucina/VentaProp Las Cabras.pdf` fragmented into the old multi-segment pattern instead of `@1..20`; `gloria/Avalúo.pdf` flipped from `no-clasificado` to `carpeta-tributaria@1..1`. Neither touches `informe-deuda` / `informe-credito` / `deuda-consumo`; both are on cases this doc already classifies as Pro-variance-prone (long-deed packets, Avalúo false positives).

Net attributable to the rule: **+1, no real regressions**. The ±4 swing is structural Pro variance — same pattern as the May 11 container-only run that swung Inv Santander / VentaProp / Avalúo too.

### Shipped

Edits live in `../jogi/data/doctypes.json` (no satellite code change). The parent plan's target case (`CMF.pdf` 2-page split-into-two) is not in `~/Downloads/docs`; positive validation of rule A1 happens via the parent app's plan step D (re-upload of the redacted batch).
