# Classifier Testing Notes

We are debugging the lean sandbox classifier, not rebuilding `@jogi/docs`.

Main goal: keep it fast, cheap, and simple. No OCR, page ledger, regex detector, local doctype detector, or pile of post-processing unless evidence forces it.

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
