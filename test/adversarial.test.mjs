import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { compactProvider } from "../src/adapters.mjs";
import { BLACKMAGIC_DETAILS_TYPE, createCheckpoint, identifySurface, readCheckpoint, sameProvider, sha256 } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

function codexToken() {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
  return `e30.${payload}.test`;
}

const providers = {
  openai: { kind: "supported", surface: "openai_api", endpoint: "http://127.0.0.1:1/v1", model: "gpt-5" },
  azure: { kind: "supported", surface: "azure_openai", endpoint: "http://127.0.0.1:1/openai/v1", model: "gpt-5", deployment: "private-deployment" },
  codex: { kind: "supported", surface: "chatgpt_codex", endpoint: "http://127.0.0.1:1/backend-api", model: "gpt-5" },
};
const prepared = {
  payload: {
    model: "gpt-5",
    instructions: "system",
    tools: [{ type: "function", name: "probe" }],
    reasoning: { effort: "high" },
    text: { verbosity: "low" },
    input: [{ role: "user", content: "old" }],
  },
  input: [{ role: "user", content: "old" }],
};

async function loopback(run) {
  let requestError;
  const server = http.createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const result = await run(request, JSON.parse(text));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      requestError = error;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "opaque" }] }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run({ url: `http://127.0.0.1:${server.address().port}` });
    if (requestError) throw requestError;
    return result;
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

for (const [name, provider] of Object.entries(providers)) test(`${name} uses its one server-compaction request`, async () => {
  await loopback(async (request, body) => {
    if (body === undefined) {
      const selected = { ...provider, endpoint: request.url + (provider.surface === "chatgpt_codex" ? "/backend-api" : provider.surface === "azure_openai" ? "/openai/v1" : "/v1") };
      const result = await compactProvider({ provider: selected, prepared, auth: { apiKey: provider.surface === "chatgpt_codex" ? codexToken() : "synthetic-key", headers: { "x-proof": "present" } }, fetchImpl: fetch });
      assert.ok(result.input, result.error?.message);
      return {};
    }
    assert.equal(request.headers["x-proof"], "present");
    if (provider.surface === "azure_openai") assert.equal(request.headers["api-key"], "synthetic-key");
    else assert.match(request.headers.authorization, /^Bearer /);
    if (provider.surface === "chatgpt_codex") {
      assert.equal(request.url, "/backend-api/codex/responses");
      assert.equal(request.headers["chatgpt-account-id"], "acct-test");
      assert.deepEqual(body.input.at(-1), { type: "compaction_trigger" });
      assert.deepEqual(body.tools, prepared.payload.tools);
    } else {
      assert.match(request.url, /responses\/compact$/);
      assert.deepEqual(body.input, prepared.input);
      assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model"].sort());
    }
    return { output: [{ type: "compaction", encrypted_content: "opaque" }] };
  });
});

test("the provider owns the replacement window", async () => {
  const user = { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] };
  const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "retained by provider" }] };
  const compaction = { type: "compaction", encrypted_content: "opaque" };
  const official = await compactProvider({ provider: providers.openai, prepared, auth: { apiKey: "key" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [user, assistant, compaction] }) }) });
  assert.deepEqual(official.input, [user, assistant, compaction]);

  const codex = await compactProvider({ provider: providers.codex, prepared, auth: { apiKey: codexToken() }, fetchImpl: async () => ({ ok: true, json: async () => ({ output: [user, compaction] }) }) });
  assert.deepEqual(codex.input, [compaction], "Codex replay keeps only its opaque compaction output");
});

test("malformed provider output is rejected", async () => {
  for (const output of [[], [{ type: "compaction" }], [{ type: "compaction", encrypted_content: "a" }, { type: "compaction", encrypted_content: "b" }]]) {
    const result = await compactProvider({ provider: providers.openai, prepared, auth: { apiKey: "key" }, fetchImpl: async () => ({ ok: true, json: async () => ({ output }) }) });
    assert.equal(result.input, undefined);
    assert.match(result.error.message, /invalid compaction window/);
  }
});

test("checkpoint compatibility is provider-scoped and current-only", () => {
  const replacedItemHashes = [sha256({ role: "user", content: "placeholder" })];
  const details = createCheckpoint({ provider: providers.openai, input: [{ type: "compaction", encrypted_content: "opaque" }], replacedItemHashes });
  const entry = { type: "compaction", summary: "", details };
  assert.equal(readCheckpoint(entry)?.details.type, BLACKMAGIC_DETAILS_TYPE);
  assert.equal(sameProvider(details.provider, { ...providers.openai, model: "different-model" }), true);
  assert.equal(sameProvider(details.provider, providers.azure), false);
  assert.equal(readCheckpoint({ ...entry, details: { type: BLACKMAGIC_DETAILS_TYPE } }), undefined);
  assert.equal(readCheckpoint({ ...entry, summary: "old readable summary" }), undefined);
});

function fakePi() {
  const handlers = new Map();
  return { on: (name, handler) => handlers.set(name, handler), registerCommand() {}, handlers };
}
function context(branch, model = { provider: "openai", id: "gpt-5.1", baseUrl: "https://api.openai.com/v1", api: "openai-responses" }) {
  return {
    model,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) },
    sessionManager: { getBranch: () => branch },
    ui: { setStatus() {} },
  };
}

test("replay crosses models on one provider and never crosses providers", async () => {
  const placeholder = { role: "user", content: "placeholder" };
  const details = createCheckpoint({
    provider: { ...providers.openai, endpoint: "https://api.openai.com/v1" },
    input: [{ type: "compaction", encrypted_content: "opaque" }],
    replacedItemHashes: [sha256(placeholder)],
  });
  const branch = [{ type: "compaction", summary: "", details }];
  const pi = fakePi();
  createServerCompactionController(pi);
  const payload = { model: "gpt-5.1", input: [placeholder, { role: "user", content: "new" }] };
  const replayed = await pi.handlers.get("before_provider_request")({ payload }, context(branch));
  assert.deepEqual(replayed.input, [{ type: "compaction", encrypted_content: "opaque" }, { role: "user", content: "new" }]);

  const otherProvider = { provider: "openai-codex", id: "gpt-5.1", baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses" };
  assert.deepEqual(await pi.handlers.get("before_provider_request")({ payload }, context(branch, otherProvider)), payload);
});
