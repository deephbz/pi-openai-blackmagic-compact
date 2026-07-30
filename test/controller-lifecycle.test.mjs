import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { createServerCompactionController } from "../src/controller.mjs";
import { serializeTail } from "../src/wrappers.mjs";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai", id: "gpt-5", name: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses", input: ["text"], reasoning: true, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const providerContext = { systemPrompt: "system", tools: [] };
const auth = { ok: true, apiKey: "synthetic-key", headers: { "x-test": "yes" } };
const compactResponse = { output: [{ type: "compaction", encrypted_content: "opaque-lifecycle" }], usage: { input_tokens: 7 } };

function user(text, timestamp) { return { role: "user", content: [{ type: "text", text }], timestamp }; }
function assistant(text, timestamp) { return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp }; }
async function payloadFor(session) { return { model: model.id, instructions: providerContext.systemPrompt, input: await serializeTail(model, { ...providerContext, messages: [] }, convertToLlm(session.buildSessionContext().messages), []) }; }
function fakePi() {
  const handlers = new Map();
  return { on: (name, handler) => handlers.set(name, handler), registerCommand() {}, handlers };
}
function contextFor(session) { return { model, modelRegistry: { getApiKeyAndHeaders: async () => auth }, sessionManager: session }; }
function makeController(options = {}) {
  const pi = fakePi(); let observeFinal; let observeNativeMessage; let requestCorrelation; const telemetry = [];
  const controller = createServerCompactionController(pi, {
    lastRewriterAsserted: true,
    summaryFactory: () => "local lifecycle summary",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => compactResponse }),
    telemetry: (event) => telemetry.push(event),
    installWrappers: (_pi, final, native, correlation) => { observeFinal = final; observeNativeMessage = native; requestCorrelation = correlation; return ["synthetic-test-wrapper"]; },
    ...options,
  });
  return { pi, controller, telemetry, requestCorrelation, observeFinal: (...args) => observeFinal(...args), observeNativeMessage: (...args) => observeNativeMessage(...args) };
}
async function sendRequest(harness, session, payload) {
  const ctx = contextFor(session);
  const requestContext = { ...providerContext, messages: convertToLlm(session.buildSessionContext().messages) };
  const invocation = Object.freeze({});
  const rewritten = await harness.requestCorrelation.run(invocation, () => harness.pi.handlers.get("before_provider_request")({ payload }, ctx));
  const finalBody = rewritten ?? payload;
  await harness.observeFinal({ model, context: requestContext, base: payload, finalBody, invocation });
  return { finalBody, requestContext, invocation };
}
function replayWithFreshController(session, payload) {
  const harness = makeController();
  return harness.pi.handlers.get("before_provider_request")({ payload }, contextFor(session));
}
async function calibratedHarness(session) {
  const harness = makeController();
  const firstId = session.appendMessage(user("first", 1));
  const firstRequest = await sendRequest(harness, session, await payloadFor(session));
  const firstAssistant = assistant("first answer", 2);
  harness.observeNativeMessage({ model, context: firstRequest.requestContext, message: firstAssistant, invocation: firstRequest.invocation });
  harness.pi.handlers.get("message_end")({ message: firstAssistant });
  session.appendMessage(firstAssistant);
  const secondUser = user("second", 3);
  harness.pi.handlers.get("message_end")({ message: secondUser });
  session.appendMessage(secondUser);
  const secondRequest = await sendRequest(harness, session, await payloadFor(session));
  const secondAssistant = assistant("second answer", 4);
  harness.observeNativeMessage({ model, context: secondRequest.requestContext, message: secondAssistant, invocation: secondRequest.invocation });
  harness.pi.handlers.get("message_end")({ message: secondAssistant });
  session.appendMessage(secondAssistant);
  const branchEntries = session.getBranch();
  return { harness, preparation: { firstKeptEntryId: firstId, messagesToSummarize: [branchEntries[0].message], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } }, branchEntries };
}

