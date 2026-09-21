#!/usr/bin/env node

/**
 * Purpose: Empirical audit of Blackmagic readiness against Pi's native
 * compaction preparation, SessionManager persistence, and native provider
 * serialization.
 * Scope: Owns disposable synthetic local coverage and an opt-in live canary.
 * It does not read credential files, print credentials, or persist provider
 * payloads. It does not claim exhaustive compatibility.
 */

import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { zstdDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import {
  buildSessionContext,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import registerBlackmagic from "../src/extension.mjs";
import { captureNativeBody } from "../src/controller.mjs";

const PACKAGE_ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))), "node_modules");
const nativeCompactionModule = pathToFileURL(join(
  PACKAGE_ROOT,
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "core",
  "compaction",
  "compaction.js",
)).href;
const { prepareCompaction } = await import(nativeCompactionModule);
const SYSTEM_PROMPT = "audit-system-v1";
const CHANGED_SYSTEM_PROMPT = "audit-system-v2";
const CUSTOM_VISIBLE_TEXT = "synthetic context-visible custom message";
const UI_ONLY_MARKER = "synthetic-ui-only";
const NONCE = "BLACKMAGIC_SYNTHETIC_NONCE_9f4e";
const MAX_REMOTE_CALLS = 12;
function remainingRemoteCalls(priorRemoteCalls) {
  return Number.isInteger(priorRemoteCalls) && priorRemoteCalls >= 0 && priorRemoteCalls <= MAX_REMOTE_CALLS
    ? MAX_REMOTE_CALLS - priorRemoteCalls
    : 0;
}

function liveLimits(priorRemoteCalls, remoteCalls, websocketBlocked = true) {
  const priorCountKnown = Number.isInteger(priorRemoteCalls);
  const transportGuarded = websocketBlocked;
  return {
    maxRemoteCalls: remainingRemoteCalls(priorRemoteCalls),
    priorRemoteCalls: priorCountKnown ? priorRemoteCalls : undefined,
    remoteCalls,
    cumulativeRemoteCalls: priorCountKnown ? priorRemoteCalls + remoteCalls : undefined,
    priorEgressVerified: priorCountKnown,
    totalEgressVerified: priorCountKnown && transportGuarded,
    egressVerification: priorCountKnown && transportGuarded
      ? "explicit_prior_plus_observed_fetches"
      : "prior_count_required",
    transport: "sse",
    websocketBlocked,
  };
}
const APPROVED = Object.freeze({
  openai: "openai_responses",
  "azure-openai-responses": "azure_openai_responses",
  "openai-codex": "chatgpt_codex_responses",
});

async function localPackageVersion(packageName) {
  try {
    const packagePath = join(PACKAGE_ROOT, ...packageName.split("/"), "package.json");
    const metadata = JSON.parse(await readFile(packagePath, "utf8"));
    return typeof metadata.version === "string" ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

function installedPiCliVersion() {
  try {
    const result = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] });
    const output = `${result.stdout ?? ""}`;
    return output.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0];
  } catch {
    return undefined;
  }
}

async function versionReport() {
  return {
    installedPiCli: { version: installedPiCliVersion(), source: "pi --version" },
    installedHostIntegration: { tested: false, reason: "the harness imports the local peer SDK; pi --version is version evidence only" },
    localPeerSdk: {
      codingAgent: { version: await localPackageVersion("@earendil-works/pi-coding-agent"), source: "installed package metadata" },
      piAi: { version: await localPackageVersion("@earendil-works/pi-ai"), source: "installed package metadata" },
    },
  };
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function modelIsApproved(model) {
  return typeof model?.provider === "string" && APPROVED[model.provider] && [
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
  ].includes(model.api);
}

function routeName(model) {
  if (model?.provider === "openai" && model.api === "openai-responses") return APPROVED.openai;
  if (model?.provider === "azure-openai-responses" && model.api === "azure-openai-responses") return APPROVED["azure-openai-responses"];
  if (model?.provider === "openai-codex" && model.api === "openai-codex-responses") return APPROVED["openai-codex"];
  return undefined;
}

function safeModelPair(a, b) {
  return { route: routeName(a), producer: a?.id, consumer: b?.id };
}

function settings() {
  return SettingsManager.inMemory({
    transport: "sse",
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
    retry: { enabled: false, maxRetries: 0, provider: { timeoutMs: 10_000, maxRetries: 0 } },
  });
}

async function makeLoader(cwd, manager, prompt = SYSTEM_PROMPT) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent-config"),
    settingsManager: manager,
    extensionFactories: [registerBlackmagic],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => prompt,
  });
  await loader.reload();
  return loader;
}

async function makeSession({ cwd, sessionManager, modelRuntime, model, prompt = SYSTEM_PROMPT, tools = ["read"] }) {
  const manager = settings();
  const loader = await makeLoader(cwd, manager, prompt);
  const result = await createAgentSession({
    cwd,
    modelRuntime,
    model,
    thinkingLevel: "off",
    tools,
    sessionManager,
    settingsManager: manager,
    resourceLoader: loader,
  });
  const notices = [];
  await result.session.bindExtensions({
    mode: "print",
    uiContext: { notify: (...message) => notices.push(message) },
  });
  result.session.__readinessNotices = notices;
  return { ...result, notices, settingsManager: manager, sessionManager };
}

function assistantMessage(model, text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: 2,
  };
}

function appendSyntheticUser(session, text) {
  const id = session.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  return id;
}

