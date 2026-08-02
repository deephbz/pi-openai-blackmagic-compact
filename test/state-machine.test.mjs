import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CompactionSummaryMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { BLACKMAGIC_APPLIED_NOTICE, BLACKMAGIC_MODEL_SUMMARY, BLACKMAGIC_READY, PROVIDER_MISMATCH, STATE_MACHINE, SUMMARY_STAYS_READABLE, classifyContinuation, continuationFooter, projectBlackmagicStatus } from "../src/state-machine.mjs";

test("the executable machine owns three states and all transitions", () => {
  assert.deepEqual(STATE_MACHINE.states.map((state) => state.name), [SUMMARY_STAYS_READABLE, BLACKMAGIC_READY, PROVIDER_MISMATCH]);
  assert.equal(STATE_MACHINE.transitions.length, 9);
  assert.deepEqual(
    new Set(STATE_MACHINE.transitions.map(({ source, target }) => `${source}:${target}`)),
    new Set(["summary:summary", "summary:ready", "summary:mismatch", "ready:summary", "ready:ready", "ready:mismatch", "mismatch:summary", "mismatch:ready", "mismatch:mismatch"]),
  );
  assert.equal(BLACKMAGIC_MODEL_SUMMARY, "");
  assert.equal(BLACKMAGIC_APPLIED_NOTICE, "Server-side compaction applied. Keep this provider.");
  assert.equal(continuationFooter(SUMMARY_STAYS_READABLE), undefined);
  assert.match(continuationFooter(BLACKMAGIC_READY), /keep this provider/);
  assert.match(continuationFooter(PROVIDER_MISMATCH), /switch back or use \/tree/);
});

test("human status exposes only current meaning and next action", () => {
  assert.equal(projectBlackmagicStatus({ state: SUMMARY_STAYS_READABLE }), "History: Readable.\nNext /compact: Pi compaction.");
  assert.equal(projectBlackmagicStatus({ state: BLACKMAGIC_READY, serverCompactionAvailable: true }), "History: Server-side compacted and available.\nAction: Keep this provider.\nNext /compact: Server-side compaction.");
  assert.match(projectBlackmagicStatus({ state: PROVIDER_MISMATCH }), /Switch back, or select a readable point with \/tree/);
  assert.doesNotMatch(projectBlackmagicStatus({ state: BLACKMAGIC_READY }), /protocol|endpoint|artifact|hash|model|BLACKMAGIC_READY/i);
});

test("Pi's compaction component receives no human-only advice", () => {
  initTheme("dark");
  const component = new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: BLACKMAGIC_MODEL_SUMMARY, tokensBefore: 52161, timestamp: Date.now() });
  const plain = () => component.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain(), /\[compaction\]/);
  assert.match(plain(), /Compacted from 52,161 tokens/);
  assert.doesNotMatch(plain(), /Server-side compaction applied|Keep this provider/);
  component.setExpanded(true);
  assert.doesNotMatch(plain(), /Server-side compaction applied|Keep this provider/);
});

test("continuation classification depends only on History and provider compatibility", () => {
  assert.equal(classifyContinuation(), SUMMARY_STAYS_READABLE);
  assert.equal(classifyContinuation({ blackmagicHistory: true, providerMatches: true }), BLACKMAGIC_READY);
  assert.equal(classifyContinuation({ blackmagicHistory: true, providerMatches: false }), PROVIDER_MISMATCH);
  assert.equal(classifyContinuation({ blackmagicHistory: true, providerMatches: true, replayFailed: true }), PROVIDER_MISMATCH);
});

test("generated HTML is an exact rendering of code authority", () => {
  execFileSync(process.execPath, ["scripts/generate-state-machine-html.mjs", "--check"], { cwd: new URL("..", import.meta.url) });
  const html = readFileSync(new URL("../docs/design/compaction-state-machine.html", import.meta.url), "utf8");
  const encoded = html.match(/<script id="machine-data" type="application\/json">\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.deepEqual(JSON.parse(encoded), STATE_MACHINE);
});
