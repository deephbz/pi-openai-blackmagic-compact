# Pi OpenAI Blackmagic Compact — current state

As of: 2026-08-01

Stage: hardening.

Status: unreleased source after `0.1.0-rc.3`.

## Product boundary

Blackmagic provides server-side compaction in Pi. Its public interface has four parts:

- `/compact` starts compaction through Pi.
- `/blackmagic` reports status and help.
- The TUI confirms successful server-side compaction.
- The footer warns when the selected provider cannot use active Blackmagic History.

Blackmagic does not own thresholds, transport, handoffs, conversation storage, or provider setup. Pi remains the Session authority.

## Executable authority

[`src/state-machine.mjs`](../../src/state-machine.mjs) owns the three public states, transitions, footer text, command projection, and classification rule.

[`src/controller.mjs`](../../src/controller.mjs) owns Pi event handling. [`src/contract.mjs`](../../src/contract.mjs) owns the private checkpoint shape. [`src/adapters.mjs`](../../src/adapters.mjs) owns provider requests.

The [interactive HTML](../design/compaction-state-machine.html) is generated from the state-machine code. Run `npm run generate:state-machine` after a state-machine change. Do not edit the generated HTML.

## Compaction contract

A supported and authorized provider runs server-side compaction before Pi creates a local summary.

Success returns one Pi `CompactionEntry`. Its model-facing summary is empty. Its private details contain only:

- the provider connection identity;
- the provider-owned replay input;
- hashes that locate the one serialized Pi segment to replace.

Official OpenAI and Azure output remains unchanged. ChatGPT Codex stores only its returned opaque compaction item. Blackmagic adds no local retention window.

An unsupported or unauthorized provider delegates to Pi. Pi then creates its normal local summary.

A supported serialization or server failure cancels the attempt. History stays unchanged.

## Continuation contract

`SUMMARY_STAYS_READABLE` means History is readable.

`BLACKMAGIC_READY` means the active provider can use the stored server result. Model selection can change within the same provider connection.

`PROVIDER_MISMATCH` means the active provider cannot use the stored result. Blackmagic shows one persistent footer warning. It does not block or confirm any action. It does not inject a warning into History or model input.

The controller recomputes state after Session start, model or provider selection, tree selection, compaction, and restart. It clears its footer on Session shutdown.

A compatible provider replays the stored provider input. A mismatch continues with visible History only. A later compaction can establish a new result for the selected provider.

Blackmagic reads only its current checkpoint shape. Zero backward compatibility is intentional.

## TUI contract

Blackmagic uses Pi's one built-in compaction card. Pi 0.83 has no public extension API to change that card.

A successful extension compaction schedules one human-only TUI notice. The footer and `/blackmagic` are also human-only. None of these texts enters the empty summary or provider payload.

## Evidence and limits

Focused tests cover provider requests, provider-owned outputs, current-branch serialization, one server call, one Pi entry, failure behavior, replay, model changes, provider mismatch, tree recovery, TUI separation, persistence, generated output, package contents, and RPC loading.

An authenticated canary confirmed ChatGPT Codex replay across two other models. This is empirical evidence, not a documented vendor guarantee. Authenticated OpenAI API and Azure canaries remain unavailable.

## Architecture impact

None. The cleanup reduces the extension's private contract. It does not change component responsibility, authority, dependency direction, data flow, persistence boundary, or deployment topology.
