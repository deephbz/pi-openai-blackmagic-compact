import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { azureOpenAIResponsesApi, openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { compactProvider } from "./adapters.mjs";
import { BLACKMAGIC_DETAILS_TYPE, createCheckpoint, identifySurface, latestActiveCompaction, readCheckpoint, replaceOneHashSegment, sameProvider, sha256 } from "./contract.mjs";
import { BLACKMAGIC_APPLIED_NOTICE, BLACKMAGIC_MODEL_SUMMARY, SUMMARY_STAYS_READABLE, classifyContinuation, continuationFooter, projectBlackmagicStatus } from "./state-machine.mjs";

const DELEGATES = Object.freeze({
  "openai-responses": openAIResponsesApi().streamSimple,
  "openai-codex-responses": openAICodexResponsesApi().streamSimple,
  "azure-openai-responses": azureOpenAIResponsesApi().streamSimple,
});
const FOOTER_STATUS_KEY = "pi-openai-blackmagic-compact/provider";
class SerializationProbeComplete extends Error {}

function extractPrepared(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.input)) return undefined;
  return { payload, input: payload.input };
}

function azureDeployment(model, auth) {
  const mapping = auth?.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  for (const entry of String(mapping ?? "").split(",")) {
    const [id, deployment] = entry.split("=", 2).map((value) => value?.trim());
    if (id === model?.id && deployment) return deployment;
  }
  return model?.id;
}

function selectedProvider(ctx, auth) {
  const model = ctx?.model;
  const env = auth?.env ?? {};
  const baseUrl = model?.api === "azure-openai-responses"
    ? (env.AZURE_OPENAI_BASE_URL ?? (env.AZURE_OPENAI_RESOURCE_NAME ? `https://${env.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1` : model?.baseUrl))
    : (env.OPENAI_BASE_URL ?? model?.baseUrl);
  return identifySurface({
    provider: model?.provider,
    baseUrl,
    api: model?.api,
    model: model?.id,
    deployment: model?.api === "azure-openai-responses" ? azureDeployment(model, auth) : undefined,
  });
}

function activeCheckpointStatus(branch) {
  const entry = latestActiveCompaction(branch);
  if (!entry) return { kind: "readable" };
  const checkpoint = readCheckpoint(entry);
  if (checkpoint) return { kind: "blackmagic", checkpoint };
  return entry.details?.type === BLACKMAGIC_DETAILS_TYPE ? { kind: "invalid", entry } : { kind: "readable" };
}

function rewriteReplay(payload, checkpoint, provider) {
  if (!payload || !sameProvider(checkpoint?.details?.provider, provider)) return undefined;
  const input = replaceOneHashSegment(payload.input, checkpoint.details.replacedItemHashes, checkpoint.details.input);
  return input ? { ...payload, input } : undefined;
}

function compactionSummaryText() {
  const [message] = convertToLlm([{ role: "compactionSummary", summary: BLACKMAGIC_MODEL_SUMMARY, tokensBefore: 0, timestamp: 0 }]);
  const [content] = Array.isArray(message?.content) ? message.content : [];
  return content?.type === "text" ? content.text : undefined;
}

function exactText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content) || item.content.length !== 1) return undefined;
  const [content] = item.content;
  return (content?.type === "text" || content?.type === "input_text") && typeof content.text === "string" ? content.text : undefined;
}

function removeModelPlaceholder(payload) {
  if (!payload) return payload;
  const expected = compactionSummaryText();
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
    return ctx?.model && typeof ctx?.modelRegistry?.getApiKeyAndHeaders === "function"
      ? await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
      : undefined;
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
    stream = delegate(model, context, {
      ...options,
      onPayload(payload) {
        if (!Array.isArray(payload?.input)) throw new Error("native Responses serializer produced no input array");
        settled = true;
        resolveCapture(structuredClone(payload));
        throw new SerializationProbeComplete("serialization probe complete");
      },
    });
  } catch (error) {
    rejectCapture(error);
    return capture;
  }
  void stream.result().then((message) => {
    if (!settled) rejectCapture(new Error(message?.errorMessage ?? "native Responses serializer failed"));
  }, rejectCapture);
  return capture;
}

export function serializationOptions(ctx, auth, signal) {
  return {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    cacheRetention: "none",
    transport: "sse",
    reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    signal,
  };
}

async function serializeBranch(pi, event, ctx, auth) {
  if (typeof ctx?.getSystemPrompt !== "function") throw new Error("Pi system prompt access is unavailable");
  const messages = convertToLlm(buildSessionContext(event.branchEntries ?? ctx.sessionManager?.getBranch?.() ?? []).messages);
  return captureNativeBody(
    ctx.model,
    { systemPrompt: ctx.getSystemPrompt(), messages, tools: activeTools(pi) },
    serializationOptions(ctx, auth, event.signal),
  );
}

async function serializePostCompaction(pi, event, ctx, auth, syntheticCompaction) {
  if (typeof ctx?.getSystemPrompt !== "function") throw new Error("Pi system prompt access is unavailable");
  const branch = event.branchEntries ?? ctx.sessionManager?.getBranch?.() ?? [];
  const messages = convertToLlm(buildSessionContext([...branch, syntheticCompaction]).messages);
  return (await captureNativeBody(
    ctx.model,
    { systemPrompt: ctx.getSystemPrompt(), messages, tools: activeTools(pi) },
    serializationOptions(ctx, auth, event.signal),
  )).input;
}

