import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { compactProviderInput } from "../src/adapters.mjs";
import { checkpointDetails, identifySurface, safeTelemetry, sha256 } from "../src/contract.mjs";
import { captureNativeBody, createServerCompactionController, serializationOptions } from "../src/controller.mjs";

function codexToken() {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
  return `e30.${payload}.test`;
}
const identities = {
  openai: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "http://127.0.0.1:1/v1", model: "gpt-5" },
  azure: { surface: "azure_openai", protocol: "responses_compact_v1", endpoint: "http://127.0.0.1:1/openai/v1", model: "gpt-5", deployment: "private-deployment" },
  codex: { surface: "chatgpt_codex", protocol: "codex_compaction_trigger_v2", endpoint: "http://127.0.0.1:1/backend-api", model: "gpt-5" },
};
const nativeUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function nativeModel(provider, id, baseUrl, api) {
  return { provider, id, name: id, baseUrl, api, input: ["text"], reasoning: true, thinkingLevelMap: { high: "high" }, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function nativePreparation(firstKeptEntryId) {
  return { firstKeptEntryId, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } };
}
async function nativeModelSwitch({ producer, current, auth, producerLookup }) {
  const session = SessionManager.inMemory("/tmp");
  const firstKeptEntryId = session.appendMessage({ role: "user", content: [{ type: "text", text: "native switch source" }], timestamp: 1 });
  session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "native reasoning" }, { type: "text", text: "native assistant" }], api: producer.api, provider: producer.provider, model: producer.id, usage: nativeUsage, stopReason: "stop", timestamp: 2 });
  session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "tool reasoning" }, { type: "toolCall", id: "native-call", name: "probe", arguments: {} }], api: producer.api, provider: producer.provider, model: producer.id, usage: nativeUsage, stopReason: "toolUse", timestamp: 3 });
  session.appendMessage({ role: "toolResult", toolCallId: "native-call", toolName: "probe", content: [{ type: "text", text: "native tool result" }], isError: false, timestamp: 4 });
  const pi = fakePi();
  const requests = [];
  createServerCompactionController(pi, { fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: `opaque-${requests.length}` }] }) }; } });
  const modelRegistry = { getApiKeyAndHeaders: async () => auth };
  if (producerLookup) modelRegistry.find = (provider, id) => producerLookup(provider, id);
  const ctx = { model: producer, modelRegistry, sessionManager: session, getSystemPrompt: () => "native switch system", thinkingLevel: "high" };
  const first = await pi.handlers.get("session_before_compact")({ preparation: nativePreparation(firstKeptEntryId), branchEntries: session.getBranch(), signal: new AbortController().signal }, ctx);
  assert.equal(first.compaction.details.state, "remote_applied");
  session.appendCompaction(first.compaction.summary, first.compaction.firstKeptEntryId, first.compaction.tokensBefore, first.compaction.details, true);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "after native switch" }], timestamp: 5 });
  const switchedContext = { ...ctx, model: current };
  const branchEntries = session.getBranch();
  const signal = new AbortController().signal;
  const payload = await captureNativeBody(current, { systemPrompt: switchedContext.getSystemPrompt(), messages: convertToLlm(buildSessionContext(branchEntries).messages), tools: [] }, serializationOptions(switchedContext, auth, signal));
  const replayed = await pi.handlers.get("before_provider_request")({ payload }, switchedContext);
  const next = await pi.handlers.get("session_before_compact")({ preparation: nativePreparation(branchEntries[0].id), branchEntries, signal }, switchedContext);
  return { first, payload, replayed, next, requests, identity: first.compaction.details.identity };
}
test("approved provider surfaces require HTTPS", () => {
  const candidates = [
    { provider: "openai", baseUrl: "http://api.openai.com/v1", api: "openai-responses", model: "gpt-5" },
    { provider: "azure-openai-responses", baseUrl: "http://test.openai.azure.com/openai/v1", api: "azure-openai-responses", model: "gpt-5", deployment: "gpt-5" },
    { provider: "openai-codex", baseUrl: "http://chatgpt.com/backend-api", api: "openai-codex-responses", model: "gpt-5" },
  ];
  for (const candidate of candidates) assert.deepEqual(identifySurface(candidate), { kind: "unsupported", reason: "insecure_endpoint" });
  assert.equal(identifySurface({ ...candidates[0], baseUrl: "https://api.openai.com/v1" }).kind, "supported");
});

