import test from "node:test";
import assert from "node:assert/strict";
import { compactCodex, compactResponses, retainCodexInput } from "../src/adapters.mjs";
import { checkpointDetails, identifySurface, identityMatches, safeTelemetry } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

const auth = { ok: true, apiKey: "synthetic-key", headers: { "x-test-auth": "yes" } };
const openai = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
const azure = { surface: "azure_openai", protocol: "responses_compact_v1", endpoint: "https://x.openai.azure.com/openai/v1", model: "gpt-5", deployment: "prod", api: "azure-openai-responses" };
const codex = { surface: "chatgpt_codex", protocol: "codex_compaction_trigger_v2", endpoint: "https://chatgpt.com/backend-api", model: "gpt-5", api: "openai-codex-responses" };
const prepared = { instructions: "rewritten", tools: [{ type: "function", name: "last-tool" }], input: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }] };
const response = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const compactOutput = { output: [{ type: "compaction", encrypted_content: "opaque" }], usage: { input_tokens: 4 } };

test("strictly identifies the three approved surfaces, including Pi 0.83's installed Codex base URL", () => {
  assert.equal(identifySurface({ provider: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-responses", model: "gpt-5" }).surface, "openai_api");
  assert.equal(identifySurface({ provider: "azure-openai-responses", baseUrl: azure.endpoint, api: "azure-openai-responses", model: "gpt-5", deployment: "prod" }).surface, "azure_openai");
  assert.equal(identifySurface({ provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses", model: "gpt-5" }).surface, "chatgpt_codex");
  assert.equal(identifySurface({ provider: "openai", baseUrl: "https://proxy.example/v1", api: "openai-responses", model: "gpt-5" }).kind, "unsupported");
});
test("OpenAI and Azure retain their exact canonical response window", async () => {
  for (const identity of [openai, azure]) {
    let request; const result = await compactResponses({ identity, prepared, auth, fetchImpl: async (url, options) => { request = { url, options }; return response(compactOutput); } });
    assert.equal(result.details.identity.surface, identity.surface); assert.match(request.url, /responses\/compact$/); assert.deepEqual(JSON.parse(request.options.body).input, prepared.input); assert.equal(result.details.checkpoint.artifact[0].encrypted_content, "opaque");
  }
});
test("Codex sends full prepared input plus trigger, while persisting a bounded user window", async () => {
  const codexAuth = { ...auth, apiKey: "eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdCJ9fQ.signature" };
  let request; const result = await compactCodex({ identity: codex, prepared, auth: codexAuth, fetchImpl: async (url, options) => { request = { url, body: JSON.parse(options.body) }; return response(compactOutput); } });
  assert.equal(request.url, "https://chatgpt.com/backend-api/codex/responses"); assert.deepEqual(request.body.input, [...prepared.input, { type: "compaction_trigger" }]);
  assert.deepEqual(retainCodexInput([{ role: "user", content: "a" }, { role: "user", name: "hc-control", content: "b" }]), [{ role: "user", content: "a" }]);
  assert.deepEqual(result.details.checkpoint.artifact, [{ role: "user", content: "one" }, compactOutput.output[0]]);
});
test("Codex SSE retains output_item.done when response.completed omits output", async () => {
  const codexAuth = { ...auth, apiKey: "eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdCJ9fQ.signature" };
  const events = [
    { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "opaque-sse" } },
    { type: "response.completed", response: { usage: { input_tokens: 17 } } },
  ];
  const result = await compactCodex({ identity: codex, prepared, auth: codexAuth, fetchImpl: async () => ({ ok: true, status: 200, text: async () => `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}` }) });
  assert.equal(result.details.checkpoint.artifact.at(-1).encrypted_content, "opaque-sse");
  assert.equal(result.details.usage.input_tokens, 17);
});
test("malformed, timeout, auth and model failures fail safely", async () => {
  for (const fetchImpl of [async () => response({ output: [] }), async () => { const e = new Error("abort"); e.name = "AbortError"; throw e; }, async () => response({}, 401), async () => response({}, 422)]) {
    const result = await compactResponses({ identity: openai, prepared, auth, fetchImpl }); assert.ok(result.error); assert.ok(result.failureClass);
  }
});
test("checkpoint identity prevents provider/deployment mismatch and telemetry redacts content", () => {
  const details = checkpointDetails({ identity: azure, opaqueWindow: [{ type: "compaction", encrypted_content: "never-log" }], retention: "canonical_provider_window" });
  assert.equal(identityMatches(details, azure), true); assert.equal(identityMatches(details, { ...azure, deployment: "other" }), false);
  const line = JSON.stringify(safeTelemetry("remote_applied", { identity: azure, checkpoint: details.checkpoint })); assert.ok(!line.includes("never-log")); assert.ok(!line.includes(azure.endpoint)); assert.ok(!line.includes("prod"));
});
function fakePi() { const handlers = new Map(); let command; return { on: (name, fn) => handlers.set(name, fn), registerCommand: (_name, value) => { command = value; }, handlers, get command() { return command; } }; }
function ctx(branch = []) { return { model: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" }, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: { getBranch: () => branch }, hasUI: true, ui: { notify() {} } }; }
test("remote compaction stays local until wrapper tail calibration has passed", async () => {
  const pi = fakePi(); createServerCompactionController(pi, { lastRewriterAsserted: true, summaryFactory: () => "local summary", fetchImpl: async () => response(compactOutput) });
  const payload = { ...prepared, model: "gpt-5" };
  await pi.handlers.get("before_provider_request")({ payload }, ctx());
  const compact = await pi.handlers.get("session_before_compact")({ preparation: { firstKeptEntryId: "keep", tokensBefore: 9, messagesToSummarize: [] } }, ctx());
  assert.equal(compact.compaction.details.state, "local_fallback");
  assert.equal(compact.compaction.details.failureClass, "calibration_unverified");
});
test("unasserted load order returns local model compaction only and commands are status/help", async () => { const pi = fakePi(); createServerCompactionController(pi, { summaryFactory: () => "test local summary" }); assert.ok(pi.command); assert.equal(pi.handlers.has("turn_end"), false); const result = await pi.handlers.get("session_before_compact")({ preparation: { firstKeptEntryId: "x", tokensBefore: 1, messagesToSummarize: [] } }, ctx()); assert.equal(result.compaction.details.state, "local_fallback"); assert.equal(result.compaction.details.failureClass, "calibration_unverified"); });
