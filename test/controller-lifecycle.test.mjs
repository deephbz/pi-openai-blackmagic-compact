import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureNativeBody, createServerCompactionController, serializationOptions } from "../src/controller.mjs";
import { BLACKMAGIC_COMPACTION_MARKER } from "../src/state-machine.mjs";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai", id: "gpt-5", name: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" }, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const auth = { ok: true, apiKey: "synthetic-key", headers: { "x-test": "yes" } };
const tool = { name: "probe", description: "Probe the current branch", parameters: { type: "object", properties: {} } };
function fakePi() { const handlers = new Map(); const renderers = new Map(); const appended = []; return { on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerEntryRenderer: (type, renderer) => renderers.set(type, renderer), appendEntry: (type, data) => appended.push({ type, data }), getActiveTools: () => ["probe"], getAllTools: () => [tool], handlers, renderers, appended }; }
function assistantToolCall() { return { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 6 }; }
function preparation(firstKeptEntryId) { return { firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } }; }

async function compactCurrentBranch(entries) {
  const session = SessionManager.inMemory("/tmp");
  let first;
  for (const message of entries) { const id = session.appendMessage(message); first ??= id; }
  const pi = fakePi(); let request; let remoteCalls = 0; let summaryCalls = 0;
  createServerCompactionController(pi, { summaryFactory: () => { summaryCalls += 1; throw new Error("native summary must not run"); }, fetchImpl: async (_url, options) => { remoteCalls += 1; request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque" }], usage: { input_tokens: 3 } }) }; } });
  const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: session, getSystemPrompt: () => "direct system prompt", thinkingLevel: "high" };
  const branchEntries = session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(first), branchEntries, reason: "manual", signal: new AbortController().signal }, ctx);
  return { result, request, pi, ctx, session, remoteCalls, summaryCalls };
}

test("direct compaction serializes canonical current-branch messages on its first attempt", async () => {
  const entries = [
    { role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 },
    { role: "custom", customType: "handoff", content: "custom handoff", display: false, timestamp: 2 },
    { role: "branchSummary", summary: "branch summary", fromId: "branch", timestamp: 3 },
    { role: "compactionSummary", summary: "old summary", tokensBefore: 10, timestamp: 4 },
    { role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
    { role: "bashExecution", command: "secret", output: "hidden", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 5 },
    assistantToolCall(),
    { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "tool result" }], isError: false, timestamp: 7 },
  ];
  const { result, request, remoteCalls, summaryCalls } = await compactCurrentBranch(entries);
  assert.equal(result.compaction.details.state, "remote_applied", JSON.stringify(result));
  assert.equal(result.compaction.summary, BLACKMAGIC_COMPACTION_MARKER);
  assert.equal(result.compaction.details.checkpoint.artifact.length, 1);
  assert.equal(remoteCalls, 1);
  assert.equal(summaryCalls, 0);
  const serialized = JSON.stringify(request);
  assert.match(serialized, /direct system prompt/);
  assert.match(serialized, /custom handoff/);
  assert.match(serialized, /branch summary/);
  assert.match(serialized, /old summary/);
  assert.match(serialized, /Ran `pwd`/);
  assert.match(serialized, /tool result/);
  assert.match(serialized, /probe/);
  assert.doesNotMatch(serialized, /hidden/);
});

test("direct compaction applies the latest persisted checkpoint to the derived body", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "old branch" }], timestamp: 1 }]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: [{ type: "text", text: "later branch" }], timestamp: 2 });
  const pi = fakePi(); let request;
  createServerCompactionController(pi, { summaryFactory: () => "second summary", fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque-2" }] }) }; } });
  const branchEntries = first.session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal: new AbortController().signal }, first.ctx);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.match(JSON.stringify(request), /opaque/);
  assert.doesNotMatch(JSON.stringify(request), /old branch/);
});

