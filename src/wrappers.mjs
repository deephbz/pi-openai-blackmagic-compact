import { AsyncLocalStorage } from "node:async_hooks";
import { openAIResponsesApi, openAICodexResponsesApi, azureOpenAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { sha256 } from "./contract.mjs";

const DELEGATES = Object.freeze({
  "openai-responses": openAIResponsesApi().streamSimple,
  "openai-codex-responses": openAICodexResponsesApi().streamSimple,
  "azure-openai-responses": azureOpenAIResponsesApi().streamSimple,
});
const PROBE_CODEX_TOKEN = "eyJhbGciOiJub25lIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiaGMtc2VyaWFsaXphdGlvbi1wcm9iZSJ9fQ.signature";

export function payloadHash(payload) { return sha256(payload); }
export function supportedApi(api) { return Object.hasOwn(DELEGATES, api); }
export function createProviderRequestCorrelation() {
  const storage = new AsyncLocalStorage();
  return Object.freeze({
    current: () => storage.getStore(),
    run: (invocation, callback) => storage.run(invocation, callback),
  });
}

/**
 * Calls Pi's complete onPayload chain first, then observes the exact body that
 * the unmodified pi-ai streamSimple delegate will send to its native client.
 * The invocation token scopes Pi's before_provider_request correlation to this
 * stream only, so same-provider auxiliary calls cannot consume or poison it.
 */
export function wrapOnPayload(originalOnPayload, observeFinal, model, context, correlation, invocation = Object.freeze({})) {
  return async (base, payloadModel) => {
    const baseSnapshot = structuredClone(base);
    const callOriginal = () => originalOnPayload?.(base, payloadModel);
    let chained;
    try { chained = correlation ? await correlation.run(invocation, callOriginal) : await callOriginal(); }
    catch (error) { await observeFinal({ model: payloadModel, context, base: baseSnapshot, callbackError: error, invocation }); throw error; }
    const finalBody = chained === undefined ? base : chained;
    await observeFinal({ model: payloadModel, context, base: baseSnapshot, finalBody, invocation });
    return finalBody;
  };
}
export function transparentStreamSimple(observeFinal, fallback, observeNativeMessage = () => {}, correlation) {
  return (model, context, options = {}) => {
    const delegate = DELEGATES[model.api];
    if (!delegate) return fallback(model, context, options);
    const originalOnPayload = options.onPayload;
    const invocation = Object.freeze({});
    const stream = delegate(model, context, { ...options, onPayload: wrapOnPayload(originalOnPayload, observeFinal, model, context, correlation, invocation) });
    void stream.result().then((message) => observeNativeMessage({ model, context, message, invocation }), () => {});
    return stream;
  };
}

export function installTransparentWrappers(pi, observeFinal, observeNativeMessage, correlation = createProviderRequestCorrelation()) {
  const pairs = [["openai", "openai-responses"], ["openai-codex", "openai-codex-responses"], ["azure-openai-responses", "azure-openai-responses"]];
  if (typeof pi.registerProvider !== "function") return [];
  for (const [name, api] of pairs) pi.registerProvider(name, { api, streamSimple: transparentStreamSimple(observeFinal, () => { throw new Error(`Unexpected non-${api} stream on ${name}`); }, observeNativeMessage, correlation) });
  return pairs.map(([name]) => name);
}

class SerializationProbeComplete extends Error {}
async function captureNativeInput(model, context) {
  const delegate = DELEGATES[model.api];
  if (!delegate) throw new Error(`unsupported Responses serializer API: ${model.api}`);
  let settled = false;
  let resolveCapture;
  let rejectCapture;
  const capture = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  const stream = delegate(model, context, {
    apiKey: model.api === "openai-codex-responses" ? PROBE_CODEX_TOKEN : "hc-serialization-probe",
    cacheRetention: "none",
    transport: "sse",
    onPayload(payload) {
      if (!Array.isArray(payload?.input)) throw new Error("native Responses serializer produced no input array");
      settled = true;
      resolveCapture(structuredClone(payload.input));
      throw new SerializationProbeComplete("serialization probe complete");
    },
  });
  void stream.result().then((message) => {
    if (!settled) rejectCapture(new Error(message?.errorMessage ?? "native Responses serialization probe failed"));
  }, rejectCapture);
  return capture;
}

export async function serializePostCompactionSegment(model, context, branchEntries, compactionEntry) {
  const messages = convertToLlm(buildSessionContext([...branchEntries, compactionEntry]).messages);
  return captureNativeInput(model, { ...context, messages });
}

export async function serializeTail(model, context, tail, priorInput) {
  if (!tail.length) return [];
  const priorMessages = context?.messages ?? [];
  const expectedPrefix = priorInput ?? await captureNativeInput(model, { ...context, messages: priorMessages });
  const combined = await captureNativeInput(model, { ...context, messages: [...priorMessages, ...tail] });
  if (combined.length < expectedPrefix.length || expectedPrefix.some((item, index) => payloadHash(item) !== payloadHash(combined[index]))) throw new Error("tail serialization prefix mismatch");
  return combined.slice(expectedPrefix.length);
}

export function appendTailPrediction(priorPayload, serializedTail) {
  return { ...priorPayload, input: [...(priorPayload.input ?? []), ...serializedTail] };
}
export function calibrationMatches(priorPayload, serializedTail, nextProviderBody) {
  return payloadHash(appendTailPrediction(priorPayload, serializedTail).input) === payloadHash(nextProviderBody?.input);
}

export function evaluateCaptureOrder({ base, extensionInputHash, extensionOutputHash, finalBody }) {
  const baseHash = payloadHash(base);
  const baseInputHash = payloadHash(base?.input);
  const finalHash = payloadHash(finalBody);
  return { baseHash, baseInputHash, finalHash, earlierRewrite: Boolean(extensionInputHash) && extensionInputHash !== baseInputHash, laterRewrite: Boolean(extensionOutputHash) && extensionOutputHash !== finalHash, verified: Boolean(extensionInputHash) && Boolean(extensionOutputHash) && extensionInputHash === baseInputHash && extensionOutputHash === finalHash };
}
