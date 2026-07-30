import test from "node:test";
import assert from "node:assert/strict";
import { COMPACTION_METHOD_LABELS, describeRemoteRoute, footerCompactionStatus, projectCompactionMethod, projectNextRemoteReadiness } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

const remote = (protocol = "responses_compact_v1") => ({ type: "compaction", details: { schemaVersion: 1, state: "remote_applied", identity: { protocol, surface: protocol === "codex_compaction_trigger_v2" ? "chatgpt_codex" : "openai_api" } } });

test("compaction method projection is active-branch-only and redacts persisted details", () => {
  assert.equal(projectCompactionMethod([]), COMPACTION_METHOD_LABELS.none);
  assert.equal(projectCompactionMethod([{ type: "compaction", summary: "Pi summary" }]), COMPACTION_METHOD_LABELS.native);
  assert.equal(projectCompactionMethod([remote("codex_compaction_trigger_v2")]), COMPACTION_METHOD_LABELS.codex);
  assert.equal(projectCompactionMethod([remote()]), COMPACTION_METHOD_LABELS.responses);
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "remote_replayed", prompt: "never display" } }]), COMPACTION_METHOD_LABELS.replay);
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "remote_invalidated" } }]), COMPACTION_METHOD_LABELS.invalidated);
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "unsupported_surface", endpoint: "https://secret.example" } }]), COMPACTION_METHOD_LABELS.unsupported);
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } }]), "local fallback (timeout)");
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "api-key=secret" } }]), "local fallback (unclassified)");
  assert.equal(projectCompactionMethod([{ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } }, remote("codex_compaction_trigger_v2")]), COMPACTION_METHOD_LABELS.codex);
});

test("next remote readiness is redacted and operationally useful", () => {
  assert.equal(projectNextRemoteReadiness(), "capture_unverified");
  assert.equal(projectNextRemoteReadiness({ lastRewriterAsserted: true, calibration: "unverified" }), "calibration_unverified");
  assert.equal(projectNextRemoteReadiness({ lastRewriterAsserted: true, calibration: "mismatch", identity: { endpoint: "https://secret.example" } }), "calibration_mismatch");
  assert.equal(projectNextRemoteReadiness({ lastRewriterAsserted: true, calibration: "passed", prepared: true, identity: { kind: "unsupported", endpoint: "https://secret.example" } }), "unsupported");
  assert.equal(projectNextRemoteReadiness({ lastRewriterAsserted: true, calibration: "passed", prepared: true, identity: { kind: "supported", protocol: "codex_compaction_trigger_v2" } }), "ready");
  assert.equal(footerCompactionStatus(COMPACTION_METHOD_LABELS.none), undefined);
  assert.equal(footerCompactionStatus(COMPACTION_METHOD_LABELS.native), "Compaction: Pi local");
  assert.equal(footerCompactionStatus(COMPACTION_METHOD_LABELS.codex), "Compaction: Codex remote v2");
  assert.equal(footerCompactionStatus("local fallback (timeout)"), "Compaction: Pi local fallback (timeout)");
  assert.equal(describeRemoteRoute({ surface: "chatgpt_codex", protocol: "codex_compaction_trigger_v2", endpoint: "https://secret.example" }), "ChatGPT Codex / codex_compaction_trigger_v2");
});

test("TUI status refreshes from the active branch and status command is RPC-safe", async () => {
  const handlers = new Map(); let command;
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (_name, value) => { command = value; } };
  createServerCompactionController(pi, { lastRewriterAsserted: true, installWrappers: () => [] });
  let branch = [remote("codex_compaction_trigger_v2")];
  const statuses = []; const notices = [];
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { setStatus: (...args) => statuses.push(args), notify: (...args) => notices.push(args) } };

  await handlers.get("session_start")({}, ctx);
  assert.deepEqual(statuses.at(-1), ["pi-openai-blackmagic-compact", "Compaction: Codex remote v2"]);
  await command.handler("status", ctx);
  assert.match(notices.at(-1)[0], /^Active branch: remote ChatGPT Codex \(codex_compaction_trigger_v2\)\n/);
  assert.match(notices.at(-1)[0], /Route\/protocol: ChatGPT Codex \/ codex_compaction_trigger_v2/);
  assert.match(notices.at(-1)[0], /Guaranteed fallback: Pi native local summary\./);

  branch = [{ type: "compaction", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } }];
  handlers.get("session_tree")({}, ctx);
  assert.deepEqual(statuses.at(-1), ["pi-openai-blackmagic-compact", "Compaction: Pi local fallback (timeout)"]);

  branch = [];
  handlers.get("session_compact")({}, ctx);
  assert.deepEqual(statuses.at(-1), ["pi-openai-blackmagic-compact", undefined]);

  await command.handler("status", ctx);
  assert.equal(notices.at(-1)[0], [
    "Active branch: no active compaction",
    "Next /compact: Pi local fallback — calibration has not passed yet (calibration_unverified)",
    "Calibration: not yet verified",
    "Load-last assertion: asserted",
    "Wrappers: 0 installed",
    "Guaranteed fallback: Pi native local summary.",
    "Privacy: no prompts, tools, credentials, endpoints, deployments, opaque artifacts, hashes, or item counts.",
  ].join("\n"));
  await command.handler("status", { sessionManager: { getBranch: () => [remote()] }, hasUI: false, ui: {} });
});