test("new checkpoints emit the new namespace and legacy checkpoints replay after restart only on descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-controller-lifecycle-"));
  const sessionDir = join(root, "sessions");
  try {
    await mkdir(sessionDir, { recursive: true });
    const session = SessionManager.create(root, sessionDir);
    const firstId = session.appendMessage(user("first", 1));
    const harness = makeController();

    const firstPayload = await payloadFor(session);
    const firstRequest = await sendRequest(harness, session, firstPayload);
    const firstAssistant = assistant("first answer", 2);
    harness.observeNativeMessage({ model, context: firstRequest.requestContext, message: firstAssistant, invocation: firstRequest.invocation });
    harness.pi.handlers.get("message_end")({ message: firstAssistant });
    const firstAssistantId = session.appendMessage(firstAssistant);

    const secondUser = user("second", 3);
    harness.pi.handlers.get("message_end")({ message: secondUser });
    session.appendMessage(secondUser);
    const secondPayload = await payloadFor(session);
    const secondRequest = await sendRequest(harness, session, secondPayload);
    assert.equal(harness.controller.snapshot().calibration, "passed");

    const secondAssistant = assistant("second answer", 4);
    harness.observeNativeMessage({ model, context: secondRequest.requestContext, message: secondAssistant, invocation: secondRequest.invocation });
    harness.pi.handlers.get("message_end")({ message: secondAssistant });
    session.appendMessage(secondAssistant);

    const branchEntries = session.getBranch();
    const preparation = { firstKeptEntryId: firstId, messagesToSummarize: [branchEntries[0].message], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 12, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } };
    const result = await harness.pi.handlers.get("session_before_compact")({ preparation, branchEntries, reason: "manual", willRetry: false, signal: new AbortController().signal }, contextFor(session));
    assert.equal(result.compaction.details.state, "remote_applied", JSON.stringify(result.compaction.details));
    assert.equal(result.compaction.details.replay.namespace, "pi-openai-blackmagic-compact/1");
    assert.equal(result.compaction.details.local, undefined);
    const legacyDetails = structuredClone(result.compaction.details);
    legacyDetails.replay.namespace = "hc-openai-server-compaction/3";
    session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, legacyDetails, true, result.compaction.usage);
    session.appendMessage(user("after checkpoint", 5));

    const file = session.getSessionFile();
    const persisted = await readFile(file, "utf8");
    assert.equal((persisted.match(/opaque-lifecycle/g) ?? []).length, 1, "opaque artifact is persisted exactly once");

    const reopened = SessionManager.open(file, sessionDir, root);
    const restartPayload = await payloadFor(reopened);
    const restartReplay = await replayWithFreshController(reopened, restartPayload);
    const restartJson = JSON.stringify(restartReplay.input);
    assert.equal((restartJson.match(/opaque-lifecycle/g) ?? []).length, 1);
    assert.equal((restartJson.match(/after checkpoint/g) ?? []).length, 1);
    assert.equal(restartJson.includes("local lifecycle summary"), false);
    assert.equal(restartJson.includes("first answer"), false);

    const forkDir = join(root, "fork-sessions");
    await mkdir(forkDir, { recursive: true });
    const descendantFork = SessionManager.forkFrom(file, join(root, "fork-cwd"), forkDir);
    const forkReplay = await replayWithFreshController(descendantFork, await payloadFor(descendantFork));
    assert.equal((JSON.stringify(forkReplay.input).match(/opaque-lifecycle/g) ?? []).length, 1, "descendant fork inherits checkpoint replay");

    const preCheckpoint = SessionManager.open(file, sessionDir, root);
    const preCheckpointFile = preCheckpoint.createBranchedSession(firstAssistantId);
    const preCheckpointFork = SessionManager.open(preCheckpointFile, sessionDir, root);
    assert.equal(preCheckpointFork.getBranch().some((entry) => entry.type === "compaction"), false);
    assert.equal(await replayWithFreshController(preCheckpointFork, await payloadFor(preCheckpointFork)), undefined, "fork before checkpoint cannot inherit replay");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tree, session start, and compaction completion clear calibrated capture state", async () => {
  for (const eventName of ["session_tree", "session_start", "session_compact"]) {
    const session = SessionManager.inMemory("/tmp");
    const { harness } = await calibratedHarness(session);
    assert.equal(harness.controller.snapshot().readiness, "ready");
    await harness.pi.handlers.get(eventName)({}, contextFor(session));
    const snapshot = harness.controller.snapshot();
    assert.equal(snapshot.prepared, false);
    assert.equal(snapshot.calibration, "unverified");
    assert.equal(snapshot.readiness, "calibration_unverified");
  }
});

test("remote compaction rejects stale session or branch capture", async () => {
  for (const stale of ["session", "branch"]) {
    const session = SessionManager.inMemory("/tmp");
    const { harness, preparation, branchEntries } = await calibratedHarness(session);
    const current = contextFor(session);
    const staleManager = {
      getSessionId: () => stale === "session" ? "other-session" : session.getSessionId(),
      getLeafId: () => session.getLeafId(),
      getBranch: () => stale === "branch" ? branchEntries.filter((entry) => entry.message?.timestamp !== 3) : session.getBranch(),
    };
    const result = await harness.pi.handlers.get("session_before_compact")({ preparation, branchEntries, reason: "manual", willRetry: false, signal: new AbortController().signal }, { ...current, sessionManager: staleManager });
    assert.equal(result.compaction.details.failureClass, "capture_stale");
    assert.equal(harness.controller.snapshot().readiness, "calibration_unverified");
  }
});

