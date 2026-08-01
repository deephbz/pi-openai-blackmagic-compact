import test from "node:test";
import assert from "node:assert/strict";
import { checkpointDetails, sha256 } from "../src/contract.mjs";
import { createServerCompactionController } from "../src/controller.mjs";

test("blackmagic status uses human meaning and omits machine records", async () => {
  const handlers = new Map(); let command; let commandName;
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, value) => { commandName = name; command = value; } };
  createServerCompactionController(pi);
  const identity = { surface: "openai_api", protocol: "responses_compact_v1", endpoint: "https://api.openai.com/v1", model: "gpt-5", api: "openai-responses" };
  const details = checkpointDetails({ identity, opaqueWindow: [{ type: "compaction", encrypted_content: "opaque" }] });
  details.replay = { namespace: "pi-openai-blackmagic-compact/1", replacedItemHashes: [sha256({ role: "user", content: "old" })] };
  const notices = [];
  const ctx = {
    hasUI: true,
    model: { provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1", api: "openai-responses" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-key" }) },
    sessionManager: { getBranch: () => [{ type: "compaction", details }] },
    ui: { notify: (...args) => notices.push(args) },
  };
  await command.handler("status", ctx);
  assert.equal(commandName, "blackmagic");
  assert.equal(notices.at(-1)[0], "History: Server-side compacted and available.\nAction: Keep this model and provider.\nNext /compact: Server-side compaction.");
  assert.doesNotMatch(notices.at(-1)[0], /privacy|protocol|endpoint|deployment|artifact|hash|item count|v\d|BLACKMAGIC_READY/i);
  await command.handler("help", ctx);
  assert.match(notices.at(-1)[0], /^Usage: \/blackmagic/);
  assert.deepEqual(command.getArgumentCompletions("st"), [{ value: "status", label: "status", description: "Show current compaction status" }]);
});
