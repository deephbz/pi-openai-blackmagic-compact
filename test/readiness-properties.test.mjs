import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { buildSessionContext, convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { captureNativeBody, createServerCompactionController, serializationOptions } from "../src/controller.mjs";
import { checkpointDetails, sha256 } from "../src/contract.mjs";

const require = createRequire(import.meta.url);
const codingEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const corePackage = require.resolve("@earendil-works/pi-agent-core/package.json", { paths: [dirname(codingEntry)] });
const { prepareCompaction, DEFAULT_COMPACTION_SETTINGS } = await import(join(dirname(corePackage), "dist/index.js"));

const AUDIT = Object.freeze({ extendedSeeds: [0x5eedc0de, 0x51cedbad, 0xa11ce5ed], extendedCases: 1000, stratumCases: 100, shrinkRuns: 2 });
const HISTORICAL_ARTIFACT = Object.freeze([{ type: "compaction", encrypted_content: "frozen-historical-v1" }]);
const HISTORICAL_ARTIFACT_JSON = JSON.stringify(HISTORICAL_ARTIFACT);
const HISTORICAL_DETAILS = Object.freeze({
  schemaVersion: 1,
  state: "remote_applied",
  identity: Object.freeze({ kind: "supported", surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-4-historical", api: "openai-responses" }),
  checkpoint: Object.freeze({ artifact: HISTORICAL_ARTIFACT, hash: sha256(HISTORICAL_ARTIFACT_JSON), length: HISTORICAL_ARTIFACT_JSON.length, retention: "canonical_provider_window" }),
  replay: Object.freeze({ namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: Object.freeze([sha256(HISTORICAL_ARTIFACT[0])]) }),
  latencyMs: 0,
});
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const tool = { name: "probe", description: "Probe the readiness fixture", parameters: { type: "object", properties: {} } };
const stats = { generated: 0, nativeSetupExcluded: 0, routes: {}, checkpoints: {}, storage: {}, dimensions: { contextEmpty: 0, promptChanged: 0, toolsChanged: 0, metadataDiffers: 0, descendant: 0, repeat: 0, custom: 0, timeline: 0, partialTurn: 0, duplicate: 0 }, remoteCalls: 0 };

function model(route, id, metadata = {}) {
  const baseUrl = route === "openai" ? "https://api.openai.com/v1" : route === "codex" ? "https://chatgpt.com/backend-api" : route === "azure" ? "https://resource.openai.azure.com/openai/v1" : "https://proxy.invalid/v1";
  const provider = route === "openai" ? "openai" : route === "codex" ? "openai-codex" : route === "azure" ? "azure-openai-responses" : "proxy";
  const api = route === "openai" ? "openai-responses" : route === "codex" ? "openai-codex-responses" : route === "azure" ? "azure-openai-responses" : "unsupported-api";
  return { provider, id, name: id, baseUrl, api, input: ["text"], reasoning: metadata.reasoning ?? true, thinkingLevelMap: metadata.thinkingLevelMap ?? { high: "high" }, contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function codexToken() { const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "property-account" } })).toString("base64url"); return `e30.${payload}.property-signature`; }
function fakePi(activeTools) {
  const handlers = new Map(); let command; let names = activeTools.map((entry) => typeof entry === "string" ? entry : entry.name);
  return { on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, value) => { command = value; }, registerEntryRenderer() {}, appendEntry() {}, getActiveTools: () => [...names], getAllTools: () => [tool], setActiveTools: (next) => { names = next.map((entry) => typeof entry === "string" ? entry : entry.name); }, handlers, get command() { return command; } };
}
function prep(branch, settings) { const result = prepareCompaction(branch, settings); return result.ok ? result.value : undefined; }
function baseModel(route, switchModel, metadataDiffers) {
  const producer = model(route, route === "azure" ? "deployment-a" : "gpt-5", { reasoning: true, thinkingLevelMap: { high: "high" } });
  const currentId = route === "azure" ? (switchModel ? "deployment-alias" : "deployment-a") : switchModel ? "gpt-5-mini" : "gpt-5";
  const current = model(route, currentId, metadataDiffers ? { reasoning: false, thinkingLevelMap: { off: "off" } } : {});
  return { producer, current };
}
function authFor(scenario, producer, current) {
  if (scenario.authMode === "missing") return undefined;
  if (scenario.authMode === "failed") return { ok: false, apiKey: "synthetic-key" };
  if (scenario.authMode === "bad-route") return scenario.route === "azure" ? { ok: true, apiKey: "synthetic-key", env: { AZURE_OPENAI_BASE_URL: "https://proxy.invalid/openai/v1" } } : { ok: true, apiKey: "synthetic-key", env: { OPENAI_BASE_URL: "http://proxy.invalid/v1" } };
  if (scenario.route === "codex") return { ok: true, apiKey: codexToken() };
  if (scenario.route === "azure") return { ok: true, apiKey: "synthetic-key", env: { AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${producer.id}=deployment-a,${current.id}=deployment-a` } };
  return { ok: true, apiKey: "synthetic-key" };
}
function appendHistory(session, scenario, producer) {
  let firstMessageId;
  const append = (message) => { const id = session.appendMessage(message); firstMessageId ??= id; return id; };
  if (scenario.context === "present") append({ role: "user", content: [{ type: "text", text: "property context" }], timestamp: 1 });
  for (const [index, operation] of scenario.history.entries()) {
    if (["user", "duplicate-user"].includes(operation)) append({ role: "user", content: [{ type: "text", text: operation === "duplicate-user" ? "repeated property user" : `property user ${index}` }], timestamp: index + 2 });
    if (operation === "assistant") append({ role: "assistant", content: [{ type: "text", text: `property assistant ${index}` }], api: producer.api, provider: producer.provider, model: producer.id, usage, stopReason: "stop", timestamp: index + 2 });
    if (operation === "reasoning-tool" || operation === "partial-tool") {
      append({ role: "assistant", content: [{ type: "thinking", thinking: `property reasoning ${index}` }, { type: "toolCall", id: `property-call-${index}`, name: "probe", arguments: {} }], api: producer.api, provider: producer.provider, model: producer.id, usage, stopReason: "toolUse", timestamp: index + 2 });
      if (operation === "reasoning-tool") append({ role: "toolResult", toolCallId: `property-call-${index}`, toolName: "probe", content: [{ type: "text", text: `property tool result ${index}` }], isError: false, timestamp: index + 3 });
    }
    if (operation === "custom") session.appendCustomEntry("readiness-property/note", { index, content: "custom property evidence" });
    if (operation === "timeline") session.appendCustomEntry("readiness-property/timeline", { index, method: "property" });
  }
  return firstMessageId;
}
function payload(ctx, modelValue, branch, auth, tools) { return captureNativeBody(modelValue, { systemPrompt: ctx.getSystemPrompt(), messages: convertToLlm(buildSessionContext(branch).messages), tools }, serializationOptions({ ...ctx, model: modelValue }, auth, new AbortController().signal)); }
function nativeControlItem(providerPayload) {
  return providerPayload?.input?.find((item) => item?.role === "developer" || item?.role === "system");
}
function oracle(scenario, nativeEligible, contextEligible) {
  if (!nativeEligible || !contextEligible || scenario.route === "unsupported" || scenario.authMode !== "valid" || !scenario.systemPrompt) return false;
  if (["tampered", "duplicate", "artifact-hash-corrupt", "artifact-length-corrupt", "unknown-scope"].includes(scenario.checkpoint)) return false;
  if (scenario.checkpoint === "switch-unavailable") return false;
  if (scenario.checkpoint !== "none" && !scenario.descendant) return false;
  return true;
}

const scenarioArbitrary = fc.record({
  route: fc.constantFrom("openai", "codex", "azure", "unsupported"),
  authMode: fc.constantFrom("valid", "valid", "missing", "failed", "bad-route"),
  context: fc.constantFrom("present", "present", "empty"),
  checkpoint: fc.constantFrom("none", "none", "same", "switch", "switch-unavailable", "tampered", "duplicate"),
  history: fc.array(fc.constantFrom("user", "assistant", "reasoning-tool", "partial-tool", "custom", "timeline", "duplicate-user"), { minLength: 0, maxLength: 5 }),
  keepRecentTokens: fc.constantFrom(1, 32, 20000),
  promptChanged: fc.boolean(),
  toolsChanged: fc.boolean(),
  metadataDiffers: fc.boolean(),
  systemPrompt: fc.boolean(),
  descendant: fc.boolean(),
  repeat: fc.boolean(),
  storage: fc.constantFrom("memory", "memory", "reopen", "fork"),
});

async function runScenario(scenario, { remoteEnabled = true, verifyReplay = true } = {}) {
  stats.generated += 1;
  stats.routes[scenario.route] = (stats.routes[scenario.route] ?? 0) + 1;
  stats.checkpoints[scenario.checkpoint] = (stats.checkpoints[scenario.checkpoint] ?? 0) + 1;
  stats.storage[scenario.storage] = (stats.storage[scenario.storage] ?? 0) + 1;
  if (scenario.context === "empty") stats.dimensions.contextEmpty += 1;
  if (scenario.promptChanged) stats.dimensions.promptChanged += 1;
  if (scenario.toolsChanged) stats.dimensions.toolsChanged += 1;
  if (scenario.metadataDiffers) stats.dimensions.metadataDiffers += 1;
  if (scenario.descendant) stats.dimensions.descendant += 1;
  if (scenario.repeat) stats.dimensions.repeat += 1;
  for (const operation of scenario.history) if (operation === "custom") stats.dimensions.custom += 1; else if (operation === "timeline") stats.dimensions.timeline += 1; else if (operation === "partial-tool") stats.dimensions.partialTurn += 1; else if (operation === "duplicate-user") stats.dimensions.duplicate += 1;
  const effective = remoteEnabled ? scenario : { ...scenario, checkpoint: "none", storage: "memory", repeat: false };
  const { producer, current } = baseModel(effective.route, effective.checkpoint.startsWith("switch"), effective.metadataDiffers);
  const auth = authFor(effective, producer, current);
  // Create the checkpoint under the producer configuration, then change the
  // current configuration before readiness and replay.
  const producerPrompt = "property producer system prompt";
  const currentPrompt = effective.promptChanged ? "property current system prompt" : producerPrompt;
  const producerTools = [tool];
  const currentTools = effective.toolsChanged ? [] : producerTools;
  let root;
  try {
    let session;
    if (effective.storage === "memory") session = SessionManager.inMemory("/tmp");
    else { root = await mkdtemp(join(tmpdir(), "hc-readiness-property-")); const sessions = join(root, "sessions"); await mkdir(sessions, { recursive: true }); session = SessionManager.create(root, sessions); }
    const firstMessageId = appendHistory(session, effective, producer);
    if (effective.storage !== "memory" && !session.getBranch().some((entry) => entry.type === "message" && entry.message?.role === "assistant")) {
      session.appendMessage({ role: "assistant", content: [{ type: "text", text: "persisted property assistant" }], api: producer.api, provider: producer.provider, model: producer.id, usage, stopReason: "stop", timestamp: 50 });
    }
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: effective.keepRecentTokens };
    const registry = { getApiKeyAndHeaders: async () => auth };
    if (effective.checkpoint === "switch" || effective.checkpoint === "switch-unavailable") registry.find = effective.checkpoint === "switch" ? (_provider, id) => id === producer.id ? producer : undefined : () => undefined;
    const fetchCalls = [];
    const pi = fakePi(producerTools);
    createServerCompactionController(pi, { fetchImpl: async (_url, options) => { stats.remoteCalls += 1; fetchCalls.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({ output: [{ type: "compaction", encrypted_content: `property-opaque-${fetchCalls.length}` }] }) }; } });
    const producerContext = { model: producer, modelRegistry: registry, sessionManager: session, getSystemPrompt: effective.systemPrompt ? () => producerPrompt : undefined, thinkingLevel: "high" };
    const initialPreparation = prep(session.getBranch(), settings);
    if (effective.checkpoint !== "none") {
      if (!initialPreparation || effective.authMode !== "valid" || effective.route === "unsupported" || !effective.systemPrompt) {
        stats.nativeSetupExcluded += 1;
        return { excluded: true, observed: false, expected: false, nativeEligible: false, branchPreserved: true, statusFetchCalls: 0 };
      }
      const initial = effective.checkpoint === "switch-unavailable"
        ? { compaction: { summary: "", firstKeptEntryId: initialPreparation.firstKeptEntryId, tokensBefore: initialPreparation.tokensBefore, details: HISTORICAL_DETAILS } }
        : await pi.handlers.get("session_before_compact")({ preparation: initialPreparation, branchEntries: session.getBranch(), signal: new AbortController().signal }, producerContext);
      if (!initial?.compaction) throw new Error(`native eligible setup returned no extension compaction: ${JSON.stringify(effective)}`);
      session.appendCompaction(initial.compaction.summary, initial.compaction.firstKeptEntryId, initial.compaction.tokensBefore, initial.compaction.details, true);
      if (effective.checkpoint === "duplicate") {
        session.appendMessage({ role: "user", content: [{ type: "text", text: "explicit duplicate payload" }], timestamp: 200 });
        session.appendMessage({ role: "user", content: [{ type: "text", text: "explicit duplicate payload" }], timestamp: 201 });
      }
      if (["tampered", "duplicate", "artifact-hash-corrupt", "artifact-length-corrupt", "unknown-scope"].includes(effective.checkpoint)) {
        const tampered = structuredClone(initial.compaction.details);
        if (effective.checkpoint === "artifact-hash-corrupt") tampered.checkpoint.hash = "0".repeat(64);
        else if (effective.checkpoint === "artifact-length-corrupt") tampered.checkpoint.length += 1;
        else if (effective.checkpoint === "unknown-scope") tampered.replay.scope = "future-unknown-scope";
        if (effective.checkpoint === "tampered") tampered.replay.replacedItemHashes = ["0".repeat(64)];
        else if (effective.checkpoint === "duplicate") {
          const duplicatePayload = await payload(producerContext, producer, session.getBranch(), auth, producerTools);
          const hashes = duplicatePayload.input.map((item) => JSON.stringify(item));
          const duplicateIndex = hashes.findIndex((hash, index) => hashes.indexOf(hash) !== index);
          assert.notEqual(duplicateIndex, -1, "explicit duplicate fixture must produce duplicate provider items");
          tampered.replay.replacedItemHashes = [JSON.parse(hashes[duplicateIndex])].map((item) => {
            const { createHash } = require("node:crypto");
            return createHash("sha256").update(JSON.stringify(item)).digest("hex");
          });
        }
        session.appendCompaction("", initial.compaction.firstKeptEntryId, initial.compaction.tokensBefore, tampered, true);
      }
      if (effective.checkpoint === "source-tampered") {
        const retained = session.getBranch().find((entry) => entry.id === initialPreparation.firstKeptEntryId);
        assert.ok(retained, "source-tampered fixture needs the native firstKeptEntryId");
        assert.equal(retained.type, "message", "native firstKeptEntryId must identify a message");
        assert.ok(["user", "assistant", "toolResult"].includes(retained.message?.role), "source-tampered fixture must target retained conversation");
        const beforeMutation = await payload(producerContext, producer, session.getBranch(), auth, producerTools);
        const message = retained.message;
        if (message.role === "assistant") {
          const toolCall = message.content?.find((part) => part?.type === "toolCall");
          if (toolCall) toolCall.arguments = { ...(toolCall.arguments ?? {}), sourceTampered: true };
          else {
            const content = Array.isArray(message.content) ? message.content : [];
            const index = content.findIndex((part) => typeof part?.text === "string");
            assert.notEqual(index, -1, "assistant retained conversation needs serialized text or tool call");
            message.content = content.with(index, { ...content[index], text: "mutated retained source" });
          }
        } else {
          const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
          const index = content.findIndex((part) => typeof part?.text === "string");
          assert.notEqual(index, -1, "retained conversation needs serialized text");
          message.content = content.with(index, { ...content[index], text: "mutated retained source" });
        }
        const afterMutation = await payload(producerContext, producer, session.getBranch(), auth, producerTools);
        assert.notDeepEqual(afterMutation.input, beforeMutation.input, "source mutation must alter native covered conversation input");
      }
      if (effective.descendant) {
        session.appendMessage({ role: "user", content: [{ type: "text", text: "property descendant" }], timestamp: 99 });
        if (effective.history.includes("partial-tool")) session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "tail partial reasoning" }, { type: "toolCall", id: "tail-partial", name: "probe", arguments: {} }], api: producer.api, provider: producer.provider, model: producer.id, usage, stopReason: "toolUse", timestamp: 100 });
        session.appendCustomEntry("readiness-property/tail", { uiOnly: true });
      }
      if (effective.storage === "reopen") session = SessionManager.open(session.getSessionFile(), join(root, "sessions"), root);
      if (effective.storage === "fork") session = SessionManager.forkFrom(session.getSessionFile(), join(root, "fork"), join(root, "sessions"));
      producerContext.sessionManager = session;
    }
    const nativePreparation = prep(session.getBranch(), settings);
    const nativeEligible = Boolean(nativePreparation);
    const contextEligible = buildSessionContext(session.getBranch()).messages.length > 0;
    const expected = oracle(effective, nativeEligible, contextEligible);
    const context = { ...producerContext, model: current, getSystemPrompt: effective.systemPrompt ? () => currentPrompt : undefined, hasUI: true, ui: { notify: () => {} } };
    pi.setActiveTools(currentTools);
    const before = JSON.stringify(session.getBranch());
    const notices = []; context.ui.notify = (...notice) => notices.push(notice);
    const fetchBeforeStatus = fetchCalls.length;
    await pi.command.handler("", context);
    const statusText = notices.at(-1)?.[0] ?? "";
    const observed = /^Blackmagic remote compaction: ready to attempt/i.test(statusText);
    const statusFetchCalls = fetchCalls.length - fetchBeforeStatus;
    const branchPreserved = JSON.stringify(session.getBranch()) === before;
    if (statusFetchCalls !== 0) throw new Error(`status performed provider egress: ${statusFetchCalls}`);
    if (verifyReplay && observed && effective.checkpoint !== "none" && !["tampered", "duplicate", "payload-tampered"].includes(effective.checkpoint)) {
      const currentPayload = await payload(context, current, session.getBranch(), auth, currentTools);
      const replayed = await pi.handlers.get("before_provider_request")({ payload: currentPayload }, context);
      assert.ok(replayed, "normal provider replay must succeed");
      assert.deepEqual(nativeControlItem(replayed), nativeControlItem(currentPayload), "replay must preserve the native system/developer control item");
      assert.deepEqual(replayed.tools, currentPayload.tools, "replay must preserve current tools");
    }
    if (effective.checkpoint === "payload-tampered") {
      const currentPayload = await payload(context, current, session.getBranch(), auth, currentTools);
      const retained = session.getBranch().find((entry) => entry.id === initialPreparation.firstKeptEntryId);
      assert.ok(retained?.message, "payload-tampered fixture needs the native firstKeptEntryId");
      const retainedText = JSON.stringify(retained.message.content).match(/property (?:context|user \d+)/)?.[0];
      assert.ok(retainedText, "payload-tampered fixture needs retained conversation text");
      const coveredIndex = currentPayload.input.findIndex((item) => item?.role !== "developer" && JSON.stringify(item).includes(retainedText));
      assert.notEqual(coveredIndex, -1, `payload-tampered fixture needs the retained conversation item: ${JSON.stringify(currentPayload.input.map((item) => ({ type: item?.type, role: item?.role })))}`);
      const tamperedPayload = structuredClone(currentPayload);
      const target = tamperedPayload.input[coveredIndex];
      tamperedPayload.input[coveredIndex] = { ...target, content: typeof target.content === "string" ? "actual covered payload mutation" : target.content?.map?.((part) => part?.text ? { ...part, text: "actual covered payload mutation" } : part) };
      const replayed = await pi.handlers.get("before_provider_request")({ payload: tamperedPayload }, context);
      assert.equal(replayed, undefined, "actual current payload tampering must fail closed");
    }
    let compactionState;
    if (observed && effective.checkpoint === "none" && remoteEnabled) {
      const result = await pi.handlers.get("session_before_compact")({ preparation: nativePreparation, branchEntries: session.getBranch(), signal: new AbortController().signal }, context);
      compactionState = result?.compaction?.details?.state;
      assert.equal(compactionState, "remote_applied");
      assert.match(JSON.stringify(fetchCalls.at(-1)), new RegExp(currentPrompt), "outgoing body must preserve instructions");
      if (effective.repeat) {
        session.appendCompaction(result.compaction.summary, result.compaction.firstKeptEntryId, result.compaction.tokensBefore, result.compaction.details, true);
        session.appendMessage({ role: "user", content: [{ type: "text", text: "property repeated descendant" }], timestamp: 101 });
        const repeatBranch = session.getBranch();
        const repeatPreparation = prep(repeatBranch, settings);
        const repeatNotices = [];
        context.ui.notify = (...notice) => repeatNotices.push(notice);
        await pi.command.handler("", context);
        assert.match(repeatNotices.at(-1)?.[0] ?? "", /ready to attempt/i, "repeated readiness failed");
        const repeatResult = await pi.handlers.get("session_before_compact")({ preparation: repeatPreparation, branchEntries: repeatBranch, signal: new AbortController().signal }, context);
        assert.equal(repeatResult?.compaction?.details?.state, "remote_applied", "repeated compaction failed");
      }
    }
    return { observed, expected, nativeEligible, statusFetchCalls, fetchCalls: fetchCalls.length, branchPreserved, compactionState, statusText };
  } finally { if (root) await rm(root, { recursive: true, force: true }); }
}

async function assertFamily(name, arbitrary, seeds, numRuns, options = {}) {
  try {
    for (const seed of seeds) await fc.assert(fc.asyncProperty(arbitrary, async (scenario) => {
      const result = await runScenario(scenario, options);
      if (result.excluded) return;
      assert.equal(result.branchPreserved, true, `${name}: status mutated session`);
      assert.equal(result.observed, result.expected, JSON.stringify({ family: name, seed, scenario, result }));
    }), { seed, numRuns, endOnFailure: false, interruptAfterTimeLimit: 120000 });
  } catch (error) {
    throw new Error(`${name} seed/path/counterexample: ${error.message}; stats=${JSON.stringify(stats)}`, { cause: error });
  }
}

const nativeEligibilityArb = scenarioArbitrary.map((scenario) => ({ ...scenario, checkpoint: "none", storage: "memory", repeat: false }));
const continuationArb = fc.record({ route: fc.constantFrom("openai", "codex", "azure"), authMode: fc.constant("valid"), context: fc.constant("present"), checkpoint: fc.constantFrom("same", "switch", "switch-unavailable"), history: fc.array(fc.constantFrom("user", "assistant", "reasoning-tool", "partial-tool", "custom", "timeline", "duplicate-user"), { minLength: 1, maxLength: 4 }), keepRecentTokens: fc.constantFrom(1, 32, 20000), promptChanged: fc.constant(false), toolsChanged: fc.constant(false), metadataDiffers: fc.boolean(), systemPrompt: fc.constant(true), descendant: fc.constant(true), repeat: fc.constant(false), storage: fc.constantFrom("memory", "reopen", "fork") });
const instructionArb = fc.record({
  base: continuationArb,
  changed: fc.constantFrom("prompt", "tools", "both"),
}).map(({ base, changed }) => ({
  ...base,
  checkpoint: "switch",
  promptChanged: changed === "prompt" || changed === "both",
  toolsChanged: changed === "tools" || changed === "both",
}));
const repeatArb = continuationArb.map((scenario) => ({ ...scenario, checkpoint: "none", repeat: true, storage: "memory" }));
const unsafeBaseArb = continuationArb.map((scenario) => ({ ...scenario, storage: "memory" }));
const hashTamperedArb = unsafeBaseArb.map((scenario) => ({ ...scenario, checkpoint: "tampered" }));
const duplicateArb = unsafeBaseArb.map((scenario) => ({ ...scenario, checkpoint: "duplicate" }));
const sourceTamperedArb = unsafeBaseArb.filter((scenario) => !scenario.history.some((operation) => operation === "custom" || operation === "timeline")).map((scenario) => ({ ...scenario, checkpoint: "source-tampered" }));
const payloadTamperedArb = unsafeBaseArb.map((scenario) => ({ ...scenario, route: "openai", metadataDiffers: false, history: ["user"], checkpoint: "payload-tampered" }));
const invalidCheckpointBaseArb = continuationArb.map((scenario) => ({ ...scenario, storage: "memory" }));
const artifactHashArb = invalidCheckpointBaseArb.map((scenario) => ({ ...scenario, checkpoint: "artifact-hash-corrupt" }));
const artifactLengthArb = invalidCheckpointBaseArb.map((scenario) => ({ ...scenario, checkpoint: "artifact-length-corrupt" }));
const unknownScopeArb = invalidCheckpointBaseArb.map((scenario) => ({ ...scenario, checkpoint: "unknown-scope" }));
// Historical v1 has no source-independent proof. Keep this fixture frozen and
// require fail-closed behavior when the producer metadata cannot be resolved.
const historicalV1Arb = continuationArb.map((scenario) => ({ ...scenario, checkpoint: "switch-unavailable", metadataDiffers: true, promptChanged: true, toolsChanged: true, storage: "memory" }));
const checkpointAuditArb = fc.record({
  route: fc.constantFrom("openai", "codex", "azure"),
  authMode: fc.constant("valid"),
  context: fc.constant("present"),
  checkpoint: fc.constantFrom("same", "switch"),
  history: fc.array(fc.constantFrom("user", "assistant", "reasoning-tool", "partial-tool", "custom", "timeline"), { minLength: 1, maxLength: 4 }),
  keepRecentTokens: fc.constantFrom(1, 32, 20000),
  promptChanged: fc.constant(false),
  toolsChanged: fc.constant(false),
  metadataDiffers: fc.constant(false),
  systemPrompt: fc.constant(true),
  descendant: fc.constant(true),
  repeat: fc.constant(false),
  storage: fc.constant("memory"),
});

// The broad run keeps generated checkpoints. The dedicated family below adds
// a controlled checkpoint matrix and keeps historical v1 fixtures separate.
test(`extended readiness oracle audit seeds=${AUDIT.extendedSeeds.join(",")} cases=${AUDIT.extendedCases}`, async () => {
  await assertFamily("native-eligibility", nativeEligibilityArb, AUDIT.extendedSeeds, Math.ceil(AUDIT.extendedCases / AUDIT.extendedSeeds.length), { verifyReplay: false });
  assert.ok(stats.generated >= AUDIT.extendedCases, `generated=${stats.generated}`);
});

test(`extended checkpoint replay audit cases=${AUDIT.extendedCases}`, async () => {
  const before = stats.generated;
  await assertFamily("checkpoint-replay", checkpointAuditArb, AUDIT.extendedSeeds, Math.ceil(AUDIT.extendedCases / AUDIT.extendedSeeds.length), { verifyReplay: true });
  assert.ok(stats.generated - before >= AUDIT.extendedCases, `checkpoint cases=${stats.generated - before}`);
});

test("continuation property stratum", async () => {
  await assertFamily("continuation", continuationArb, [0x1111, 0x2222], AUDIT.stratumCases);
});

test("instruction and tool preservation property stratum", async () => {
  await assertFamily("instruction-and-tool-change", instructionArb, [0x3333], AUDIT.stratumCases);
});

test("repeated compaction property stratum", async () => {
  await assertFamily("repeat", repeatArb, [0x5555], AUDIT.stratumCases);
});

test("hash-tampered checkpoint property stratum", async () => {
  await assertFamily("hash-tampered-checkpoint", hashTamperedArb, [0x4444], AUDIT.stratumCases);
});

test("duplicate checkpoint property stratum", async () => {
  await assertFamily("duplicate-checkpoint", duplicateArb, [0x7777], AUDIT.stratumCases);
});

test("pre-checkpoint source mutation property stratum", async () => {
  await assertFamily("source-tampered-checkpoint", sourceTamperedArb, [0x8888], AUDIT.stratumCases);
});

test("actual current payload tampering property stratum", async () => {
  await assertFamily("payload-tampered-checkpoint", payloadTamperedArb, [0x9999], AUDIT.stratumCases);
});

test("corrupt persisted checkpoint hash remains blocked without provider egress", async () => {
  await assertFamily("artifact-hash-corrupt", artifactHashArb, [0xa55a], AUDIT.stratumCases, { verifyReplay: false });
});

test("corrupt persisted checkpoint length remains blocked without provider egress", async () => {
  await assertFamily("artifact-length-corrupt", artifactLengthArb, [0xa66a], AUDIT.stratumCases, { verifyReplay: false });
});

test("unknown replay scope remains blocked without provider egress", async () => {
  await assertFamily("unknown-replay-scope", unknownScopeArb, [0xa77a], AUDIT.stratumCases, { verifyReplay: false });
});

test("legacy full witness stays unique when conversation-only sequence repeats", async () => {
  const pi = fakePi([tool]);
  createServerCompactionController(pi);
  const current = model("openai", "gpt-5");
  const identity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: current.id, api: current.api };
  const artifact = [{ type: "compaction", encrypted_content: "legacy-opaque" }];
  const details = checkpointDetails({ identity, opaqueWindow: artifact });
  const developer = { role: "developer", content: "current instructions" };
  const first = { role: "user", content: "conversation one" };
  const second = { role: "user", content: "conversation two" };
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [developer, first, second].map(sha256) };
  const payloadValue = { model: current.id, input: [developer, first, second, first, second] };
  const branch = [{ id: "legacy-compaction", type: "compaction", details }];
  const replayed = await pi.handlers.get("before_provider_request")({ payload: payloadValue }, {
    model: current,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-key" }) },
    sessionManager: { getBranch: () => branch, getLeafId: () => "legacy-compaction" },
    getSystemPrompt: () => "current instructions",
    thinkingLevel: "high",
  });
  assert.ok(replayed, "legacy full witness should replay despite repeated conversation-only sequence");
  assert.deepEqual(replayed.input.slice(0, 2), [developer, ...artifact]);
});

test("historical v1 replay remains fail-closed when producer proof is unavailable", async () => {
  await assertFamily("historical-v1", historicalV1Arb, [0x6666], AUDIT.stratumCases, { verifyReplay: false });
});

test("readiness property audit report", () => {
  console.log(`[readiness-property-audit] ${JSON.stringify({ audit: AUDIT, stats })}`);
});