test("an outstanding request correlation is poisoned instead of overwritten", async () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage(user("one", 1));
  const harness = makeController();
  const payload = await payloadFor(session);
  await harness.pi.handlers.get("before_provider_request")({ payload }, contextFor(session));
  await harness.pi.handlers.get("before_provider_request")({ payload }, contextFor(session));
  assert.equal(harness.controller.snapshot().calibration, "mismatch");
  assert.equal(harness.telemetry.at(-1).failureClass, "outstanding_correlation_overwritten");
});

test("same-provider auxiliary calls cannot poison pending or passed main-request calibration", async () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage(user("first", 1));
  const harness = makeController();
  const mainPayload = await payloadFor(session);
  const mainContext = { ...providerContext, messages: convertToLlm(session.buildSessionContext().messages) };
  const mainInvocation = Object.freeze({});
  await harness.requestCorrelation.run(mainInvocation, () => harness.pi.handlers.get("before_provider_request")({ payload: mainPayload }, contextFor(session)));

  const auxiliaryInvocation = Object.freeze({});
  const auxiliaryContext = { systemPrompt: "auxiliary", messages: [] };
  const auxiliaryPayload = { model: model.id, instructions: "auxiliary", input: [{ role: "user", content: "side call" }] };
  await harness.observeFinal({ model, context: auxiliaryContext, base: auxiliaryPayload, finalBody: auxiliaryPayload, invocation: auxiliaryInvocation });
  harness.observeNativeMessage({ model, context: auxiliaryContext, message: assistant("side answer", 99), invocation: auxiliaryInvocation });
  assert.equal(harness.controller.snapshot().calibration, "unverified");
  assert.equal(harness.controller.snapshot().prepared, false);

  await harness.observeFinal({ model, context: mainContext, base: mainPayload, finalBody: mainPayload, invocation: mainInvocation });
  const firstAssistant = assistant("first answer", 2);
  harness.observeNativeMessage({ model, context: mainContext, message: firstAssistant, invocation: mainInvocation });
  harness.pi.handlers.get("message_end")({ message: firstAssistant });
  session.appendMessage(firstAssistant);
  const secondUser = user("second", 3);
  harness.pi.handlers.get("message_end")({ message: secondUser });
  session.appendMessage(secondUser);
  await sendRequest(harness, session, await payloadFor(session));
  assert.equal(harness.controller.snapshot().readiness, "ready");

  await harness.observeFinal({ model, context: auxiliaryContext, base: auxiliaryPayload, finalBody: auxiliaryPayload, invocation: Object.freeze({}) });
  harness.observeNativeMessage({ model, context: auxiliaryContext, message: assistant("another side answer", 100), invocation: Object.freeze({}) });
  assert.equal(harness.controller.snapshot().readiness, "ready");
  assert.equal(harness.telemetry.filter((event) => event.type === "auxiliary_call_ignored").length, 2);
});

test("a duplicate callback from the correlated main provider stream still fails closed", async () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage(user("one", 1));
  const harness = makeController();
  const request = await sendRequest(harness, session, await payloadFor(session));
  await harness.observeFinal({ model, context: request.requestContext, base: request.finalBody, finalBody: request.finalBody, invocation: request.invocation });
  assert.equal(harness.controller.snapshot().calibration, "mismatch");
  assert.equal(harness.telemetry.at(-1).failureClass, "duplicate_provider_callback");
});

test("current uncalibrated tail must be the one native final assistant", async () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendMessage(user("one", 1));
  const harness = makeController();
  const firstRequest = await sendRequest(harness, session, await payloadFor(session));
  const firstAssistant = assistant("one answer", 2);
  harness.observeNativeMessage({ model, context: firstRequest.requestContext, message: firstAssistant, invocation: firstRequest.invocation });
  harness.pi.handlers.get("message_end")({ message: firstAssistant });
  session.appendMessage(firstAssistant);
  const nextUser = user("two", 3);
  harness.pi.handlers.get("message_end")({ message: nextUser });
  session.appendMessage(nextUser);
  const secondRequest = await sendRequest(harness, session, await payloadFor(session));
  assert.equal(harness.controller.snapshot().calibration, "passed");
  const nativeFinal = assistant("two answer", 4);
  harness.observeNativeMessage({ model, context: secondRequest.requestContext, message: nativeFinal, invocation: secondRequest.invocation });
  const branchEntries = session.getBranch();
  const preparation = { firstKeptEntryId: branchEntries[0].id, messagesToSummarize: [branchEntries[0].message], turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 5, fileOps: { read: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } };
  const compact = await harness.pi.handlers.get("session_before_compact")({ preparation, branchEntries, reason: "manual", willRetry: false, signal: new AbortController().signal }, contextFor(session));
  assert.equal(compact.compaction.details.failureClass, "native_tail_unverified", "missing message_end fails closed");
});
