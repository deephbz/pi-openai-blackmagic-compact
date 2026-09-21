# Pi OpenAI Blackmagic Compact — current state

As of: 2026-09-21

Source base: `0.1.0-rc.10`. Candidate metadata: `0.1.0-rc.11` for the
`latest` dist-tag. This candidate is not published. Observed published tags remain
`next` rc.10 and `latest` rc.9.

The candidate carries serializer-drift lineage fallback for provider requests
and compaction preflight, Session-leaf timeline ownership, and configured HTTPS
GPT-5/GPT-6 Responses recognition. Earlier release notes: [rc.10](../../release/v0.1.0-rc.10-release-notes.md). See the [rc.11 release notes](../../release/v0.1.0-rc.11-release-notes.md).

Publication evidence lives in repository release receipts. The
[rc.8 release receipt](../../release/v0.1.0-rc.8-release-receipt.md) records the
previous publication's source, workflow, registry, and provenance evidence.

Stage: alpha hardening of the narrow direct-compaction contract.

Compatibility: Pi peers support version 0.83.0 or later, with no upper bound. No backward-compatibility guarantee applies before the first stable release.

## Purpose and boundary

This hook-only package compacts the authoritative current Pi branch on approved OpenAI Responses, Azure OpenAI Responses, ChatGPT Codex Responses, and configured HTTPS Responses endpoints with the exact `openai-responses` API and case-insensitive `gpt-5` or `gpt-6` model IDs. The adapter appends `/responses/compact` to the configured base path. It discards query strings and fragments from both the request URL and endpoint identity. Query-based routing is unsupported. Recognition permits an attempt and does not validate transport compatibility. After a validated remote result, it writes an empty Pi summary and adds an opaque provider checkpoint.

The package has no separate extension configuration file. It does not register or wrap providers, observe normal provider requests, own thresholds, or create handoffs. A Session-local preference controls only new remote compaction attempts. Payload-only request rewrites are outside the compaction source because they are not persisted Pi Session history.

## Contract

At `session_before_compact`, the package derives AgentMessages from `buildSessionContext(event.branchEntries)`, converts them through Pi `convertToLlm()`, filters the current Pi tool definitions by active tool names, and uses the unmodified Pi-AI Responses `streamSimple` delegate with a deliberately terminated `onPayload` probe. This captures one native semantic request body without a network request or native compaction call.

The probe receives the current system prompt, thinking level, session ID, authorization, and stable serializer options. The package identifies the exact approved surface, applies a matching active checkpoint replay to the derived body when present, and calls the matching compact protocol. Generic GPT routes reuse the OpenAI Responses adapter and keep their normalized endpoint in checkpoint identity. A validated result persists an empty summary with its checkpoint. Failure to serialize, authenticate, match replay, compact, or serialize the post-compaction segment returns no hook result, so Pi performs its normal native compaction.

Normal `before_provider_request` only replays an active persisted checkpoint or records its invalidation. It does not affect compaction readiness, and `/blackmagic disable` does not disable this replay. `/blackmagic status` uses a no-provider-compaction preflight over the active branch and current model route when remote attempts are enabled. It reports concrete route blockers such as a missing model, invalid endpoint, non-HTTPS endpoint, or unsupported provider route. It rejects an empty branch, a branch without context, and a branch that already ends with compaction. It resolves authorization through Pi's normal `getApiKeyAndHeaders` resolver, which may refresh auth or use configured auth storage. Codex readiness also validates the account identity required by its transport. `/blackmagic enable` and `/blackmagic disable` control only new remote compaction attempts. Disabled status skips preflight and states that Pi native compaction and persisted replay remain active. The commands accept only the `status`, `enable`, and `disable` subcommands and reject unknown or extra arguments before preflight. They persist a typed, namespaced custom Session entry outside LLM context. The latest valid setting across `getEntries()` applies across tree navigation; copied forks inherit setting entries copied into the fork, and new Sessions default to enabled. Repeated same-state commands are idempotent, and toggle notices state that persisted replay remains active. Each compaction hook snapshots the setting at entry, so an in-flight remote attempt completes if a later command disables new attempts. Enabled status reports readiness for an attempt, not future success, in one transient notice and does not set persistent footer state. Pi completion suggests all three subcommands after `/blackmagic`.

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
full-input hashes for direct replay. A legacy checkpoint with persisted active
lineage can use the lineage fallback after serializer drift. The fallback
preserves current request controls and does not authenticate rewritten
historical content.

