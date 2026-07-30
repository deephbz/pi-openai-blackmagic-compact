import { buildSessionContext, compact as nativeCompact, convertToLlm } from "@earendil-works/pi-coding-agent";
import { azureOpenAIResponsesApi, openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { compactCodex, compactResponses } from "./adapters.mjs";
import { describeRemoteRoute, footerCompactionStatus, identifySurface, identityMatches, latestActiveCompaction, projectCompactionMethod, replaceOneHashSegment, safeTelemetry, sha256 } from "./contract.mjs";

const DELEGATES = Object.freeze({
  "openai-responses": openAIResponsesApi().streamSimple,
  "openai-codex-responses": openAICodexResponsesApi().streamSimple,
  "azure-openai-responses": azureOpenAIResponsesApi().streamSimple,
});
const REPLAY_NAMESPACE = "pi-openai-blackmagic-compact/1";
const LEGACY_REPLAY_NAMESPACE = "hc-openai-server-compaction/3";
class SerializationProbeComplete extends Error {}

function extractPrepared(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.input)) return undefined;
  return { payload, instructions: payload.instructions, tools: payload.tools, input: payload.input, model: payload.model };
}
function azureDeployment(model, auth) {
  const mapping = auth?.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  for (const entry of String(mapping ?? "").split(",")) { const [id, deployment] = entry.split("=", 2).map((value) => value?.trim()); if (id === model?.id && deployment) return deployment; }
  return model?.id;
}
function modelIdentity(ctx, auth) {
  const model = ctx?.model; const env = auth?.env ?? {};
  const baseUrl = model?.api === "azure-openai-responses" ? (env.AZURE_OPENAI_BASE_URL ?? (env.AZURE_OPENAI_RESOURCE_NAME ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1` : model?.baseUrl)) : (env.OPENAI_BASE_URL ?? model?.baseUrl);
  return identifySurface({ provider: model?.provider, baseUrl, api: model?.api, model: model?.id, deployment: model?.api === "azure-openai-responses" ? azureDeployment(model, auth) : undefined });
}
function activeCheckpoint(branch) {
  const entry = latestActiveCompaction(branch);
  const details = entry?.details; const replay = details?.replay; const checkpoint = details?.checkpoint;
  if (details?.schemaVersion !== 1 || details.state !== "remote_applied" || ![REPLAY_NAMESPACE, LEGACY_REPLAY_NAMESPACE].includes(replay?.namespace) || !Array.isArray(replay.replacedItemHashes) || !replay.replacedItemHashes.length || replay.replacedItemHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) || !Array.isArray(checkpoint?.artifact) || !checkpoint.artifact.length) return undefined;
  const serialized = JSON.stringify(checkpoint.artifact);
  if (checkpoint.hash !== sha256(serialized) || checkpoint.length !== serialized.length) return undefined;
  return { entry, details };
}
function rewriteReplay(payload, checkpoint, identity) {
  const replay = checkpoint?.details?.replay;
  if (!payload || !identityMatches(checkpoint.details, identity) || ![REPLAY_NAMESPACE, LEGACY_REPLAY_NAMESPACE].includes(replay?.namespace)) return undefined;
  const next = replaceOneHashSegment(payload.input, replay.replacedItemHashes, checkpoint.details.checkpoint?.artifact);
  return next ? { ...payload, input: next } : undefined;
}
async function nativeSummary(event, ctx) {
  if (!ctx?.model || typeof ctx?.modelRegistry?.getApiKeyAndHeaders !== "function") return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth?.ok) return undefined;
  return nativeCompact(event.preparation, ctx.model, auth.apiKey, auth.headers, event.customInstructions, event.signal, ctx.thinkingLevel, undefined, auth.env);
}
function activeTools(pi) {
  if (typeof pi?.getActiveTools !== "function" || typeof pi?.getAllTools !== "function") throw new Error("Pi tool access is unavailable");
  const names = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => names.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
}
export async function captureNativeBody(model, context, options) {
  const delegate = DELEGATES[model?.api];
  if (!delegate) throw new Error("unsupported Responses serializer API");
  let settled = false; let resolveCapture; let rejectCapture;
  const capture = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  let stream;
  try {
    stream = delegate(model, context, { ...options, onPayload(payload) { if (!Array.isArray(payload?.input)) throw new Error("native Responses serializer produced no input array"); settled = true; resolveCapture(structuredClone(payload)); throw new SerializationProbeComplete("serialization probe complete"); } });
  } catch (error) { rejectCapture(error); return capture; }
  void stream.result().then((message) => { if (!settled) rejectCapture(new Error(message?.errorMessage ?? "native Responses serializer failed")); }, rejectCapture);
  return capture;
}
export function serializationOptions(ctx, auth, signal) {
  return { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, cacheRetention: "none", transport: "sse", reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel, sessionId: ctx.sessionManager?.getSessionId?.(), signal };
}
async function serializeBranch(pi, event, ctx, auth) {
  if (typeof ctx?.getSystemPrompt !== "function") throw new Error("Pi system prompt access is unavailable");
  const messages = convertToLlm(buildSessionContext(event.branchEntries ?? ctx.sessionManager?.getBranch?.() ?? []).messages);
  return captureNativeBody(ctx.model, { systemPrompt: ctx.getSystemPrompt(), messages, tools: activeTools(pi) }, serializationOptions(ctx, auth, event.signal));
}
async function serializePostCompaction(pi, event, ctx, auth, syntheticCompaction) {
  if (typeof ctx?.getSystemPrompt !== "function") throw new Error("Pi system prompt access is unavailable");
  const branch = event.branchEntries ?? ctx.sessionManager?.getBranch?.() ?? [];
  const messages = convertToLlm(buildSessionContext([...branch, syntheticCompaction]).messages);
  return (await captureNativeBody(ctx.model, { systemPrompt: ctx.getSystemPrompt(), messages, tools: activeTools(pi) }, serializationOptions(ctx, auth, event.signal))).input;
}
export function readableSummary() { throw new Error("readableSummary is model-generated by Pi native compact(); call the session lifecycle handler"); }

export function createServerCompactionController(pi, options = {}) {
  if (!pi?.on || !pi?.registerCommand) throw new TypeError("A complete Pi ExtensionAPI is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const summaryFactory = options.summaryFactory;
  const telemetry = typeof options.telemetry === "function" ? options.telemetry : () => {};
  const emit = (type, data = {}) => { try { telemetry(safeTelemetry(type, data)); } catch {} };
  const methodFor = (ctx) => projectCompactionMethod(ctx?.sessionManager?.getBranch?.());
  const routeFor = (ctx) => describeRemoteRoute(modelIdentity(ctx));
  const updateMethodStatus = (ctx) => { const method = methodFor(ctx); if (typeof ctx?.ui?.setStatus === "function") ctx.ui.setStatus("pi-openai-blackmagic-compact", footerCompactionStatus(method)); return method; };
  const localFallback = (local, failureClass) => ({ compaction: { ...local, details: { ...(local.details ?? {}), schemaVersion: 1, state: "local_fallback", failureClass } } });

  pi.on("session_start", (_event, ctx) => { updateMethodStatus(ctx); });
  pi.on("session_tree", (_event, ctx) => { updateMethodStatus(ctx); });
  pi.on("session_compact", (_event, ctx) => { updateMethodStatus(ctx); });
  pi.on("before_provider_request", async (event, ctx) => {
    const auth = ctx?.model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function" ? await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model) : undefined;
    const identity = modelIdentity(ctx, auth);
    if (identity.kind !== "supported") { emit("unsupported_surface", { identity }); return undefined; }
    const checkpoint = activeCheckpoint(ctx?.sessionManager?.getBranch?.());
    const replayed = checkpoint && rewriteReplay(event.payload, checkpoint, identity);
    if (replayed) emit("remote_replayed", { identity, checkpoint: checkpoint.details.checkpoint, retention: checkpoint.details.checkpoint.retention });
    else if (checkpoint?.details?.schemaVersion === 1) emit("remote_invalidated", { identity, failureClass: identityMatches(checkpoint.details, identity) ? "replay_segment_mismatch" : "identity_mismatch" });
    return replayed;
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const local = summaryFactory ? { summary: await summaryFactory(event.preparation, event, ctx), firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } : await nativeSummary(event, ctx);
    if (!local?.summary?.trim()) return undefined;
    if (!ctx?.model || typeof ctx?.modelRegistry?.getApiKeyAndHeaders !== "function") return localFallback(local, "auth_unavailable");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    const identity = modelIdentity(ctx, auth);
    if (!auth?.ok || !auth.apiKey) return localFallback(local, "auth_unavailable");
    if (identity.kind !== "supported") { emit("local_fallback", { identity, failureClass: "model_or_protocol" }); return localFallback(local, "model_or_protocol"); }
    let compactBody;
    try { compactBody = extractPrepared(await serializeBranch(pi, event, ctx, auth)); } catch { emit("local_fallback", { identity, failureClass: "serialization_unavailable" }); return localFallback(local, "serialization_unavailable"); }
    if (!compactBody) return localFallback(local, "serialization_unavailable");
    const checkpoint = activeCheckpoint(event.branchEntries ?? ctx.sessionManager?.getBranch?.());
    if (checkpoint) {
      const replayed = rewriteReplay(compactBody.payload, checkpoint, identity);
      if (!replayed) { emit("local_fallback", { identity, failureClass: "replay_segment_mismatch" }); return localFallback(local, "replay_segment_mismatch"); }
      compactBody = extractPrepared(replayed);
    }
    const result = identity.surface === "chatgpt_codex" ? await compactCodex({ identity, prepared: compactBody, auth, fetchImpl, signal: event.signal }) : await compactResponses({ identity, prepared: compactBody, auth, fetchImpl, signal: event.signal });
    if (!result.details) { emit("local_fallback", { identity, failureClass: result.failureClass }); return localFallback(local, result.failureClass); }
    const syntheticCompaction = { type: "compaction", id: "pi-openai-blackmagic-compact-pending", parentId: ctx.sessionManager?.getLeafId?.() ?? "", timestamp: Date.now(), summary: local.summary, firstKeptEntryId: local.firstKeptEntryId, tokensBefore: local.tokensBefore };
    let postSegment;
    try { postSegment = await serializePostCompaction(pi, event, ctx, auth, syntheticCompaction); } catch { emit("local_fallback", { identity, failureClass: "post_compaction_segment_unavailable" }); return localFallback(local, "post_compaction_segment_unavailable"); }
    result.details.lineage = { firstKeptEntryId: event.preparation.firstKeptEntryId, leafId: ctx.sessionManager?.getLeafId?.() };
    result.details.replay = { namespace: REPLAY_NAMESPACE, replacedItemHashes: postSegment.map((item) => sha256(item)) };
    emit("remote_applied", { identity, ...result.details, checkpoint: result.details.checkpoint });
    return { compaction: { ...local, details: { ...result.details, local: local.details } } };
  });
  pi.registerCommand("server-compact", { description: "Show focused server-compaction status or help; it never changes thresholds.", getArgumentCompletions(prefix) { const items = ["status", "help"].filter((x) => x.startsWith(prefix.trim())).map((value) => ({ value, label: value, description: value === "status" ? "Safe current capability status" : "Command usage" })); return items.length ? items : null; }, handler: async (args, ctx) => { const action = args.trim() || "status"; const method = updateMethodStatus(ctx); const route = routeFor(ctx); const text = action === "help" ? "Usage: /server-compact [status|help]. It has no agent tool and never owns thresholds." : action === "status" ? [
    `Active branch: ${method}`,
    `Next /compact: ${route ? "direct provider compaction when authorization permits it" : "Pi local fallback — current surface is unsupported"}`,
    ...(route ? [`Route/protocol: ${route}`] : []),
    "Guaranteed fallback: Pi native local summary.",
    "Privacy: no prompts, tools, credentials, endpoints, deployments, opaque artifacts, hashes, or item counts.",
  ].join("\n") : "Usage: /server-compact [status|help]"; if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, action === "status" || action === "help" ? "info" : "warning"); } });
}
