import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { captureNativeBody, createServerCompactionController, projectSavedCheckpoint, serializationOptions } from "../src/controller.mjs";
import { sha256 } from "../src/contract.mjs";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai", id: "gpt-5", name: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" }, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const switchedModel = { ...model, id: "gpt-5-mini", name: "gpt-5-mini" };
const auth = { ok: true, apiKey: "synthetic-key", headers: { "x-test": "yes" } };
const tool = { name: "probe", description: "Probe the current branch", parameters: { type: "object", properties: {} } };
function fakePi() { const handlers = new Map(); const renderers = new Map(); const appended = []; return { on: (name, handler) => handlers.set(name, handler), registerCommand(name, command) { this.command = command; }, registerEntryRenderer: (type, renderer) => renderers.set(type, renderer), appendEntry: (type, data) => appended.push({ type, data }), getActiveTools: () => ["probe"], getAllTools: () => [tool], handlers, renderers, appended }; }
function assistantToolCall() { return { role: "assistant", content: [{ type: "thinking", thinking: "reasoning before the probe" }, { type: "toolCall", id: "call-1", name: "probe", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 6 }; }
function preparation(firstKeptEntryId) { return { firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } }; }

async function compactCurrentBranch(entries, contextOverrides = {}) {
  const session = SessionManager.inMemory("/tmp");
  let first;
  for (const message of entries) { const id = session.appendMessage(message); first ??= id; }
  const pi = fakePi(); let request;
  createServerCompactionController(pi, { fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque" }], usage: { input_tokens: 3 } }) }; } });
  const ctx = { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: session, getSystemPrompt: () => "direct system prompt", thinkingLevel: "high", ...contextOverrides };
  const branchEntries = session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(first), branchEntries, reason: "manual", signal: new AbortController().signal }, ctx);
  return { result, request, pi, ctx, session };
}
async function mixedModelSwitchSetup() {
  const first = await compactCurrentBranch([
    { role: "user", content: [{ type: "text", text: "before model switch" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "reasoning before the answer" }, { type: "text", text: "assistant history" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 2 },
    assistantToolCall(),
    { role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "text", text: "tool history" }], isError: false, timestamp: 7 },
  ]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: [{ type: "text", text: "after model switch" }], timestamp: 8 });
  return { first, ctx: { ...first.ctx, model: switchedModel }, branchEntries: first.session.getBranch() };
}

test("direct compaction serializes canonical current-branch messages and persists an empty summary", async () => {
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
  const { result, request, session } = await compactCurrentBranch(entries);
  assert.equal(result.compaction.details.state, "remote_applied", JSON.stringify(result));
  assert.equal(result.compaction.summary, "", "remote compaction must not create a native text summary");
  session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true);
  assert.equal(session.getBranch().at(-1).summary, "", "Pi's persisted compaction entry must have an empty summary");
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

test("one resolved authorization snapshot serves the full compaction attempt", async () => {
  let lookups = 0;
  const { result } = await compactCurrentBranch(
    [{ role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 }],
    { modelRegistry: { getApiKeyAndHeaders: async () => { lookups += 1; return auth; } } },
  );
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(lookups, 1);
});

test("direct compaction applies the latest persisted checkpoint to the derived body", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "old branch" }], timestamp: 1 }]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: [{ type: "text", text: "later branch" }], timestamp: 2 });
  const pi = fakePi(); let request;
  createServerCompactionController(pi, { fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque-2" }] }) }; } });
  const branchEntries = first.session.getBranch();
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal: new AbortController().signal }, first.ctx);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.match(JSON.stringify(request), /opaque/);
  assert.doesNotMatch(JSON.stringify(request), /old branch/);
});

