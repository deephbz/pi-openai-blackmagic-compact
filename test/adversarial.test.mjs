import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { compactCodex, compactResponses } from "../src/adapters.mjs";
import { checkpointDetails, safeTelemetry, sha256 } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

const identities = {
  openai: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "http://127.0.0.1:1/v1", model: "gpt-5" },
  azure: { surface: "azure_openai", protocol: "responses_compact_v1", endpoint: "http://127.0.0.1:1/openai/v1", model: "gpt-5", deployment: "private-deployment" },
  codex: { surface: "chatgpt_codex", protocol: "codex_compaction_trigger_v2", endpoint: "http://127.0.0.1:1/backend-api", model: "gpt-5" },
};
const prepared = {
  instructions: "final system prompt",
  tools: [{ type: "function", name: "final-tool" }],
  reasoning: { effort: "high" }, text: { verbosity: "low" }, parallel_tool_calls: true, tool_choice: "auto", store: true, include: ["reasoning.encrypted_content"], prompt_cache_key: "synthetic-cache-key",
  input: [{ role: "user", content: "old" }, { type: "reasoning", encrypted_content: "opaque-reasoning" }, { role: "assistant", content: "latest" }],
};

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
      const run = remote.surface === "chatgpt_codex" ? compactCodex : compactResponses;
      const result = await run({ identity: remote, prepared, auth: { apiKey: identity.surface === "chatgpt_codex" ? "eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC10ZXN0In19.signature" : "synthetic-key", headers: { "x-provider-proof": "present" } }, fetchImpl: fetch });
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

test("Codex persists a bounded real-user window plus its one validated compaction item", async () => {
  const result = await compactCodex({ identity: identities.codex, prepared: { ...prepared, input: [{ role: "user", content: "keep" }, { role: "assistant", content: "discard" }, { role: "user", name: "hc-control", content: "discard" }] }, auth: { apiKey: "eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC10ZXN0In19.signature" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [{ type: "compaction", encrypted_content: "opaque" }] }) }) });
  assert.deepEqual(result.details.checkpoint.artifact, [{ role: "user", content: "keep" }, { type: "compaction", encrypted_content: "opaque" }]);
  assert.equal(result.details.checkpoint.retention, "recent_real_user_messages_64000_plus_canonical_provider_window");
});

test("official compact output persists only returned user items plus its final compaction item", async () => {
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "retain" }] };
  const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "must-not-replay" }] };
  const compaction = { type: "compaction", encrypted_content: "opaque" };
  const result = await compactResponses({ identity: identities.openai, prepared, auth: { apiKey: "synthetic-key" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [user, assistant, compaction] }) }) });
  assert.deepEqual(result.details.checkpoint.artifact, [user, compaction]);
});

test("rejects output that is not exactly one encrypted provider compaction item", async () => {
  for (const output of [[{ type: "message", encrypted_content: "wrong" }], [{ type: "compaction" }], [{ type: "compaction", encrypted_content: "a" }, { type: "compaction", encrypted_content: "b" }]]) {
    const result = await compactResponses({ identity: identities.openai, prepared, auth: { apiKey: "synthetic-key" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output }) }) });
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

function fakePi() { const handlers = new Map(); return { on: (name, fn) => handlers.set(name, fn), registerCommand() {}, handlers }; }
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
  createServerCompactionController(pi, { lastRewriterAsserted: true, summaryFactory: () => "local summary" });
  const details = checkpointDetails({ identity: { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" }, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  details.lineage = { firstKeptEntryId: "keep", branchLeafId: "leaf" };
  const original = { model: "gpt-5", input: [{ role: "user", content: [{ type: "input_text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nlocal summary\n</summary>" }] }, { role: "user", content: "new work" }] };
  details.replay = { namespace: "hc-openai-server-compaction/3", replacedItemHashes: [sha256(original.input[0])] };
  const branch = [{ id: "remote-compact", type: "compaction", summary: "local summary", details }];
  const replayed = await pi.handlers.get("before_provider_request")({ payload: original }, controllerContext(branch));
  assert.equal(replayed.input[0].encrypted_content, "opaque");
  assert.equal(JSON.stringify(replayed.input).includes("local summary"), false);
  assert.equal(JSON.stringify(replayed.input).includes("new work"), true);
  assert.deepEqual(original.input[0].role, "user", "request hook returns a replacement rather than mutating caller payload");
});
