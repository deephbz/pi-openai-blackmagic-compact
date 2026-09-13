# @hypercarrier/pi-openai-blackmagic-compact

Direct server compaction for the Pi branch you are using now.

Blackmagic keeps Pi in charge of the Session change. When one of three approved OpenAI-family surfaces validates a remote compaction, it writes an empty Pi summary and adds one provider checkpoint. When it cannot, Pi makes its normal local summary. No ceremony. No provider wrapper. No extension configuration.

For the full current contract, see [docs/current/README.md](docs/current/README.md).

## A normal day

You work through a long Pi session. You run `/compact`. You want an approved server-side compaction when the current model supports it.

Without Blackmagic, Pi makes its normal local summary. That is the fallback path.

With Blackmagic, it first derives the current branch through Pi's normal serializer, then tries the approved compact protocol. A validated remote result writes an empty summary and its opaque checkpoint. If any step fails, the hook returns no result and Pi makes its normal local summary.

## Install and use

```sh
pi install npm:@hypercarrier/pi-openai-blackmagic-compact@0.1.0-rc.8
# Or test a local checkout:
pi -e /path/to/pi-openai-blackmagic-compact
```

Start Pi as usual, then use `/compact` as usual. Blackmagic has no setup command and does not own Pi's compaction thresholds.

Use this command to check local readiness for one direct compaction attempt:

```text
/blackmagic-status
```

It checks the current model route, Pi authorization, branch serialization, and persisted replay. It reports concrete route blockers without exposing endpoint data. It accepts no argument. It does not call the compaction endpoint or guarantee that a later request succeeds. It sends one transient notification and does not create a sticky display state.

## Supported surfaces

Blackmagic accepts only these official Responses surfaces:

- OpenAI Responses
- Azure OpenAI Responses
- ChatGPT Codex Responses

It does not claim general provider support. Other models and unsupported conditions use Pi's local fallback.

## What you see

After a recognized Blackmagic compaction, Pi adds one durable TUI timeline card beside its built-in compaction record:

```text
[server compaction] OpenAI/Azure Responses v1 applied
```

The card can also show Codex v2 or a local fallback with an allowlisted failure class. Remote cards expand to show the earlier TUI transcript from the existing session records. The card does not store a transcript copy. It does not enter LLM context, so it does not change replay, serializer input, or compaction selection.

## How it works

During `session_before_compact`, Blackmagic derives the authoritative current branch with Pi's canonical conversion and native serializer. It uses that result for an approved server compaction attempt without calling Pi's native compaction model.

Pi then owns and persists the returned atomic Session mutation. On remote success, its summary is the empty string and the package stores one opaque provider window in normal compaction details. Later requests can replay that checkpoint only when the active branch and approved provider identity match. The timeline card follows `session_compact` as a separate TUI-only custom entry.

This boundary is deliberate: Pi owns the conversation record. Blackmagic adds a narrow server checkpoint path. It does not register or wrap providers, observe normal provider calls, create handoffs, or change thresholds.

## Public source lineage

rc.8 continues the sanitized rc.5 current source lineage. See [the minimal source-lineage receipt](release/privacy-lineage.v1.json).

Old tag graphs remain public and are not privacy-clean. Old releases remain immutable. `v0.1.0-rc.4` was an unpublished failed attempt.

## Safety and persistence

Pi's native fallback is always available. Blackmagic returns no compaction result for unsupported surfaces or unsafe replay conditions instead of guessing.

Session data can contain opaque provider artifacts. Treat the session file as sensitive history. The visible timeline entry is redacted: it does not persist or render prompts, tools, credentials, endpoints, deployments, models, opaque artifacts, hashes, usage data, or identity objects.

## Limits

This package is not a promise of lossless compaction or identical provider transport. It supports only the listed surfaces. It has authenticated Codex evidence, but OpenAI and Azure live canaries are still blocked by missing credentials. Pi's native compaction remains the dependable fallback when a remote result is unavailable.

## Verify

```sh
npm test
npm run verify:package
npm run pack:check
```

The rc.8 suite checks provider contracts, the unbounded Pi peer range from 0.83.0, empty-summary remote compaction, direct current-branch serialization, transcript restoration from source records, replay and restart boundaries, timeline persistence, redaction, LLM-context exclusion, package contents, and RPC loading.
