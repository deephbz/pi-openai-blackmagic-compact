import test from "node:test";
import assert from "node:assert/strict";
import { appendTailPrediction, calibrationMatches, createProviderRequestCorrelation, evaluateCaptureOrder, installTransparentWrappers, payloadHash, wrapOnPayload } from "../src/wrappers.mjs";
import { replaceOneHashSegment, sha256 } from "../src/contract.mjs";

test("provider registration retains native provider identity, models, auth and unsupported stream behavior", () => {
  const registrations = []; const pi = { registerProvider(name, config) { registrations.push({ name, config }); } };
  assert.deepEqual(installTransparentWrappers(pi, async () => {}), ["openai", "openai-codex", "azure-openai-responses"]);
  assert.deepEqual(registrations.map(({ name, config }) => [name, config.api]), [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"], ["azure-openai-responses", "azure-openai-responses"]]);
});

test("wrapped onPayload snapshots before one callback, observes its exact returned body, and never mutates it", async () => {
  const base = { input: [{ role: "user", text: "base" }], tools: [{ name: "preserved" }], prompt_cache_key: "cache" };
  const final = { ...base, input: [{ role: "user", text: "rewritten" }], reasoning: { effort: "high" } };
  let callbacks = 0; let observed;
  const wrapped = wrapOnPayload(async () => { callbacks += 1; base.input[0].text = "mutated-after-snapshot"; return final; }, async (record) => { observed = record; });
  const result = await wrapped(base, { id: "model" });
  assert.equal(callbacks, 1); assert.equal(result, final); assert.equal(observed.base.input[0].text, "base"); assert.equal(observed.finalBody, final);
  assert.deepEqual(result.tools, [{ name: "preserved" }]); assert.equal(result.prompt_cache_key, "cache");
});
test("wrapped payload callbacks expose a request-local correlation token", async () => {
  const correlation = createProviderRequestCorrelation();
  const invocation = Object.freeze({});
  let callbackToken; let observed;
  const wrapped = wrapOnPayload(async (base) => { callbackToken = correlation.current(); return base; }, async (record) => { observed = record; }, {}, {}, correlation, invocation);
  await wrapped({ input: [] }, {});
  assert.equal(callbackToken, invocation);
  assert.equal(observed.invocation, invocation);
  assert.equal(correlation.current(), undefined);
});
test("wrapped callback errors are reported once and rethrown", async () => {
  const boom = new Error("boom"); let observed;
  const wrapped = wrapOnPayload(async () => { throw boom; }, async (record) => { observed = record; });
  await assert.rejects(() => wrapped({ input: [] }, {}), boom);
  assert.equal(observed.callbackError, boom);
});
test("ordering proof detects both earlier and later request rewriters", () => {
  const base = { input: [{ role: "user", text: "base" }] }; const extension = { input: [{ role: "user", text: "extension" }] }; const final = { input: [{ role: "user", text: "final" }] };
  assert.equal(evaluateCaptureOrder({ base, extensionInputHash: payloadHash(extension.input), extensionOutputHash: payloadHash(extension), finalBody: extension }).earlierRewrite, true);
  assert.equal(evaluateCaptureOrder({ base, extensionInputHash: payloadHash(base.input), extensionOutputHash: payloadHash(extension), finalBody: final }).laterRewrite, true);
  assert.equal(evaluateCaptureOrder({ base, extensionInputHash: payloadHash(base.input), extensionOutputHash: payloadHash(base), finalBody: base }).verified, true);
});
test("tail prediction keeps all provider request fields and segment replay is exact once", () => {
  const prior = { model: "gpt", input: [{ id: "old" }], reasoning: { effort: "high" }, text: { verbosity: "low" }, tool_choice: "auto", store: false, include: ["reasoning.encrypted_content"], prompt_cache_key: "cache" };
  const predicted = appendTailPrediction(prior, [{ id: "tail" }]);
  assert.deepEqual(predicted.input, [{ id: "old" }, { id: "tail" }]); assert.equal(predicted.prompt_cache_key, "cache"); assert.equal(predicted.reasoning.effort, "high");
  assert.equal(calibrationMatches(prior, [{ id: "tail" }], predicted), true); assert.equal(calibrationMatches(prior, [{ id: "tail" }], { ...predicted, tools: [] }), true, "prompt/tool rewrites are fenced separately from input calibration");
  assert.deepEqual(replaceOneHashSegment([{ id: "summary" }, { id: "keep" }, { id: "new" }], [sha256({ id: "summary" }), sha256({ id: "keep" })], [{ id: "opaque" }]), [{ id: "opaque" }, { id: "new" }]);
  assert.equal(replaceOneHashSegment([{ id: "same" }, { id: "same" }], [sha256({ id: "same" })], [{ id: "opaque" }]), undefined, "ambiguous replay fails closed");
});
