import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COMPACTION_TIMELINE_ENTRY_TYPE } from "../src/contract.mjs";
import { createServerCompactionController, projectSavedCheckpoint } from "../src/controller.mjs";

const theme = { bg: (_key, text) => text, fg: (_key, text) => text };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { provider: "openai", id: "gpt-5", name: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" };
const userItem = (text) => ({ role: "user", content: [{ type: "input_text", text }] });
const compactionItem = (encrypted) => ({ type: "compaction", encrypted_content: encrypted });

function fakePi() {
  const handlers = new Map();
  const renderers = new Map();
  return {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
    appendEntry() {},
    getActiveTools: () => [],
    getAllTools: () => [],
    handlers,
    renderers,
  };
}

function sessionWithCheckpoint(artifact, extraDetails = {}) {
  const session = SessionManager.inMemory("/tmp");
  const anchor = session.appendMessage({ role: "user", content: [{ type: "text", text: "anchor" }], timestamp: 1 });
  const details = { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact, hash: "synthetic-hash", length: 1, retention: "canonical_provider_window" }, ...extraDetails };
  const id = session.appendCompaction("", anchor, 1, details, true);
  return { session, id };
}

function rendererFor(session) {
  const pi = fakePi();
  createServerCompactionController(pi);
  pi.handlers.get("session_start")({}, { sessionManager: session });
  return pi.renderers.get(COMPACTION_TIMELINE_ENTRY_TYPE);
}

const entryFor = (id) => ({ type: "custom", parentId: id, data: { method: "remote_responses_v1" } });
const lines = (view, width = 100) => view.render(width).join("\n");

test("expanded view shows saved user messages in artifact order and omits non-user items", () => {
  const artifact = [
    { role: "user", content: [{ type: "input_text", text: "first saved" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "assistant-secret" }] },
    { role: "user", content: "second saved" },
    { type: "toolResult", role: "tool", toolName: "probe", content: [{ type: "text", text: "tool-secret" }] },
    { type: "reasoning", encrypted_content: "reasoning-secret" },
    { type: "compaction", encrypted_content: "opaque-prefix" },
  ];
  const { session, id } = sessionWithCheckpoint(artifact);
  assert.deepEqual(projectSavedCheckpoint(session, id).retainedUsers, ["first saved", "second saved"]);

  const out = lines(rendererFor(session)(entryFor(id), { expanded: true }, theme));
  assert.ok(out.indexOf("first saved") < out.indexOf("second saved"));
  for (const secret of ["assistant-secret", "tool-secret", "reasoning-secret"]) assert.doesNotMatch(out, new RegExp(secret));
});

