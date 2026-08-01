import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { azureOpenAIResponsesApi, openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { compactCodex, compactResponses } from "./adapters.mjs";
import { identifySurface, identityMatches, latestActiveCompaction, replaceOneHashSegment, safeTelemetry, sha256 } from "./contract.mjs";
import { BLACKMAGIC_APPLIED_NOTICE, BLACKMAGIC_MODEL_SUMMARY, COMPACTION_DECISION, COMPACTION_OUTCOME, CONTINUATION_REPLAY, SUMMARY_STAYS_READABLE, classifyContinuation, continuationFooter, decideCompaction, isBlackmagicModelPlaceholder, projectBlackmagicStatus } from "./state-machine.mjs";

const DELEGATES = Object.freeze({
  "openai-responses": openAIResponsesApi().streamSimple,
  "openai-codex-responses": openAICodexResponsesApi().streamSimple,
  "azure-openai-responses": azureOpenAIResponsesApi().streamSimple,
});
const REPLAY_NAMESPACE = "pi-openai-blackmagic-compact/1";
const LEGACY_REPLAY_NAMESPACE = "hc-openai-server-compaction/3";
const FOOTER_STATUS_KEY = "pi-openai-blackmagic-compact/provider-mismatch";
class SerializationProbeComplete extends Error {}

function extractPrepared(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.input)) return undefined;
  return { payload, instructions: payload.instructions, tools: payload.tools, input: payload.input, model: payload.model };
}
function azureDeployment(model, auth) {
  const mapping = auth?.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  for (const entry of String(mapping ?? "").split(",")) {
    const [id, deployment] = entry.split("=", 2).map((value) => value?.trim());
    if (id === model?.id && deployment) return deployment;
  }
  return model?.id;
}
function modelIdentity(ctx, auth) {
  const model = ctx?.model;
  const env = auth?.env ?? {};
  const baseUrl = model?.api === "azure-openai-responses"
    ? (env.AZURE_OPENAI_BASE_URL ?? (env.AZURE_OPENAI_RESOURCE_NAME ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1` : model?.baseUrl))
    : (env.OPENAI_BASE_URL ?? model?.baseUrl);
  return identifySurface({ provider: model?.provider, baseUrl, api: model?.api, model: model?.id, deployment: model?.api === "azure-openai-responses" ? azureDeployment(model, auth) : undefined });
}
function activeCheckpoint(branch) {
  const entry = latestActiveCompaction(branch);
  const details = entry?.details;
  const replay = details?.replay;
  const checkpoint = details?.checkpoint;
  if (details?.schemaVersion !== 1 || details.state !== "remote_applied" || ![REPLAY_NAMESPACE, LEGACY_REPLAY_NAMESPACE].includes(replay?.namespace) || !Array.isArray(replay.replacedItemHashes) || !replay.replacedItemHashes.length || replay.replacedItemHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) || !Array.isArray(checkpoint?.artifact) || !checkpoint.artifact.length) return undefined;
  const serialized = JSON.stringify(checkpoint.artifact);
  if (checkpoint.hash !== sha256(serialized) || checkpoint.length !== serialized.length) return undefined;
  return { entry, details };
}
function activeCheckpointStatus(branch) {
  const entry = latestActiveCompaction(branch);
  if (!entry) return { kind: "none" };
  if (entry.details?.state !== "remote_applied") return { kind: "readable" };
  const checkpoint = activeCheckpoint(branch);
  return checkpoint ? { kind: "valid", checkpoint } : { kind: "invalid", entry };
}
function rewriteReplay(payload, checkpoint, identity) {
  const replay = checkpoint?.details?.replay;
  if (!payload || !identityMatches(checkpoint.details, identity) || ![REPLAY_NAMESPACE, LEGACY_REPLAY_NAMESPACE].includes(replay?.namespace)) return undefined;
  const next = replaceOneHashSegment(payload.input, replay.replacedItemHashes, checkpoint.details.checkpoint?.artifact);
  return next ? { ...payload, input: next } : undefined;
}
function compactionSummaryText(summary) {
  const [message] = convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }]);
  const [content] = Array.isArray(message?.content) ? message.content : [];
  return content?.type === "text" ? content.text : undefined;
}
function exactText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content) || item.content.length !== 1) return undefined;
  const [content] = item.content;
  return (content?.type === "text" || content?.type === "input_text") && typeof content.text === "string" ? content.text : undefined;
}
function removeModelPlaceholder(payload, summary) {
  if (!payload || !isBlackmagicModelPlaceholder(summary)) return payload;
  const expected = compactionSummaryText(summary);
  if (!expected) return payload;
  for (const field of ["input", "messages"]) {
    const items = payload[field];
    if (!Array.isArray(items)) continue;
    const index = items.findIndex((item) => item?.role === "user" && exactText(item) === expected);
    if (index >= 0) return { ...payload, [field]: [...items.slice(0, index), ...items.slice(index + 1)] };
  }
  return payload;
}
async function resolveAuth(ctx) {
  try {
    return ctx?.model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function" ? await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model) : undefined;
  } catch {
    return undefined;
  }
}
function activeTools(pi) {
  if (typeof pi?.getActiveTools !== "function" || typeof pi?.getAllTools !== "function") throw new Error("Pi tool access is unavailable");
  const names = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => names.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
}
export async function captureNativeBody(model, context, options) {
  const delegate = DELEGATES[model?.api];
  if (!delegate) throw new Error("unsupported Responses serializer API");
  let settled = false;
  let resolveCapture;
  let rejectCapture;
  const capture = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  let stream;
  try {
    stream = delegate(model, context, { ...options, onPayload(payload) {
      if (!Array.isArray(payload?.input)) throw new Error("native Responses serializer produced no input array");
      settled = true;
      resolveCapture(structuredClone(payload));
      throw new SerializationProbeComplete("serialization probe complete");
    } });
  } catch (error) {
    rejectCapture(error);
    return capture;
  }
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
function hookResult(decision) {
  if (decision.kind === COMPACTION_DECISION.DELEGATE) return undefined;
  if (decision.kind === COMPACTION_DECISION.CANCEL) return { cancel: true };
  if (decision.kind === COMPACTION_DECISION.APPLY) return { compaction: decision.compaction };
  throw new TypeError(`cannot render pending compaction decision: ${decision.kind}`);
}
export function readableSummary() { throw new Error("Blackmagic opaque History has no readable summary; readable summaries belong to Pi native compaction"); }

export function createServerCompactionController(pi, options = {}) {
  if (!pi?.on || !pi?.registerCommand) throw new TypeError("A complete Pi ExtensionAPI is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const telemetry = typeof options.telemetry === "function" ? options.telemetry : () => {};
  const emit = (type, data = {}) => { try { telemetry(safeTelemetry(type, data)); } catch {} };
  const scheduledNotices = new Set();
  const scheduleAppliedNotice = (ctx) => {
    const ui = ctx?.ui;
    if (ctx?.mode !== "tui" || typeof ui?.notify !== "function") return;
    const timer = setTimeout(() => {
      scheduledNotices.delete(timer);
      ui.notify(BLACKMAGIC_APPLIED_NOTICE, "info");
    }, 0);
    scheduledNotices.add(timer);
  };
  const clearScheduledNotices = () => {
    for (const timer of scheduledNotices) clearTimeout(timer);
    scheduledNotices.clear();
  };

  const setState = (ctx, state) => {
    if (typeof ctx?.ui?.setStatus === "function") ctx.ui.setStatus(FOOTER_STATUS_KEY, continuationFooter(state));
    return state;
  };
  const coarseState = async (ctx, selectedIdentity) => {
    const status = activeCheckpointStatus(ctx?.sessionManager?.getBranch?.());
    if (status.kind === "none" || status.kind === "readable") return setState(ctx, classifyContinuation());
    if (status.kind === "invalid") return setState(ctx, classifyContinuation({ opaqueHistory: true, routeMatches: false, replay: CONTINUATION_REPLAY.FAILED }));
    const checkpoint = status.checkpoint;
    const identity = selectedIdentity ?? modelIdentity(ctx, await resolveAuth(ctx));
    return setState(ctx, classifyContinuation({ opaqueHistory: true, routeMatches: identityMatches(checkpoint.details, identity) }));
  };

  for (const eventName of ["session_start", "model_select", "session_tree"]) pi.on(eventName, (_event, ctx) => coarseState(ctx));
  pi.on("session_compact", async (event, ctx) => {
    const state = await coarseState(ctx);
    if (event.fromExtension && event.compactionEntry?.details?.state === "remote_applied") scheduleAppliedNotice(ctx);
    return state;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearScheduledNotices();
    return setState(ctx, SUMMARY_STAYS_READABLE);
  });
  pi.on("context", async (event, ctx) => {
    const status = activeCheckpointStatus(ctx?.sessionManager?.getBranch?.());
    if (status.kind === "none" || status.kind === "readable") return;
    const entry = status.kind === "valid" ? status.checkpoint.entry : status.entry;
    if (!isBlackmagicModelPlaceholder(entry?.summary)) return;
    if (status.kind === "valid") {
      const identity = modelIdentity(ctx, await resolveAuth(ctx));
      if (identityMatches(status.checkpoint.details, identity)) return;
    }
    return { messages: event.messages.filter((message) => !(message?.role === "compactionSummary" && message.summary === entry.summary)) };
  });
  pi.on("before_provider_request", async (event, ctx) => {
    const auth = await resolveAuth(ctx);
    const identity = modelIdentity(ctx, auth);
    const status = activeCheckpointStatus(ctx?.sessionManager?.getBranch?.());
    if (status.kind === "none" || status.kind === "readable") {
      setState(ctx, classifyContinuation());
      if (identity.kind !== "supported") emit("unsupported_surface", { identity });
      return event.payload;
    }
    if (status.kind === "invalid") {
      setState(ctx, classifyContinuation({ opaqueHistory: true, routeMatches: false, replay: CONTINUATION_REPLAY.FAILED }));
      emit("remote_invalidated", { identity, failureClass: "invalid_checkpoint" });
      return removeModelPlaceholder(event.payload, status.entry?.summary);
    }
    const checkpoint = status.checkpoint;
    const replayed = rewriteReplay(event.payload, checkpoint, identity);
    if (replayed) {
      setState(ctx, classifyContinuation({ opaqueHistory: true, routeMatches: true, replay: CONTINUATION_REPLAY.SUCCEEDED }));
      emit("remote_replayed", { identity, checkpoint: checkpoint.details.checkpoint, retention: checkpoint.details.checkpoint.retention });
      return replayed;
    }
    setState(ctx, classifyContinuation({ opaqueHistory: true, routeMatches: identityMatches(checkpoint.details, identity), replay: CONTINUATION_REPLAY.FAILED }));
    emit("remote_invalidated", { identity, failureClass: identityMatches(checkpoint.details, identity) ? "replay_segment_mismatch" : "identity_mismatch" });
    return removeModelPlaceholder(event.payload, checkpoint.entry?.summary);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const auth = await resolveAuth(ctx);
    const identity = modelIdentity(ctx, auth);
    const initial = decideCompaction({ routeSupported: identity.kind === "supported", authorized: auth?.ok === true && Boolean(auth.apiKey) });
    if (initial.kind === COMPACTION_DECISION.DELEGATE) return hookResult(initial);

    let compactBody;
    try { compactBody = extractPrepared(await serializeBranch(pi, event, ctx, auth)); } catch {}
    if (!compactBody) return hookResult(decideCompaction({ routeSupported: true, authorized: true, outcome: COMPACTION_OUTCOME.FAILED, failureClass: "serialization_unavailable" }));

    const checkpoint = activeCheckpoint(event.branchEntries ?? ctx.sessionManager?.getBranch?.());
    if (checkpoint) {
      const replayed = rewriteReplay(compactBody.payload, checkpoint, identity);
      if (replayed) compactBody = extractPrepared(replayed);
    }

    const result = identity.surface === "chatgpt_codex"
      ? await compactCodex({ identity, prepared: compactBody, auth, fetchImpl, signal: event.signal })
      : await compactResponses({ identity, prepared: compactBody, auth, fetchImpl, signal: event.signal });
    if (!result.details) return hookResult(decideCompaction({ routeSupported: true, authorized: true, outcome: COMPACTION_OUTCOME.FAILED, failureClass: result.failureClass }));

    const syntheticCompaction = {
      type: "compaction",
      id: "pi-openai-blackmagic-compact-pending",
      parentId: ctx.sessionManager?.getLeafId?.() ?? "",
      timestamp: Date.now(),
      summary: BLACKMAGIC_MODEL_SUMMARY,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    };
    let postSegment;
    try { postSegment = await serializePostCompaction(pi, event, ctx, auth, syntheticCompaction); } catch {}
    if (!Array.isArray(postSegment) || !postSegment.length) return hookResult(decideCompaction({ routeSupported: true, authorized: true, outcome: COMPACTION_OUTCOME.FAILED, failureClass: "post_compaction_segment_unavailable" }));

    result.details.lineage = { firstKeptEntryId: event.preparation.firstKeptEntryId, leafId: ctx.sessionManager?.getLeafId?.() };
    result.details.replay = { namespace: REPLAY_NAMESPACE, replacedItemHashes: postSegment.map((item) => sha256(item)) };
    const compaction = { summary: BLACKMAGIC_MODEL_SUMMARY, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: result.details };
    emit("remote_applied", { identity, ...result.details, checkpoint: result.details.checkpoint });
    return hookResult(decideCompaction({ routeSupported: true, authorized: true, outcome: COMPACTION_OUTCOME.SUCCEEDED, compaction }));
  });
  pi.registerCommand("blackmagic", {
    description: "Show Blackmagic compaction status or help.",
    getArgumentCompletions(prefix) {
      const items = ["status", "help"].filter((x) => x.startsWith(prefix.trim())).map((value) => ({ value, label: value, description: value === "status" ? "Show current compaction status" : "Show command usage" }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      let text;
      if (action === "help") {
        text = "Usage: /blackmagic [status|help]\nUse /compact to compact History. /blackmagic only reports current state.";
      } else if (action === "status") {
        const auth = await resolveAuth(ctx);
        const identity = modelIdentity(ctx, auth);
        const state = await coarseState(ctx, identity);
        text = projectBlackmagicStatus({ state, serverCompactionAvailable: identity.kind === "supported" && auth?.ok === true && Boolean(auth.apiKey) });
      } else {
        text = "Usage: /blackmagic [status|help]";
      }
      if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, action === "status" || action === "help" ? "info" : "warning");
    },
  });
}
