import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BLACKMAGIC_COMPACTION_MARKER, BLACKMAGIC_READY, COMPACTION_DECISION, COMPACTION_OUTCOME, CONTINUATION_REPLAY, PROVIDER_MISMATCH, STATE_MACHINE, SUMMARY_STAYS_READABLE, classifyContinuation, decideCompaction } from "../src/state-machine.mjs";

test("the executable machine exports its exact states and complete 3x3 transitions", () => {
  assert.deepEqual(STATE_MACHINE.states.map((state) => state.name), [SUMMARY_STAYS_READABLE, BLACKMAGIC_READY, PROVIDER_MISMATCH]);
  assert.equal(STATE_MACHINE.transitions.length, 9);
  const pairs = new Set(STATE_MACHINE.transitions.map(({ source, target }) => `${source}:${target}`));
  assert.deepEqual(pairs, new Set(["summary:summary", "summary:ready", "summary:mismatch", "ready:summary", "ready:ready", "ready:mismatch", "mismatch:summary", "mismatch:ready", "mismatch:mismatch"]));
  assert.match(BLACKMAGIC_COMPACTION_MARKER, /Blackmagic compaction checkpoint/);
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
