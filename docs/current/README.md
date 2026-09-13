# Pi OpenAI Blackmagic Compact — current state

As of: 2026-09-13

Candidate: 0.1.0-rc.8

Stage: alpha hardening of the narrow direct-compaction contract.

Compatibility: Pi peers support version 0.83.0 or later, with no upper bound. No backward-compatibility guarantee applies before the first stable release.

## Purpose and boundary

This hook-only package compacts the authoritative current Pi branch on official OpenAI Responses, official Azure OpenAI Responses, and ChatGPT Codex Responses. After a validated remote result, it writes an empty Pi summary and adds an opaque provider checkpoint.

The package has no extension configuration. It does not register or wrap providers, observe normal provider requests, own thresholds, or create handoffs. Payload-only request rewrites are outside the compaction source because they are not persisted Pi Session history.

## Contract

At `session_before_compact`, the package derives AgentMessages from `buildSessionContext(event.branchEntries)`, converts them through Pi `convertToLlm()`, filters the current Pi tool definitions by active tool names, and uses the unmodified Pi-AI Responses `streamSimple` delegate with a deliberately terminated `onPayload` probe. This captures one native semantic request body without a network request or native compaction call.

The probe receives the current system prompt, thinking level, session ID, authorization, and stable serializer options. The package identifies the exact approved surface, applies a matching active checkpoint replay to the derived body when present, and calls the matching compact protocol. A validated result persists an empty summary with its checkpoint. Failure to serialize, authenticate, match replay, compact, or serialize the post-compaction segment returns no hook result, so Pi performs its normal native compaction.

Normal `before_provider_request` only replays an active persisted checkpoint or records its invalidation. It does not affect compaction readiness. `/blackmagic-status` uses a no-provider-compaction preflight over the active branch and current model route. It reports concrete route blockers such as a missing model, invalid endpoint, non-HTTPS endpoint, or unsupported provider route. It rejects an empty branch, a branch without context, and a branch that already ends in compaction. It resolves authorization through Pi's normal `getApiKeyAndHeaders` resolver, which may refresh auth or use configured auth storage. Codex readiness also validates the account identity required by its transport. The command accepts no argument. It does not call the compaction endpoint or make a model request. It reports readiness for an attempt, not future success, in one transient notice and does not set persistent footer state.

## Persistence and replay

Replay requires an active-branch checkpoint, exact provider identity, a supported namespace, and exactly one matching contiguous hashed provider-input segment. The opaque provider artifact stays in typed `CompactionEntry.details`; a successful remote compaction writes an empty string to Pi's normal summary field. After a recognized extension compaction, one namespaced custom timeline entry stores only an allowlisted method label. Its parent is the compaction entry. Its expanded TUI view reads the saved checkpoint: it shows retained user messages in order and the exact first 100 characters of `encrypted_content` as the approved session-log search prefix. It does not read live replay input or guess from source history, duplicate payload data, or enter LLM context. Terminal controls are escaped, and narrow TUI wrapping can split copied prefix text. Forks before a checkpoint cannot replay it.

## Public source lineage

rc.8 continues the sanitized rc.5 current source lineage. The deterministic transform and its minimal source-lineage receipt are recorded in [release/privacy-lineage.v1.json](../../release/privacy-lineage.v1.json).

Old tag graphs remain public and are not privacy-clean. Old releases remain immutable. `v0.1.0-rc.4` was an unpublished failed attempt.

## Evidence

- The rc.8 test suite passes, including the unbounded Pi peer-range release contract.
- Unit and lifecycle tests cover all three protocol adapters and direct current-branch serialization.
- The serialization corpus includes custom messages, branch and compaction summaries, included and excluded bash messages, assistant tool calls, and tool results.
- Tests cover checkpoint replay, saved-checkpoint projection, restart and fork boundaries, redacted telemetry, package contents, and RPC loading from another directory.
- Official OpenAI and Azure authenticated canaries remain live-unverified. Pi native compaction remains the fallback when remote compaction cannot produce a validated checkpoint.
