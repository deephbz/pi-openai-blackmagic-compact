# @hypercarrier/pi-openai-blackmagic-compact

A Pi hook package that compacts the authoritative current Pi branch through approved OpenAI Responses, Azure OpenAI Responses, and ChatGPT Codex Responses surfaces.

At `session_before_compact`, the package gets Pi's readable native summary. It converts the complete current branch with Pi's canonical `convertToLlm()`, then uses the unchanged Pi-AI `streamSimple` serializer with a terminated `onPayload` probe. The resulting native semantic body goes to the matching compact protocol. This works on the first attempt and includes custom messages, summaries, bash records, assistant tool calls, and tool results.

The package uses no extension configuration. It does not wrap or register providers, observe normal provider calls, create thresholds, or create handoffs. Provider-payload-only rewrites are outside the compaction source because they are not Pi Session history. `/server-compact status` reports the current branch method and active model route. Pi native compaction remains the readable fallback.

## Install

```sh
pi install npm:@hypercarrier/pi-openai-blackmagic-compact@0.1.0-rc.2
# or test a local checkout
pi -e /path/to/pi-openai-blackmagic-compact
```

## Security and persistence

A remote checkpoint stores only in typed `CompactionEntry.details`. Replay requires exact active-branch lineage, provider surface, endpoint, model, protocol, Azure deployment, namespace, and one unique input segment. Session JSONL can contain opaque provider artifacts. Protect it like session history.

## Verification

```sh
npm test
npm run pack:check
```

Tests cover the three provider contracts, direct current-branch serialization, custom and summary messages, excluded bash output, tool calls/results, exact replay, restart/fork behavior, fallback, redaction, and RPC loading from another directory.
