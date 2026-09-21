import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { checkpointDetails, sha256 } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

const baseModel = {
  id: "gpt-5",
  name: "gpt-5",
  input: ["text"],
  reasoning: true,
  thinkingLevelMap: { off: "off" },
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const openAIModel = { ...baseModel, provider: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-responses" };
const azureModel = { ...baseModel, provider: "azure-openai-responses", baseUrl: "https://resource.openai.azure.com/openai/v1", api: "azure-openai-responses" };
const codexModel = { ...baseModel, provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses" };

function codexToken(accountId = "acct-synthetic") {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url");
  return `e30.${payload}.synthetic-signature`;
}
function fakePi() {
  let command;
  const commands = [];
  const appended = [];
  return {
    on() {},
    registerCommand(name, value) { command = value; commands.push(name); },
    registerEntryRenderer() {},
    appendEntry(...args) { appended.push(args); },
    getActiveTools: () => [],
    getAllTools: () => [],
    get command() { return command; },
    get commands() { return commands; },
    get appended() { return appended; },
  };
}
function sessionWithContext() {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage({ role: "user", content: [{ type: "text", text: "synthetic readiness context" }], timestamp: 1 });
  return session;
}
function statusContext({ model, session, auth, onAuth } = {}) {
  return {
    hasUI: true,
    model: model ?? openAIModel,
    modelRegistry: {
      getApiKeyAndHeaders: async (resolvedModel) => {
        onAuth?.(resolvedModel);
        return auth ?? { ok: true, apiKey: "synthetic-key" };
      },
    },
    sessionManager: session ?? sessionWithContext(),
    getSystemPrompt: () => "synthetic system prompt",
    thinkingLevel: "off",
    ui: { notify: () => {} },
  };
}

async function runStatusContext(ctx, { fetchImpl, args = "" } = {}) {
  const pi = fakePi();
  createServerCompactionController(pi, { fetchImpl });
  const notices = [];
  ctx.ui.notify = (...notice) => notices.push(notice);
  await pi.command.handler(args, ctx);
  return { notices, session: ctx.sessionManager, pi };
}
async function runStatus({ model, session, auth, onAuth, fetchImpl, args = "" } = {}) {
  return runStatusContext(statusContext({ model, session, auth, onAuth }), { fetchImpl, args });
}

test("status reports readiness once without provider egress or session mutation", async () => {
  let fetchCalls = 0;
  let authCalls = 0;
  const session = sessionWithContext();
  const before = JSON.stringify(session.getBranch());
  const result = await runStatus({ session, fetchImpl: async () => { fetchCalls += 1; } , onAuth: () => { authCalls += 1; } });
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0][0], /^Blackmagic remote compaction: ready to attempt/i);
  assert.equal(result.notices[0][1], "info");
  assert.equal(authCalls, 1);
  assert.equal(fetchCalls, 0, "readiness must not call the compaction endpoint");
  assert.equal(JSON.stringify(session.getBranch()), before, "readiness must not mutate session state");
  assert.doesNotMatch(result.notices[0][0], /synthetic-key|api\.openai\.com|system prompt/i);
});

test("status rejects malformed Codex credentials with an authorization reason", async () => {
  const result = await runStatus({ model: codexModel, auth: { ok: true, apiKey: "malformed-codex-credential" } });
  assert.equal(result.notices.length, 1);
  assert.doesNotMatch(result.notices[0][0], /ready to attempt/i);
  assert.match(result.notices[0][0], /authorization|account identity/i);
});

test("status uses the effective auth environment route, not only the display model route", async () => {
  const result = await runStatus({ auth: { ok: true, apiKey: "synthetic-key", env: { OPENAI_BASE_URL: "https://proxy.invalid/v1" } } });
  assert.equal(result.notices.length, 1);
  assert.doesNotMatch(result.notices[0][0], /ready to attempt/i);
  assert.match(result.notices[0][0], /unsupported provider route/i);
});

test("status rejects missing, undefined, and failed authorization resolutions", async () => {
  const cases = [
    { name: "missing resolver", modelRegistry: undefined },
    { name: "undefined auth", modelRegistry: { getApiKeyAndHeaders: async () => undefined } },
    { name: "missing ok flag", modelRegistry: { getApiKeyAndHeaders: async () => ({ apiKey: "synthetic-key" }) } },
    { name: "throwing resolver", modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("synthetic resolver failure"); } } },
  ];
  for (const scenario of cases) {
    const ctx = statusContext();
    ctx.modelRegistry = scenario.modelRegistry;
    const result = await runStatusContext(ctx);
    assert.equal(result.notices.length, 1, scenario.name);
    assert.doesNotMatch(result.notices[0][0], /ready to attempt/i, scenario.name);
    assert.match(result.notices[0][0], /authorization unavailable/i, scenario.name);
  }
});