function assistantNoncePresent(session) {
  return session.sessionManager.getBranch().some((entry) =>
    entry?.type === "message" && entry.message?.role === "assistant" && JSON.stringify(entry.message).includes(NONCE),
  );
}

function preparationValue(result) {
  // Pi 0.83 returns Result<CompactionPreparation | undefined>. Keep a
  // compatibility fallback for hosts that return the preparation directly.
  return result && typeof result === "object" && "ok" in result
    ? (result.ok === true ? result.value : undefined)
    : result;
}

function nativeEligibility(session) {
  try {
    const preparation = preparationValue(prepareCompaction(session.sessionManager.getBranch(), session.settingsManager.getCompactionSettings()));
    return { eligible: Boolean(preparation), sdkFailure: false };
  } catch {
    return { eligible: false, sdkFailure: true };
  }
}

async function readiness(session) {
  const before = session.sessionManager.getBranch().length;
  const notices = session.__readinessNotices ?? [];
  const start = notices.length;
  await session.prompt("/blackmagic status");
  const notice = notices.slice(start).at(-1);
  return {
    ready: typeof notice?.[0] === "string" && /ready to attempt/i.test(notice[0]),
    noticeType: notice?.[1],
    mutated: session.sessionManager.getBranch().length !== before,
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function textResponse(text) {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function normalSse(text, sequence) {
  const id = `synthetic-response-${sequence}`;
  const item = { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  return [
    `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id, role: "assistant", status: "in_progress", content: [] } })}`,
    `data: ${JSON.stringify({ type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })}`,
    `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text })}`,
    `data: ${JSON.stringify({ type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text })}`,
    `data: ${JSON.stringify({ type: "response.content_part.done", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } })}`,
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: `synthetic-${sequence}`, status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } })}`,
    "data: [DONE]",
    "",
  ].join("\n");
}

function requestFacts(body, checkpoint, currentPrompt, postMarker) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const serialized = JSON.stringify(input);
  const userText = JSON.stringify(input.filter((item) => item?.role === "user"));
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return {
    // The nonce exists only in a pre-compaction assistant message. A retained
    // user item or follow-up must never make the recall check pass by itself.
    sourceAssistantNonce: input.some((item) => item?.role === "assistant" && JSON.stringify(item).includes(NONCE)),
    userNonceAbsent: !userText.includes(NONCE),
    currentInstruction: input.some((item) => item?.role === "developer" && JSON.stringify(item).includes(currentPrompt)),
    changedInstruction: input.some((item) => item?.role === "developer" && JSON.stringify(item).includes(CHANGED_SYSTEM_PROMPT)),
    activeReadTool: tools.some((tool) => tool?.name === "read" || tool?.function?.name === "read"),
    checkpointConsumed: Boolean(checkpoint) && input.some((item) => item?.type === "compaction" && item?.encrypted_content === checkpoint),
    postCheckpointUser: serialized.includes(postMarker) && userText.includes(postMarker),
    contextVisibleCustom: serialized.includes(CUSTOM_VISIBLE_TEXT),
    uiOnlyMarkerAbsent: !serialized.includes(UI_ONLY_MARKER),
  };
}

function syntheticFetchObserver() {
  let checkpoint;
  let sequence = 0;
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    sequence += 1;
    const url = String(input);
    const body = JSON.parse(init.body ?? "{}");
    const isCompact = url.endsWith("/responses/compact") || url.endsWith("/codex/responses");
    const facts = requestFacts(body, checkpoint, SYSTEM_PROMPT, "audit-post-checkpoint");
    if (isCompact) {
      checkpoint = `synthetic-provider-window-${sequence}`;
      requests.push({ kind: "compact", facts });
      return jsonResponse({ output: [{ type: "compaction", encrypted_content: checkpoint }] });
    }
    const consumed = facts.checkpointConsumed;
    requests.push({ kind: "normal", facts: { ...facts, checkpointConsumed: consumed } });
    return textResponse(normalSse(consumed ? NONCE : "BLACKMAGIC_REPLAY_MISSING", sequence));
  };
  return { fetchImpl, requests };
}

function requestSummary(requests) {
  return {
    compactCount: requests.filter((request) => request.kind === "compact").length,
    normalCount: requests.filter((request) => request.kind === "normal").length,
    normalReplay: requests.filter((request) => request.kind === "normal").map((request) => request.facts),
    compactSourcePreserved: requests.filter((request) => request.kind === "compact").every((request, index) => request.facts.userNonceAbsent && (index === 0 ? request.facts.sourceAssistantNonce : request.facts.checkpointConsumed)),
  };
}

async function waitForPersistence() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function generatedHistoryMarkers() {
  return fc.sample(
    fc.record({ suffix: fc.integer({ min: 100, max: 9999 }), custom: fc.boolean() }),
    { seed: 20260915, numRuns: 3 },
  ).map(({ suffix, custom }, index) => ({ suffix, custom: custom || index === 2 }));
}

function seedHistory(session, model, marker, custom) {
  session.appendMessage({ role: "user", content: [{ type: "text", text: `synthetic question history-${marker}` }], timestamp: 1 });
  session.appendMessage(assistantMessage(model, `synthetic answer history-${marker}; remembered ${NONCE}`));
  session.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: `synthetic-call-${marker}`, name: "read", arguments: { path: "synthetic.txt" } }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "toolUse",
    timestamp: 3,
  });
  session.appendMessage({ role: "toolResult", toolCallId: `synthetic-call-${marker}`, toolName: "read", content: [{ type: "text", text: "synthetic tool result" }], isError: false, timestamp: 4 });
  for (let index = 0; index < 8; index += 1) {
    session.appendMessage({ role: "user", content: [{ type: "text", text: `synthetic history continuation ${marker}-${index}` }], timestamp: 10 + index * 2 });
    session.appendMessage(assistantMessage(model, `synthetic continuation answer ${marker}-${index}`));
  }
  if (custom) session.appendMessage({ role: "custom", customType: "synthetic-audit", content: "synthetic custom context", display: false, timestamp: 5 });
}

async function runCustomContextCase({ modelRuntime, producer, root }) {
  const manager = SessionManager.inMemory(root);
  seedHistory(manager, producer, 8801, false);
  manager.appendCustomMessageEntry("synthetic-visible", CUSTOM_VISIBLE_TEXT, true, { source: "synthetic" });
  const before = manager.getBranch().length;
  const context = manager.buildSessionContext();
  const contextVisible = context.messages.some((message) => JSON.stringify(message).includes(CUSTOM_VISIBLE_TEXT));
  const observer = syntheticFetchObserver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = observer.fetchImpl;
  let current;
  try {
    current = await makeSession({ cwd: root, sessionManager: manager, modelRuntime, model: producer });
    const native = nativeEligibility(current.session);
    const ready = await readiness(current.session);
    const compact = await current.session.compact();
    const compactFacts = observer.requests.find((request) => request.kind === "compact")?.facts;
    return {
      native,
      readiness: ready,
      contextVisible,
      outgoingContextVisible: compactFacts?.contextVisibleCustom === true && compactFacts?.userNonceAbsent === true,
      remoteApplied: compact?.details?.state === "remote_applied",
      branchPreserved: current.sessionManager.getBranch().length > before,
      mockCalls: observer.requests.length,
    };
  } finally {
    current?.session.dispose();
    globalThis.fetch = originalFetch;
  }
}

async function runUiOnlyTailCase({ modelRuntime, producer, root }) {
  const manager = SessionManager.inMemory(root);
  seedHistory(manager, producer, 8802, false);
  const observer = syntheticFetchObserver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = observer.fetchImpl;
  let current;
  try {
    current = await makeSession({ cwd: root, sessionManager: manager, modelRuntime, model: producer });
    const first = await current.session.compact();
    if (first?.details?.state !== "remote_applied") throw new Error("UI-tail setup compaction did not apply");
    manager.appendCustomEntry(UI_ONLY_MARKER, { label: "synthetic UI-only tail" });
    current.session.agent.state.messages = manager.buildSessionContext().messages;
    const contextOnlyUiTail = manager.buildSessionContext();
    const nativeOnlyUiTail = nativeEligibility(current.session);
    const readinessOnlyUiTail = await readiness(current.session);
    let uiTailCompactFacts;
    if (nativeOnlyUiTail.eligible) {
      const uiTailCompact = await current.session.compact();
      if (uiTailCompact?.details?.state !== "remote_applied") throw new Error("UI-tail eligible compaction did not apply");
      uiTailCompactFacts = observer.requests.filter((request) => request.kind === "compact").at(-1)?.facts;
    }

    appendSyntheticUser(current.session, "audit descendant after a UI-only tail");
    const contextWithDescendant = manager.buildSessionContext();
    const nativeWithDescendant = nativeEligibility(current.session);
    const readinessWithDescendant = await readiness(current.session);
    await current.session.prompt("Synthetic descendant source-preservation check.");
    const normalFacts = observer.requests.find((request) => request.kind === "normal")?.facts;
    const body = await captureNativeBody(
      producer,
      { systemPrompt: current.session.systemPrompt, messages: convertToLlm(contextWithDescendant.messages), tools: [] },
      { apiKey: "synthetic-local-key", transport: "sse", reasoning: undefined, sessionId: manager.getSessionId() },
    );
    const input = Array.isArray(body.input) ? body.input : [];
    const serialized = JSON.stringify(input);
    return {
      uiTailOnly: {
        native: nativeOnlyUiTail,
        readiness: readinessOnlyUiTail,
        contextExcludesTail: !contextOnlyUiTail.messages.some((message) => JSON.stringify(message).includes(UI_ONLY_MARKER)),
        hostIneligibleNoOp: !nativeOnlyUiTail.eligible,
        noAttemptWhenIneligible: nativeOnlyUiTail.eligible || !uiTailCompactFacts,
        readinessMatchesNative: readinessOnlyUiTail.ready === nativeOnlyUiTail.eligible,
      },
      descendant: {
        native: nativeWithDescendant,
        readiness: readinessWithDescendant,
        uiTailExcludedFromContext: !contextWithDescendant.messages.some((message) => JSON.stringify(message).includes(UI_ONLY_MARKER)),
        uiTailExcludedFromNativeSource: !serialized.includes(UI_ONLY_MARKER),
        checkpointConsumedOnNormalReplay: normalFacts?.checkpointConsumed === true,
        currentInstructionPreserved: normalFacts?.currentInstruction === true,
        systemPromptPreservedInNativeSource: serialized.includes(SYSTEM_PROMPT),
        compactCheckpointPreserved: nativeOnlyUiTail.eligible ? uiTailCompactFacts?.checkpointConsumed === true : undefined,
      },
      mockCalls: observer.requests.length,
    };
  } finally {
    current?.session.dispose();
    globalThis.fetch = originalFetch;
  }
}

async function runLocalSequence({ modelRuntime, producer, consumer, root, marker, custom }) {
  const sessions = join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const manager = SessionManager.create(root, sessions);
  seedHistory(manager, producer, marker, custom);
  const observer = syntheticFetchObserver();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = observer.fetchImpl;
  let current;
  const result = { route: routeName(producer), pair: safeModelPair(producer, consumer), redRepros: [], requestChecks: {} };
  try {
    current = await makeSession({ cwd: root, sessionManager: manager, modelRuntime, model: producer });
    const initialReadiness = await readiness(current.session);
    const initialEligibility = nativeEligibility(current.session);
    const first = await current.session.compact();
    if (first?.details?.state !== "remote_applied") throw new Error("remote compaction did not apply");

    appendSyntheticUser(current.session, "audit-post-checkpoint query for the retained synthetic fact");
    const sameReadiness = await readiness(current.session);
    if (!sameReadiness.ready) result.redRepros.push({ dimension: "post_checkpoint", classification: "local_false_negative", nativeEligible: nativeEligibility(current.session).eligible });
    await current.session.prompt("Repeat the synthetic nonce exactly.");
    const samePrompt = current.session.getLastAssistantText() ?? "";
    const sameKnowledge = samePrompt.includes(NONCE) || assistantNoncePresent(current.session);
    const second = await current.session.compact();
    if (second?.details?.state !== "remote_applied") throw new Error("same-model recompact did not apply");

    await waitForPersistence();
    current.session.dispose();
    const reopenedManager = SessionManager.open(manager.getSessionFile(), sessions, root);
    current = await makeSession({ cwd: root, sessionManager: reopenedManager, modelRuntime, model: producer });
    appendSyntheticUser(current.session, "audit-post-checkpoint query after reopen for the retained synthetic fact");
    const reopenReadiness = await readiness(current.session);
    await current.session.prompt("Repeat the synthetic nonce exactly after reopen.");
    const reopenPrompt = current.session.getLastAssistantText() ?? "";
    const reopenKnowledge = reopenPrompt.includes(NONCE) || assistantNoncePresent(current.session);

    await current.session.setModel(consumer);
    appendSyntheticUser(current.session, "audit-post-checkpoint query after model switch for the retained synthetic fact");
    const crossReadiness = await readiness(current.session);
    await current.session.prompt("Repeat the synthetic nonce exactly after the model switch.");
    const crossPrompt = current.session.getLastAssistantText() ?? "";
    const crossKnowledge = crossPrompt.includes(NONCE) || assistantNoncePresent(current.session);
    const third = await current.session.compact();
    if (third?.details?.state !== "remote_applied") throw new Error("cross-model recompact did not apply");

    current.session.dispose();
    const changedSession = await makeSession({
      cwd: root,
      sessionManager: reopenedManager,
      modelRuntime,
      model: consumer,
      prompt: CHANGED_SYSTEM_PROMPT,
    });
    current = changedSession;
    const systemChanged = current.session;
    appendSyntheticUser(systemChanged, "audit-post-checkpoint query after system prompt change");
    const changedSystemNative = nativeEligibility(systemChanged);
    const changedSystemReadiness = await readiness(systemChanged);
    if (changedSystemNative.eligible && !changedSystemReadiness.ready) result.redRepros.push({ dimension: "system_prompt", classification: "local_false_negative", nativeEligible: true });
    await systemChanged.prompt("Synthetic prompt-change preservation check.");

    systemChanged.setActiveToolsByName([]);
    appendSyntheticUser(systemChanged, "audit-post-checkpoint query after active tool change");
    const changedToolsNative = nativeEligibility(systemChanged);
    const changedToolsReadiness = await readiness(systemChanged);
    if (changedToolsNative.eligible && !changedToolsReadiness.ready) result.redRepros.push({ dimension: "active_tools", classification: "local_false_negative", nativeEligible: true });
    await systemChanged.prompt("Synthetic active-tool preservation check.");

    const summary = requestSummary(observer.requests);
    const normal = summary.normalReplay;
    result.requestChecks = {
      sourceContextPreserved: summary.compactSourcePreserved,
      currentInstructionPreserved: normal.slice(0, 3).every((facts) => facts.currentInstruction),
      activeToolsPreserved: normal.slice(0, 3).every((facts) => facts.activeReadTool),
      checkpointConsumedAfterCompaction: normal[0]?.checkpointConsumed === true,
      checkpointConsumedAfterReopen: normal[1]?.checkpointConsumed === true,
      checkpointConsumedAfterModelSwitch: normal[2]?.checkpointConsumed === true,
      postCheckpointUserPreserved: normal.slice(0, 3).every((facts) => facts.postCheckpointUser),
      changedInstructionPreserved: normal[3]?.changedInstruction === true,
      activeToolsChangedPreserved: normal.at(-1)?.activeReadTool === false,
      knowledgeSurvivedSameModel: sameKnowledge,
      knowledgeSurvivedAfterReopen: reopenKnowledge,
      knowledgeSurvivedCrossModel: crossKnowledge,
    };
    result.coverage = {
      initialReadiness,
      initialEligibility,
      sameReadiness,
      reopenReadiness,
      crossReadiness,
      changedSystem: { native: changedSystemNative, readiness: changedSystemReadiness },
      changedTools: { native: changedToolsNative, readiness: changedToolsReadiness },
      remoteCalls: observer.requests.length,
      outgoing: { compact: observer.requests.filter((request) => request.kind === "compact").map((request) => request.facts), normal },
    };
    return result;
  } finally {
    current?.session.dispose();
    globalThis.fetch = originalFetch;
  }
}

function approvedModels(runtime) {
  const grouped = new Map();
  for (const model of runtime.getModels()) {
    const route = routeName(model);
    if (!route) continue;
    const list = grouped.get(route) ?? [];
    list.push(model);
    grouped.set(route, list);
  }
  return grouped;
}

export async function enumerateApprovedRoutes(runtime) {
  const grouped = approvedModels(runtime);
  return [...grouped.entries()].map(([route, models]) => ({
    route,
    modelCount: models.length,
    representativeModels: models.slice(0, 2).map((model) => model.id),
    configuredAuth: models.some((model) => runtime.hasConfiguredAuth(model.provider)),
  }));
}

function classifyLiveFailure(error, phase) {
  if (error?.code === "AUTH_UNAVAILABLE") return "auth_unavailable";
  if (error?.code === "PROVIDER_REJECTION") return "provider_rejection";
  if (error?.code === "LOCAL_FALSE_NEGATIVE") return "local_false_negative";
  if (error?.code === "SDK_FAILURE") return "sdk_failure";
  return phase === "auth" ? "auth_unavailable" : "sdk_failure";
}

function liveRequestFacts(body, kind) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const serialized = JSON.stringify(input);
  const userText = JSON.stringify(input.filter((item) => item?.role === "user"));
  return {
    kind,
    sourceAssistantNonce: input.some((item) => item?.role === "assistant" && JSON.stringify(item).includes(NONCE)),
    userNonceAbsent: !userText.includes(NONCE),
    currentInstruction: (typeof body?.instructions === "string" && body.instructions.includes(SYSTEM_PROMPT))
      || input.some((item) => (item?.role === "developer" || item?.role === "system") && JSON.stringify(item).includes(SYSTEM_PROMPT)),
    activeToolsAbsent: !Array.isArray(body?.tools) || body.tools.length === 0,
    checkpointPresent: input.some((item) => item?.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0),
    postCheckpointUser: serialized.includes("Live synthetic nonce query"),
  };
}

function messageCategory(value) {
  if (typeof value !== "string") return undefined;
  const text = value.toLowerCase();
  if (/(model|deployment).*(not found|unsupported|not supported|invalid|does not exist)/.test(text)) return "unsupported_model";
  if (/(auth|api[ _-]?key|credential|account|quota|permission|forbidden)/.test(text)) return "auth_or_account";
  if (/(invalid request|invalid parameter|malformed|schema|unsupported field|input)/.test(text)) return "wire_request";
  return undefined;
}

const SAFE_ERROR_VALUES = Object.freeze({
  code: new Set(["model_not_found", "unsupported_model", "invalid_api_key", "invalid_request", "rate_limit_exceeded", "usage_limit_reached"]),
  type: new Set(["invalid_request_error", "authentication_error", "permission_error", "rate_limit_error"]),
  param: new Set(["input", "model", "tools", "instructions", "compaction_trigger", "stream", "store"]),
});

function safeErrorField(field, value) {
  return typeof value === "string" && SAFE_ERROR_VALUES[field]?.has(value) ? value : undefined;
}

function safeErrorEvidence(value, seen = new Set(), depth = 0) {
  if (value === undefined || value === null || depth > 3) return undefined;
  if (typeof value === "string") {
    const category = messageCategory(value);
    return category ? { messageCategory: category } : undefined;
  }
  if (typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const safe = {};
  for (const field of ["code", "type", "param"]) {
    const safeValue = safeErrorField(field, value[field]);
    if (safeValue) safe[field] = safeValue;
  }
  const directCategory = messageCategory(value.message);
  if (directCategory) safe.messageCategory = directCategory;
  for (const field of ["error", "details", "root", "rootCause", "cause", "detail"]) {
    const nested = safeErrorEvidence(value[field], seen, depth + 1);
    if (!nested) continue;
    for (const [key, nestedValue] of Object.entries(nested)) safe[key] ??= nestedValue;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

async function safeProviderError(response) {
  if (response.ok) return undefined;
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  try {
    const text = await response.clone().text();
    try {
      const evidence = safeErrorEvidence(JSON.parse(text));
      if (evidence) return evidence;
      return { responseCategory: "json_error_unclassified" };
    } catch {
      const category = messageCategory(text);
      if (text.trim().startsWith("data:")) return { responseCategory: "non_json_sse", messageCategory: category };
      if (contentType.startsWith("text/")) return { responseCategory: "text_error", messageCategory: category };
      if (text.trim().length === 0) return { responseCategory: "empty_error_body" };
      return { responseCategory: "non_json_error", messageCategory: category };
    }
  } catch {
    return { responseCategory: "unreadable_error_body" };
  }
}

export async function decodeLiveRequestBody(input, init = {}) {
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const bodyValue = init.body ?? (input instanceof Request ? await input.clone().arrayBuffer() : "{}");
  if (headers.get("content-encoding")?.toLowerCase() === "zstd") {
    const bytes = bodyValue instanceof Uint8Array
      ? new Uint8Array(bodyValue)
      : bodyValue instanceof ArrayBuffer
        ? new Uint8Array(bodyValue.slice(0))
        : ArrayBuffer.isView(bodyValue)
          ? new Uint8Array(bodyValue.buffer.slice(bodyValue.byteOffset, bodyValue.byteOffset + bodyValue.byteLength))
          : undefined;
    if (!bytes) throw new TypeError("zstd request body is not byte data");
    return zstdDecompressSync(bytes).toString("utf8");
  }
  if (typeof bodyValue === "string") return bodyValue;
  if (bodyValue instanceof Uint8Array) return new TextDecoder().decode(new Uint8Array(bodyValue));
  if (bodyValue instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(bodyValue.slice(0)));
  if (ArrayBuffer.isView(bodyValue)) return new TextDecoder().decode(new Uint8Array(bodyValue.buffer.slice(bodyValue.byteOffset, bodyValue.byteOffset + bodyValue.byteLength)));
  return bodyValue ?? "{}";
}

export function withLiveBudget(originalFetch, requests, timeoutMs, callBudget) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const isProviderCall = url.includes("/responses");
    if (isProviderCall) {
      if (requests.length >= callBudget) {
        const error = new Error("remote call budget exceeded");
        error.code = "SDK_FAILURE";
        throw error;
      }
      let body = {};
      try {
        body = JSON.parse(await decodeLiveRequestBody(input, init) || "{}");
      } catch {
        const error = new Error("provider payload was not JSON");
        error.code = "SDK_FAILURE";
        throw error;
      }
      const kind = url.endsWith("/responses/compact") || body?.compaction_trigger === true
        || (Array.isArray(body?.input) && body.input.some((item) => item?.type === "compaction_trigger"))
        ? "compact"
        : "normal";
      const accept = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).get("accept") ?? "";
      if (kind === "normal" && !accept.includes("text/event-stream")) {
        const error = new Error("normal provider call was not SSE");
        error.code = "SDK_FAILURE";
        throw error;
      }
      requests.push({ kind, facts: liveRequestFacts(body, kind) });
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await originalFetch(input, { ...init, signal });
      if (isProviderCall) {
        requests.at(-1).response = { ok: response.ok, status: response.status };
        requests.at(-1).providerError = await safeProviderError(response);
      }
      return response;
    } catch (error) {
      if (isProviderCall) requests.at(-1).transportFailure = error?.constructor?.name ?? "unknown";
      throw error;
    }
  };
}

async function livePair({ runtime, producer, consumer, root, requests }) {
  const sessions = join(root, "sessions");
  await mkdir(sessions, { recursive: true });
  const manager = SessionManager.create(root, sessions);
  seedHistory(manager, producer, 777, false);
  let phase = "session_setup";
  const firstSession = await makeSession({ cwd: root, sessionManager: manager, modelRuntime: runtime, model: producer, tools: [] });
  const result = { pair: safeModelPair(producer, consumer), status: "unknown", checks: {}, redRepros: [], failureClass: undefined };
  const actualTools = typeof firstSession.session.getActiveToolNames === "function" ? firstSession.session.getActiveToolNames() : undefined;
  const actualSystemPrompt = firstSession.session.systemPrompt;
  result.preflight = {
    activeToolsEmpty: Array.isArray(actualTools) && actualTools.length === 0,
    syntheticSystemPrompt: typeof actualSystemPrompt === "string" && actualSystemPrompt.includes(SYSTEM_PROMPT)
      && !actualSystemPrompt.includes("AGENTS.md") && !actualSystemPrompt.includes(".agents"),
  };
  try {
    if (!result.preflight.activeToolsEmpty || !result.preflight.syntheticSystemPrompt) {
      const error = new Error("live synthetic resource preflight failed");
      error.code = "SDK_FAILURE";
      throw error;
    }
    phase = "initial_readiness";
    const initial = await readiness(firstSession.session);
    if (!initial.ready) {
      const error = new Error("readiness rejected a native-eligible branch");
      error.code = "LOCAL_FALSE_NEGATIVE";
      throw error;
    }
    phase = "initial_compact";
    const first = await firstSession.session.compact();
    if (first?.details?.state !== "remote_applied") {
      const error = new Error("provider rejected compaction");
      error.code = "PROVIDER_REJECTION";
      throw error;
    }
    appendSyntheticUser(firstSession.session, "Live synthetic nonce query for the retained synthetic fact");
    phase = "same_model_readiness";
    if (!(await readiness(firstSession.session)).ready) {
      const error = new Error("readiness rejected a post-checkpoint branch");
      error.code = "LOCAL_FALSE_NEGATIVE";
      throw error;
    }
    phase = "same_model_prompt";
    await firstSession.session.prompt("Return the exact retained synthetic fact from earlier context.");
    const sameKnowledge = (firstSession.session.getLastAssistantText() ?? "").includes(NONCE) || assistantNoncePresent(firstSession.session);
    phase = "same_model_recompact";
    const second = await firstSession.session.compact();
    if (second?.details?.state !== "remote_applied") {
      const error = new Error("same-model recompact rejected");
      error.code = "PROVIDER_REJECTION";
      throw error;
    }
    await waitForPersistence();
    firstSession.session.dispose();
    const reopenedManager = SessionManager.open(manager.getSessionFile(), sessions, root);
    phase = "reopen_setup";
    const resumed = await makeSession({ cwd: root, sessionManager: reopenedManager, modelRuntime: runtime, model: producer, tools: [] });
    appendSyntheticUser(resumed.session, "Live synthetic nonce query after reopen for the retained synthetic fact");
    phase = "model_switch";
    await resumed.session.setModel(consumer);
    phase = "cross_model_readiness";
    if (!(await readiness(resumed.session)).ready) {
      const error = new Error("cross-model readiness rejected a native-eligible branch");
      error.code = "LOCAL_FALSE_NEGATIVE";
      throw error;
    }
    phase = "cross_model_prompt";
    await resumed.session.prompt("Return the exact retained synthetic fact after the model switch.");
    const crossKnowledge = (resumed.session.getLastAssistantText() ?? "").includes(NONCE) || assistantNoncePresent(resumed.session);
    phase = "cross_model_recompact";
    const third = await resumed.session.compact();
    if (third?.details?.state !== "remote_applied") {
      const error = new Error("cross-model recompact rejected");
      error.code = "PROVIDER_REJECTION";
      throw error;
    }
    const compactRequests = requests.filter((request) => request.kind === "compact");
    const normalRequests = requests.filter((request) => request.kind === "normal");
    const sourceSafe = compactRequests[0]?.facts.sourceAssistantNonce === true && compactRequests.every((request) => request.facts.userNonceAbsent);
    const opaqueConsumed = normalRequests.slice(0, 3).every((request) => request.facts.checkpointPresent);
    const followupsSafe = normalRequests.slice(0, 3).every((request) => request.facts.userNonceAbsent && request.facts.postCheckpointUser);
    if (!sourceSafe || !opaqueConsumed || !followupsSafe) {
      const error = new Error("live payload safety or opaque-context consumption check failed");
      error.code = "SDK_FAILURE";
      throw error;
    }
    const currentInstructionPreserved = normalRequests.slice(0, 3).every((request) => request.facts.currentInstruction);
    if (!currentInstructionPreserved) result.redRepros.push({ dimension: "system_prompt", classification: "local_false_negative", nativeEligible: true });
    result.status = sameKnowledge && crossKnowledge
      ? (currentInstructionPreserved ? "passed" : "passed_with_red_repros")
      : "provider_accepted_knowledge_unverified";
    result.checks = {
      sameModelKnowledge: sameKnowledge,
      crossModelKnowledge: crossKnowledge,
      sourceAssistantNonceOnly: sourceSafe,
      opaqueContextConsumed: opaqueConsumed,
      followupsContainNoNonce: followupsSafe,
      currentInstructionPreserved,
      activeToolsAbsentByDesign: normalRequests.slice(0, 3).every((request) => request.facts.activeToolsAbsent),
      remoteCalls: requests.length,
    };
    resumed.session.dispose();
  } catch (error) {
    result.status = "blocked";
    const lastResponse = requests.at(-1)?.response;
    result.failureClass = lastResponse && !lastResponse.ok ? "provider_rejection" : classifyLiveFailure(error, "provider");
    const providerError = requests.at(-1)?.providerError ?? safeErrorEvidence(error);
    result.providerBlockKind = providerError?.code === "model_not_found" || providerError?.code === "unsupported_model" || providerError?.messageCategory === "unsupported_model"
      ? "unsupported_model"
      : lastResponse?.status === 401 || lastResponse?.status === 403 || providerError?.code === "invalid_api_key" || providerError?.messageCategory === "auth_or_account"
        ? "auth_or_account"
        : providerError?.type === "invalid_request_error" || providerError?.param || providerError?.messageCategory === "wire_request"
          ? "wire_request"
          : "unknown_provider_rejection";
    result.providerError = providerError;
    result.failurePhase = phase;
    result.exceptionClass = typeof error?.constructor?.name === "string" ? error.constructor.name : "unknown";
    result.failureCode = typeof error?.code === "string" && /^[A-Za-z0-9_.-]+$/.test(error.code) ? error.code : undefined;
    const message = typeof error?.message === "string" ? error.message : "";
    const propertyAccess = message.match(/^Cannot read properties of undefined \(reading '([A-Za-z0-9_$]+)'\)$/);
    result.safeFailureDetail = propertyAccess
      ? `undefined_property:${propertyAccess[1]}`
      : message === "Pi tool access is unavailable"
        ? "tool_access_unavailable"
        : error instanceof TypeError
          ? "type_error_unclassified"
          : undefined;
    result.safeFailureFrames = typeof error?.stack === "string"
      ? error.stack.split("\n").slice(1, 5).map((line) => {
        const rawName = line.match(/at (?:async )?([^ (]+)(?: \(|$)/)?.[1] ?? "anonymous";
        const functionName = rawName.startsWith("file:") ? "anonymous" : rawName;
        const location = line.match(/\/([^/\s()]+:\d+:\d+)\)?$/)?.[1] ?? "unknown";
        return { functionName, location };
      })
      : [];
  }
  result.remoteOutcomes = requests.map(({ kind, response, providerError, transportFailure }) => ({
    kind,
    response,
    providerError,
    transportFailure,
  }));
  return result;
}

export async function runLocalAudit() {
  const root = await mkdtemp(join(tmpdir(), "blackmagic-readiness-local-"));
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials });
  await runtime.setRuntimeApiKey("openai", "synthetic-local-key");
  const producer = runtime.getModel("openai", "gpt-5");
  const consumer = runtime.getModel("openai", "gpt-5-mini");
  if (!producer || !consumer) throw new Error("SDK_FAILURE: installed Pi catalog lacks local test models");
  const markers = generatedHistoryMarkers();
  const nativeMatrix = markers.map(({ suffix, custom }) => {
    const manager = SessionManager.inMemory(root);
    seedHistory(manager, producer, suffix, custom);
    manager.appendThinkingLevelChange("off");
    try {
      return { custom, nativeEligible: Boolean(preparationValue(prepareCompaction(manager.getBranch(), settings().getCompactionSettings()))) };
    } catch {
      return { custom, nativeEligible: false, sdkFailure: true };
    }
  });
  try {
    const sequence = await runLocalSequence({ modelRuntime: runtime, producer, consumer, root, marker: markers[0].suffix, custom: markers[0].custom });
    const customContext = await runCustomContextCase({ modelRuntime: runtime, producer, root });
    const uiOnlyTail = await runUiOnlyTailCase({ modelRuntime: runtime, producer, root });
    const branchCasesPassed = customContext.native.eligible
      && customContext.readiness.ready
      && customContext.contextVisible
      && customContext.outgoingContextVisible
      && customContext.remoteApplied
      && uiOnlyTail.uiTailOnly.contextExcludesTail
      && uiOnlyTail.uiTailOnly.hostIneligibleNoOp
      && uiOnlyTail.uiTailOnly.noAttemptWhenIneligible
      && uiOnlyTail.descendant.uiTailExcludedFromContext
      && uiOnlyTail.descendant.uiTailExcludedFromNativeSource
      && uiOnlyTail.descendant.checkpointConsumedOnNormalReplay
      && uiOnlyTail.descendant.systemPromptPreservedInNativeSource;
    return {
      kind: "local",
      status: !branchCasesPassed ? "blocked" : sequence.redRepros.length > 0 ? "passed_with_red_repros" : "passed",
      versions: await versionReport(),
      sdk: { nativePrepareCompaction: true, generatedHistories: nativeMatrix },
      sequence,
      branchCases: { customContext, uiOnlyTail },
      observations: uiOnlyTail.uiTailOnly.readinessMatchesNative ? [] : [{
        dimension: "ui_only_tail_readiness_relation",
        classification: "host_ineligible_readiness_mismatch",
        nativeEligible: false,
        readinessReady: uiOnlyTail.uiTailOnly.readiness.ready,
        noProviderAttempt: uiOnlyTail.uiTailOnly.noAttemptWhenIneligible,
      }],
      limits: {
        maxRemoteCalls: MAX_REMOTE_CALLS,
        remoteCalls: sequence.coverage.remoteCalls,
        mockCalls: sequence.coverage.remoteCalls + customContext.mockCalls + uiOnlyTail.mockCalls,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function runLiveCanary({ timeoutMs = 10_000, priorRemoteCalls, producerId, consumerId } = {}) {
  if (!Number.isInteger(priorRemoteCalls) || priorRemoteCalls < 0 || priorRemoteCalls > MAX_REMOTE_CALLS) {
    return { kind: "live", status: "blocked", failureClass: "budget_unknown", versions: await versionReport(), limits: liveLimits(undefined, 0) };
  }
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelRefreshTimeoutMs: timeoutMs });
  const routes = await enumerateApprovedRoutes(runtime);
  const available = [];
  for (const entry of routes) {
    if (!entry.configuredAuth) continue;
    const models = [...runtime.getModels()].filter((model) => routeName(model) === entry.route && runtime.hasConfiguredAuth(model.provider));
    const producer = producerId ? models.find((model) => model.id === producerId) : models[0];
    const consumer = consumerId ? models.find((model) => model.id === consumerId) : models[1];
    if (producer && consumer) available.push({ route: entry.route, producer, consumer });
  }
  if (available.length === 0) {
    const selectorRequested = producerId !== undefined || consumerId !== undefined;
    return {
      kind: "live",
      status: "blocked",
      failureClass: selectorRequested ? "model_selection_unavailable" : "auth_unavailable",
      versions: await versionReport(),
      routes,
      requestedPair: selectorRequested ? { producer: producerId, consumer: consumerId } : undefined,
      limits: liveLimits(priorRemoteCalls, 0),
    };
  }
  const root = await mkdtemp(join(tmpdir(), "blackmagic-readiness-live-"));
  const originalFetch = globalThis.fetch;
  const requests = [];
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  globalThis.fetch = withLiveBudget(originalFetch, requests, timeoutMs, remainingRemoteCalls(priorRemoteCalls));
  try {
    const pair = available[0];
    const result = await livePair({ runtime, ...pair, root, requests });
    return { kind: "live", status: result.status, versions: await versionReport(), routes, pair: result, limits: liveLimits(priorRemoteCalls, requests.length) };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    await rm(root, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const priorArg = argv.find((arg) => arg.startsWith("--prior-remote-calls="));
  const producerArg = argv.find((arg) => arg.startsWith("--producer-id="));
  const consumerArg = argv.find((arg) => arg.startsWith("--consumer-id="));
  return {
    live: argv.includes("--live"),
    json: argv.includes("--json"),
    priorRemoteCalls: priorArg ? Number(priorArg.slice("--prior-remote-calls=".length)) : undefined,
    producerId: producerArg?.slice("--producer-id=".length),
    consumerId: consumerArg?.slice("--consumer-id=".length),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = args.live ? await runLiveCanary({
      priorRemoteCalls: args.priorRemoteCalls,
      producerId: args.producerId,
      consumerId: args.consumerId,
    }) : await runLocalAudit();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === "blocked" ? 2 : 0;
  } catch (error) {
    const report = { kind: args.live ? "live" : "local", status: "blocked", failureClass: "sdk_failure" };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  }
}
