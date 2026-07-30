# Pi OpenAI Blackmagic Compact — current state

As of: 2026-07-30

Stage: hardening of the narrow package contract; authenticated ChatGPT Codex compact and replay are verified, while official OpenAI and Azure remain live-unverified.

## Purpose and boundary

`@hypercarrier/pi-openai-blackmagic-compact` is a hook-only Pi package. It supplies an opaque provider continuation window to Pi's native compaction lifecycle while preserving a readable Pi `CompactionEntry.summary`. It owns neither context thresholds nor handoff policy: `@hypercarrier/hc-auto-compact` remains the sole automatic threshold and handoff owner.

The package accepts only three identified service surfaces: official OpenAI Responses, official Azure OpenAI Responses, and ChatGPT-subscription Codex Responses. It has no agent tool, no automatic threshold, and no durable configuration containing credentials. On Session start it transparently re-registers only Pi 0.83's native `openai/openai-responses`, `openai-codex/openai-codex-responses`, and `azure-openai-responses/azure-openai-responses` providers with their original provider object, model list, auth, and native stream behavior retained.

## Contract

The transparent Pi-AI wrappers delegate to the exact Pi 0.83 `streamSimple` implementation unchanged except for wrapping `options.onPayload`. They snapshot the semantic provider body before Pi's callback chain, call that chain exactly once, then observe its returned final semantic body immediately before Pi-AI sends it. An `AsyncLocalStorage` token binds the `before_provider_request` capture to the exact provider-stream invocation that ran it. Provider side-calls without that token—including same-model calls from other extensions—are ignored; a callback error, duplicate callback, malformed body, earlier/later rewrite, tail-serialization failure, calibration fence mismatch, stale session, or stale active-branch leaf on the correlated main request disables remote compaction. Capture/calibration/tail state is cleared on session start, tree navigation, and compaction completion. It does not prove headers, credentials, SDK bytes, retries, routing, cache outcome, or a future provider transform after `onPayload`.

Tail reconstruction uses the public loader-compatible Pi-AI provider APIs themselves: a deliberately terminated, network-free `onPayload` probe serializes the prior context and prior-context-plus-tail, verifies prefix stability, and takes the exact suffix. This preserves position-derived Response item IDs that tail-only conversion loses. The predicted prior final body plus suffix must match the next final body before remote compaction is enabled. A `session_before_compact` handler then obtains a readable local summary and attempts the matching provider protocol. A remote opaque checkpoint is committed only with that summary. Provider artifacts are stored only as typed `CompactionEntry.details`; the footer and status command expose only the redacted method projection, never prompt, tool, credential, identity, hash, count, or opaque-item content.

Replay uses a checkpoint only when its active branch contains it and surface, endpoint, model, protocol, and Azure deployment exactly match. The persisted extension namespace and a unique contiguous item-hash segment must match exactly; the current namespace is `pi-openai-blackmagic-compact/1`, while legacy `hc-openai-server-compaction/3` checkpoints remain replay-compatible. Missing or ambiguous segments never replay. Mismatch, malformed persisted state, unavailable prepared state, or a fork before the checkpoint fails closed to normal Pi local summary replay. The concise footer is a side-effect-free, redacted active-branch method projection: no active compaction, Pi-native local summary, the two remote protocols, replay, safe-class local fallback, invalidation, or unsupported surface. `/server-compact status` and RPC provide the exact active method plus redacted next-remote outcome/reason, known route/protocol, calibration, load-last assertion, wrapper count, local fallback guarantee, and privacy boundary. Neither projection persists a status or displays raw provider identity, prompts, tools, artifacts, hashes, or counts. Pi Session JSONL includes opaque artifacts and is a local secret-bearing retention boundary; it needs equivalent filesystem, backup, and export protection.

## Evidence

- Loopback protocol tests cover allowlisting, OpenAI/Azure compact, Codex trigger-v2, identity mismatch, malformed responses, timeouts/auth/model errors, and redaction.
- A full programmatic Pi 0.83 controller corpus covers two-request native serialization calibration, remote compaction, one-copy persistence, filesystem reopen/restart, descendant-fork replay, and pre-checkpoint non-inheritance.
- An RPC test loads the extension from an unrelated working directory and executes `/server-compact status`, guarding the host's peer-resolution boundary.
- `npm pack --dry-run` verifies the distributable source bundle and `scripts/verify-package.mjs` validates its manifest and tarball contents.
- An authenticated ChatGPT Codex canary on 2026-07-30 used an immutable copied Pi Session and explicit project-local extension load. Calibration passed after two ordinary turns. Remote compaction accepted 197,290 input tokens, produced one opaque compaction item, and persisted it with seven retained user records, a 15,476-character readable Pi summary, the 64K retention rule, matching recorded/recomputed artifact hash and length, and 48 replay-segment hashes.
- After a full Pi process restart, the next request reported `replayed`, returned the correct pre-compaction branch and commit fact, and used 4,249 uncached plus 6,656 cached input tokens. The source Session SHA-256 remained unchanged.
- The canary first exposed two production-only defects. Current ChatGPT Codex rejects a `protocol_version` property on `compaction_trigger`. Its SSE `response.completed` event can omit `output` while `response.output_item.done` carries the compaction item. Both are fixed and covered by regression tests.
- Official OpenAI and Azure authenticated canaries have not run. Azure API-version and deployment behavior remain unverified until the owner supplies authorized credentials and an explicit Responses-capable deployment.

## Remaining live-only gap

ChatGPT Codex is verified for one Pi 0.83 compact → persist → restart → replay path. This is a canary, not broad production qualification. The semantic-body boundary still does not prove later headers, credentials, SDK bytes, retries, routing, cache outcome, or future Pi-AI transforms after `onPayload`. Official OpenAI and Azure remain live-unverified. Normal Pi local compaction remains the readable continuation fallback.

## Next verification

Repeat ChatGPT Codex on a second independent Session and verify descendant/pre-checkpoint fork behavior live. Run isolated official OpenAI and Azure canaries when credentials are available. Preserve raw Session evidence privately and record only route/model/deployment plus latency/cache/usage receipts without secrets.
