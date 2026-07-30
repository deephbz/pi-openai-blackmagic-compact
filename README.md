# @hypercarrier/pi-openai-blackmagic-compact

A focused [Pi](https://github.com/earendil-works/pi) package that supplies a provider-owned opaque continuation checkpoint through Pi's native `session_before_compact` lifecycle.

It targets only official OpenAI Responses, official Azure OpenAI Responses, and ChatGPT-subscription Codex Responses. Compatible endpoints and proxies are intentionally rejected. An authenticated ChatGPT Codex canary has verified compact → persist → restart → replay on Pi 0.83. Official OpenAI and Azure remain live-unverified, and normal Pi local compaction remains the safe fallback.

## What it owns

On Session start it transparently wraps only Pi 0.83's native OpenAI, Codex, and Azure Responses `streamSimple` pairs. Each wrapper delegates to the matching Pi-AI implementation unchanged, except it calls Pi's `onPayload` callback chain once and observes the returned final semantic body immediately before native Pi-AI sends it. An async request-local token correlates that body and native response only with the `before_provider_request` event executed inside the same provider stream; same-model side-calls from Rarebit, tutors, or any other extension are ignored and cannot consume or poison main-Session calibration. It compares provider-base, hook-input/output, and final-body hashes; it also uses the public Pi-AI provider to serialize the prior context plus response tail without making a network request, then calibrates that suffix against the subsequent final body. Until that calibration passes—or on a correlated mismatch—it disables remote compaction. This proves semantic-body ordering only, not headers, credentials, SDK bytes, retries, routing, caching, or a future Pi-AI transform after `onPayload`. Capture state is cleared on session start, tree navigation, and compaction completion; immediately before remote compaction it must still name the current session and an entry on its active branch. When enabled it stores the opaque window only in typed Pi `CompactionEntry.details`, and replays it only for an exact compatible identity, active-branch lineage, namespace, and unique item-hash segment. It also stores a readable Pi summary, so mismatches and failures retain a local continuation.

It does **not** register an agent tool, configure model lists or credentials, choose models, create automatic compaction thresholds, or create handoffs. Pair it with `@hypercarrier/hc-auto-compact` when threshold/handoff control is wanted; load Auto Compact and any request rewriters before this package.

## Install

Use project-local installation while capability remains under canary validation:

```sh
pi install npm:@hypercarrier/pi-openai-blackmagic-compact@0.1.0-rc.1
# or test a local checkout without installation
pi -e /path/to/pi-openai-blackmagic-compact
```

Copy `config/pi-openai-blackmagic-compact.example.json` to trusted project configuration `.pi/pi-openai-blackmagic-compact.json` only after ensuring this package loads last among request rewriters. `/server-compact status` and `/server-compact help` are safe in TUI and RPC modes. The TUI footer gives a concise redacted active-branch method, while status/RPC gives a short diagnostic: exact active method, next `/compact` outcome and reason, known route/protocol, calibration, load-last assertion, wrapper count, guaranteed local fallback, and privacy boundary. Neither persists status or discloses prompts, tools, opaque artifacts, credentials, endpoints, deployments, hashes, or item counts.

## Security and persistence

The full prepared request stays memory-local. Persisted details include schema version, non-secret provider identity, opaque provider artifact, its SHA-256 hash/length, safe token usage, latency, retention rule, and cut-point/branch lineage. Pi Session JSONL is therefore a local secret-bearing retention boundary; protect it with the same filesystem, backup, and export controls as Session history. Structured telemetry excludes authorization, raw prompt/tool data, and opaque artifact content. A provider/model/endpoint/protocol/Azure-deployment mismatch—or a fork whose active branch lacks the checkpoint—never replays remote state.

## Verification

```sh
npm test
npm run pack:check
```

Tests exercise all three loopback routes, malformed/timeout/auth/model failures, request rewrite and load-order capture, native serializer calibration, full controller compaction, filesystem Session restart, descendant and pre-checkpoint forks, mismatch, duplicate prevention, redaction, and the absence of a competing Auto Compact lifecycle. An RPC test loads the extension from an unrelated working directory so host peer-resolution regressions fail CI.

An authenticated ChatGPT Codex canary on 2026-07-30 compacted 197,270 input tokens into one persisted encrypted compaction item plus the 64K retained-user policy, restarted Pi, replayed the checkpoint, recalled a pre-compaction fact, and reduced the replay turn to 4,249 uncached plus 6,656 cached input tokens. The canary exposed and fixed two production-only protocol defects: current Codex rejects `compaction_trigger.protocol_version`, and its SSE `response.completed` event can omit `output` while `response.output_item.done` carries the artifact. Official OpenAI and Azure still require authenticated canaries; details and privacy boundaries are recorded in [the current-state artifact](docs/current/README.md).