test("native serialization probe carries reasoning and session identity without network", async () => {
  let networkCalled = false;
  const options = serializationOptions({ thinkingLevel: "high", sessionManager: { getSessionId: () => "session-1" } }, auth, new AbortController().signal);
  const body = await captureNativeBody(model, { systemPrompt: "probe system", messages: [], tools: [tool] }, { ...options, fetch() { networkCalled = true; throw new Error("network must not run"); } });
  assert.equal(options.reasoning, "high");
  assert.equal(options.sessionId, "session-1");
  assert.equal(body.reasoning?.effort, "high");
  assert.match(JSON.stringify(body), /probe system/);
  assert.match(JSON.stringify(body.tools), /probe/);
  assert.equal(networkCalled, false);
  assert.equal(serializationOptions({ thinkingLevel: "off", sessionManager: { getSessionId: () => "session-1" } }, auth).reasoning, undefined);
});

test("timeline entries append once after recognized extension compaction only", async () => {
  const { pi } = await compactCurrentBranch([]);
  const compact = pi.handlers.get("session_compact");
  const entry = { id: "compact-1", type: "compaction", details: { schemaVersion: 1, state: "remote_applied", identity: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://secret.example/v1", model: "secret-model" }, checkpoint: { artifact: ["secret"], hash: "secret", length: 6 } } };
  compact({ compactionEntry: entry, fromExtension: true });
  compact({ compactionEntry: entry, fromExtension: true });
  compact({ compactionEntry: { ...entry, id: "compact-2" }, fromExtension: false });
  compact({ compactionEntry: { id: "compact-3", type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } }, fromExtension: true });
  assert.deepEqual(pi.appended, [
    { type: "pi-openai-blackmagic-compact/compaction-timeline/1", data: { method: "remote_responses_v1" } },
    { type: "pi-openai-blackmagic-compact/compaction-timeline/1", data: { method: "local_fallback", failureClass: "timeout" } },
  ]);
  const renderer = pi.renderers.get("pi-openai-blackmagic-compact/compaction-timeline/1");
  assert.ok(renderer({ data: pi.appended[0].data }, {}, { bg: (_key, text) => text, fg: (_key, text) => text }));
  assert.equal(renderer({ data: { method: "secret-model" } }, {}, { bg: (_key, text) => text, fg: (_key, text) => text }), undefined);
});

test("supported serialization, remote, and post-segment failures cancel without Session mutation", async () => {
  async function run({ getSystemPrompt = () => "system", fetchImpl }) {
    const session = SessionManager.inMemory("/tmp");
    const first = session.appendMessage({ role: "user", content: [{ type: "text", text: "unchanged" }], timestamp: 1 });
    const before = structuredClone(session.getBranch());
    const pi = fakePi();
    createServerCompactionController(pi, { fetchImpl });
    const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: session, getSystemPrompt, thinkingLevel: "high" };
    const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(first), branchEntries: session.getBranch(), signal: new AbortController().signal }, ctx);
    assert.deepEqual(result, { cancel: true });
    assert.deepEqual(session.getBranch(), before);
  }
  let serializationRemoteCalls = 0;
  await run({ getSystemPrompt: () => { throw new Error("serialization unavailable"); }, fetchImpl: async () => { serializationRemoteCalls += 1; } });
  assert.equal(serializationRemoteCalls, 0);
  let remoteCalls = 0;
  await run({ fetchImpl: async () => { remoteCalls += 1; return { ok: false, status: 500, json: async () => ({}) }; } });
  assert.equal(remoteCalls, 1);
  let promptCalls = 0; let postRemoteCalls = 0;
  await run({
    getSystemPrompt: () => { promptCalls += 1; if (promptCalls === 2) throw new Error("post segment unavailable"); return "system"; },
    fetchImpl: async () => { postRemoteCalls += 1; return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque" }] }) }; },
  });
  assert.equal(postRemoteCalls, 1);
});

