# @hypercarrier/pi-openai-blackmagic-compact

Direct server compaction for the Pi branch you are using now.

Blackmagic keeps Pi in charge of the readable summary and the Session change. When one of three approved OpenAI-family surfaces can compact the branch, it adds one provider checkpoint. When it cannot, Pi keeps working with its local summary. No ceremony. No provider wrapper. No extension configuration.

**Proof, not promise:** rc.3 has 21 passing tests. Authenticated Codex checks covered apply, repeated apply, fresh-process replay, and recall. OpenAI and Azure live checks still need credentials, so they remain unverified live surfaces.

For the full current contract, see [docs/current/README.md](docs/current/README.md).

## A normal day

You work through a long Pi session. You run `/compact`. You want Pi's useful readable summary, but you also want an approved server-side compaction when the current model supports it.

Without Blackmagic, Pi makes its normal local summary. That is always the safe path.

With Blackmagic, Pi still makes and saves that summary. Blackmagic derives the current branch through Pi's normal serializer on the first compaction attempt. It then uses the approved compact protocol when the active surface and authorization permit it. If any required step fails, Pi uses its local fallback. The extension does not turn a compaction failure into a new kind of session drama.

## Install and use

```sh
pi install npm:@hypercarrier/pi-openai-blackmagic-compact@0.1.0-rc.3
# Or test a local checkout:
pi -e /path/to/pi-openai-blackmagic-compact
```

Start Pi as usual, then use `/compact` as usual. Blackmagic has no setup command and does not own Pi's compaction thresholds.

Use this command when you want a short current-state report:

```text
/server-compact status
```

It sends a transient notification. It does not create a sticky display state.

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

The card can also show Codex v2 or a local fallback with an allowlisted failure class. It stores only that small redacted display result. It does not enter LLM context, so it does not change replay, serializer input, or compaction selection.

## How it works

Pi first creates the readable summary. During `session_before_compact`, Blackmagic derives the authoritative current branch with Pi's canonical conversion and native serializer. It uses that result for an approved server compaction attempt.

Pi then owns and persists the returned atomic Session mutation. On success, the package stores one opaque provider window in the normal compaction details. Later requests can replay that checkpoint only when the active branch and approved provider identity match. The timeline card follows `session_compact` as a separate TUI-only custom entry.

This boundary is deliberate: Pi owns the conversation record. Blackmagic adds a narrow server checkpoint path. It does not register or wrap providers, observe normal provider calls, create handoffs, or change thresholds.

## Safety and persistence

The local fallback is always available. Blackmagic rejects unsupported surfaces and unsafe replay conditions instead of guessing.

Session data can contain opaque provider artifacts. Treat the session file as sensitive history. The visible timeline entry is redacted: it does not persist or render prompts, tools, credentials, endpoints, deployments, models, opaque artifacts, hashes, usage data, or identity objects.

## Limits

This package is not a promise of lossless compaction or identical provider transport. It supports only the listed surfaces. It has authenticated Codex evidence, but OpenAI and Azure live canaries are still blocked by missing credentials. Pi's readable local summary remains the dependable fallback.

## Verify

```sh
npm test
npm run verify:package
npm run pack:check
```

The rc.3 suite checks provider contracts, direct current-branch serialization, replay and restart boundaries, timeline persistence, redaction, LLM-context exclusion, package contents, and RPC loading.
