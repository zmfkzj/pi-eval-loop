# ctrl-confirm-2 analysis (preregistered)

Units: 1116 of 1116 scheduled (4 arms x 93 tasks x 3); complete: true.

**Primary (OCR - OC, legacy-valid): INCONCLUSIVE** — at least one co-primary endpoint did not reach its preregistered bound (absence of evidence, not evidence of no effect). Adoption status: **KEEP_STABLE** — primary INCONCLUSIVE.

## Arms

| arm | legacy-valid units | E1 rate | E2 reliable tasks | 0/r tasks | strict-valid units | strict E2 | functional units | legacy fail | strict fail (strict-only) | leak | critical | infra | requests | wall h |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OC | 73/279 | 26.2 | 18/93 | 63 | 25 | 3 | 75 | 8 | 125 (117) | 0 | 1 | 0 | 8578 | 16.6 |
| OCR | 84/279 | 30.1 | 22/93 | 61 | 70 | 14 | 86 | 3 | 33 (30) | 0 | 0 | 0 | 8219 | 16.2 |
| PC | 79/279 | 28.3 | 20/93 | 58 | 69 | 15 | 82 | 4 | 21 (17) | 0 | 0 | 0 | 2738 | 5.0 |
| PCR | 75/279 | 26.9 | 20/93 | 63 | 73 | 20 | 77 | 2 | 7 (5) | 1 | 2 | 0 | 2697 | 5.0 |

## Contrasts (pt; family-cluster bootstrap 95% CI; sign-flip p one-sided / two-sided)

| contrast | scoring | E1 rate | p1 / p2 | E2 reliable | p1 / p2 | tasks +/- (E1) |
|---|---|---|---|---|---|---|
| OCR-OC (primary) | legacy | +3.9 [+0.4, +7.8] | 0.0341 / 0.0713 | +4.3 [+1.0, +9.0] | 0.0650 / 0.1308 | 8/4 |
| OCR-OC (primary) | strict | +16.1 [+9.5, +23.6] | 0.0000 / 0.0000 | +11.8 [+5.9, +18.7] | 0.0010 / 0.0014 | 24/1 |
| OCR-OC (primary) | functional | +3.9 [+0.4, +8.0] | 0.0401 / 0.0767 | +4.3 [+1.0, +8.8] | 0.0616 / 0.1261 | 7/3 |
| OCR-PCR | legacy | +3.2 [-0.7, +7.5] | 0.0903 / 0.1790 | +2.2 [-3.1, +7.4] | 0.3397 / 0.6806 | 11/6 |
| OCR-PCR | strict | -1.1 [-5.3, +3.0] | 0.7414 / 0.7489 | -6.5 [-12.5, -1.1] | 0.9962 / 0.0683 | 8/12 |
| OCR-PCR | functional | +3.2 [-0.4, +7.3] | 0.0852 / 0.1661 | +3.2 [-1.1, +8.2] | 0.1835 / 0.3734 | 10/5 |
| PCR-PC | legacy | -1.4 [-5.3, +1.9] | 0.8212 / 0.5829 | +0.0 [-5.3, +5.2] | 0.6524 / 1.0000 | 7/9 |
| PCR-PC | strict | +1.4 [-3.6, +6.5] | 0.3398 / 0.6824 | +5.4 [-1.1, +12.6] | 0.1150 / 0.2308 | 12/9 |
| PCR-PC | functional | -1.8 [-5.7, +1.6] | 0.8665 / 0.4545 | +0.0 [-5.3, +5.2] | 0.6532 / 1.0000 | 6/9 |
| OC-PC | legacy | -2.2 [-6.7, +2.2] | 0.8550 / 0.4521 | -2.2 [-8.2, +3.8] | 0.8559 / 0.7275 | 9/13 |
| OC-PC | strict | -15.8 [-24.5, -8.0] | 1.0000 / 0.0001 | -12.9 [-21.1, -5.7] | 1.0000 / 0.0017 | 3/27 |
| OC-PC | functional | -2.5 [-6.7, +1.7] | 0.9028 / 0.3349 | -1.1 [-6.6, +4.4] | 0.7695 / 1.0000 | 8/12 |

