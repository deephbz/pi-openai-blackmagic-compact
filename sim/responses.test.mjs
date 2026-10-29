import "../test/home.mjs";
import './bootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { run, violations } from './world.mjs';

function check(trace) {
  assert.deepEqual(violations(trace), [], JSON.stringify(trace));
  assert.ok(trace.history.some((entry) => entry.kind === 'request'), 'nonvacuous wire history');
  for (const entry of trace.history.filter((entry) => entry.kind === 'session')) {
    for (const added of entry.entries.slice(entry.before.length)) {
      assert.notEqual(added.message?.stopReason, 'error', added.message?.errorMessage);
    }
  }
}
const stable = ({ wallMs, ...trace }) => trace;

test('B1-B5 bounded fault/reopen/old-Session table', async () => {
  for (const old of [false, true]) {
    for (const failure of ['compact', 'http', 'malformed']) {
      const actions = ['one', 'two', failure, 'three', 'compact', 'four', 'reopen', 'five'];
      check(await run(17, actions, { old }));
    }
  }
});

test('B7 minimized duplicate-system regression', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/duplicate-system.json', import.meta.url), 'utf8'));
  check(await run(fixture.seed, fixture.actions));
});

test('B6 exact seeded replay and virtual/wall speed', async (t) => {
  const actions = ['one', 'two', 'compact', 'three', 'reopen', 'four'];
  for (const seed of [17, 91]) {
    const first = await run(seed, actions);
    const second = await run(seed, actions);
    check(first);
    assert.deepEqual(stable(first), stable(second));
    t.diagnostic(JSON.stringify({ seed, virtualMs: first.virtualMs, wallMs: first.wallMs, speedRatio: first.virtualMs / first.wallMs }));
  }
});

test('two minimal outgoing-request mutants fail named monitors', async (t) => {
  const witnesses = [
    { mutant: 'drop-encrypted', property: 'B2', actions: ['one', 'compact', 'two'] },
    { mutant: 'rotate-key', property: 'B3', actions: ['one', 'two'] },
  ];
  for (const witness of witnesses) {
    check(await run(17, witness.actions));
    const trace = await run(17, witness.actions, witness);
    assert.ok(violations(trace).includes(witness.property), JSON.stringify(trace));
    t.diagnostic(JSON.stringify({ seed: 17, ...witness, violations: violations(trace) }));
  }
});

test('fast-check generated scenarios with shrinking', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 0x7fffffff }),
    fc.array(fc.constantFrom('one', 'two', 'compact', 'http', 'malformed', 'reopen'), { minLength: 0, maxLength: 8 }),
    async (seed, tail) => {
      // A completed user turn before every compact keeps Pi's work-selection
      // precondition independent from the extension's remote-result oracle.
      const actions = ['start'];
      for (const action of tail) {
        if (['compact', 'http', 'malformed'].includes(action)) actions.push('input');
        actions.push(action);
      }
      actions.push('finish');
      check(await run(seed, actions));
    }), { seed: 20261015, numRuns: Number(process.env.PI_SIM_RUNS ?? 30), verbose: true });
});