test("expanded view loses no saved user occurrence, including repeats and image-only messages", () => {
  const artifact = [
    userItem("repeat"),
    userItem("repeat"),
    { role: "user", content: [{ type: "input_text", text: "text" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { role: "user", content: [{ type: "image", mimeType: "image/png" }] },
  ];
  const { session, id } = sessionWithCheckpoint(artifact);
  assert.deepEqual(projectSavedCheckpoint(session, id).retainedUsers, ["repeat", "repeat", "text\n[image]", "[image]"]);

  const out = lines(rendererFor(session)(entryFor(id), { expanded: true }, theme));
  assert.equal((out.match(/repeat/g) ?? []).length, 2, "repeated saved occurrences must both render");
  assert.equal((out.match(/\[image\]/g) ?? []).length, 2, "each image-only occurrence must render");
});

test("expanded view shows exactly the first 100 characters of the saved artifact with no suffix", () => {
  const unique = Array.from({ length: 150 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("");
  const expected = unique.slice(0, 100);
  assert.equal(new Set(unique).size, 150, "the prefix fixture must use unique characters");

  const long = sessionWithCheckpoint([userItem("u"), compactionItem(unique)]);
  assert.equal(projectSavedCheckpoint(long.session, long.id).encryptedPrefix, expected);
  assert.equal(projectSavedCheckpoint(long.session, long.id).encryptedPrefix.length, 100);
  assert.equal(projectSavedCheckpoint(long.session, long.id).encryptedPrefix.at(-1), String.fromCodePoint(0x4e63));

  const out = lines(rendererFor(long.session)(entryFor(long.id), { expanded: true }, theme));
  const dense = out.replace(/\s+/g, "");
  assert.ok(dense.includes(expected), "the exact ordered 100-character prefix must render");
  assert.equal(dense.includes(unique.slice(0, 101)), false, "the prefix must not extend past 100 characters");
  assert.equal(dense.includes(String.fromCodePoint(0x4e64)), false, "the 101st saved character must not render");
  assert.doesNotMatch(out, /…|\.\.\./);

  const short = sessionWithCheckpoint([userItem("u"), compactionItem("short-prefix")]);
  assert.equal(projectSavedCheckpoint(short.session, short.id).encryptedPrefix, "short-prefix");
});

test("collapsed view hides the saved artifact and private checkpoint fields", () => {
  const artifact = [userItem("private-user-text"), compactionItem("private-encrypted")];
  const details = { identity: { model: "secret-model", endpoint: "https://secret.example/v1", deployment: "secret-deploy" }, credential: "secret-credential", cwd: "/secret/cwd" };
  const { session, id } = sessionWithCheckpoint(artifact, details);

  const out = lines(rendererFor(session)(entryFor(id), { expanded: false }, theme));
  assert.match(out, /Context saved at this compaction \(expand to view\)/);
  for (const secret of [/private-user-text/, /private-encrypted/, /secret-model/, /secret\.example/, /secret-deploy/, /secret-credential/, /secret\/cwd/]) {
    assert.doesNotMatch(out, secret);
  }
});

test("expanded view exposes only allowlisted artifact fields, not identity or credentials", () => {
  const artifact = [userItem("allowed user text"), compactionItem("opaque-prefix")];
  const details = { identity: { model: "secret-model", endpoint: "https://secret.example/v1", deployment: "secret-deploy" }, credential: "secret-credential", usage: { input_tokens: 12345 }, latencyMs: 987654 };
  const { session, id } = sessionWithCheckpoint(artifact, details);

  const out = lines(rendererFor(session)(entryFor(id), { expanded: true }, theme));
  assert.match(out, /allowed user text/);
  assert.match(out, /opaque-prefix/);
  for (const secret of [/secret-model/, /secret\.example/, /secret-deploy/, /secret-credential/, /12345/, /987654/]) {
    assert.doesNotMatch(out, secret);
  }
});

test("expanded view keeps ordinary line breaks and tabs but neutralizes terminal controls", () => {
  const artifact = [userItem("line1\nline2\ttabbed\u001b[31mred\u0007")];
  const { session, id } = sessionWithCheckpoint(artifact);
  const archive = projectSavedCheckpoint(session, id);
  assert.match(archive.retainedUsers[0], /line1\nline2\ttabbed/);
  assert.doesNotMatch(archive.retainedUsers[0], /\u001b|\u0007/);
  assert.match(archive.retainedUsers[0], /\\x1b/);

  const out = lines(rendererFor(session)(entryFor(id), { expanded: true }, theme));
  assert.match(out, /line1/);
  assert.match(out, /line2/);
  assert.doesNotMatch(out, /\u001b\[31m/);
});

test("expanded view puts the search label and the encrypted prefix on separate lines", () => {
  const { session, id } = sessionWithCheckpoint([userItem("u"), compactionItem("P".repeat(100))]);
  const rendered = rendererFor(session)(entryFor(id), { expanded: true }, theme).render(100);
  const labelIndex = rendered.findIndex((line) => line.includes("Session-log search prefix"));
  const prefixIndex = rendered.findIndex((line) => line.includes("PPPPPPPPPP"));
  assert.ok(labelIndex >= 0, "search label must render");
  assert.ok(prefixIndex > labelIndex, "prefix must render on its own later line");
  assert.doesNotMatch(rendered[labelIndex], /PPPPPPPPPP/);
});

test("each compaction shows only its own saved artifact, including a later compaction", () => {
  const session = SessionManager.inMemory("/tmp");
  const anchor = session.appendMessage({ role: "user", content: [{ type: "text", text: "anchor" }], timestamp: 1 });
  const idA = session.appendCompaction("", anchor, 1, { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: [userItem("gen-A"), compactionItem("enc-A")] } }, true);
  session.appendMessage({ role: "user", content: [{ type: "text", text: "later" }], timestamp: 2 });
  const idB = session.appendCompaction("", anchor, 1, { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: [userItem("gen-B"), compactionItem("enc-B")] } }, true);

  assert.deepEqual(projectSavedCheckpoint(session, idA).retainedUsers, ["gen-A"]);
  assert.deepEqual(projectSavedCheckpoint(session, idB).retainedUsers, ["gen-B"]);
  const renderer = rendererFor(session);
  const outA = lines(renderer(entryFor(idA), { expanded: true }, theme));
  assert.match(outA, /gen-A/);
  assert.doesNotMatch(outA, /gen-B/);
  const outB = lines(renderer(entryFor(idB), { expanded: true }, theme));
  assert.match(outB, /gen-B/);
  assert.doesNotMatch(outB, /gen-A/);
});

test("a fork keeps each compaction's own saved artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-display-"));
  const sessions = join(root, "sessions");
  try {
    await mkdir(sessions, { recursive: true });
    const session = SessionManager.create(root, sessions);
    const anchor = session.appendMessage({ role: "user", content: [{ type: "text", text: "anchor" }], timestamp: 1 });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 2 });
    const idA = session.appendCompaction("", anchor, 1, { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: [userItem("gen-A"), compactionItem("enc-A")] } }, true);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      try { if ((await stat(session.getSessionFile())).size > 0) break; } catch { /* wait for the session file */ }
    }
    const fork = SessionManager.forkFrom(session.getSessionFile(), join(root, "fork"), sessions);

    assert.deepEqual(projectSavedCheckpoint(fork, idA).retainedUsers, ["gen-A"]);
    const forkAnchor = fork.getBranch()[0].id;
    const idB = fork.appendCompaction("", forkAnchor, 1, { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: [userItem("gen-B"), compactionItem("enc-B")] } }, true);
    assert.deepEqual(projectSavedCheckpoint(fork, idA).retainedUsers, ["gen-A"]);
    assert.deepEqual(projectSavedCheckpoint(fork, idB).retainedUsers, ["gen-B"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed or older checkpoint details degrade to the label only", () => {
  const cases = [
    { name: "no details", details: undefined },
    { name: "empty details", details: {} },
    { name: "no checkpoint", details: { schemaVersion: 1, state: "remote_applied" } },
    { name: "artifact not array", details: { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: "opaque" } } },
    { name: "empty artifact", details: { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: [] } } },
    { name: "non-user items only", details: { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: [{ type: "reasoning", encrypted_content: "reasoning-artifact" }] } } },
    { name: "user without content", details: { schemaVersion: 1, state: "remote_applied", checkpoint: { artifact: [{ role: "user" }] } } },
    { name: "legacy local fallback without checkpoint", details: { schemaVersion: 1, state: "local_fallback", failureClass: "timeout" } },
  ];
  for (const scenario of cases) {
    const session = SessionManager.inMemory("/tmp");
    const anchor = session.appendMessage({ role: "user", content: [{ type: "text", text: "anchor" }], timestamp: 1 });
    const id = session.appendCompaction("", anchor, 1, scenario.details, true);
    assert.equal(projectSavedCheckpoint(session, id), undefined, scenario.name);
    const view = rendererFor(session)(entryFor(id), { expanded: true }, theme);
    assert.ok(view, scenario.name);
    assert.match(lines(view), /server compaction/i, scenario.name);
  }
});