export function createServerCompactionController(pi, options = {}) {
  if (!pi?.on || !pi?.registerCommand) throw new TypeError("A complete Pi ExtensionAPI is required");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const scheduledNotices = new Set();

  const scheduleAppliedNotice = (ctx) => {
    if (ctx?.mode !== "tui" || typeof ctx?.ui?.notify !== "function") return;
    const timer = setTimeout(() => {
      scheduledNotices.delete(timer);
      ctx.ui.notify(BLACKMAGIC_APPLIED_NOTICE, "info");
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
  const coarseState = async (ctx, providerOverride) => {
    const status = activeCheckpointStatus(ctx?.sessionManager?.getBranch?.());
    if (status.kind === "readable") return setState(ctx, classifyContinuation());
    if (status.kind === "invalid") return setState(ctx, classifyContinuation({ blackmagicHistory: true }));
    const provider = providerOverride ?? selectedProvider(ctx, await resolveAuth(ctx));
    return setState(ctx, classifyContinuation({ blackmagicHistory: true, providerMatches: sameProvider(status.checkpoint.details.provider, provider) }));
  };

  pi.on("session_start", (_event, ctx) => {
    clearScheduledNotices();
    return coarseState(ctx);
  });
  pi.on("model_select", (_event, ctx) => coarseState(ctx));
  pi.on("session_tree", (_event, ctx) => {
    clearScheduledNotices();
    return coarseState(ctx);
  });
  pi.on("session_compact", async (event, ctx) => {
    const state = await coarseState(ctx);
    const activeEntry = latestActiveCompaction(ctx?.sessionManager?.getBranch?.());
    if (event.fromExtension && readCheckpoint(activeEntry)) scheduleAppliedNotice(ctx);
    return state;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearScheduledNotices();
    return setState(ctx, SUMMARY_STAYS_READABLE);
  });
  pi.on("context", async (event, ctx) => {
    const status = activeCheckpointStatus(ctx?.sessionManager?.getBranch?.());
    if (status.kind === "readable") return;
    if (status.kind === "blackmagic") {
      const provider = selectedProvider(ctx, await resolveAuth(ctx));
      if (sameProvider(status.checkpoint.details.provider, provider)) return;
    }
    return { messages: event.messages.filter((message) => !(message?.role === "compactionSummary" && message.summary === BLACKMAGIC_MODEL_SUMMARY)) };
  });
  pi.on("before_provider_request", async (event, ctx) => {
    const provider = selectedProvider(ctx, await resolveAuth(ctx));
    const status = activeCheckpointStatus(ctx?.sessionManager?.getBranch?.());
    if (status.kind === "readable") {
      setState(ctx, classifyContinuation());
      return event.payload;
    }
    if (status.kind === "blackmagic") {
      const replayed = rewriteReplay(event.payload, status.checkpoint, provider);
      if (replayed) {
        setState(ctx, classifyContinuation({ blackmagicHistory: true, providerMatches: true }));
        return replayed;
      }
    }
    setState(ctx, classifyContinuation({ blackmagicHistory: true, replayFailed: true }));
    return removeModelPlaceholder(event.payload);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    const auth = await resolveAuth(ctx);
    const provider = selectedProvider(ctx, auth);
    if (provider.kind !== "supported" || auth?.ok !== true || !auth.apiKey) return undefined;

    let compactBody;
    try { compactBody = extractPrepared(await serializeBranch(pi, event, ctx, auth)); } catch {}
    if (!compactBody) return { cancel: true };

    const status = activeCheckpointStatus(event.branchEntries ?? ctx.sessionManager?.getBranch?.());
    if (status.kind === "blackmagic") {
      compactBody = extractPrepared(rewriteReplay(compactBody.payload, status.checkpoint, provider) ?? removeModelPlaceholder(compactBody.payload));
    } else if (status.kind === "invalid") {
      compactBody = extractPrepared(removeModelPlaceholder(compactBody.payload));
    }
    if (!compactBody) return { cancel: true };

    const remote = await compactProvider({ provider, prepared: compactBody, auth, fetchImpl, signal: event.signal });
    if (!remote.input) return { cancel: true };

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
    if (!Array.isArray(postSegment) || !postSegment.length) return { cancel: true };

    const details = createCheckpoint({
      provider,
      input: remote.input,
      replacedItemHashes: postSegment.map((item) => sha256(item)),
    });
    return {
      compaction: {
        summary: BLACKMAGIC_MODEL_SUMMARY,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details,
      },
    };
  });
  pi.registerCommand("blackmagic", {
    description: "Show Blackmagic compaction status or help.",
    getArgumentCompletions(prefix) {
      const items = ["status", "help"]
        .filter((value) => value.startsWith(prefix.trim()))
        .map((value) => ({ value, label: value, description: value === "status" ? "Show current compaction status" : "Show command usage" }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      let text;
      if (action === "help") {
        text = "Usage: /blackmagic [status|help]\nUse /compact to compact History. /blackmagic only reports current state.";
      } else if (action === "status") {
        const auth = await resolveAuth(ctx);
        const provider = selectedProvider(ctx, auth);
        const state = await coarseState(ctx, provider);
        text = projectBlackmagicStatus({ state, serverCompactionAvailable: provider.kind === "supported" && auth?.ok === true && Boolean(auth.apiKey) });
      } else {
        text = "Usage: /blackmagic [status|help]";
      }
      if (ctx?.hasUI && typeof ctx.ui?.notify === "function") ctx.ui.notify(text, action === "status" || action === "help" ? "info" : "warning");
    },
  });
}