test("post-compaction serialization is verified before the remote request", async () => {
  let serializationCount = 0;
  const { result, request } = await compactCurrentBranch(
    [{ role: "user", content: [{ type: "text", text: "ordinary user" }], timestamp: 1 }],
    { getSystemPrompt: () => { serializationCount += 1; if (serializationCount === 2) throw new Error("synthetic post-compaction serialization failed"); return "direct system prompt"; } },
  );
  assert.equal(result, undefined, "Pi must perform its native fallback after a failed continuation preflight");
  assert.equal(request, undefined, "a failed continuation preflight must not send a remote compaction request");
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

test("timeline ownership follows the current Session leaf and rejects native leaves", () => {
  const remote = (surface, protocol) => ({ schemaVersion: 1, state: "remote_applied", identity: { surface, protocol } });
  const stale = { id: "stale", type: "compaction", details: remote("openai_api", "responses_compact_v1") };
  const current = { id: "current", type: "compaction", details: remote("chatgpt_codex", "codex_compaction_trigger_v2") };
  const session = { getLeafId: () => current.id, getBranch: () => [stale, current] };
  const pi = fakePi();
  createServerCompactionController(pi);
  const compact = pi.handlers.get("session_compact");
  compact({ compactionEntry: stale, fromExtension: true }, { sessionManager: session });
  compact({ compactionEntry: stale, fromExtension: true }, { sessionManager: session });
  assert.deepEqual(pi.appended, [{ type: "pi-openai-blackmagic-compact/compaction-timeline/1", data: { method: "remote_codex_v2" } }]);

  const fallbackPi = fakePi();
  createServerCompactionController(fallbackPi);
  const fallback = fallbackPi.handlers.get("session_compact");
  fallback({ compactionEntry: stale, fromExtension: true }, { sessionManager: { getLeafId: () => "message", getBranch: () => [{ id: "message", type: "message" }] } });
  assert.deepEqual(fallbackPi.appended[0].data, { method: "remote_responses_v1" });

  for (const details of [{ schemaVersion: 1, state: "native" }, { schemaVersion: 1, state: "remote_applied", identity: { surface: "unsupported", protocol: "unsupported" } }]) {
    const leaf = { id: "blocked", type: "compaction", details };
    const blockedPi = fakePi();
    createServerCompactionController(blockedPi);
    blockedPi.handlers.get("session_compact")({ compactionEntry: stale, fromExtension: true }, { sessionManager: { getLeafId: () => leaf.id, getBranch: () => [stale, leaf] } });
    assert.deepEqual(blockedPi.appended, []);
  }
});

test("remote timeline expands the saved checkpoint without a second summary", () => {
  const session = SessionManager.inMemory("/tmp");
  const anchor = session.appendMessage({ role: "user", content: [{ type: "text", text: "anchor" }], timestamp: 1 });
  const artifact = [
    { role: "user", content: [{ type: "input_text", text: "saved user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "saved assistant" }] },
    { type: "compaction", encrypted_content: "opaque-prefix" },
  ];
  const compactionId = session.appendCompaction("", anchor, 2, { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact } }, true);
  const archive = projectSavedCheckpoint(session, compactionId);
  assert.deepEqual(archive.retainedUsers, ["saved user"]);
  assert.equal(archive.encryptedPrefix, "opaque-prefix");

  const pi = fakePi();
  createServerCompactionController(pi);
  pi.handlers.get("session_start")({}, { sessionManager: session });
  const renderer = pi.renderers.get("pi-openai-blackmagic-compact/compaction-timeline/1");
  const entry = { type: "custom", parentId: compactionId, data: { method: "remote_responses_v1" } };
  const theme = { bg: (_key, text) => text, fg: (_key, text) => text };
  assert.doesNotMatch(renderer(entry, { expanded: false }, theme).render(100).join("\n"), /saved user/);
  const expanded = renderer(entry, { expanded: true }, theme).render(100).join("\n");
  assert.match(expanded, /saved user/);
  assert.doesNotMatch(expanded, /saved assistant/);
  assert.doesNotMatch(JSON.stringify({ method: "remote_responses_v1" }), /saved user/, "timeline persistence does not duplicate artifact records");
});

test("direct compaction is independent of auxiliary provider requests and defers unsupported models to Pi", async () => {
  const entry = { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 };
  const { result, pi, ctx } = await compactCurrentBranch([entry]);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(pi.handlers.has("message_end"), false);
  const unsupported = await pi.handlers.get("session_before_compact")({ preparation: preparation("x"), branchEntries: [], signal: new AbortController().signal }, { ...ctx, model: { ...model, baseUrl: "https://proxy.invalid/v1" } });
  assert.equal(unsupported, undefined, "Pi must perform its native fallback for an unsupported model");
});

test("legacy lineage replay keeps the next compaction ready after serializer drift", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "legacy drift source" }], timestamp: 1 }]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: [{ type: "text", text: "legacy drift descendant" }], timestamp: 2 });
  const branchEntries = first.session.getBranch().map((entry) => entry.type === "compaction" ? {
    ...entry,
    details: { ...entry.details, replay: { namespace: entry.details.replay.namespace, replacedItemHashes: ["0".repeat(64)] } },
  } : entry);
  let fetchCalls = 0;
  const pi = fakePi();
  createServerCompactionController(pi, { fetchImpl: async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "legacy-next" }] }) }; } });
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal: new AbortController().signal }, first.ctx);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(fetchCalls, 1);
});