test("projection returns undefined for unavailable or malformed session inputs", () => {
  assert.equal(projectSavedCheckpoint(undefined, "x"), undefined);
  assert.equal(projectSavedCheckpoint({ getBranch: () => { throw new Error("synthetic branch failure"); } }, "x"), undefined);
  assert.equal(projectSavedCheckpoint({ getBranch: () => [] }, "x"), undefined);
  assert.equal(projectSavedCheckpoint({ getBranch: () => [] }, undefined), undefined);
  assert.equal(projectSavedCheckpoint({ getBranch: () => [{ id: "x", type: "message" }] }, "x"), undefined);
});

test("rendering does not mutate the session or add model context", () => {
  const artifact = [userItem("saved text"), compactionItem("opaque")];
  const { session, id } = sessionWithCheckpoint(artifact);
  const branchBefore = JSON.stringify(session.getBranch());
  const contextBefore = JSON.stringify(session.buildSessionContext().messages);
  const renderer = rendererFor(session);
  const entry = entryFor(id);
  renderer(entry, { expanded: false }, theme).render(48);
  renderer(entry, { expanded: true }, theme).render(48);

  assert.equal(JSON.stringify(session.getBranch()), branchBefore);
  assert.equal(JSON.stringify(session.buildSessionContext().messages), contextBefore);
  assert.doesNotMatch(contextBefore, /saved text|opaque/);
});

test("expanded view preserves Unicode prose, escapes controls, and stays within realistic terminal widths", () => {
  const prose = "日本語 🚀🎉 e\u0301 עברית \u0007\u001b[31m";
  const { session, id } = sessionWithCheckpoint([userItem(prose), compactionItem("X".repeat(100))]);
  const archive = projectSavedCheckpoint(session, id);
  assert.match(archive.retainedUsers[0], /日本語/);
  assert.match(archive.retainedUsers[0], /🚀🎉/);
  assert.match(archive.retainedUsers[0], /e\u0301/);
  assert.match(archive.retainedUsers[0], /עברית/);
  assert.doesNotMatch(archive.retainedUsers[0], /\u0007|\u001b/);
  assert.match(archive.retainedUsers[0], /\\x07\\x1b/);

  const renderer = rendererFor(session);
  const entry = entryFor(id);
  const spyTheme = { bg: (_key, text) => text, fg: (_key, text) => `\u001b[36m${text}\u001b[0m` };
  for (const width of [20, 40, 48, 120]) {
    for (const expanded of [false, true]) {
      for (const activeTheme of [theme, spyTheme]) {
        const out = renderer(entry, { expanded }, activeTheme).render(width);
        assert.ok(out.every((line) => visibleWidth(line) <= width), `expanded=${expanded} width=${width} must respect the terminal width`);
      }
    }
  }

  const expandedOut = lines(renderer(entry, { expanded: true }, theme));
  assert.match(expandedOut, /日本語/);
  assert.match(expandedOut, /🚀🎉/);
  assert.match(expandedOut, /עברית/);
  assert.doesNotMatch(expandedOut, /\u001b\[31m/);
});