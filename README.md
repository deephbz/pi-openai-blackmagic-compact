# @hypercarrier/pi-openai-blackmagic-compact

Server-side compaction for Pi on supported OpenAI providers.

Blackmagic does one thing. It runs provider compaction before Pi creates a local summary. It then reuses the provider result in later requests.

The code in [`src/state-machine.mjs`](src/state-machine.mjs) owns the public state contract. The [interactive state-machine view](docs/design/compaction-state-machine.html) is generated from that code.

## Install and use

```sh
pi install npm:@hypercarrier/pi-openai-blackmagic-compact@0.1.0-rc.4
# Or use a local checkout:
pi -e /path/to/pi-openai-blackmagic-compact
```

Use Pi's normal command:

```text
/compact
```

Use Blackmagic's command for status or help:

```text
/blackmagic
/blackmagic help
```

Blackmagic does not set compaction thresholds. It has no setup command.

## Supported providers

Blackmagic supports these official provider connections:

- OpenAI Responses
- Azure OpenAI Responses
- ChatGPT Codex Responses

An unsupported or unauthorized provider uses Pi's local compaction. A failed server request leaves History unchanged.

A model change on the same provider connection keeps Blackmagic active. An authenticated ChatGPT Codex canary confirmed cross-model replay. OpenAI does not document this as a stable cross-model contract.

## What the user sees

Blackmagic uses Pi's normal compaction card. It does not add a second card:

```text
[compaction]

Compacted from 52,161 tokens (ctrl+o to expand)
```

Pi 0.83 does not let an extension change this card through its public API. Blackmagic does not patch private Pi code.

After success, the TUI shows a transient notice:

```text
Server-side compaction applied. Keep this provider.
```

The footer then shows:

```text
Blackmagic active · keep this provider
```

If the selected provider cannot use the active result, the footer shows:

```text
Blackmagic History unavailable · switch back or use /tree
```

The warning does not block messages, compaction, provider changes, or tree changes. These TUI texts do not enter Session History or model input.

## Session behavior

A successful operation creates one Pi `CompactionEntry`. Its summary is empty. Its private details contain the provider result and the minimum data needed to replay it.

Blackmagic replays that result only on the same provider connection. It does not keep compatibility code for older Blackmagic records.

Use `/tree` to select a readable point before the Blackmagic result. You can also return to the matching provider.

## Verify

```sh
npm test
npm run verify:package
npm run pack:check
```

The current source has package version `0.1.0-rc.4`.