test("eligible model switch preserves checkpoint replay and permits the next compaction", async () => {
  const { first, ctx: switchedContext, branchEntries: initialBranch } = await mixedModelSwitchSetup();
  const pi = fakePi();
  let request;
  createServerCompactionController(pi, {
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque-next" }] }) };
    },
  });
  const notices = [];
  const ctx = { ...switchedContext, hasUI: true, ui: { notify: (...notice) => notices.push(notice) } };
  await pi.command.handler("", ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /ready to attempt/i);
  assert.equal(notices[0][1], "info");

  const branchEntries = initialBranch;
  const signal = new AbortController().signal;
  const nativePayload = await captureNativeBody(switchedModel, {
    systemPrompt: ctx.getSystemPrompt(),
    messages: convertToLlm(buildSessionContext(branchEntries).messages),
    tools: [tool],
  }, serializationOptions(ctx, auth, signal));
  const replayed = await pi.handlers.get("before_provider_request")({ payload: nativePayload }, ctx);
  assert.ok(replayed, "normal provider requests must retain the persisted replay");
  assert.match(JSON.stringify(replayed.input), /opaque/);

  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal }, ctx);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.match(JSON.stringify(request), /opaque/);
});

test("v1 replay survives restart and repeated model-switch compactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-replay-"));
  const sessions = join(root, "sessions");
  try {
    await mkdir(sessions, { recursive: true });
    const session = SessionManager.create(root, sessions);
    const firstId = session.appendMessage({ role: "user", content: [{ type: "text", text: "restart source" }], timestamp: 1 });
    session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "restart reasoning" }, { type: "text", text: "restart answer" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 2 });
    session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "restart tool reasoning" }, { type: "toolCall", id: "restart-call", name: "probe", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 3 });
    session.appendMessage({ role: "toolResult", toolCallId: "restart-call", toolName: "probe", content: [{ type: "text", text: "restart tool result" }], isError: false, timestamp: 4 });
    const firstPi = fakePi();
    createServerCompactionController(firstPi, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque-first" }] }) }) });
    const producerCtx = { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: session, getSystemPrompt: () => "restart system", thinkingLevel: "high" };
    const firstResult = await firstPi.handlers.get("session_before_compact")({ preparation: preparation(firstId), branchEntries: session.getBranch(), signal: new AbortController().signal }, producerCtx);
    assert.equal(firstResult.compaction.details.schemaVersion, 1);
    session.appendCompaction(firstResult.compaction.summary, firstResult.compaction.firstKeptEntryId, firstResult.compaction.tokensBefore, firstResult.compaction.details, true);
    session.appendMessage({ role: "user", content: [{ type: "text", text: "after restart checkpoint" }], timestamp: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const reopened = SessionManager.open(session.getSessionFile(), sessions, root);
    const persisted = reopened.getBranch().find((entry) => entry.type === "compaction");
    assert.equal(persisted.details.schemaVersion, 1);
    const requests = [];
    const secondPi = fakePi();
    createServerCompactionController(secondPi, { fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: `opaque-${requests.length + 1}` }] }) }; } });
    const notices = [];
    const switchedCtx = { ...producerCtx, model: switchedModel, sessionManager: reopened, hasUI: true, ui: { notify: (...notice) => notices.push(notice) } };
    await secondPi.command.handler("", switchedCtx);
    assert.match(notices[0][0], /ready to attempt/i);

    const branchAfterRestart = reopened.getBranch();
    const signal = new AbortController().signal;
    const payloadAfterRestart = await captureNativeBody(switchedModel, { systemPrompt: switchedCtx.getSystemPrompt(), messages: convertToLlm(buildSessionContext(branchAfterRestart).messages), tools: [tool] }, serializationOptions(switchedCtx, auth, signal));
    const replayedAfterRestart = await secondPi.handlers.get("before_provider_request")({ payload: payloadAfterRestart }, switchedCtx);
    assert.equal(replayedAfterRestart.input.some((item) => item.encrypted_content === "opaque-first"), true);

    const secondResult = await secondPi.handlers.get("session_before_compact")({ preparation: preparation(branchAfterRestart[0].id), branchEntries: branchAfterRestart, signal }, switchedCtx);
    assert.equal(secondResult.compaction.details.state, "remote_applied");
    reopened.appendCompaction(secondResult.compaction.summary, secondResult.compaction.firstKeptEntryId, secondResult.compaction.tokensBefore, secondResult.compaction.details, true);
    reopened.appendMessage({ role: "user", content: [{ type: "text", text: "after repeated checkpoint" }], timestamp: 6 });

    const branchAfterRepeat = reopened.getBranch();
    const repeatedPayload = await captureNativeBody(switchedModel, { systemPrompt: switchedCtx.getSystemPrompt(), messages: convertToLlm(buildSessionContext(branchAfterRepeat).messages), tools: [tool] }, serializationOptions(switchedCtx, auth, new AbortController().signal));
    const repeatedReplay = await secondPi.handlers.get("before_provider_request")({ payload: repeatedPayload }, switchedCtx);
    assert.equal(repeatedReplay.input.some((item) => item.encrypted_content === "opaque-2"), true);
    const thirdResult = await secondPi.handlers.get("session_before_compact")({ preparation: preparation(branchAfterRepeat[0].id), branchEntries: branchAfterRepeat, signal: new AbortController().signal }, switchedCtx);
    assert.equal(thirdResult.compaction.details.state, "remote_applied");
    assert.equal(requests.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lineage fallback does not authenticate an altered retained source", async () => {
  const { ctx, branchEntries } = await mixedModelSwitchSetup();
  const checkpoint = branchEntries.find((entry) => entry.type === "compaction");
  const originalHashes = structuredClone(checkpoint.details.replay.replacedItemHashes);
  const retained = branchEntries.find((entry) => entry.type === "message" && entry.message.role === "user");
  const alteredBranch = branchEntries.map((entry) => entry.id === retained.id ? {
    ...entry,
    message: { ...entry.message, content: [{ type: "text", text: "altered retained source" }] },
  } : entry);
  assert.deepEqual(checkpoint.details.replay.replacedItemHashes, originalHashes);
  let fetchCalls = 0;
  const pi = fakePi();
  createServerCompactionController(pi, { fetchImpl: async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "lineage-opaque" }] }) }; } });
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(alteredBranch[0].id), branchEntries: alteredBranch, signal: new AbortController().signal }, ctx);
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(fetchCalls, 1, "lineage fallback may proceed without historical hash authentication");
});