Holm (secondary, legacy, 6 tests): OCR-PCR:E1 1.0000; OC-PC:E1 1.0000; PCR-PC:E1 1.0000; OCR-PCR:E2 1.0000; OC-PC:E2 1.0000; PCR-PC:E2 1.0000. Interaction (OCR-OC)-(PCR-PC) on E1: +5.4 pt (descriptive).
Sensitivity without infra-only units (0 excluded): OCR-OC E1 +3.9 [+0.6, +7.7], E2 +4.3 [+1.0, +8.9].

## Families (legacy-valid units / units); regressions OCR < OC: gh:ahmtsahin/agent-context-bench, gh:codyrobertson/gh-issue-lease

| family | tasks | OC | OCR | PC | PCR |
|---|---|---|---|---|---|
| gh:ahmtsahin/agent-context-bench | 3 | 1/9 | 0/9 | 0/9 | 0/9 |
| gh:alannerfranklin/dsh-relay-isolation | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:antonioprosperi2-svg/beeladybug-universal | 3 | 0/9 | 0/9 | 0/9 | 0/9 |
| gh:avoidwork/filesize.js | 3 | 3/9 | 6/9 | 4/9 | 3/9 |
| gh:avoidwork/tiny-lru | 2 | 5/6 | 5/6 | 4/6 | 5/6 |
| gh:azu/setup-npm-trusted-publish | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:blakeb056/six-degrees | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:blucca/n8n-check | 3 | 0/9 | 0/9 | 0/9 | 0/9 |
| gh:cccalana/gatewaycheck | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:cheapestinference/claude-auto-retry | 3 | 3/9 | 3/9 | 2/9 | 3/9 |
| gh:codyrobertson/gh-issue-lease | 1 | 1/3 | 0/3 | 1/3 | 1/3 |
| gh:dgrr-studio/dice | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:dhaupin/crashtest | 3 | 3/9 | 3/9 | 3/9 | 3/9 |
| gh:dirop1/pi-delay-prompt | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:drewthomas00/tcpa-quiet-hours | 1 | 3/3 | 3/3 | 3/3 | 3/3 |
| gh:ducaoya/pi-hang-guard | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:evomap/gep-sdk-js | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:fugangcui/speakremix-codes | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:ghostpawjs/grimoire | 3 | 4/9 | 5/9 | 4/9 | 6/9 |
| gh:groophylifefor/heap-analysis | 3 | 0/9 | 0/9 | 0/9 | 0/9 |
| gh:guorunjie/agentic-workflow-guard | 3 | 0/9 | 0/9 | 0/9 | 0/9 |
| gh:guotree/magpie-websearch | 3 | 0/9 | 0/9 | 0/9 | 0/9 |
| gh:igormel81/dsh-chat-cost | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:insession-space/insession-sdk | 3 | 6/9 | 8/9 | 8/9 | 5/9 |
| gh:johnhenry/mport | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:johnhenry/spintax | 1 | 3/3 | 3/3 | 3/3 | 3/3 |
| gh:kannakuron/dsh-ide-git | 3 | 0/9 | 0/9 | 0/9 | 0/9 |
| gh:l956615272-hub/dsh-token-usage | 3 | 0/9 | 0/9 | 2/9 | 2/9 |
| gh:legible-sh/mutex | 2 | 0/6 | 0/6 | 1/6 | 0/6 |
| gh:lhf198/dsh-prompt-optimizer | 2 | 2/6 | 2/6 | 0/6 | 1/6 |
| gh:lucastonidev/patrickuser | 1 | 3/3 | 3/3 | 3/3 | 3/3 |
| gh:magrinj/hermes-intl | 2 | 0/6 | 3/6 | 2/6 | 2/6 |
| gh:marko-js/htmljs-parser | 1 | 3/3 | 3/3 | 2/3 | 2/3 |
| gh:metarhia/metawatch | 2 | 2/6 | 2/6 | 0/6 | 0/6 |
| gh:misterkante/cc-model-router | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:mr-mihu/dsh-dbhub-live | 2 | 2/6 | 2/6 | 1/6 | 1/6 |
| gh:mukundakatta/agentfit | 1 | 2/3 | 3/3 | 3/3 | 3/3 |
| gh:nodemailer/libqp | 1 | 3/3 | 3/3 | 3/3 | 3/3 |
| gh:opopeshku/cronalive-node | 1 | 3/3 | 3/3 | 3/3 | 3/3 |
| gh:otto-ottospace/mizan | 1 | 2/3 | 3/3 | 3/3 | 3/3 |
| gh:panpontomate/solana-risk-engine | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:runcat-tommy/dsh-panda-calendar | 2 | 0/6 | 0/6 | 0/6 | 0/6 |
| gh:sanchit07-dev/node-core-easy-kit | 3 | 0/9 | 0/9 | 0/9 | 0/9 |
| gh:sandsoftwaresolutions/ss-duration | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:sandsoftwaresolutions/ss-human-format | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:shelamkoff/event-bus | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:short-io/envalid-unused | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:shrinivas-sn/adapter-ingestion | 1 | 3/3 | 3/3 | 3/3 | 3/3 |
| gh:sindresorhus/clone-regexp | 1 | 3/3 | 3/3 | 3/3 | 2/3 |
| gh:spartawhy117/dsh-token-dash | 1 | 0/3 | 0/3 | 0/3 | 0/3 |
| gh:toolbuilder/list | 3 | 7/9 | 7/9 | 9/9 | 6/9 |
| gh:w8s/rng-with-intention | 1 | 3/3 | 3/3 | 3/3 | 3/3 |
| gh:wenaixi/dsh-prompt-history | 3 | 0/9 | 2/9 | 3/9 | 3/9 |
| gh:yammm/ynode-ylog | 1 | 3/3 | 3/3 | 3/3 | 3/3 |

