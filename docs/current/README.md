# Pi OpenAI Blackmagic Compact — current state

As of: 2026-08-01

Status: unreleased working-tree contract after the published `0.1.0-rc.3`

Stage: hardening of the narrow direct-compaction contract.

The published `0.1.0-rc.3` is the last release. Its documented path created
Pi's native readable summary before the remote attempt. The source in this
working tree changes that path to remote-first. It has no assigned release
version, so do not treat this working tree as a release.

## Authority and boundary

[`src/state-machine.mjs`](../../src/state-machine.mjs) is the executable
semantic authority for continuation states, the fixed compaction marker, pure
replay classification, and pure compaction decisions. The controller consumes
that module, and tests execute the contract. The interactive state-machine HTML
is generated output from that module; edit the code authority and run
`npm run generate:state-machine`, rather than editing the HTML by hand.

This hook-only package compacts the authoritative current Pi branch on official
OpenAI Responses, official Azure OpenAI Responses, and ChatGPT Codex Responses.
It preserves Pi's Session authority and adds a narrow opaque provider
checkpoint. It has no extension configuration, provider wrapper, threshold
policy, handoff, or normal provider-request ownership.

## Compaction ownership

At `session_before_compact`, Blackmagic identifies the selected Route and
authorization before it does compaction work.

- A supported and authorized Route runs Blackmagic first. It serializes the
  current branch through Pi's canonical path, applies a matching checkpoint
  when one exists, and calls the approved remote protocol. On success, it
  returns one Pi `CompactionEntry` with the fixed
  `BLACKMAGIC_COMPACTION_MARKER`, validated opaque details, and replay lineage.
  Pi then persists that result, and its native readable summary is skipped.
- An unsupported or unauthorized Route returns `undefined` to Pi. Pi performs
  exactly one native readable summary, and Blackmagic makes no remote call.
- A supported serialization, remote, or post-segment failure returns
  `{ cancel: true }`. Blackmagic makes no native-summary call and does not
  change History.

The exact state and decision vocabulary remains in the executable authority;
this document does not duplicate its machine table.

## Continuation and mismatch

The controller recomputes coarse state on `session_start`, `model_select`,
`session_tree`, and `session_compact`. It refines that state from actual replay
success or failure in `before_provider_request`.

`SUMMARY_STAYS_READABLE` means Pi has readable History. `BLACKMAGIC_READY`
means opaque History matches the selected Route. `PROVIDER_MISMATCH` means
opaque History cannot replay on the selected Route. The mismatch is derived
state only: it shows one footer warning, clears that warning on state exit, and
never restricts actions, intercepts input, appends a warning Session entry,
prompts, confirms, cancels user sends, registers input handling, or injects
warning context. When replay is unavailable, the visible provider payload is
unchanged. A mismatch compaction may proceed from visible History and establish
a new matching checkpoint.

## Persistence and compatibility

Pi owns the conversation record and Session mutation. A successful remote
operation stores one opaque provider artifact in typed `CompactionEntry.details`
and a fixed marker in the readable compaction summary. The custom timeline
entry is redacted and remains outside LLM context. The package reads both the
current replay namespace and legacy `hc-openai-server-compaction/3` records, so
older sessions remain readable and compatible with the redacted timeline path.

The opaque artifact stays usable only when its active branch, provider identity,
and replay segment match. A mismatch does not deny transport or ordinary user
actions. Pi's native summary remains the fallback for unsupported or
unauthorized Routes, not for a supported remote failure: supported failure
leaves History unchanged.

## Evidence

Focused tests cover all three protocol adapters, canonical current-branch
serialization, zero native-summary calls on remote success, one remote call,
one marker entry, one opaque artifact, unsupported and unauthorized delegation,
supported failure cancellation without Session mutation, replay and restart
boundaries, mismatch freedom, state-hook footer behavior, legacy records,
redaction, generated output, package contents, and RPC loading.

Official OpenAI and Azure authenticated canaries remain live-unverified. Pi's
native compaction remains the dependable path for unsupported or unauthorized
Routes.

## Architecture impact

None. This change moves the stabilized Blackmagic behavior from shaping prose
and the HTML projection into the child package's executable authority. It does
not change HyperCarrier component responsibility, authority, dependency
direction, data flow, persistence boundary, deployment topology, or the
implementation-status claims in the root current docs or Structurizr DSL.
