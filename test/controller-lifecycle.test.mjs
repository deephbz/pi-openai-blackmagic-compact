import test from "node:test";
import assert from "node:assert/strict";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { captureNativeBody, createServerCompactionController, serializationOptions } from "../src/controller.mjs";
import { BLACKMAGIC_APPLIED_NOTICE, BLACKMAGIC_MODEL_SUMMARY } from "../src/state-machine.mjs";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai", id: "gpt-5", name: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" }, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const auth = { ok: true, apiKey: "synthetic-key", headers: { "x-test": "yes" } };
const tool = { name: "probe", description: "Probe the current branch", parameters: { type: "object", properties: {} } };
function fakePi() { const handlers = new Map(); return { on: (name, handler) => handlers.set(name, handler), registerCommand() {}, getActiveTools: () => ["probe"], getAllTools: () => [tool], handlers }; }
function assistantToolCall() { return { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 6 }; }
function preparation(firstKeptEntryId) { return { firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } }; }

async function compactCurrentBranch(entries, options = {}) {
  const session = SessionManager.inMemory("/tmp");
  let first;
  for (const message of entries) { const id = session.appendMessage(message); first ??= id; }
  const pi = fakePi();
  let request;
  let remoteCalls = 0;
  createServerCompactionController(pi, { fetchImpl: options.fetchImpl ?? (async (_url, requestOptions) => {
    remoteCalls += 1;
    request = JSON.parse(requestOptions.body);
    return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque" }] }) };
  }) });
  const ctx = { model: options.model ?? model, modelRegistry: { getApiKeyAndHeaders: async () => options.auth ?? auth }, sessionManager: session, getSystemPrompt: () => "direct system prompt", thinkingLevel: "high" };
  const branchEntries = session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(first), branchEntries, reason: "manual", signal: new AbortController().signal }, ctx);
  return { result, request, pi, ctx, session, remoteCalls };
}

test("server compaction serializes the canonical current branch and skips native summary", async () => {
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
  const { result, request, remoteCalls } = await compactCurrentBranch(entries);
  assert.equal(result.compaction.summary, BLACKMAGIC_MODEL_SUMMARY);
  assert.equal(result.compaction.details.type, "pi-openai-blackmagic-compact");
  assert.deepEqual(result.compaction.details.input, [{ type: "compaction", encrypted_content: "opaque" }]);
  assert.equal(remoteCalls, 1);
  const serialized = JSON.stringify(request);
  for (const text of ["direct system prompt", "custom handoff", "branch summary", "old summary", "Ran `pwd`", "tool result", "probe"]) assert.match(serialized, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /hidden/);
});

test("a later compaction applies the active provider checkpoint first", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: "old branch", timestamp: 1 }]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: "later branch", timestamp: 2 });
  const pi = fakePi();
  let request;
  createServerCompactionController(pi, { fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque-2" }] }) }; } });
  const branchEntries = first.session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal: new AbortController().signal }, first.ctx);
  assert.equal(result.compaction.details.type, "pi-openai-blackmagic-compact");
  assert.match(JSON.stringify(request), /opaque/);
  assert.doesNotMatch(JSON.stringify(request), /old branch/);
});

test("native serialization probe carries reasoning and Session identity without network", async () => {
  let networkCalled = false;
  const options = serializationOptions({ thinkingLevel: "high", sessionManager: { getSessionId: () => "session-1" } }, auth, new AbortController().signal);
  const body = await captureNativeBody(model, { systemPrompt: "probe system", messages: [], tools: [tool] }, { ...options, fetch() { networkCalled = true; throw new Error("network must not run"); } });
  assert.equal(body.reasoning?.effort, "high");
  assert.match(JSON.stringify(body), /probe system|probe/);
  assert.equal(networkCalled, false);
});