test("native mixed-history replay rejects tampered current-model payload", async () => {
  const { ctx, branchEntries } = await mixedModelSwitchSetup();
  const signal = new AbortController().signal;
  const nativePayload = await captureNativeBody(switchedModel, {
    systemPrompt: ctx.getSystemPrompt(),
    messages: convertToLlm(buildSessionContext(branchEntries).messages),
    tools: [tool],
  }, serializationOptions(ctx, auth, signal));
  const tamperIndex = nativePayload.input.findIndex((item) => item.role === "user" && Array.isArray(item.content));
  assert.notEqual(tamperIndex, -1, "mixed native payload must include retained user content");
  const tamperedItem = nativePayload.input[tamperIndex];
  nativePayload.input[tamperIndex] = { ...tamperedItem, content: [{ ...tamperedItem.content[0], text: "tampered current-model payload" }] };
  const pi = fakePi();
  createServerCompactionController(pi);
  const replayed = await pi.handlers.get("before_provider_request")({ payload: nativePayload }, ctx);
  assert.equal(replayed, undefined, "tampered provider payload must not be accepted or rehashed");
});

test("model switch uses active lineage after a persisted replay segment mismatch", async () => {
  const first = await compactCurrentBranch([{ role: "user", content: [{ type: "text", text: "branch mismatch anchor" }], timestamp: 1 }]);
  first.session.appendCompaction(first.result.compaction.summary, first.result.compaction.firstKeptEntryId, first.result.compaction.tokensBefore, first.result.compaction.details, true);
  first.session.appendMessage({ role: "user", content: [{ type: "text", text: "descendant" }], timestamp: 2 });
  const branchEntries = first.session.getBranch().map((entry) => entry.type === "compaction" ? {
    ...entry,
    details: { ...entry.details, replay: { ...entry.details.replay, replacedItemHashes: [sha256({ role: "user", content: "absent from branch" })] } },
  } : entry);
  let fetchCalls = 0;
  const pi = fakePi();
  createServerCompactionController(pi, { fetchImpl: async () => { fetchCalls += 1; return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "lineage-opaque" }] }) }; } });
  const result = await pi.handlers.get("session_before_compact")({ preparation: preparation(branchEntries[0].id), branchEntries, signal: new AbortController().signal }, { ...first.ctx, model: switchedModel });
  assert.equal(result.compaction.details.state, "remote_applied");
  assert.equal(fetchCalls, 1, "active lineage must handle serializer drift after direct mismatch");
});
