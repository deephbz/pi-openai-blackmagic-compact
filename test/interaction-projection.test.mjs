import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpoint, sha256 } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

test("blackmagic status uses human meaning and omits machine records", async () => {
  const handlers = new Map(); let command; let commandName;
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => { commandName = name; command = value; } };
  createServerCompactionController(pi);
  const details = createCheckpoint({
    provider: { surface: "openai_api", endpoint: "https://api.openai.com/v1" },
    input: [{ type: "compaction", encrypted_content: "opaque" }],
    replacedItemHashes: [sha256({ role: "user", content: "old" })],
  });
  const notices = [];
  const ctx = {
    hasUI: true,
    model: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-key" }) },
    sessionManager: { getBranch: () => [{ type: "compaction", summary: "", details }] },
    ui: { notify: (...args) => notices.push(args) },
  };
  await command.handler("status", ctx);
  assert.equal(commandName, "blackmagic");
  assert.equal(notices.at(-1)[0], "History: Server-side compacted and available.\nAction: Keep this provider.\nNext /compact: Server-side compaction.");
  assert.doesNotMatch(notices.at(-1)[0], /privacy|protocol|endpoint|deployment|artifact|hash|item count|v\d|BLACKMAGIC_READY/i);
  await command.handler("help", ctx);
  assert.match(notices.at(-1)[0], /^Usage: \/blackmagic/);
  assert.deepEqual(command.getArgumentCompletions("st"), [{ value: "status", label: "status", description: "Show current compaction status" }]);
});
