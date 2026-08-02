import test from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, replaceOneHashSegment, sha256 } from "../src/contract.mjs";

test("persisted-compaction-style segment replaces once on descendant context and is absent before checkpoint", () => {
  const session = SessionManager.inMemory("/tmp");
  const first = session.appendMessage({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer" }], api: "openai-responses", provider: "openai", model: "gpt-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  session.appendCompaction("summary", first, 2, {});
  const segment = session.buildSessionContext().messages.map((message) => ({ role: message.role, content: message.content }));
  const hashes = segment.map(sha256); const later = [...segment, { role: "user", content: [{ type: "text", text: "later" }] }];
  assert.deepEqual(replaceOneHashSegment(later, hashes, [{ type: "compaction", encrypted_content: "opaque" }]), [{ type: "compaction", encrypted_content: "opaque" }, { role: "user", content: [{ type: "text", text: "later" }] }]);
  assert.equal(replaceOneHashSegment([{ role: "user", content: [{ type: "text", text: "old" }] }], hashes, [{ type: "compaction" }]), undefined);
});

test("filesystem SessionManager survives reopen and fork with one compaction artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "hc-compaction-")); const sessions = join(root, "sessions");
  try {
    await mkdir(sessions, { recursive: true });
    const session = SessionManager.create(root, sessions); const first = session.appendMessage({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-responses", provider: "openai", model: "gpt-5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
    const details = createCheckpoint({
      provider: { surface: "openai_api", endpoint: "https://api.openai.com/v1" },
      input: [{ type: "compaction", encrypted_content: "opaque" }],
      replacedItemHashes: [sha256({ role: "user", content: "placeholder" })],
    });
    session.appendCompaction("", first, 1, details);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const file = session.getSessionFile();
    const persisted = await readFile(file, "utf8");
    assert.equal((persisted.match(/encrypted_content/g) ?? []).length, 1);
    const reopened = SessionManager.open(file, sessions, root);
    assert.equal(reopened.getBranch().filter((entry) => entry.type === "compaction").length, 1);
    assert.deepEqual(reopened.getBranch().find((entry) => entry.type === "compaction")?.details, details);
    const fork = SessionManager.forkFrom(file, join(root, "fork"), sessions);
    assert.ok(fork.getBranch().some((entry) => entry.type === "compaction"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
