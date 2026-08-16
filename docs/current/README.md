# Pi OpenAI Blackmagic Compact — current state

As of: 2026-08-16

Current published prerelease: `0.1.0-rc.8` on npm `next`. The exact source,
workflow, registry, and provenance evidence is in the
[rc.8 release receipt](../../release/v0.1.0-rc.8-release-receipt.md).

Stage: alpha hardening of the narrow direct-compaction contract.

Compatibility: Pi peers support version 0.83.0 or later, with no upper bound. No backward-compatibility guarantee applies before the first stable release.

## Purpose and boundary

This hook-only package compacts the authoritative current Pi branch on official OpenAI Responses, official Azure OpenAI Responses, and ChatGPT Codex Responses. After a validated remote result, it writes an empty Pi summary and adds an opaque provider checkpoint.

The package has no extension configuration. It does not register or wrap providers, observe normal provider requests, own thresholds, or create handoffs. Payload-only request rewrites are outside the compaction source because they are not persisted Pi Session history.

## Contract

At `session_before_compact`, the package derives AgentMessages from `buildSessionContext(event.branchEntries)`, converts them through Pi `convertToLlm()`, filters the current Pi tool definitions by active tool names, and uses the unmodified Pi-AI Responses `streamSimple` delegate with a deliberately terminated `onPayload` probe. This captures one native semantic request body without a network request or native compaction call.

The probe receives the current system prompt, thinking level, session ID, authorization, and stable serializer options. The package identifies the exact approved surface, applies a matching active checkpoint replay to the derived body when present, and calls the matching compact protocol. A validated result persists an empty summary with its checkpoint. Failure to serialize, authenticate, match replay, compact, or serialize the post-compaction segment returns no hook result, so Pi performs its normal native compaction.

Normal `before_provider_request` only replays an active persisted checkpoint or records its invalidation. It does not affect compaction readiness. `/server-compact status` sends a transient notice from the active branch and current model route. It does not set persistent footer state.

## Persistence and replay

Replay requires an active-branch checkpoint, exact provider identity, a supported namespace, and exactly one matching contiguous hashed provider-input segment. The opaque provider artifact stays in typed `CompactionEntry.details`; a successful remote compaction writes an empty string to Pi's normal summary field. After a recognized extension compaction, one namespaced custom timeline entry stores only an allowlisted method label. Its parent is the compaction entry. Its expanded TUI view derives the earlier transcript from existing source records. It does not duplicate those records or enter LLM context. Forks before a checkpoint cannot replay it.

## Public source lineage

rc.8 continues the sanitized rc.5 current source lineage. The deterministic transform and its minimal source-lineage receipt are recorded in [release/privacy-lineage.v1.json](../../release/privacy-lineage.v1.json).

Old tag graphs remain public and are not privacy-clean. Old releases remain immutable. `v0.1.0-rc.4` was an unpublished failed attempt.

## Evidence

- The rc.8 test suite passes, including the unbounded Pi peer-range release contract.
- OIDC publish run `31930165211` passed from exact `main` source; npm `next`
  selects rc.8 with verified registry integrity and SLSA provenance.
- Unit and lifecycle tests cover all three protocol adapters and direct current-branch serialization.
- The serialization corpus includes custom messages, branch and compaction summaries, included and excluded bash messages, assistant tool calls, and tool results.
- Tests cover checkpoint replay, source-record transcript restoration, restart and fork boundaries, redacted telemetry, package contents, and RPC loading from another directory.
- Official OpenAI and Azure authenticated canaries remain live-unverified. Pi native compaction remains the fallback when remote compaction cannot produce a validated checkpoint.
