import test from "node:test";
import assert from "node:assert/strict";
import { COMPACTION_METHOD_LABELS, COMPACTION_TIMELINE_METHODS, compactionTimelineData, compactionTimelineLabel, describeRemoteRoute, projectCompactionMethod } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

const remote = (protocol = "responses_compact_v1") => ({ type: "compaction", details: { schemaVersion: 1, state: "remote_applied", identity: { protocol, surface: protocol === "codex_compaction_trigger_v2" ? "chatgpt_codex" : "openai_api" } } });
test("compaction method projection is active-branch-only and redacts persisted details", () => {
  assert.equal(projectCompactionMethod([]), COMPACTION_METHOD_LABELS.none);
  assert.equal(projectCompactionMethod([{ type: "compaction", summary: "Pi summary" }]), COMPACTION_METHOD_LABELS.native);
  assert.equal(projectCompactionMethod([remote("codex_compaction_trigger_v2")]), COMPACTION_METHOD_LABELS.codex);
  assert.equal(projectCompactionMethod([remote()]), COMPACTION_METHOD_LABELS.responses);
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } }]), "local fallback (timeout)");
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "remote_replayed" } }]), COMPACTION_METHOD_LABELS.unsupported, "telemetry-only outcomes are not durable states");
  assert.equal(describeRemoteRoute({ surface: "chatgpt_codex", protocol: "codex_compaction_trigger_v2" }), "ChatGPT Codex / codex_compaction_trigger_v2");
});
test("timeline data has one allowlisted redacted field", () => {
  assert.deepEqual(compactionTimelineData(remote("codex_compaction_trigger_v2")), { method: COMPACTION_TIMELINE_METHODS.CODEX });
  assert.deepEqual(compactionTimelineData(remote()), { method: COMPACTION_TIMELINE_METHODS.RESPONSES });
  assert.deepEqual(compactionTimelineData({ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } }), { method: COMPACTION_TIMELINE_METHODS.LOCAL_FALLBACK, failureClass: "timeout" });
  assert.equal(compactionTimelineData({ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "untrusted error" } }), undefined);
  assert.equal(compactionTimelineLabel({ method: COMPACTION_TIMELINE_METHODS.CODEX }), "[server compaction] Codex v2 applied");
  assert.equal(compactionTimelineLabel({ method: COMPACTION_TIMELINE_METHODS.LOCAL_FALLBACK, failureClass: "timeout" }), "[server compaction] Pi local fallback (timeout)");
  assert.equal(compactionTimelineLabel({ method: "https://secret.invalid" }), undefined);
});
test("status reports a concrete reason when the current branch has no context", async () => {
  const handlers = new Map(); let command;
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, value) => { command = value; }, registerEntryRenderer() {}, appendEntry() {} };
  createServerCompactionController(pi);
  const notices = []; const ctx = { hasUI: true, model: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" }, sessionManager: { getBranch: () => [] }, ui: { notify: (...args) => notices.push(args) } };
  await command.handler("", ctx);
  assert.equal(notices.length, 1);
  assert.match(notices[0][0], /not ready/i);
  assert.match(notices[0][0], /current branch has no context/i);
  assert.equal(notices[0][1], "warning");
});