test("mismatch compaction uses visible History and establishes a new ready checkpoint", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "old branch" }], timestamp: 1 }]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: [{ type: "text", text: "new visible work" }], timestamp: 2 });
  const selectedModel = { ...model, id: "gpt-5.1", name: "gpt-5.1" };
  const pi = fakePi(); let request;
  createServerCompactionController(pi, { fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "new-opaque" }] }) }; } });
  const branchEntries = first.session.getBranch();
  const statuses = [];
  const ctx = { ...first.ctx, model: selectedModel, ui: { setStatus: (...args) => statuses.push(args) } };
  await pi.handlers.get("session_start")({}, ctx);
  assert.match(statuses.at(-1)[1], /cannot replay/);
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal: new AbortController().signal }, ctx);
  assert.equal(result.compaction.details.identity.model, "gpt-5.1");
  assert.equal(result.compaction.summary, BLACKMAGIC_COMPACTION_MARKER);
  assert.doesNotMatch(JSON.stringify(request), /\"encrypted_content\":\"opaque\"/);
  assert.match(JSON.stringify(request), /new visible work/);
  assert.match(statuses.at(-1)[1], /cannot replay/, "uncommitted handler results must not change footer state");
  first.session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true);
  await pi.handlers.get("session_compact")({ fromExtension: true, compactionEntry: first.session.getBranch().findLast((entry) => entry.type === "compaction") }, ctx);
  assert.equal(statuses.at(-1)[1], undefined, "committed compaction recomputes and clears the footer");
});

test("state hooks restore and clear the single mismatch footer without intercepting input", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }]);
  let branch = [{ id: "remote", type: "compaction", summary: BLACKMAGIC_COMPACTION_MARKER, details: first.result.compaction.details }];
  const pi = fakePi();
  createServerCompactionController(pi);
  const statuses = [];
  const context = (selectedModel) => ({ model: selectedModel, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: { getBranch: () => branch }, ui: { setStatus: (...args) => statuses.push(args) } });
  const mismatch = context({ ...model, id: "gpt-5.1" });
  await pi.handlers.get("session_start")({}, mismatch);
  assert.match(statuses.at(-1)[1], /cannot replay/);
  const matching = context(model);
  await pi.handlers.get("model_select")({}, matching);
  assert.equal(statuses.at(-1)[1], undefined);
  const payload = { model: "gpt-5.1", input: [{ role: "user", content: "visible" }] };
  assert.deepEqual(await pi.handlers.get("before_provider_request")({ payload }, mismatch), payload);
  assert.match(statuses.at(-1)[1], /cannot replay/);
  branch = [{ type: "message", role: "user" }];
  await pi.handlers.get("session_tree")({}, mismatch);
  assert.equal(statuses.at(-1)[1], undefined);
  await pi.handlers.get("session_compact")({ fromExtension: false, compactionEntry: { id: "native", type: "compaction", summary: "readable" } }, mismatch);
  assert.equal(statuses.at(-1)[1], undefined);
  await pi.handlers.get("session_start")({}, mismatch);
  assert.equal(statuses.at(-1)[1], undefined);
  assert.equal(pi.handlers.has("input"), false);
});

test("unsupported and unauthorized routes delegate to Pi without remote or summary work", async () => {
  const entry = { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 };
  const { result, pi, ctx } = await compactCurrentBranch([entry]);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(pi.handlers.has("message_end"), false);
  let remoteCalls = 0; let summaryCalls = 0;
  const delegatedPi = fakePi();
  createServerCompactionController(delegatedPi, { summaryFactory: () => { summaryCalls += 1; }, fetchImpl: async () => { remoteCalls += 1; throw new Error("remote must not run"); } });
  const event = { preparation: preparation("x"), branchEntries: [], signal: new AbortController().signal };
  const unsupported = await delegatedPi.handlers.get("session_before_compact")(event, { ...ctx, model: { ...model, baseUrl: "https://proxy.invalid/v1" } });
  const unauthorized = await delegatedPi.handlers.get("session_before_compact")(event, { ...ctx, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false }) } });
  assert.equal(unsupported, undefined);
  assert.equal(unauthorized, undefined);
  assert.equal(remoteCalls, 0);
  assert.equal(summaryCalls, 0);
});
