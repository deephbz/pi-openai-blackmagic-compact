# Pi OpenAI Blackmagic Compact — current state

As of: 2026-09-15

Published release line: `0.1.0-rc.9`. This candidate prepares
`0.1.0-rc.10` for the `next` dist-tag; published `latest` remains unchanged.

Unreleased candidate changes: eligible model switches can reuse checkpoints
within the same approved provider route. Conversation-scoped replay preserves
current instructions and tools. Invalid recognized checkpoints block remote
readiness. Public notes: [rc.10 release notes](../../release/v0.1.0-rc.10-release-notes.md).

Publication evidence lives in repository release receipts. The
[rc.8 release receipt](../../release/v0.1.0-rc.8-release-receipt.md) records the
previous publication's source, workflow, registry, and provenance evidence.

Stage: alpha hardening of the narrow direct-compaction contract.

Compatibility: Pi peers support version 0.83.0 or later, with no upper bound. No backward-compatibility guarantee applies before the first stable release.

## Purpose and boundary

This hook-only package compacts the authoritative current Pi branch on official OpenAI Responses, official Azure OpenAI Responses, and ChatGPT Codex Responses. After a validated remote result, it writes an empty Pi summary and adds an opaque provider checkpoint.

The package has no extension configuration. It does not register or wrap providers, observe normal provider requests, own thresholds, or create handoffs. Payload-only request rewrites are outside the compaction source because they are not persisted Pi Session history.

## Contract

At `session_before_compact`, the package derives AgentMessages from `buildSessionContext(event.branchEntries)`, converts them through Pi `convertToLlm()`, filters the current Pi tool definitions by active tool names, and uses the unmodified Pi-AI Responses `streamSimple` delegate with a deliberately terminated `onPayload` probe. This captures one native semantic request body without a network request or native compaction call.

The probe receives the current system prompt, thinking level, session ID, authorization, and stable serializer options. The package identifies the exact approved surface, applies a matching active checkpoint replay to the derived body when present, and calls the matching compact protocol. A validated result persists an empty summary with its checkpoint. Failure to serialize, authenticate, match replay, compact, or serialize the post-compaction segment returns no hook result, so Pi performs its normal native compaction.

Normal `before_provider_request` only replays an active persisted checkpoint or records its invalidation. It does not affect compaction readiness. `/blackmagic-status` uses a no-provider-compaction preflight over the active branch and current model route. It reports concrete route blockers such as a missing model, invalid endpoint, non-HTTPS endpoint, or unsupported provider route. It rejects an empty branch, a branch without context, and a branch that already ends with compaction. It resolves authorization through Pi's normal `getApiKeyAndHeaders` resolver, which may refresh auth or use configured auth storage. Codex readiness also validates the account identity required by its transport. The command accepts no argument. It does not call the compaction endpoint or make a model request. It reports readiness for an attempt, not future success, in one transient notice and does not set persistent footer state.

This preflight does not fully establish Pi's native work selection. With a
checkpoint and only a UI-entry tail, status can report ready while Pi declines
`/compact`. This remains a known false positive. The repository's
`docs/reviews/readiness-audit.md` records the evidence and limits.

## Persistence and replay

Replay requires an active-branch checkpoint and matching surface, protocol,
endpoint, deployment, and API. It requires a supported namespace and one unique
contiguous hash sequence within the recorded scope. New checkpoints use
`replay.scope: "conversation"`. Replay replaces conversation items and preserves
current request instructions and tools. An absent scope denotes legacy
full-input hashes. Replay preserves legacy request-control items only after it
proves the complete original span.

The checkpoint identity retains the producer model. An eligible model switch on
the same route can replay directly when the stored hashes match. If serialization
changes, replay serializes the active branch through the checkpoint under the
producer model. It must reproduce the complete stored hash sequence within the
recorded scope. It then serializes that prefix under the current model and
replaces one unique matching conversation segment. Either failed proof blocks
replay.

A malformed recognized checkpoint blocks readiness and direct remote compaction.
This includes an invalid artifact hash or length and an unknown replay scope.
Valid Pi-native and local-fallback summaries remain unaffected.

Direct remote compaction failure can defer to Pi's native fallback. Replay acceptance does not guarantee server consumption or automatic retry after provider rejection.

The opaque provider artifact stays in typed `CompactionEntry.details`; a successful remote compaction writes an empty string to Pi's normal summary field. After a recognized extension compaction, one namespaced custom timeline entry stores only an allowlisted method label. Its parent is the compaction entry. Its expanded TUI view reads the saved checkpoint: it shows retained user messages in order and the exact first 100 characters of `encrypted_content` as the approved session-log search prefix. It does not read live replay input or guess from source history, duplicate payload data, or enter LLM context. Terminal controls are escaped, and narrow TUI wrapping can split copied prefix text. Forks before a checkpoint cannot replay it.

## Public source lineage

rc.9 continues the sanitized rc.5 current source lineage. The deterministic transform and its minimal source-lineage receipt are recorded in [release/privacy-lineage.v1.json](../../release/privacy-lineage.v1.json).

Old tag graphs remain public and are not privacy-clean. Old releases remain immutable. `v0.1.0-rc.4` was an unpublished failed attempt.

## Evidence

- The rc.10 candidate suite passes locally, including the unbounded Pi peer-range release contract.
- The rc.8 OIDC publish run `31930165211` passed from exact `main` source.
  Its receipt records verified registry integrity and SLSA provenance.
- Unit and lifecycle tests cover all three protocol adapters and direct current-branch serialization.
- The serialization corpus includes custom messages, branch and compaction summaries, included and excluded bash messages, assistant tool calls, and tool results.
- Tests cover checkpoint replay, same-route model-switch translation, saved-checkpoint projection, restart and fork boundaries, redacted telemetry, package contents, and RPC loading from another directory.
- Cross-model replay passes deterministic tests; authenticated cross-model acceptance remains unverified.
- Official OpenAI and Azure authenticated canaries remain live-unverified. Pi native compaction remains the fallback when remote compaction cannot produce a validated checkpoint.