const prepared = {
  instructions: "final system prompt",
  tools: [{ type: "function", name: "final-tool" }],
  reasoning: { effort: "high" }, text: { verbosity: "low" }, parallel_tool_calls: true, tool_choice: "auto", store: true, include: ["reasoning.encrypted_content"], prompt_cache_key: "synthetic-cache-key",
  input: [{ role: "user", content: "old" }, { type: "reasoning", encrypted_content: "opaque-reasoning" }, { role: "assistant", content: "latest" }],
};

test("generic GPT-5 and GPT-6 routes reuse the Responses adapter", async () => {
  const cases = [
    { provider: "synthetic-a", baseUrl: "https://gateway.example", model: "@azure/gpt-5" },
    { provider: "synthetic-b", baseUrl: "https://gateway.example/prefix/v1", model: "@bedrock-mantle-usw2/openai.gpt-6-astra" },
    { provider: "synthetic-c", baseUrl: "https://other.example/api/responses", model: "provider/GPT-5.6-custom" },
  ];
  for (const scenario of cases) {
    const identity = identifySurface({ api: "openai-responses", ...scenario });
    assert.equal(identity.kind, "supported");
    assert.equal(identity.surface, "openai_api");
    let request;
    const result = await compactProviderInput({
      identity,
      prepared,
      auth: { apiKey: "synthetic-key" },
      fetchImpl: async (url, options) => {
        request = { url, headers: options.headers, body: JSON.parse(options.body) };
        return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "synthetic-opaque" }] }) };
      },
    });
    assert.ok(result.details, result.error?.message);
    assert.equal(request.url, `${identity.endpoint}/responses/compact`);
    assert.equal(request.headers.authorization, "Bearer synthetic-key");
    assert.equal(request.body.model, scenario.model);
    assert.deepEqual(result.details.identity, identity);
  }
});

test("generic GPT route rejects HTTP, wrong API, GPT-4, and Claude models", () => {
  const base = { provider: "synthetic", api: "openai-responses", model: "gpt-5" };
  for (const candidate of [
    { ...base, baseUrl: "http://gateway.example/prefix" },
    { ...base, api: "openai-chat", baseUrl: "https://gateway.example/prefix" },
    { ...base, model: "gpt-4.1", baseUrl: "https://gateway.example/prefix" },
    { ...base, model: "claude-sonnet", baseUrl: "https://gateway.example/prefix" },
  ]) assert.equal(identifySurface(candidate).kind, "unsupported", JSON.stringify(candidate));
});

test("generic route replay rejects a changed endpoint", async () => {
  const checkpointIdentity = identifySurface({ provider: "synthetic", api: "openai-responses", baseUrl: "https://gateway-a.example/prefix", model: "gpt-6" });
  const result = await replayWithCurrentModel({
    checkpointIdentity,
    currentModel: { provider: "synthetic", id: "gpt-6", baseUrl: "https://gateway-b.example/prefix", api: "openai-responses" },
  });
  assert.equal(result.replayed, undefined);
  assert.ok(result.telemetry.some((event) => event.failureClass === "identity_mismatch"));
});

test("provider compaction interface rejects an identity without one matching adapter", async () => {
  let fetchCalls = 0;
  const result = await compactProviderInput({
    identity: { ...identities.openai, protocol: "codex_compaction_trigger_v2" },
    prepared,
    auth: { apiKey: "synthetic-key" },
    fetchImpl: async () => { fetchCalls += 1; },
  });
  assert.equal(result.failureClass, "model_or_protocol");
  assert.equal(fetchCalls, 0);
});

