# Readiness audit — 2026-09-15

Base: `aff0267`. At audit capture, the changes remained uncommitted and unpublished. Current candidate status is recorded in [the rc.10 release notes](../../release/v0.1.0-rc.10-release-notes.md).

## Result

The audited false-negative cases now pass. The audit also found and repaired
instruction loss and unsafe readiness for damaged recognized checkpoints.
Authenticated cross-model acceptance remains unverified. One host-eligibility
false positive remains below.

### Repairs

- Replay compatibility excludes model ID. It still checks surface, protocol,
  endpoint, deployment, and provider API identity. The checkpoint retains its
  producer model.
- Model changes can alter native serialization of reasoning and tool history.
  Replay first tries an exact stored witness. Translation must reproduce the
  complete producer scope, then match one unique current conversation segment.
- New checkpoints declare `replay.scope: "conversation"`. Replay preserves current
  developer/system instructions and tools. It maps conversation matches to their
  actual input positions.
- An absent scope retains legacy full-input proof. Replay preserves the proven
  legacy span without searching again for an ambiguous narrower witness.
- Invalid artifact hashes, lengths, and unknown scopes in recognized checkpoints
  block readiness and remote compaction. They no longer look like absent
  checkpoints. Valid native/local summaries remain usable.

Executable contracts live in `src/contract.mjs` and `src/controller.mjs`.
The current contract lives in `docs/current/README.md`.

## Property evidence

Run:

```sh
node --test test/readiness-properties.test.mjs
```

The final source audit passed 15 property strata and 3,204 generated cases.
The dedicated checkpoint family checked replay in 1,002 cases. No native setup
was excluded. The tests made 2,274 synthetic fetch calls.

Broad seeds: `0x5eedc0de`, `0x51cedbad`, `0xa11ce5ed`.
The test file records separate stratum seeds and fast-check shrinking settings.

| Dimension | Generated cases |
| --- | ---: |
| Changed prompt | 692 |
| Changed tools | 657 |
| Different model metadata | 1,113 |
| Reopen | 102 |
| Fork | 105 |
| Custom-entry fixture | 1,050 |
| Timeline-entry fixture | 1,107 |
| Partial turn | 1,098 |

These dimensions overlap. Custom-entry counts do not imply context-visible
custom-message coverage. The native integration case below tests that API.

The generator covers OpenAI, Codex, Azure, and unsupported routes. It varies
authentication, native preparation, kept history, model changes, tools, prompts,
repeated compaction, persistence, and branch shape. Separate negative strata
check replay hashes, duplicate witnesses, retained-source mutation, actual
payload mutation, artifact integrity, and unsupported scope. Frozen legacy v1
fixtures remain separate from the current writer.

Original instruction-loss failures used seeds `4369` and `13107`.
The repaired invalid-checkpoint failures use seeds `42330`, `42602`, and `42874`;
each minimized to path `0:0:0:0:0:0`. The legacy unique full-window witness also
passes when its narrower conversation sequence appears elsewhere.

## Native integration evidence

Run the local SDK matrix:

```sh
node scripts/check-readiness-integration.mjs --json
node --test test/readiness-integration.test.mjs
```

The matrix uses real Pi SessionManager, AgentSession, native preparation, native
serialization, and filesystem reopen. Its provider transport is synthetic.
The main sequence makes eight simulated requests. Two additional branch cases
bring the total to eleven.

- Initial, same-model, reopened, and changed-model paths preserve the checkpoint.
- Changed instructions and tools remain in the outgoing normal request.
- Compact requests retain source/checkpoint context under the provider schema.
  OpenAI/Azure compact bodies intentionally omit unsupported tool fields.
- An actual `appendCustomMessageEntry` case remains context-visible, reports
  ready, and reaches remote compaction with that context preserved.
- UI-only entries remain outside model input. A later user message still permits
  checkpoint replay and compaction.

The local peer SDK versions are coding-agent/pi-ai `0.83.0`.
An independent isolated run used installed coding-agent/pi-ai `0.85.1`: current
source and the harness were copied to a temporary directory, peers were linked
to the installed packages, and `runLocalAudit()` was called explicitly. All
12 main-sequence request checks passed with eight simulated requests. That run
preceded the two additional branch cases. It proves SDK lifecycle behavior;
it does not prove CLI/TUI behavior.

Synthetic nonce responses test request preservation. They do not prove that a
real provider consumed encrypted context.

## Remaining limits

### Native work selection

A checkpoint followed only by a UI entry produced:

```text
native preparation: ineligible
remote status:      ready
compact attempt:    none
```

This is an unfixed readiness false positive. It is outside the requested
should-allow-but-blocked class. The audit keeps this counterexample explicit.
Pi owns native work selection and `keepRecentTokens`. A blanket rejection of
all no-new-message tails could create false negatives after settings changes.
Exact native eligibility needs authoritative preparation/settings evidence.

### Authenticated provider evidence

Early Codex runs observed eight HTTP 400 responses at initial compaction.
The cause remains unresolved. No authenticated checkpoint consumption,
cross-model acceptance, or nonce recall was established.

Those runs did not fully control WebSocket transport. Eight HTTP observations
are not a verified total egress count. The audit cannot certify the original
12-call accounting. The audit stopped live calls after finding this gap.
The repaired canary enforces SSE, blocks WebSocket transport, and requires a
reliable cumulative budget. Unknown prior usage blocks execution.

This is bounded coverage. It does not establish universal model portability,
all multimodal histories, checkpoint lifetime, or provider success.

## Package verification

Final local verification passed 84 package tests, `npm run verify:package`,
`npm run pack:check`, and `git diff --check`. The integration tests include
unknown-budget refusal. No live calls ran during this final verification.
The independent verifier did not mark the strict readiness oracle achieved:
the UI-only-tail false positive remains.

Architecture impact: changed replay contract; topology unchanged.
