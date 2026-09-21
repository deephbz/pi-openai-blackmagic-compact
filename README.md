# @hypercarrier/pi-openai-blackmagic-compact

Direct server compaction for the Pi branch you are using now.

Blackmagic keeps Pi in charge of the Session change. When an approved OpenAI-family surface validates a remote compaction, it writes an empty Pi summary and adds one provider checkpoint. When it cannot, Pi makes its normal local summary. No ceremony. No provider wrapper. No extension configuration.

For the full current contract, see [docs/current/README.md](docs/current/README.md).

## A normal day

You work through a long Pi session. You run `/compact`. You want an approved server-side compaction when the current model supports it.

Without Blackmagic, Pi makes its normal local summary. That is the fallback path.

With Blackmagic, it first derives the current branch through Pi's normal serializer, then tries the approved compact protocol. A validated remote result writes an empty summary and its opaque checkpoint. If any step fails, the hook returns no result and Pi makes its normal local summary.

## Install and use

The current checkout prepares candidate `0.1.0-rc.11` for the `latest` dist-tag. It is not published. The install command below remains the published rc.10 baseline and does not contain the current changes. See the [rc.11 release notes](release/v0.1.0-rc.11-release-notes.md).

```sh
pi install npm:@hypercarrier/pi-openai-blackmagic-compact@0.1.0-rc.10
# Or test a local checkout:
pi -e /path/to/pi-openai-blackmagic-compact
```

Start Pi as usual, then use `/compact` as usual. Blackmagic has no setup command and does not own Pi's compaction thresholds.

Use this command to check local readiness for one direct compaction attempt:

```text
/blackmagic-status
```

It checks the current model route, Pi authorization, branch serialization, and persisted replay. It reports concrete route blockers without exposing endpoint data. It accepts no argument. It does not call the compaction endpoint or guarantee that a later request succeeds. It sends one transient notification and does not create a sticky display state.

## 0.1.0-rc.11 release candidate

This candidate carries conversation-scoped replay, lineage-based serializer-drift
fallback, Session-leaf timeline ownership, and generalized GPT-5/GPT-6 route
recognition. It is prepared for `latest`; no tag or publication exists yet. The
observed `next` remains on rc.10 and published `latest` remains on rc.9. See the [rc.11 release notes](release/v0.1.0-rc.11-release-notes.md).

Known limits:

- A UI-only tail can report remote readiness while Pi declines native `/compact` work.
- An authenticated Pi 0.85.1 canary passed remote compaction and fresh-process replay from `gpt-5.6-luna` to `gpt-5.6-sol` on the same Codex route. See the [bounded canary evidence](release/v0.1.0-rc.10-authenticated-canary.md). Other model pairs remain unverified.
- The historical live HTTP count is uncertain because earlier runs did not fully control WebSocket transport. The observed count is evidence, not a verified total.

## Supported surfaces

Blackmagic accepts only these approved Responses surfaces:

- OpenAI Responses
- Azure OpenAI Responses
- ChatGPT Codex Responses
- Any configured HTTPS Responses endpoint with the exact `openai-responses` API and a model ID containing `gpt-5` or `gpt-6` (case-insensitive)

Generic GPT route recognition reuses the OpenAI Responses adapter. It permits an attempt; it does not prove provider support, response semantics, compaction quality, or safe data handling. Other models and unsupported conditions use Pi's local fallback.

## What you see

After a recognized Blackmagic compaction, Pi adds one durable TUI timeline card beside its built-in compaction record:

```text
[server compaction] OpenAI/Azure Responses v1 applied
```

The card can also show Codex v2 or a local fallback with an allowlisted failure class. A remote card expands to show the saved checkpoint: its retained user messages in order, then the first 100 characters of the encrypted server context as a session-log search prefix. It reads the saved checkpoint instead of live replay input or source history, stores no transcript copy, and does not enter LLM context, so it does not change replay, serializer input, or compaction selection.

## How it works

During `session_before_compact`, Blackmagic derives the authoritative current branch with Pi's canonical conversion and native serializer. It uses that result for an approved server compaction attempt without calling Pi's native compaction model. Generic route recognition requires HTTPS, the exact OpenAI Responses API, and a GPT-5 or GPT-6 model ID.

Pi then owns and persists the returned atomic Session mutation. On remote success, its summary is the empty string and the package stores one opaque provider window in normal compaction details. Later requests can replay that checkpoint when the active branch and supported route identity match, including an eligible model switch. The checkpoint retains its producer model and uses exact stored hashes for direct replay. When serializer drift prevents old hashes from reproducing, it can rebuild the checkpoint parent plus a synthetic pending compaction through the current serializer. This fallback requires the persisted checkpoint lineage to remain active and one current serialized segment to match. It uses the active Session lineage as its source authority. It does not authenticate manually rewritten historical content when old hashes cannot be reproduced. New checkpoints separate conversation replay from current request instructions and tools. Legacy checkpoints use full-input hashes for direct replay. Legacy checkpoints with persisted active lineage can use the same lineage fallback after serializer drift; that fallback preserves current controls but does not authenticate rewritten historical content. The [authenticated canary](release/v0.1.0-rc.10-authenticated-canary.md) verifies one Codex model pair; other pairs remain unverified. A provider rejection does not trigger an automatic retry. The timeline card follows `session_compact` as a separate TUI-only custom entry.

This boundary is deliberate: Pi owns the conversation record. Blackmagic adds a narrow server checkpoint path. It does not register or wrap providers, observe normal provider calls, create handoffs, or change thresholds.

## Public source lineage

rc.9 continues the sanitized rc.5 current source lineage. See the
[minimal source-lineage receipt](release/privacy-lineage.v1.json). The
[rc.8 publication receipt](release/v0.1.0-rc.8-release-receipt.md) remains the
historical evidence for that release.

Old tag graphs remain public and are not privacy-clean. Old releases remain immutable. `v0.1.0-rc.4` was an unpublished failed attempt.

## Safety and persistence

Pi's native fallback is always available. Blackmagic returns no compaction result for unsupported surfaces or unsafe replay conditions instead of guessing.

Session data can contain opaque provider artifacts. Treat the session file as sensitive history. The visible timeline entry does not persist prompts, tools, credentials, endpoints, deployments, models, opaque artifacts, hashes, usage data, or identity objects. When expanded, it renders retained user messages and the approved session-log search prefix: the first 100 characters of the saved encrypted provider artifact. Narrow terminals wrap the prefix, so copied text can split.

## Limits

This package is not a promise of lossless compaction or identical provider transport. It supports only the listed surfaces. Generic GPT route recognition can send prompts, tools, and credentials to any configured HTTPS endpoint that matches the rule. Exact replay hashes remain the strongest replay proof. Serializer-drift fallback trusts active persisted Session lineage and does not prove that historical content was not manually rewritten when old hashes cannot be reproduced. It still requires artifact validation, route checks, active lineage, and one unique live segment. It has authenticated Codex evidence, but OpenAI and Azure live canaries are still blocked by missing credentials. Generic endpoint live acceptance remains unverified. Pi's native compaction remains the dependable fallback when a remote result is unavailable.

## Verify

```sh
npm test
npm run verify:package
npm run pack:check
```

The rc.10 candidate suite checks the readiness status command, saved-checkpoint expansion, provider contracts, the unbounded Pi peer range from 0.83.0, empty-summary remote compaction, direct current-branch serialization, replay and restart boundaries, timeline persistence, redaction, LLM-context exclusion, package contents, and RPC loading.