async function loopback(handler) {
  let requestError;
  const server = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const result = await handler(req, JSON.parse(body));
      res.writeHead(result.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (error) {
      requestError = error;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "opaque" }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await handler({ url: `http://127.0.0.1:${server.address().port}` }, undefined);
    if (requestError) throw requestError;
    return result;
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

for (const [surface, identity] of Object.entries(identities)) test(`${surface} loopback sends resolved auth and the exact protocol request`, async () => {
  await loopback(async (request, body) => {
    if (body === undefined) {
      const remote = { ...identity, endpoint: request.url + (identity.surface === "chatgpt_codex" ? "/backend-api" : identity.surface === "azure_openai" ? "/openai/v1" : "/v1") };
      const result = await compactProviderInput({ identity: remote, prepared, auth: { apiKey: identity.surface === "chatgpt_codex" ? codexToken() : "synthetic-key", headers: { "x-provider-proof": "present" } }, fetchImpl: fetch });
      assert.ok(result.details, result.error?.message);
      return { body: {} };
    }
    if (identity.surface === "azure_openai") assert.equal(request.headers["api-key"], "synthetic-key");
    else assert.match(request.headers.authorization, /^Bearer /);
    if (identity.surface === "chatgpt_codex") assert.equal(request.headers["chatgpt-account-id"], "acct-test");
    assert.equal(request.headers["x-provider-proof"], "present");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.url, identity.surface === "chatgpt_codex" ? "/backend-api/codex/responses" : "/" + (identity.surface === "azure_openai" ? "openai/v1/" : "v1/") + "responses/compact");
    assert.deepEqual(body.instructions, prepared.instructions);
    if (identity.surface === "chatgpt_codex") {
      assert.deepEqual(body.tools, prepared.tools);
      for (const field of ["reasoning", "text", "parallel_tool_calls", "tool_choice", "store", "include", "prompt_cache_key"]) assert.deepEqual(body[field], prepared[field]);
      assert.deepEqual(body.input.slice(0, -1), prepared.input);
      assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
    } else { assert.deepEqual(body.input, prepared.input); assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model", "prompt_cache_key"].sort()); }
    return { body: { output: [{ type: "compaction", encrypted_content: "opaque" }] } };
  });
});

test("Pi 0.84 header deletion markers override OpenAI and Azure defaults case-insensitively", async () => {
  const cases = [
    {
      name: "OpenAI Cloudflare placeholder authorization",
      identity: identities.openai,
      headers: { "CF-AIG-Authorization": "Bearer cloudflare-placeholder", AUTHORIZATION: null, "X-Mixed-Delete": null },
      assertHeaders: (headers) => {
        assert.equal(headers["cf-aig-authorization"], "Bearer cloudflare-placeholder");
        assert.equal(headers.authorization, undefined);
      },
    },
    {
      name: "Azure API key",
      identity: identities.azure,
      headers: { Authorization: "Bearer cloudflare-placeholder", "API-KEY": null, "X-Mixed-Delete": null },
      assertHeaders: (headers) => {
        assert.equal(headers.authorization, "Bearer cloudflare-placeholder");
        assert.equal(headers["api-key"], undefined);
      },
    },
  ];
  for (const scenario of cases) {
    await loopback(async (request, body) => {
      if (body === undefined) {
        const remote = { ...scenario.identity, endpoint: request.url + (scenario.identity.surface === "azure_openai" ? "/openai/v1" : "/v1") };
        const result = await compactProviderInput({ identity: remote, prepared, auth: { apiKey: "synthetic-key", headers: scenario.headers }, fetchImpl: fetch });
        assert.ok(result.details, result.error?.message);
        return { body: {} };
      }
      scenario.assertHeaders(request.headers);
      assert.equal(request.headers["x-mixed-delete"], undefined, scenario.name);
      assert.equal(request.headers["content-type"], "application/json", scenario.name);
      return { body: { output: [{ type: "compaction", encrypted_content: "opaque" }] } };
    });
  }
});

test("Codex restores only its Pi-native required headers after null overrides", async () => {
  await loopback(async (request, body) => {
    if (body === undefined) {
      const remote = { ...identities.codex, endpoint: request.url + "/backend-api" };
      const result = await compactProviderInput({
        identity: remote,
        prepared,
        auth: {
          apiKey: codexToken(),
          headers: { AUTHORIZATION: null, "CHATGPT-ACCOUNT-ID": null, ORIGINATOR: null, "openai-beta": null, "X-Mixed-Delete": null },
        },
        fetchImpl: fetch,
      });
      assert.ok(result.details, result.error?.message);
      return { body: {} };
    }
    assert.match(request.headers.authorization, /^Bearer /);
    assert.equal(request.headers["chatgpt-account-id"], "acct-test");
    assert.equal(request.headers.originator, "pi");
    assert.equal(request.headers["openai-beta"], "responses=experimental");
    assert.equal(request.headers["x-mixed-delete"], undefined);
    assert.equal(request.headers["content-type"], "application/json");
    return { body: { output: [{ type: "compaction", encrypted_content: "opaque" }] } };
  });
});

test("Codex persists a bounded real-user window plus its one validated compaction item", async () => {
  const result = await compactProviderInput({ identity: identities.codex, prepared: { ...prepared, input: [{ role: "user", content: "keep" }, { role: "assistant", content: "discard" }, { role: "user", name: "hc-control", content: "discard" }] }, auth: { apiKey: codexToken() }, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque" }] }) }) });
  assert.deepEqual(result.details.checkpoint.artifact, [{ role: "user", content: "keep" }, { type: "compaction", encrypted_content: "opaque" }]);
  assert.equal(result.details.checkpoint.retention, "recent_real_user_messages_64000_plus_canonical_provider_window");
});

test("official compact output persists only returned user items plus its final compaction item", async () => {
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "retain" }] };
  const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "must-not-replay" }] };
  const compaction = { type: "compaction", encrypted_content: "opaque" };
  const result = await compactProviderInput({ identity: identities.openai, prepared, auth: { apiKey: "synthetic-key" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [user, assistant, compaction] }) }) });
  assert.deepEqual(result.details.checkpoint.artifact, [user, compaction]);
});

