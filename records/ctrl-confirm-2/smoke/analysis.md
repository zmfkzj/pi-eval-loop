# ctrl-confirm-2 analysis (preregistered)

Units: 8 of 8 scheduled (4 arms x 2 tasks x 1); complete: true.

**Primary (OCR - OC, legacy-valid): INCONCLUSIVE** — at least one co-primary endpoint did not reach its preregistered bound (absence of evidence, not evidence of no effect). Adoption status: **KEEP_STABLE** — primary INCONCLUSIVE.

## Arms

| arm | legacy-valid units | E1 rate | E2 reliable tasks | 0/r tasks | strict-valid units | strict E2 | functional units | legacy fail | strict fail (strict-only) | leak | critical | infra | requests | wall h |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OC | 2/2 | 100.0 | 2/2 | 0 | 1 | 1 | 2 | 0 | 1 (1) | 0 | 0 | 0 | 27 | 0.0 |
| OCR | 2/2 | 100.0 | 2/2 | 0 | 2 | 2 | 2 | 0 | 0 (0) | 0 | 0 | 0 | 25 | 0.0 |
| PC | 2/2 | 100.0 | 2/2 | 0 | 2 | 2 | 2 | 0 | 0 (0) | 0 | 0 | 0 | 13 | 0.0 |
| PCR | 2/2 | 100.0 | 2/2 | 0 | 2 | 2 | 2 | 0 | 0 (0) | 0 | 0 | 0 | 14 | 0.0 |

## Contrasts (pt; family-cluster bootstrap 95% CI; sign-flip p one-sided / two-sided)

| contrast | scoring | E1 rate | p1 / p2 | E2 reliable | p1 / p2 | tasks +/- (E1) |
|---|---|---|---|---|---|---|
| OCR-OC (primary) | legacy | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| OCR-OC (primary) | strict | +50.0 [+0.0, +100.0] | 0.5026 / 1.0000 | +50.0 [+0.0, +100.0] | 0.5017 / 1.0000 | 1/0 |
| OCR-OC (primary) | functional | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| OCR-PCR | legacy | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| OCR-PCR | strict | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| OCR-PCR | functional | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| PCR-PC | legacy | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| PCR-PC | strict | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| PCR-PC | functional | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| OC-PC | legacy | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |
| OC-PC | strict | -50.0 [-100.0, +0.0] | 1.0000 / 1.0000 | -50.0 [-100.0, +0.0] | 1.0000 / 1.0000 | 0/1 |
| OC-PC | functional | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | +0.0 [+0.0, +0.0] | 1.0000 / 1.0000 | 0/0 |

Holm (secondary, legacy, 6 tests): OCR-PCR:E1 1.0000; OCR-PCR:E2 1.0000; PCR-PC:E1 1.0000; PCR-PC:E2 1.0000; OC-PC:E1 1.0000; OC-PC:E2 1.0000. Interaction (OCR-OC)-(PCR-PC) on E1: +0.0 pt (descriptive).
Sensitivity without infra-only units (0 excluded): OCR-OC E1 +0.0 [+0.0, +0.0], E2 +0.0 [+0.0, +0.0].

## Families (legacy-valid units / units); regressions OCR < OC: none

| family | tasks | OC | OCR | PC | PCR |
|---|---|---|---|---|---|
| pkg:ledger | 1 | 1/1 | 1/1 | 1/1 | 1/1 |
| pkg:logtool | 1 | 1/1 | 1/1 | 1/1 | 1/1 |

## Per task legacy-valid outcomes (repeat order)

| task | OC | OCR | PC | PCR |
|---|---|---|---|---|
| a6-typo-message | 1 | 1 | 1 | 1 |
| c4-malformed-lines | 1 | 1 | 1 | 1 |