test("status gives one actionable usage error for invalid arguments", async () => {
  const result = await runStatus({ args: "unexpected argument" });
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0][1], "warning");
  assert.match(result.notices[0][0], /usage/i);
  assert.match(result.notices[0][0], /blackmagic-status/);
});

test("status is not ready when the current model changes during authorization", async () => {
  const session = sessionWithContext();
  const oldModel = openAIModel;
  let releaseAuth;
  const authReady = new Promise((resolve) => { releaseAuth = resolve; });
  let resolvedModel;
  const pi = fakePi();
  createServerCompactionController(pi);
  const notices = [];
  const ctx = statusContext({ model: oldModel, session, onAuth: (model) => { resolvedModel = model; } });
  ctx.modelRegistry.getApiKeyAndHeaders = async (model) => {
    resolvedModel = model;
    await authReady;
    return { ok: true, apiKey: "synthetic-key" };
  };
  ctx.ui.notify = (...notice) => notices.push(notice);
  const pending = pi.command.handler("", ctx);
  ctx.model = azureModel;
  releaseAuth();
  await pending;
  assert.equal(resolvedModel, oldModel);
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0][0], /ready to attempt/i);
  assert.match(notices[0][0], /model|authorization|not ready/i);
});

async function assertBlocked(ctx, { reasonPattern, args } = {}) {
  let fetchCalls = 0;
  const session = ctx.sessionManager;
  const before = JSON.stringify(session?.getBranch?.() ?? null);
  const result = await runStatusContext(ctx, { args, fetchImpl: async () => { fetchCalls += 1; } });
  assert.equal(result.notices.length, 1, "exactly one transient notice");
  assert.equal(result.notices[0][1], "warning");
  assert.doesNotMatch(result.notices[0][0], /ready to attempt/i);
  assert.match(result.notices[0][0], reasonPattern);
  assert.equal(fetchCalls, 0, "readiness must never reach the provider endpoint");
  assert.equal(result.pi.appended.length, 0, "readiness must not write durable state");
  assert.equal(JSON.stringify(session?.getBranch?.() ?? null), before, "readiness must not mutate the branch");
  return result;
}

test("status is ready for each approved provider surface with one transient info notice", async () => {
  const surfaces = [
    { name: "openai", model: openAIModel, auth: { ok: true, apiKey: "synthetic-key" }, secrets: [/synthetic-key/, /api\.openai\.com/] },
    { name: "azure", model: azureModel, auth: { ok: true, apiKey: "azure-secret-key" }, secrets: [/azure-secret-key/, /resource\.openai\.azure\.com/] },
    { name: "codex", model: codexModel, auth: { ok: true, apiKey: codexToken("acct-synthetic") }, secrets: [/acct-synthetic/, /synthetic-signature/] },
  ];
  for (const surface of surfaces) {
    let fetchCalls = 0;
    const session = sessionWithContext();
    const before = JSON.stringify(session.getBranch());
    const result = await runStatus({ model: surface.model, session, auth: surface.auth, fetchImpl: async () => { fetchCalls += 1; } });
    assert.equal(result.notices.length, 1, surface.name);
    assert.equal(result.notices[0][1], "info", surface.name);
    assert.match(result.notices[0][0], /ready to attempt/i, surface.name);
    assert.doesNotMatch(result.notices[0][0], /will succeed|guaranteed/i, surface.name);
    assert.equal(fetchCalls, 0, surface.name);
    assert.equal(result.pi.appended.length, 0, `${surface.name} readiness must not write durable state`);
    assert.equal(JSON.stringify(session.getBranch()), before, `${surface.name} readiness must not mutate the branch`);
    for (const secret of surface.secrets) assert.doesNotMatch(result.notices[0][0], secret, surface.name);
  }
});

