import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CompactionSummaryMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { BLACKMAGIC_COMPACTION_MARKER, BLACKMAGIC_READY, COMPACTION_DECISION, COMPACTION_OUTCOME, CONTINUATION_REPLAY, PROVIDER_MISMATCH, STATE_MACHINE, SUMMARY_STAYS_READABLE, classifyContinuation, continuationFooter, decideCompaction, projectBlackmagicStatus } from "../src/state-machine.mjs";

test("the executable machine exports its exact states and complete 3x3 transitions", () => {
  assert.deepEqual(STATE_MACHINE.states.map((state) => state.name), [SUMMARY_STAYS_READABLE, BLACKMAGIC_READY, PROVIDER_MISMATCH]);
  assert.equal(STATE_MACHINE.transitions.length, 9);
  const pairs = new Set(STATE_MACHINE.transitions.map(({ source, target }) => `${source}:${target}`));
  assert.deepEqual(pairs, new Set(["summary:summary", "summary:ready", "summary:mismatch", "ready:summary", "ready:ready", "ready:mismatch", "mismatch:summary", "mismatch:ready", "mismatch:mismatch"]));
  assert.equal(BLACKMAGIC_COMPACTION_MARKER, "Server-side compaction applied. Keep this model and provider to use the compacted History.");
  assert.equal(continuationFooter(SUMMARY_STAYS_READABLE), undefined);
  assert.match(continuationFooter(BLACKMAGIC_READY), /keep this model and provider/);
  assert.match(continuationFooter(PROVIDER_MISMATCH), /switch back or use \/tree/);
});

test("human status projects only current meaning and the next action", () => {
  assert.equal(projectBlackmagicStatus({ state: SUMMARY_STAYS_READABLE }), "History: Readable.\nNext /compact: Pi compaction.");
  assert.equal(projectBlackmagicStatus({ state: BLACKMAGIC_READY, serverCompactionAvailable: true }), "History: Server-side compacted and available.\nAction: Keep this model and provider.\nNext /compact: Server-side compaction.");
  assert.match(projectBlackmagicStatus({ state: PROVIDER_MISMATCH }), /Switch back, or select a readable point with \/tree/);
  assert.doesNotMatch(projectBlackmagicStatus({ state: BLACKMAGIC_READY }), /protocol|endpoint|artifact|hash|v\d|BLACKMAGIC_READY/i);
});

test("Pi's native compaction component shows the Blackmagic marker when expanded", () => {
  initTheme("dark");
  const component = new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: BLACKMAGIC_COMPACTION_MARKER, tokensBefore: 52161, timestamp: Date.now() });
  const plain = () => component.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain(), /\[compaction\]/);
  assert.match(plain(), /Compacted from 52,161 tokens/);
  assert.doesNotMatch(plain(), /Server-side compaction applied/);
  component.setExpanded(true);
  assert.match(plain(), /Server-side compaction applied\. Keep this model and provider/);
});

test("continuation classification is pure and distinguishes readable, usable, and failed replay", () => {
  const input = Object.freeze({ opaqueHistory: true, routeMatches: true, replay: CONTINUATION_REPLAY.SUCCEEDED });
  assert.equal(classifyContinuation(), SUMMARY_STAYS_READABLE);
  assert.equal(classifyContinuation(input), BLACKMAGIC_READY);
  assert.equal(classifyContinuation({ ...input, routeMatches: false }), PROVIDER_MISMATCH);
  assert.equal(classifyContinuation({ ...input, replay: CONTINUATION_REPLAY.FAILED }), PROVIDER_MISMATCH);
  assert.equal(input.replay, CONTINUATION_REPLAY.SUCCEEDED);
});

test("compaction decisions delegate, attempt, cancel, or apply without side effects", () => {
  assert.equal(decideCompaction().kind, COMPACTION_DECISION.DELEGATE);
  assert.equal(decideCompaction({ routeSupported: true, authorized: false }).kind, COMPACTION_DECISION.DELEGATE);
  assert.equal(decideCompaction({ routeSupported: true, authorized: true }).kind, COMPACTION_DECISION.ATTEMPT);
  assert.deepEqual(decideCompaction({ routeSupported: true, authorized: true, outcome: COMPACTION_OUTCOME.FAILED, failureClass: "remote_error" }), { kind: COMPACTION_DECISION.CANCEL, failureClass: "remote_error" });
  const compaction = { summary: BLACKMAGIC_COMPACTION_MARKER };
  assert.deepEqual(decideCompaction({ routeSupported: true, authorized: true, outcome: COMPACTION_OUTCOME.SUCCEEDED, compaction }), { kind: COMPACTION_DECISION.APPLY, compaction });
});

test("generated HTML is an exact marked rendering of code authority", () => {
  execFileSync(process.execPath, ["scripts/generate-state-machine-html.mjs", "--check"], { cwd: new URL("..", import.meta.url) });
  const html = readFileSync(new URL("../docs/design/compaction-state-machine.html", import.meta.url), "utf8");
  assert.match(html, /^<!-- GENERATED FILE — DO NOT EDIT\./);
  const encoded = html.match(/<script id="machine-data" type="application\/json">\n([\s\S]*?)\n<\/script>/)?.[1];
  assert.deepEqual(JSON.parse(encoded), STATE_MACHINE);
});
