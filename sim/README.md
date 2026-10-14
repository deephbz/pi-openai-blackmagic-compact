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
| B7 | Compact requests preserve the effective instructions of ordinary requests without duplicating persisted system text. |

The oracle checks wire bodies and public Session entries. It does not copy the
extension's segment matcher. Prefix checks establish structural reuse only;
token thresholds, routing, TTL, and actual cache hits remain unclaimed.

Run `npm test` for unit tests plus the bounded simulator. Run `npm run test:sim`
for the simulator alone. Run `npm run test:sim:campaign` for 1000 generated runs.
Use `PI_SIM_ROOT=/path/to/node_modules` to select another Pi installation.
Use `node sim/replay.mjs sim/fixtures/duplicate-system.json` to replay the
minimal system-duplication regression. A scenario has `seed`, `actions`, and
optional `old` or `mutant` fields. The command emits every wire body and public
Session entry. It exits nonzero for a monitor violation.

All three Pi packages and agent-core resolve from that root, including imports
made by production code. Without it, the repository's locked dependencies run.
Requires Node 22.15 or later for alternate-root module hooks.
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

## Recorded verification

The system-duplication fixture failed B7 before the controller repair on locked
Pi 1.0.0. It now passes with Pi 1.0.0, 1.1.0, and 1.2.0. The compact probe used
to prepend the current prompt and replay persisted system text again. The repair
uses one current prompt/tool snapshot during probe serialization.

All three versions passed six bounded scenarios, both mutant witnesses, exact
replay for seeds 17 and 91, and 1000 fast-check scenarios (campaign seed
20261015). Campaign wall times were 9.01 s, 8.54 s, and 7.89 s respectively.
The locked-version default run passed 102 existing tests and five sim tests.
Package verification passed. Representative scenario speed was 27185x virtual
time/wall time on Pi 1.0.0; this excludes module startup and is not a provider
throughput claim. Host load affects wall time.

Provider sources:
- https://developers.openai.com/api/reference/resources/responses/methods/compact
- https://developers.openai.com/api/docs/guides/compaction
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/reference/resources/responses/streaming-events
