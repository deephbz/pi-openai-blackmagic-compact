import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { captureNativeBody, createServerCompactionController, projectSavedCheckpoint, serializationOptions } from "../src/controller.mjs";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai", id: "gpt-5", name: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses", input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" }, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const auth = { ok: true, apiKey: "synthetic-key", headers: { "x-test": "yes" } };
const tool = { name: "probe", description: "Probe the current branch", parameters: { type: "object", properties: {} } };
function fakePi() { const handlers = new Map(); const renderers = new Map(); const appended = []; return { on: (name, handler) => handlers.set(name, handler), registerCommand() {}, registerEntryRenderer: (type, renderer) => renderers.set(type, renderer), appendEntry: (type, data) => appended.push({ type, data }), getActiveTools: () => ["probe"], getAllTools: () => [tool], handlers, renderers, appended }; }
function assistantToolCall() { return { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 6 }; }
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