test("status reports a concrete model or route blocker instead of false readiness", async () => {
  const cases = [
    { name: "missing model", model: null, missingModel: true, auth: { ok: true, apiKey: "synthetic-key" }, reason: /missing model/i },
    { name: "insecure endpoint", model: openAIModel, auth: { ok: true, apiKey: "synthetic-key", env: { OPENAI_BASE_URL: "http://api.openai.com/v1" } }, reason: /endpoint not HTTPS/i },
    { name: "invalid endpoint", model: openAIModel, auth: { ok: true, apiKey: "synthetic-key", env: { OPENAI_BASE_URL: "not a url" } }, reason: /invalid endpoint/i },
    { name: "unsupported route", model: openAIModel, auth: { ok: true, apiKey: "synthetic-key", env: { OPENAI_BASE_URL: "https://example.com/v1" } }, reason: /unsupported provider route/i },
  ];
  for (const scenario of cases) {
    const ctx = statusContext({ model: scenario.model, auth: scenario.auth });
    if (scenario.missingModel) delete ctx.model;
    await assertBlocked(ctx, { reasonPattern: scenario.reason });
  }
});

test("status reports a concrete branch blocker and never fabricates readiness", async () => {
  const ending = { getBranch: () => [{ id: "m", type: "message" }, { id: "c", type: "compaction", summary: "" }], getLeafId: () => "c" };
  await assertBlocked(statusContext({ session: ending }), { reasonPattern: /already ends with compaction/i });

  const noMessages = { getBranch: () => [{ id: "c", type: "custom", customType: "note" }], getLeafId: () => "c" };
  await assertBlocked(statusContext({ session: noMessages }), { reasonPattern: /branch has no context/i });
});

test("status reports serialization unavailability instead of readiness", async () => {
  const ctx = statusContext();
  delete ctx.getSystemPrompt;
  await assertBlocked(ctx, { reasonPattern: /serialization unavailable/i });
});

test("status accepts legacy lineage replay after serializer drift", async () => {
  const identity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
  const details = checkpointDetails({ identity, opaqueWindow: [{ type: "compaction", encrypted_content: "legacy-opaque" }] });
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: ["0".repeat(64)] };
  const session = SessionManager.inMemory("/tmp");
  const first = session.appendMessage({ role: "user", content: [{ type: "text", text: "legacy readiness source" }], timestamp: 1 });
  session.appendCompaction("", first, 2, { ...details, lineage: { firstKeptEntryId: first, leafId: first } }, true);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "legacy readiness descendant" }], timestamp: 2 });
  const result = await runStatus({ session, fetchImpl: async () => { throw new Error("status must not call provider"); } });
  assert.equal(result.notices.length, 1);
  assert.match(result.notices[0][0], /ready to attempt/i);
  assert.equal(result.notices[0][1], "info");
});

test("status rejects a persisted checkpoint that no longer matches the active branch", async () => {
  const identity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
  const details = checkpointDetails({ identity, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [sha256({ role: "user", content: "segment-absent-from-branch" })] };
  const session = SessionManager.inMemory("/tmp");
  const first = session.appendMessage({ role: "user", content: [{ type: "text", text: "before" }], timestamp: 1 });
  session.appendCompaction("", first, 2, details);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "after" }], timestamp: 2 });
  await assertBlocked(statusContext({ session }), { reasonPattern: /persisted replay does not match/i });
});

test("status validates the argument before any authorization lookup", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const ctx = statusContext({ onAuth: () => { authCalls += 1; } });
  const result = await runStatusContext(ctx, { args: "status", fetchImpl: async () => { fetchCalls += 1; } });
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0][1], "warning");
  assert.match(result.notices[0][0], /usage: \/blackmagic-status/i);
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("status never echoes rejected Codex credential material", async () => {
  const payload = Buffer.from(JSON.stringify({ sub: "acct-never-print" })).toString("base64url");
  const result = await runStatus({ model: codexModel, auth: { ok: true, apiKey: `secret-material.${payload}.signature` } });
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0][1], "warning");
  assert.match(result.notices[0][0], /account identity/i);
  assert.doesNotMatch(result.notices[0][0], /secret-material|acct-never-print|signature/);
});

test("the controller registers only the readiness command with a truthful description", () => {
  const pi = fakePi();
  createServerCompactionController(pi);
  assert.deepEqual(pi.commands, ["blackmagic-status"]);
  assert.doesNotMatch(JSON.stringify(pi.commands), /server-compact/);
  assert.match(pi.command.description, /\/compact/);
  assert.match(pi.command.description, /Blackmagic remote compaction/);
});