The checkpoint identity retains the producer model. An eligible model switch on
the same route can replay directly when the stored hashes match. Exact hashes are
always tried first. When serializer drift prevents old hashes from reproducing,
replay uses the persisted active Session lineage as its fallback source authority.
It rebuilds the checkpoint parent plus a synthetic pending compaction through the
current serializer, then requires one unique matching live segment. This
fallback does not authenticate manually rewritten historical content when old
hashes cannot be reproduced.

A malformed recognized checkpoint blocks readiness and direct remote compaction.
This includes an invalid artifact hash or length and an unknown replay scope.
Valid Pi-native and local-fallback summaries remain unaffected.

Direct remote compaction failure can defer to Pi's native fallback. Disabling new remote attempts does not bypass a saved checkpoint: replay stays active, so a provider rejection of that replay still fails normally without an automatic retry. Replay acceptance does not guarantee server consumption. Exact hashes remain the strongest replay proof. The lineage fallback still enforces artifact validation, route checks, active lineage, and unique-segment matching.

The opaque provider artifact stays in typed `CompactionEntry.details`; a successful remote compaction writes an empty string to Pi's normal summary field. After a recognized extension compaction, one namespaced custom timeline entry stores only an allowlisted method label. Its parent is the compaction entry. Its expanded TUI view reads the saved checkpoint: it shows retained user messages in order and the exact first 100 characters of `encrypted_content` as the approved session-log search prefix. It does not read live replay input or guess from source history, duplicate payload data, or enter LLM context. Terminal controls are escaped, and narrow TUI wrapping can split copied prefix text. Forks before a checkpoint cannot replay it.

## Public source lineage

rc.9 continues the sanitized rc.5 current source lineage. The deterministic transform and its minimal source-lineage receipt are recorded in [release/privacy-lineage.v1.json](../../release/privacy-lineage.v1.json).

Old tag graphs remain public and are not privacy-clean. Old releases remain immutable. `v0.1.0-rc.4` was an unpublished failed attempt.

## Evidence

- The locked Pi 0.83.0 suite passes all 92 tests. Package verification passes.
- The earlier Pi 0.85.1 comparison retained the base revision's 12
  readiness-property failures. Pi 0.86.1 retained its 16 serializer/readiness
  failures. Those comparisons covered the prior 91-test tip; the unbounded
  peer range does not establish runtime compatibility for this amendment.
- The rc.8 OIDC publish run `31930165211` passed from exact `main` source.
  Its receipt records verified registry integrity and SLSA provenance.
- Unit and lifecycle tests cover all three protocol adapters and direct current-branch serialization.
- The serialization corpus includes custom messages, branch and compaction summaries, included and excluded bash messages, assistant tool calls, and tool results.
- Tests cover checkpoint replay, same-route model-switch translation, saved-checkpoint projection, restart and fork boundaries, redacted telemetry, package contents, and RPC loading from another directory.
- Cross-model replay passes deterministic tests. An [authenticated Pi 0.85.1 canary](../../release/v0.1.0-rc.10-authenticated-canary.md) verifies fresh-process Codex replay from `gpt-5.6-luna` to `gpt-5.6-sol` with no plaintext nonce in the replay request. Other pairs remain unverified.
- Official OpenAI and Azure authenticated canaries remain live-unverified. Generic endpoint live acceptance remains unverified. Pi native compaction remains the fallback when remote compaction cannot produce a validated checkpoint.
