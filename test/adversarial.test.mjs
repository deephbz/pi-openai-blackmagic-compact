import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { compactProviderInput } from "../src/adapters.mjs";
import { checkpointDetails, identifySurface, safeTelemetry, sha256 } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

function codexToken() {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
  return `e30.${payload}.test`;
}
const identities = {
  openai: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "http://127.0.0.1:1/v1", model: "gpt-5" },
  azure: { surface: "azure_openai", protocol: "responses_compact_v1", endpoint: "http://127.0.0.1:1/openai/v1", model: "gpt-5", deployment: "private-deployment" },
  codex: { surface: "chatgpt_codex", protocol: "codex_compaction_trigger_v2", endpoint: "http://127.0.0.1:1/backend-api", model: "gpt-5" },
};
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

function fakePi() { const handlers = new Map(); return { on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerEntryRenderer() {}, appendEntry() {}, handlers }; }
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
  const details = checkpointDetails({ identity: { ...currentIdentity, model: "old-model" }, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [sha256(original.input[0])] };
  const replayed = await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext([{ type: "compaction", details }]));
  assert.equal(replayed, undefined);
  assert.ok(telemetry.some((event) => event.type === "remote_invalidated" && event.failureClass === "identity_mismatch"));
  assert.equal(telemetry.some((event) => event.failureClass === "replay_segment_mismatch"), false);
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
