import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { azureOpenAIResponsesApi, openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { Box, Text } from "@earendil-works/pi-tui";
import { compactProviderInput, validateProviderAuthorization } from "./adapters.mjs";
import { COMPACTION_TIMELINE_ENTRY_TYPE, compactionTimelineData, compactionTimelineLabel, identifySurface, identityMatches, latestActiveCompaction, replaceOneHashSegment, safeTelemetry, sha256 } from "./contract.mjs";

const DELEGATES = Object.freeze({
  "openai-responses": openAIResponsesApi().streamSimple,
  "openai-codex-responses": openAICodexResponsesApi().streamSimple,
  "azure-openai-responses": azureOpenAIResponsesApi().streamSimple,
});
const REPLAY_NAMESPACE = "pi-openai-blackmagic-compact/1";
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
function modelIdentity(ctx, auth, modelOverride = ctx?.model) {
  const model = modelOverride; const env = auth?.env ?? {};
  const baseUrl = model?.api === "azure-openai-responses" ? (env.AZURE_OPENAI_BASE_URL ?? (env.AZURE_OPENAI_RESOURCE_NAME ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1` : model?.baseUrl)) : (env.OPENAI_BASE_URL ?? model?.baseUrl);
  return identifySurface({ provider: model?.provider, baseUrl, api: model?.api, model: model?.id, deployment: model?.api === "azure-openai-responses" ? azureDeployment(model, auth) : undefined });
}
function activeCheckpoint(branch) {
  const entry = latestActiveCompaction(branch);
  const details = entry?.details; const replay = details?.replay; const checkpoint = details?.checkpoint;
  if (details?.schemaVersion !== 1 || details.state !== "remote_applied" || replay?.namespace !== REPLAY_NAMESPACE || !Array.isArray(replay.replacedItemHashes) || !replay.replacedItemHashes.length || replay.replacedItemHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) || !Array.isArray(checkpoint?.artifact) || !checkpoint.artifact.length) return undefined;
  const serialized = JSON.stringify(checkpoint.artifact);
  if (checkpoint.hash !== sha256(serialized) || checkpoint.length !== serialized.length) return undefined;
  return { entry, details };
}
function rewriteReplay(payload, checkpoint, identity) {
  const replay = checkpoint?.details?.replay;
  if (!payload || !identityMatches(checkpoint.details, identity) || replay?.namespace !== REPLAY_NAMESPACE) return undefined;
  const next = replaceOneHashSegment(payload.input, replay.replacedItemHashes, checkpoint.details.checkpoint?.artifact);
  return next ? { ...payload, input: next } : undefined;
}
function activeTools(pi) {
  if (typeof pi?.getActiveTools !== "function" || typeof pi?.getAllTools !== "function") throw new Error("Pi tool access is unavailable");
  const names = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => names.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Preserve ordinary line breaks and tabs; neutralize terminal controls. */
function safeDisplayText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(2, "0");
    return `\\x${code}`;
  });
}
function checkpointUserText(item) {
  if (typeof item?.content === "string") return safeDisplayText(item.content);
  if (!Array.isArray(item?.content)) return "";
  return item.content.map((block) => {
    if ((block?.type === "text" || block?.type === "input_text") && typeof block.text === "string") return safeDisplayText(block.text);
    if (block?.type === "image" || block?.type === "input_image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

/**
 * Project only the saved provider checkpoint. This is a TUI-only view; it
 * never reconstructs history from the live branch or adds data to the Session.
 */
export function projectSavedCheckpoint(sessionManager, compactionId) {
  if (!sessionManager || typeof sessionManager.getBranch !== "function" || typeof compactionId !== "string" || !compactionId) return undefined;
  let branch;
  try { branch = sessionManager.getBranch(compactionId); } catch { return undefined; }
  if (!Array.isArray(branch)) return undefined;
  const compaction = branch.find((entry) => entry?.id === compactionId && entry.type === "compaction");
  const artifact = compaction?.details?.checkpoint?.artifact;
  if (!Array.isArray(artifact)) return undefined;
  const retainedUsers = artifact.filter((item) => item?.role === "user").map(checkpointUserText).filter(Boolean);
  const encrypted = artifact.find((item) => item?.type === "compaction" && typeof item.encrypted_content === "string");
  const encryptedPrefix = encrypted?.encrypted_content.slice(0, 100);
  if (retainedUsers.length === 0 && !encryptedPrefix) return undefined;
  return { retainedUsers, encryptedPrefix };
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
function routeFailure(identity, model) {
  if (!model) return "missing model";
  if (identity.reason === "invalid_endpoint") return "invalid endpoint";
  if (identity.reason === "insecure_endpoint") return "endpoint not HTTPS";
  return "unsupported provider route";
}
async function preflightCompaction(pi, event, ctx, auth, { rejectEmptyContext = true, model = ctx?.model } = {}) {
  const branchEntries = event.branchEntries ?? ctx.sessionManager?.getBranch?.();
  if (rejectEmptyContext) {
    if (!Array.isArray(branchEntries) || branchEntries.length === 0) return { failure: "current branch has no context" };
    if (branchEntries.at(-1)?.type === "compaction") return { failure: "current branch already ends with compaction" };
    try {
      if (buildSessionContext(branchEntries).messages.length === 0) return { failure: "current branch has no context" };
    } catch { return { failure: "current branch context unavailable" }; }
  }
  const identity = modelIdentity(ctx, auth, model);
  if (identity.kind !== "supported") return { failure: routeFailure(identity, model) };
  if (!auth?.ok || !auth.apiKey) return { failure: "authorization unavailable" };
  const authorization = validateProviderAuthorization(identity, auth);
  if (!authorization.ok) return { failure: authorization.reason };
  const modelContext = model === ctx?.model ? ctx : { ...ctx, model };
  let compactBody;
  try { compactBody = extractPrepared(await serializeBranch(pi, event, modelContext, auth)); } catch { return { failure: "current branch serialization unavailable" }; }
  if (!compactBody) return { failure: "current branch serialization unavailable" };
  const checkpoint = activeCheckpoint(event.branchEntries ?? ctx.sessionManager?.getBranch?.());
  if (checkpoint) {
    const replayed = rewriteReplay(compactBody.payload, checkpoint, identity);
    if (!replayed) return { failure: "persisted replay does not match the current branch" };
    compactBody = extractPrepared(replayed);
  }
  let postSegment;
  if (event.preparation) {
    const syntheticCompaction = { type: "compaction", id: "pi-openai-blackmagic-compact-pending", parentId: ctx.sessionManager?.getLeafId?.() ?? "", timestamp: Date.now(), summary: "", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore };
    try { postSegment = await serializePostCompaction(pi, event, modelContext, auth, syntheticCompaction); } catch { return { failure: "post-compaction serialization unavailable" }; }
  }
  return { identity, compactBody, postSegment };
}

export function createServerCompactionController(pi, options = {}) {
  if (!pi?.on || !pi?.registerCommand || !pi?.registerEntryRenderer || !pi?.appendEntry) throw new TypeError("A complete Pi ExtensionAPI is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const telemetry = typeof options.telemetry === "function" ? options.telemetry : () => {};
  const emit = (type, data = {}) => { try { telemetry(safeTelemetry(type, data)); } catch {} };
  const appendedCompactions = new Set();
  let sessionManager;

  pi.on("session_start", (_event, ctx) => { sessionManager = ctx.sessionManager; });
  pi.registerEntryRenderer(COMPACTION_TIMELINE_ENTRY_TYPE, (entry, options, theme) => {
    const label = compactionTimelineLabel(entry.data);
    if (!label) return undefined;
    const archive = projectSavedCheckpoint(sessionManager, entry.parentId);
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("accent", label), 0, 0));
    if (!archive) return box;
    if (!options.expanded) {
      box.addChild(new Text(theme.fg("customMessageText", "Context saved at this compaction (expand to view)"), 0, 0));
      return box;
    }
    box.addChild(new Text(theme.fg("customMessageText", "Context saved at this compaction"), 0, 0));
    box.addChild(new Text(theme.fg("dim", "────────────────────────────────"), 0, 0));
    if (archive.retainedUsers.length > 0) {
      box.addChild(new Text(theme.fg("accent", "Retained user messages"), 0, 0));
      for (const message of archive.retainedUsers) box.addChild(new Text(theme.fg("customMessageText", `[User]: ${message}`), 0, 0));
    }
    if (archive.encryptedPrefix) {
      box.addChild(new Text(theme.fg("accent", "Encrypted server context"), 0, 0));
      box.addChild(new Text(theme.fg("customMessageText", "Session-log search prefix"), 0, 0));
      box.addChild(new Text(theme.fg("customMessageText", safeDisplayText(archive.encryptedPrefix)), 0, 0));
    }
    return box;
  });
  pi.on("session_compact", (event, ctx) => {
    sessionManager = ctx?.sessionManager ?? sessionManager;
    const data = event?.fromExtension && compactionTimelineData(event.compactionEntry);
    const id = event?.compactionEntry?.id;
    if (!data || !id || appendedCompactions.has(id)) return;
    appendedCompactions.add(id);
    pi.appendEntry(COMPACTION_TIMELINE_ENTRY_TYPE, data);
  });
  pi.on("before_provider_request", async (event, ctx) => {
    const model = ctx?.model;
    const auth = model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function" ? await ctx.modelRegistry.getApiKeyAndHeaders(model) : undefined;
    const identity = modelIdentity(ctx, auth, model);
    if (identity.kind !== "supported") { emit("unsupported_surface", { identity }); return undefined; }
    const checkpoint = activeCheckpoint(ctx?.sessionManager?.getBranch?.());
    const replayed = checkpoint && rewriteReplay(event.payload, checkpoint, identity);
    if (replayed) emit("remote_replayed", { identity, checkpoint: checkpoint.details.checkpoint, retention: checkpoint.details.checkpoint.retention });
    else if (checkpoint?.details?.schemaVersion === 1) emit("remote_invalidated", { identity, failureClass: identityMatches(checkpoint.details, identity) ? "replay_segment_mismatch" : "identity_mismatch" });
    return replayed;
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx?.model;
    const canResolveAuth = model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function";
    if (!canResolveAuth) return undefined;
    let auth;
    try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); } catch { return undefined; }
    const preflight = await preflightCompaction(pi, event, ctx, auth, { rejectEmptyContext: false, model });
    if (preflight.failure) return undefined;
    const { identity, compactBody, postSegment } = preflight;
    const result = await compactProviderInput({ identity, prepared: compactBody, auth, fetchImpl, signal: event.signal });
    if (!result.details) return undefined;
    result.details.lineage = { firstKeptEntryId: event.preparation.firstKeptEntryId, leafId: ctx.sessionManager?.getLeafId?.() };
    result.details.replay = { namespace: REPLAY_NAMESPACE, replacedItemHashes: postSegment.map((item) => sha256(item)) };
    emit("remote_applied", { identity, ...result.details, checkpoint: result.details.checkpoint });
    return { compaction: { summary: "", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: result.details } };
  });
  pi.registerCommand("blackmagic-status", { description: "Check whether /compact can use Blackmagic remote compaction.", handler: async (args, ctx) => {
    if (typeof args === "string" && args.trim()) {
      if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify("Usage: /blackmagic-status", "warning");
      return;
    }
    const model = ctx?.model;
    let auth;
    try {
      const canResolveAuth = model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function";
      auth = canResolveAuth ? await ctx.modelRegistry.getApiKeyAndHeaders(model) : undefined;
    } catch { auth = undefined; }
    let preflight;
    if (ctx?.model !== model) preflight = { failure: "current model changed during readiness check; run /blackmagic-status again" };
    else {
      let branchEntries;
      try { branchEntries = ctx?.sessionManager?.getBranch?.() ?? []; } catch { branchEntries = undefined; }
      preflight = branchEntries ? await preflightCompaction(pi, { branchEntries }, ctx, auth, { model }) : { failure: "current branch unavailable" };
    }
    const text = preflight.failure ? `Blackmagic remote compaction: not ready — ${preflight.failure}.` : "Blackmagic remote compaction: ready to attempt with /compact.";
    if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, preflight.failure ? "warning" : "info");
  } });
}
