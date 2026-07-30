import test from "node:test";
import assert from "node:assert/strict";
import { COMPACTION_METHOD_LABELS, describeRemoteRoute, footerCompactionStatus, projectCompactionMethod } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

const remote = (protocol = "responses_compact_v1") => ({ type: "compaction", details: { schemaVersion: 1, state: "remote_applied", identity: { protocol, surface: protocol === "codex_compaction_trigger_v2" ? "chatgpt_codex" : "openai_api" } } });
test("compaction method projection is active-branch-only and redacts persisted details", () => {
  assert.equal(projectCompactionMethod([]), COMPACTION_METHOD_LABELS.none);
  assert.equal(projectCompactionMethod([{ type: "compaction", summary: "Pi summary" }]), COMPACTION_METHOD_LABELS.native);
  assert.equal(projectCompactionMethod([remote("codex_compaction_trigger_v2")]), COMPACTION_METHOD_LABELS.codex);
  assert.equal(projectCompactionMethod([remote()]), COMPACTION_METHOD_LABELS.responses);
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } }]), "local fallback (timeout)");
  assert.equal(footerCompactionStatus(COMPACTION_METHOD_LABELS.native), "Compaction: Pi local");
  assert.equal(describeRemoteRoute({ surface: "chatgpt_codex", protocol: "codex_compaction_trigger_v2" }), "ChatGPT Codex / codex_compaction_trigger_v2");
});
test("status uses current model and persisted branch state without readiness state", async () => {
  const handlers = new Map(); let command;
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, value) => { command = value; } };
  createServerCompactionController(pi);
  const notices = []; const ctx = { hasUI: true, model: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" }, sessionManager: { getBranch: () => [remote()] }, ui: { setStatus() {}, notify: (...args) => notices.push(args) } };
  await command.handler("status", ctx);
  assert.match(notices.at(-1)[0], /direct provider compaction/);
  assert.doesNotMatch(notices.at(-1)[0], /Calibration|Wrappers|assertion|capture/i);
});
