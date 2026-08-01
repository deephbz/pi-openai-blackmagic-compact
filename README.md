# @hypercarrier/pi-openai-blackmagic-compact

Remote-first server compaction for the current Pi branch.

The executable contract lives in [`src/state-machine.mjs`](src/state-machine.mjs), and focused behavior lives in the controller and tests. The HTML state-machine view is generated output; edit code, then regenerate it. For the full current contract, see [docs/current/README.md](docs/current/README.md).

The published `0.1.0-rc.3` remains the last release. Its documented path created Pi's native readable summary before the remote attempt. This working tree changes that path to remote-first; it is unreleased and has no assigned release version.

## A normal day

You run `/compact` in a long Pi Session. On a supported and authorized OpenAI-family Route, Blackmagic runs first. On success, Pi skips its native readable summary and stores one fixed Blackmagic marker with one opaque provider checkpoint. The current History stays unchanged until Pi applies that returned compaction.

On an unsupported or unauthorized Route, Blackmagic returns control to Pi, so Pi performs its normal native summary once. On a supported failure during serialization, remote compaction, or post-segment validation, Blackmagic returns cancel and leaves History unchanged. Pi remains in control of the Session record.

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

After a successful Blackmagic compaction, Pi adds one durable TUI timeline card beside the compaction record:

```text
[server compaction] OpenAI/Azure Responses v1 applied
```

It stores only a small redacted display result. It does not enter LLM context, so it does not change replay, serializer input, or compaction selection. A failure does not create a fallback card or Session warning.

## How it works

During `session_before_compact`, Blackmagic derives the authoritative current branch with Pi's canonical conversion and native serializer. It uses that result for an approved server compaction attempt before Pi's native summary.

On success, the package returns one Pi `CompactionEntry` with the fixed `BLACKMAGIC_COMPACTION_MARKER`, validated opaque provider details, and replay lineage. Pi owns and persists the atomic Session mutation. Later requests replay that checkpoint only when the active branch and approved provider identity match. The package also reads the legacy `hc-openai-server-compaction/3` checkpoint namespace for old records. The timeline card follows `session_compact` as a separate TUI-only custom entry.

A provider mismatch is derived state. Blackmagic shows one footer warning while `PROVIDER_MISMATCH` holds, clears it on state exit, and never restricts actions, intercepts input, appends a warning Session entry, or persists warning history. Normal requests continue with their unchanged payload when replay is unavailable.

This boundary is deliberate: Pi owns the conversation record. Blackmagic adds a narrow server checkpoint path. It does not own or wrap provider transport, create handoffs, or change thresholds. Its request hook only inspects and rewrites the provider payload for checkpoint replay; on mismatch it returns the unchanged payload.

## Safety and persistence

Pi's native summary remains available for unsupported or unauthorized Routes. A replay mismatch is warning-only: Blackmagic leaves the visible payload and all Pi actions available, while a later compaction can use visible History and establish a new checkpoint.

Session data can contain opaque provider artifacts. Treat the session file as sensitive history. The visible timeline entry is redacted: it does not persist or render prompts, tools, credentials, endpoints, deployments, models, opaque artifacts, hashes, usage data, or identity objects.

## Limits

This package is not a promise of lossless compaction or identical provider transport. It supports only the listed surfaces. It has authenticated Codex evidence, but OpenAI and Azure live canaries are still blocked by missing credentials. Pi's readable local summary remains the dependable fallback.

## Verify

```sh
npm test
npm run verify:package
npm run pack:check
```

The working-tree suite checks provider contracts, direct current-branch serialization, remote-first ownership, replay and restart boundaries, mismatch freedom, timeline persistence, redaction, generated output, package contents, and RPC loading.