test("successful compaction uses one Pi entry and human-only TUI text", async () => {
  const { result, pi, ctx } = await compactCurrentBranch([]);
  const notices = [];
  const statuses = [];
  ctx.mode = "tui";
  ctx.ui = { setStatus: (...args) => statuses.push(args), notify: (...args) => notices.push(args) };
  assert.equal(result.compaction.summary, "");
  assert.doesNotMatch(JSON.stringify(result.compaction.details), /Server-side compaction applied|Keep this provider/);
  const compactionEntry = { id: "compact-1", type: "compaction", ...result.compaction };
  ctx.sessionManager.appendCompaction(
    result.compaction.summary,
    result.compaction.firstKeptEntryId,
    result.compaction.tokensBefore,
    result.compaction.details,
    true,
  );
  await pi.handlers.get("session_compact")({ compactionEntry, fromExtension: true }, ctx);
  await pi.handlers.get("session_tree")({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(notices, [], "tree selection clears a pending acknowledgement");
  const staleSameSummaryEntry = { ...compactionEntry, details: { schemaVersion: 1, state: "remote_applied" } };
  await pi.handlers.get("session_compact")({ compactionEntry: staleSameSummaryEntry, fromExtension: true }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(notices.at(-1), [BLACKMAGIC_APPLIED_NOTICE, "info"]);
  assert.match(statuses.at(-1)[1], /keep this provider/);
});

test("human TUI text never enters matching model input", async () => {
  const current = await compactCurrentBranch([{ role: "user", content: "old branch", timestamp: 1 }]);
  current.session.appendCompaction(current.result.compaction.summary, current.result.compaction.firstKeptEntryId, current.result.compaction.tokensBefore, current.result.compaction.details, true);
  const messages = current.session.buildSessionContext().messages;
  const payload = await captureNativeBody(model, { systemPrompt: "system", messages: convertToLlm(messages), tools: [tool] }, serializationOptions(current.ctx, auth));
  const replayed = await current.pi.handlers.get("before_provider_request")({ payload }, current.ctx);
  assert.match(JSON.stringify(replayed), /encrypted_content/);
  assert.doesNotMatch(JSON.stringify(replayed), /Server-side compaction applied|Keep this provider/);
});

test("supported failures cancel without mutating the Session", async () => {
  async function run({ getSystemPrompt = () => "system", fetchImpl }) {
    const session = SessionManager.inMemory("/tmp");
    const first = session.appendMessage({ role: "user", content: "unchanged", timestamp: 1 });
    const before = structuredClone(session.getBranch());
    const pi = fakePi();
    createServerCompactionController(pi, { fetchImpl });
    const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: session, getSystemPrompt, thinkingLevel: "high" };
    const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(first), branchEntries: session.getBranch(), signal: new AbortController().signal }, ctx);
    assert.deepEqual(result, { cancel: true });
    assert.deepEqual(session.getBranch(), before);
  }
  await run({ getSystemPrompt: () => { throw new Error("serialization unavailable"); }, fetchImpl: async () => { throw new Error("must not run"); } });
  await run({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
});

test("switching models on one provider stays ready and replays", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: "old", timestamp: 1 }]);
  const branch = [{ id: "remote", type: "compaction", summary: "", details: first.result.compaction.details }];
  const pi = fakePi();
  createServerCompactionController(pi);
  const statuses = [];
  const switched = { ...first.ctx, model: { ...model, id: "gpt-5.1" }, sessionManager: { getBranch: () => branch }, ui: { setStatus: (...args) => statuses.push(args) } };
  await pi.handlers.get("model_select")({}, switched);
  assert.match(statuses.at(-1)[1], /keep this provider/);
});

test("switching providers warns without blocking actions", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: "old", timestamp: 1 }]);
  let branch = [{ id: "remote", type: "compaction", summary: "", details: first.result.compaction.details }];
  const pi = fakePi();
  createServerCompactionController(pi);
  const statuses = [];
  const codexModel = { ...model, provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", id: "gpt-5.6-sol" };
  const ctx = { ...first.ctx, model: codexModel, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "e30.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdCJ9fQ.test" }) }, sessionManager: { getBranch: () => branch }, ui: { setStatus: (...args) => statuses.push(args) } };
  await pi.handlers.get("model_select")({}, ctx);
  assert.match(statuses.at(-1)[1], /History unavailable/);
  assert.equal(pi.handlers.has("input"), false);
  branch = [{ type: "message", role: "user" }];
  await pi.handlers.get("session_tree")({}, ctx);
  assert.equal(statuses.at(-1)[1], undefined);
  await pi.handlers.get("session_shutdown")({}, ctx);
  assert.equal(statuses.at(-1)[1], undefined);
});

test("unsupported and unauthorized providers delegate to Pi", async () => {
  const pi = fakePi();
  let remoteCalls = 0;
  createServerCompactionController(pi, { fetchImpl: async () => { remoteCalls += 1; } });
  const event = { preparation: preparation("x"), branchEntries: [], signal: new AbortController().signal };
  const base = { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: SessionManager.inMemory("/tmp"), getSystemPrompt: () => "system" };
  assert.equal(await pi.handlers.get("session_before_compact")(event, { ...base, model: { ...model, baseUrl: "https://proxy.invalid/v1" } }), undefined);
  assert.equal(await pi.handlers.get("session_before_compact")(event, { ...base, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false }) } }), undefined);
  assert.equal(remoteCalls, 0);
});
