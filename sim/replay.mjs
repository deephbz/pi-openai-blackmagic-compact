import './bootstrap.mjs';
import { readFileSync } from 'node:fs';
import { run, violations } from './world.mjs';

const path = process.argv[2];
if (!path) throw new Error('Usage: node sim/replay.mjs scenario.json');
const scenario = JSON.parse(readFileSync(path, 'utf8'));
const trace = await run(scenario.seed, scenario.actions, scenario);
console.log(JSON.stringify({ ...trace, violations: violations(trace), speedRatio: trace.virtualMs / trace.wallMs }, null, 2));
process.exitCode = violations(trace).length ? 1 : 0;