test("rejects output that is not exactly one encrypted provider compaction item", async () => {
  for (const output of [[{ type: "message", encrypted_content: "wrong" }], [{ type: "compaction" }], [{ type: "compaction", encrypted_content: "a" }, { type: "compaction", encrypted_content: "b" }]]) {
    const result = await compactProviderInput({ identity: identities.openai, prepared, auth: { apiKey: "synthetic-key" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output }) }) });
    assert.equal(result.details, undefined);
    assert.match(result.error.message, /canonical encrypted compaction/i);
  }
});

test("telemetry never exports provider endpoint or Azure deployment", () => {
  const checkpoint = checkpointDetails({ identity: identities.azure, opaqueWindow: [{ type: "compaction", encrypted_content: "secret" }] }).checkpoint;
  const json = JSON.stringify(safeTelemetry("remote_applied", { identity: identities.azure, checkpoint }));
  assert.equal(json.includes("127.0.0.1"), false);
  assert.equal(json.includes("private-deployment"), false);
  assert.equal(json.includes("secret"), false);
});

function fakePi() { const handlers = new Map(); return { on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerEntryRenderer() {}, appendEntry() {}, getActiveTools: () => [], getAllTools: () => [], handlers }; }
function controllerContext(branch = []) {
  return {
    model: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://api.openai.com/v1", api: "openai-responses" }),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-key", headers: { "x-provider-proof": "present" } }),
    },
    sessionManager: { getBranch: () => branch, getLeafId: () => "leaf" },
  };
}
async function replayWithCurrentModel({ checkpointIdentity, currentModel, auth = { ok: true, apiKey: "synthetic-key" }, checkpointInput = [{ role: "user", content: "current segment" }], payloadInput = checkpointInput, mutatePayload }) {
  const pi = fakePi();
  const telemetry = [];
  createServerCompactionController(pi, { telemetry: (event) => telemetry.push(event) });
  const details = checkpointDetails({ identity: structuredClone(checkpointIdentity), opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  const original = { model: currentModel.id, input: structuredClone(payloadInput) };
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: checkpointInput.map(sha256) };
  mutatePayload?.(original);
  const replayed = await pi.handlers.get("before_provider_request")({ payload: original }, {
    model: currentModel,
    modelRegistry: { getApiKeyAndHeaders: async () => auth },
    sessionManager: { getBranch: () => [{ type: "compaction", details }], getLeafId: () => "leaf" },
  });
  return { details, original, replayed, telemetry };
}

test("public request hook replays only its named checkpoint into provider payload, not AgentMessage context", async () => {
  const pi = fakePi();
  createServerCompactionController(pi);
  const details = checkpointDetails({ identity: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" }, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  details.lineage = { firstKeptEntryId: "keep", branchLeafId: "leaf" };
  const original = { model: "gpt-5", input: [{ role: "user", content: [{ type: "input_text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nlocal summary\n</summary>" }] }, { role: "user", content: "new work" }] };
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [sha256(original.input[0])] };
  const branch = [{ id: "remote-compact", type: "compaction", summary: "local summary", details }];
  const replayed = await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext(branch));
  assert.equal(replayed.input[0].encrypted_content, "opaque");
  assert.equal(JSON.stringify(replayed.input).includes("local summary"), false);
  assert.equal(JSON.stringify(replayed.input).includes("new work"), true);
  assert.deepEqual(original.input[0].role, "user", "request hook returns a replacement rather than mutating caller payload");
});

test("replay invalidation preserves Pi's local-summary payload", async () => {
  const pi = fakePi(); const telemetry = [];
  createServerCompactionController(pi, { telemetry: (event) => telemetry.push(event) });
  const identity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
  const details = checkpointDetails({ identity, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [sha256({ role: "user", content: "different segment" })] };
  const original = { model: "gpt-5", input: [{ role: "user", content: "local summary remains usable" }] };
  const replayed = await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext([{ type: "compaction", details }]));
  assert.equal(replayed, undefined, "Pi must keep the unchanged provider payload when checkpoint replay is invalid");
  assert.match(JSON.stringify(original), /local summary remains usable/);
  assert.ok(telemetry.some((event) => event.type === "remote_invalidated" && event.failureClass === "replay_segment_mismatch"));
});

test("replay invalidation distinguishes checkpoint identity mismatch from segment mismatch", async () => {
  const pi = fakePi(); const telemetry = [];
  createServerCompactionController(pi, { telemetry: (event) => telemetry.push(event) });
  const currentIdentity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
  const original = { model: "gpt-5", input: [{ role: "user", content: "current segment" }] };
  const details = checkpointDetails({ identity: { ...currentIdentity, protocol: "old-protocol" }, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [sha256(original.input[0])] };
  const replayed = await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext([{ type: "compaction", details }]));
  assert.equal(replayed, undefined);
  assert.ok(telemetry.some((event) => event.type === "remote_invalidated" && event.failureClass === "identity_mismatch"));
  assert.equal(telemetry.some((event) => event.failureClass === "replay_segment_mismatch"), false);
});

test("same-route Codex and same-deployment Azure model aliases retain native replay with synthetic auth", async () => {
  const cases = [
    {
      name: "Codex",
      producer: nativeModel("openai-codex", "gpt-5", "https://chatgpt.com/backend-api", "openai-codex-responses"),
      current: nativeModel("openai-codex", "gpt-5-mini", "https://chatgpt.com/backend-api", "openai-codex-responses"),
      auth: { ok: true, apiKey: codexToken() },
    },
    {
      name: "Azure deployment alias",
      producer: nativeModel("azure-openai-responses", "deployment-alias-a", "https://resource.openai.azure.com/openai/v1", "azure-openai-responses"),
      current: nativeModel("azure-openai-responses", "deployment-alias-b", "https://resource.openai.azure.com/openai/v1", "azure-openai-responses"),
      auth: { ok: true, apiKey: "synthetic-key", env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "deployment-alias-a=deployment-a,deployment-alias-b=deployment-a" } },
    },
  ];
  const results = [];
  for (const scenario of cases) {
    const result = await nativeModelSwitch(scenario);
    results.push({ name: scenario.name, replayed: Boolean(result.replayed), nextCompaction: result.next?.compaction?.details?.state, producerIdentity: result.identity });
    assert.equal(result.replayed?.input.some((item) => item.type === "compaction"), true, `${scenario.name} must replay the opaque checkpoint`);
    assert.equal(result.next?.compaction?.details?.state, "remote_applied", `${scenario.name} next compaction must remain allowed`);
    assert.equal(result.requests.length, 2, `${scenario.name} must perform both remote compactions`);
  }
  assert.deepEqual(results.map(({ name, replayed, nextCompaction }) => ({ name, replayed, nextCompaction })), [
    { name: "Codex", replayed: true, nextCompaction: "remote_applied" },
    { name: "Azure deployment alias", replayed: true, nextCompaction: "remote_applied" },
  ]);
});