## Per task legacy-valid outcomes (repeat order)

| task | OC | OCR | PC | PCR |
|---|---|---|---|---|
| x-ahmtsahin-agent-context-bench-134ba49b33 | 001 | 000 | 000 | 000 |
| x-ahmtsahin-agent-context-bench-3912f5ad87 | 000 | 000 | 000 | 000 |
| x-ahmtsahin-agent-context-bench-b63c4acd3d | 000 | 000 | 000 | 000 |
| x-alannerfranklin-dsh-relay-isolation-dfccc5d2c1 | 000 | 000 | 000 | 000 |
| x-antonioprosperi2-svg-beeladybug-universal-5f88e1d66c | 000 | 000 | 000 | 000 |
| x-antonioprosperi2-svg-beeladybug-universal-a89811cf4e | 000 | 000 | 000 | 000 |
| x-antonioprosperi2-svg-beeladybug-universal-b6e1d19aa0 | 000 | 000 | 000 | 000 |
| x-avoidwork-filesize-js-109ae605ab | 000 | 011 | 010 | 000 |
| x-avoidwork-filesize-js-64b4a2611f | 000 | 111 | 101 | 111 |
| x-avoidwork-filesize-js-f5bd84b81b | 111 | 100 | 100 | 000 |
| x-avoidwork-tiny-lru-30397d7a76 | 110 | 101 | 001 | 011 |
| x-avoidwork-tiny-lru-da90b42c31 | 111 | 111 | 111 | 111 |
| x-azu-setup-npm-trusted-publish-6104f8bee9 | 000 | 000 | 000 | 000 |
| x-blakeb056-six-degrees-aec5ecaebb | 000 | 000 | 000 | 000 |
| x-blucca-n8n-check-0d73b43caa | 000 | 000 | 000 | 000 |
| x-blucca-n8n-check-1c589621bf | 000 | 000 | 000 | 000 |
| x-blucca-n8n-check-a7fa85ded5 | 000 | 000 | 000 | 000 |
| x-cccalana-gatewaycheck-2d961d088c | 000 | 000 | 000 | 000 |
| x-cheapestinference-claude-auto-retry-6d605a5d91 | 000 | 000 | 000 | 000 |
| x-cheapestinference-claude-auto-retry-7a1ddf10b2 | 111 | 111 | 101 | 111 |
| x-cheapestinference-claude-auto-retry-f859f12fea | 000 | 000 | 000 | 000 |
| x-codyrobertson-gh-issue-lease-f0f573c258 | 010 | 000 | 001 | 010 |
| x-dgrr-studio-dice-141a1a8d6b | 000 | 000 | 000 | 000 |
| x-dhaupin-crashtest-5c6ce1d53f | 000 | 000 | 000 | 000 |
| x-dhaupin-crashtest-e70988c5b4 | 000 | 000 | 000 | 000 |
| x-dhaupin-crashtest-eb4c5fee65 | 111 | 111 | 111 | 111 |
| x-dirop1-pi-delay-prompt-a7948a14a4 | 000 | 000 | 000 | 000 |
| x-drewthomas00-tcpa-quiet-hours-d929633b54 | 111 | 111 | 111 | 111 |
| x-ducaoya-pi-hang-guard-b75099e5bc | 000 | 000 | 000 | 000 |
| x-evomap-gep-sdk-js-6a387bbe32 | 000 | 000 | 000 | 000 |
| x-fugangcui-speakremix-codes-7bf8b8fb00 | 000 | 000 | 000 | 000 |
| x-ghostpawjs-grimoire-4a1c83b504 | 111 | 101 | 001 | 111 |
| x-ghostpawjs-grimoire-b7fc19a032 | 001 | 111 | 111 | 111 |
| x-ghostpawjs-grimoire-c5aa4b66a3 | 000 | 000 | 000 | 000 |
| x-groophylifefor-heap-analysis-10ddfecb6b | 000 | 000 | 000 | 000 |
| x-groophylifefor-heap-analysis-71cd48f8ba | 000 | 000 | 000 | 000 |
| x-groophylifefor-heap-analysis-bfc733de41 | 000 | 000 | 000 | 000 |
| x-guorunjie-agentic-workflow-guard-79f4aec3b8 | 000 | 000 | 000 | 000 |
| x-guorunjie-agentic-workflow-guard-bc30533f19 | 000 | 000 | 000 | 000 |
| x-guorunjie-agentic-workflow-guard-c1322204ff | 000 | 000 | 000 | 000 |
| x-guotree-magpie-websearch-466d493835 | 000 | 000 | 000 | 000 |
| x-guotree-magpie-websearch-a74cfdcbe9 | 000 | 000 | 000 | 000 |
| x-guotree-magpie-websearch-c4d8db57f9 | 000 | 000 | 000 | 000 |
| x-igormel81-dsh-chat-cost-8b37b31edf | 000 | 000 | 000 | 000 |
| x-insession-space-insession-sdk-29c8a3b74e | 111 | 111 | 111 | 111 |
| x-insession-space-insession-sdk-c721ee0c1d | 101 | 011 | 101 | 000 |
| x-insession-space-insession-sdk-f9057e96cd | 010 | 111 | 111 | 011 |
| x-johnhenry-mport-b70dabf4e7 | 000 | 000 | 000 | 000 |
| x-johnhenry-spintax-8e582b7cde | 111 | 111 | 111 | 111 |
| x-kannakuron-dsh-ide-git-09c63b85e5 | 000 | 000 | 000 | 000 |
| x-kannakuron-dsh-ide-git-317ae73aa6 | 000 | 000 | 000 | 000 |
| x-kannakuron-dsh-ide-git-3599010391 | 000 | 000 | 000 | 000 |
| x-l956615272-hub-dsh-token-usage-4fef2ea940 | 000 | 000 | 100 | 000 |
| x-l956615272-hub-dsh-token-usage-76b731dfd1 | 000 | 000 | 000 | 100 |
| x-l956615272-hub-dsh-token-usage-8c425815aa | 000 | 000 | 001 | 010 |
| x-legible-sh-mutex-13867857ca | 000 | 000 | 000 | 000 |
| x-legible-sh-mutex-3a0cb5dd56 | 000 | 000 | 010 | 000 |
| x-lhf198-dsh-prompt-optimizer-42cfbd7f35 | 000 | 000 | 000 | 000 |
| x-lhf198-dsh-prompt-optimizer-fe5772419b | 110 | 101 | 000 | 100 |
| x-lucastonidev-patrickuser-05e5089acf | 111 | 111 | 111 | 111 |
| x-magrinj-hermes-intl-22ec94ee24 | 000 | 111 | 100 | 000 |
| x-magrinj-hermes-intl-e1877c8147 | 000 | 000 | 010 | 110 |
| x-marko-js-htmljs-parser-a576b5c86e | 111 | 111 | 101 | 011 |
| x-metarhia-metawatch-af9528a554 | 000 | 000 | 000 | 000 |
| x-metarhia-metawatch-e1b278f5c3 | 011 | 011 | 000 | 000 |
| x-misterkante-cc-model-router-ced46f7612 | 000 | 000 | 000 | 000 |
| x-mr-mihu-dsh-dbhub-live-534032da27 | 110 | 011 | 010 | 010 |
| x-mr-mihu-dsh-dbhub-live-f9d568569b | 000 | 000 | 000 | 000 |
| x-mukundakatta-agentfit-510c32d490 | 101 | 111 | 111 | 111 |
| x-nodemailer-libqp-7bbdcbeac4 | 111 | 111 | 111 | 111 |
| x-opopeshku-cronalive-node-a6f621977e | 111 | 111 | 111 | 111 |
| x-otto-ottospace-mizan-f2f8fcb2c8 | 011 | 111 | 111 | 111 |
| x-panpontomate-solana-risk-engine-e2582ea728 | 000 | 000 | 000 | 000 |
| x-runcat-tommy-dsh-panda-calendar-667f1793e5 | 000 | 000 | 000 | 000 |
| x-runcat-tommy-dsh-panda-calendar-ec35ab2529 | 000 | 000 | 000 | 000 |
| x-sanchit07-dev-node-core-easy-kit-268de6812c | 000 | 000 | 000 | 000 |
| x-sanchit07-dev-node-core-easy-kit-39890fd99f | 000 | 000 | 000 | 000 |
| x-sanchit07-dev-node-core-easy-kit-70f95fc1b2 | 000 | 000 | 000 | 000 |
| x-sandsoftwaresolutions-ss-duration-ac6449101c | 000 | 000 | 000 | 000 |
| x-sandsoftwaresolutions-ss-human-format-ade5993e4f | 000 | 000 | 000 | 000 |
| x-shelamkoff-event-bus-cc858589eb | 000 | 000 | 000 | 000 |
| x-short-io-envalid-unused-f77a6c7072 | 000 | 000 | 000 | 000 |
| x-shrinivas-sn-adapter-ingestion-499701352b | 111 | 111 | 111 | 111 |
| x-sindresorhus-clone-regexp-0594242c88 | 111 | 111 | 111 | 101 |
| x-spartawhy117-dsh-token-dash-ba4082dce3 | 000 | 000 | 000 | 000 |
| x-toolbuilder-list-1914dfac5e | 111 | 111 | 111 | 111 |
| x-toolbuilder-list-2b73f7f42c | 010 | 010 | 111 | 000 |
| x-toolbuilder-list-bc22a50372 | 111 | 111 | 111 | 111 |
| x-w8s-rng-with-intention-d6d0f34e4c | 111 | 111 | 111 | 111 |
| x-wenaixi-dsh-prompt-history-396b4d7ce7 | 000 | 000 | 000 | 000 |
| x-wenaixi-dsh-prompt-history-87cd943992 | 000 | 011 | 111 | 111 |
| x-wenaixi-dsh-prompt-history-f2c2ad01c0 | 000 | 000 | 000 | 000 |
| x-yammm-ynode-ylog-d5c5c3f62e | 111 | 111 | 111 | 111 |
