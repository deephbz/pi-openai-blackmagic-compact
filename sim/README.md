# Standalone Responses simulator

Stage: alpha hardening. Architecture impact: none. This lane verifies the real
Blackmagic extension in a real Pi AgentSession. It fakes only fetch, time,
random IDs, and an isolated HOME. No HyperCarrier package is required.

## Property catalog

| ID | Independent observation and failure |
| --- | --- |
| B1 | Every compact request uses the documented model/input shape and excludes create-only fields. |
| B2 | A validated encrypted item reaches subsequent outgoing requests byte-for-byte; earlier Session entries do not change. |
| B3 | Consecutive ordinary requests preserve their existing input prefix and prompt_cache_key. Compaction starts a new prefix epoch. |
| B4 | Remote HTTP or malformed-output failure installs no remote checkpoint; a later explicit compaction can succeed. |
| B5 | Reopened Sessions preserve checkpoint replay; native old compactions remain ordinary summaries. |
| B6 | Same seed and actions produce identical request and Session histories. |

The oracle checks wire bodies and public Session entries. It does not copy the
extension's segment matcher. Prefix checks establish structural reuse only;
token thresholds, routing, TTL, and actual cache hits remain unclaimed.

Run `npm test` for unit tests plus the bounded simulator. Run `npm run test:sim`
for the simulator alone. Run `npm run test:sim:campaign` for 1000 generated runs.
Use `PI_SIM_ROOT=/path/to/node_modules` to select another Pi installation.
All three Pi packages and agent-core resolve from that root, including imports
made by production code. Without it, the repository's locked dependencies run.
No external network call is allowed. Tests run serially because time and fetch
are process-scoped boundaries. Failure messages contain the seed, actions, and
full synthetic history; fast-check reports its seed and shrink path.

The two test-only mutants alter real outgoing requests after Blackmagic's hook:
`drop-encrypted` removes the compacted item (B2); `rotate-key` changes the cache
key (B3). Their witnesses use the same unmodified production controller.
The boundary models OpenAI Responses only. Azure and Codex transport-specific
behavior, automatic retry delays, host crashes, concurrent sessions, and actual
provider acceptance remain outside this lane. Native fallback uses a scripted
Responses stream and remains real Pi behavior.

Provider sources:
- https://developers.openai.com/api/reference/resources/responses/methods/compact
- https://developers.openai.com/api/docs/guides/compaction
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/reference/resources/responses/streaming-events