test("lineage fallback reconstructs serializer drift from the active checkpoint parent", async () => {
  const session = SessionManager.inMemory("/tmp");
  const producer = nativeModel("openai", "gpt-5", "https://api.openai.com/v1", "openai-responses");
  const firstKeptEntryId = session.appendMessage({ role: "user", content: [{ type: "text", text: "lineage source" }], timestamp: 1 });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "lineage answer" }], api: producer.api, provider: producer.provider, model: producer.id, usage: nativeUsage, stopReason: "stop", timestamp: 2 });
  const pi = fakePi();
  createServerCompactionController(pi, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: "lineage-opaque" }] }) }) });
  const auth = { ok: true, apiKey: "synthetic-key" };
  const context = { model: producer, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: session, getSystemPrompt: () => "lineage system", thinkingLevel: "high" };
  const result = await pi.handlers.get("session_before_compact")({ preparation: nativePreparation(firstKeptEntryId), branchEntries: session.getBranch(), signal: new AbortController().signal }, context);
  session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "lineage descendant" }], timestamp: 3 });
  const payload = await captureNativeBody(producer, { systemPrompt: context.getSystemPrompt(), messages: convertToLlm(buildSessionContext(session.getBranch()).messages), tools: [] }, serializationOptions(context, auth, new AbortController().signal));
  result.compaction.details.replay.replacedItemHashes = ["0".repeat(64)];
  const replayed = await pi.handlers.get("before_provider_request")({ payload }, context);
  assert.ok(replayed, "active Session lineage should permit serializer-drift replay");
  assert.deepEqual(replayed.instructions, payload.instructions);
  assert.deepEqual(replayed.tools, payload.tools);
  assert.equal(replayed.input.some((item) => item.type === "compaction" && item.encrypted_content === "lineage-opaque"), true);
  assert.equal(JSON.stringify(replayed.input).includes("lineage descendant"), true);

  const invalidLineageCases = [
    ["missing", (details) => { delete details.lineage; }],
    ["inactive", (details) => { details.lineage.leafId = "inactive-parent"; }],
    ["ambiguous", (details, branch) => { branch.push({ ...branch.find((entry) => entry.id === details.lineage.leafId) }); }],
  ];
  for (const [name, alter] of invalidLineageCases) {
    const branch = structuredClone(session.getBranch());
    const checkpoint = branch.find((entry) => entry.type === "compaction");
    checkpoint.details.replay.replacedItemHashes = ["0".repeat(64)];
    alter(checkpoint.details, branch);
    const rejected = await pi.handlers.get("before_provider_request")({ payload }, { ...context, sessionManager: { ...session, getBranch: () => branch } });
    assert.equal(rejected, undefined, `${name} lineage must fail closed`);
  }
});

test("cross-model translation uses registered producer metadata and accepts direct proof when unavailable", async () => {
  const producer = nativeModel("openai", "gpt-5", "https://api.openai.com/v1", "openai-responses");
  producer.reasoning = true;
  producer.thinkingLevelMap = { high: "high" };
  const current = nativeModel("openai", "gpt-5-mini", "https://api.openai.com/v1", "openai-responses");
  current.reasoning = false;
  current.thinkingLevelMap = { off: "off" };
  const auth = { ok: true, apiKey: "synthetic-key" };
  const registered = await nativeModelSwitch({ producer, current, auth, producerLookup: (_provider, id) => id === producer.id ? producer : undefined });
  assert.equal(Boolean(registered.replayed), true, "registered producer metadata must validate translation");
  assert.equal(registered.next?.compaction?.details?.state, "remote_applied");

  const unavailable = await nativeModelSwitch({ producer, current, auth, producerLookup: () => undefined });
  assert.equal(Boolean(unavailable.replayed), true, "direct hash proof should allow replay without producer metadata");
  assert.equal(unavailable.replayed?.input.some((item) => item.type === "compaction"), true);
  assert.equal(unavailable.next?.compaction?.details?.state, "remote_applied", "direct hash proof should allow the next compaction");
});

test("replay rejects endpoint, API, protocol, and Azure deployment identity changes", async () => {
  const cases = [
    {
      name: "endpoint",
      checkpointIdentity: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/other", model: "gpt-5", api: "openai-responses" },
      currentModel: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
    },
    {
      name: "API",
      checkpointIdentity: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "old-api" },
      currentModel: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
    },
    {
      name: "protocol",
      checkpointIdentity: { surface: "openai_api", protocol: "old-protocol", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" },
      currentModel: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
    },
    {
      name: "Azure deployment",
      checkpointIdentity: { surface: "azure_openai", protocol: "responses_compact_v1", endpoint: "https://resource.openai.azure.com/openai/v1", model: "deployment-alias", deployment: "deployment-a", api: "azure-openai-responses" },
      currentModel: { provider: "azure-openai-responses", id: "deployment-alias", baseUrl: "https://resource.openai.azure.com/openai/v1", api: "azure-openai-responses" },
      auth: { ok: true, apiKey: "synthetic-key", env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "deployment-alias=deployment-b" } },
    },
  ];
  const outcomes = [];
  for (const scenario of cases) {
    const result = await replayWithCurrentModel(scenario);
    outcomes.push({ name: scenario.name, replayed: Boolean(result.replayed), failureClass: result.telemetry.find((event) => event.type === "remote_invalidated")?.failureClass });
    assert.deepEqual(result.details.identity, scenario.checkpointIdentity, `${scenario.name} producer identity must remain unchanged`);
  }
  assert.deepEqual(outcomes, [
    { name: "endpoint", replayed: false, failureClass: "identity_mismatch" },
    { name: "API", replayed: false, failureClass: "identity_mismatch" },
    { name: "protocol", replayed: false, failureClass: "identity_mismatch" },
    { name: "Azure deployment", replayed: false, failureClass: "identity_mismatch" },
  ]);
});

test("replay rejects altered source prefixes and independently rejects payload tampering", async () => {
  const identity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
  const source = { role: "user", content: "canonical source prefix" };
  const altered = await replayWithCurrentModel({ checkpointIdentity: identity, currentModel: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" }, checkpointInput: [source], payloadInput: [{ role: "user", content: "altered source prefix" }] });
  assert.equal(altered.replayed, undefined);
  assert.ok(altered.telemetry.some((event) => event.failureClass === "replay_segment_mismatch"));

  const tampered = await replayWithCurrentModel({ checkpointIdentity: identity, currentModel: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" }, checkpointInput: [source], mutatePayload: (payload) => { payload.input[0].content = "tampered after hash creation"; } });
  assert.equal(tampered.replayed, undefined);
  assert.ok(tampered.telemetry.some((event) => event.failureClass === "replay_segment_mismatch"));
});

test("only the latest active replay-capable checkpoint can replay", async () => {
  const pi = fakePi(); createServerCompactionController(pi);
  const identity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
  const original = { model: "gpt-5", input: [{ role: "user", content: "old" }] };
  const remote = { type: "compaction", details: checkpointDetails({ identity, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] }) };
  remote.details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [sha256(original.input[0])] };
  const local = { type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } };
  assert.equal(await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext([remote, local])), undefined);

  const emptyReplayHash = structuredClone(remote);
  emptyReplayHash.details.replay.replacedItemHashes = [""];
  assert.equal(await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext([emptyReplayHash])), undefined);
  const corrupted = structuredClone(remote);
  corrupted.details.checkpoint.hash = "invalid";
  assert.equal(await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext([corrupted])), undefined);
  const empty = structuredClone(remote);
  empty.details.checkpoint.artifact = [];
  empty.details.checkpoint.length = 2;
  empty.details.checkpoint.hash = sha256("[]");
  assert.equal(await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext([empty])), undefined);
});
