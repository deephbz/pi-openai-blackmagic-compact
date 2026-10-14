import * as module from 'node:module';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';

// Install the filesystem and dependency boundaries before importing Pi.
export const home = mkdtempSync(join(tmpdir(), 'blackmagic-sim-'));
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = join(home, 'agent');
if (process.env.PI_SIM_ROOT) {
  const require = createRequire(join(resolve(process.env.PI_SIM_ROOT), '..', 'package.json'));
  if (!module.registerHooks) throw new Error('Alternate Pi roots require Node 22.15 or later');
  module.registerHooks({ resolve(specifier, context, next) {
    if (/^@earendil-works\/pi-(coding-agent|ai|tui|agent-core)(\/|$)/.test(specifier)) {
      return next(require.resolve(specifier), context);
    }
    return next(specifier, context);
  } });
}
let entropy;
let now = 0;
let scheduled = [];
let timerId = 0;
export function installTimers() {
  const original = { setTimeout, clearTimeout, setInterval, clearInterval };
  scheduled = [];
  timerId = 0;
  const schedule = (callback, delay = 0, ...args) => {
    const timer = { id: ++timerId, at: now + Math.max(0, delay), callback: () => callback(...args), unref() { return this; }, ref() { return this; } };
    scheduled.push(timer);
    return timer;
  };
  globalThis.setTimeout = schedule;
  globalThis.clearTimeout = (timer) => { scheduled = scheduled.filter((entry) => entry !== timer); };
  globalThis.setInterval = () => { throw new Error('sim does not support interval work'); };
  globalThis.clearInterval = globalThis.clearTimeout;
  return () => { Object.assign(globalThis, original); scheduled = []; };
}
export class Entropy {
  constructor(seed) { this.state = seed >>> 0 || 1; this.choices = []; }
  draw(bound) {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    const value = this.state % bound;
    this.choices.push({ bound, value });
    return value;
  }
}
export function reset(seed) { entropy = new Entropy(seed); now = 1700000000000; return entropy; }
export function advance(ms) {
  const target = now + ms;
  let steps = 0;
  while (true) {
    scheduled.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = scheduled[0];
    if (!next || next.at > target) break;
    if (++steps > 10000) throw new Error('sim timer livelock');
    scheduled.shift();
    now = next.at;
    next.callback();
  }
  now = target;
}
const HostDate = Date;
globalThis.Date = class extends HostDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};
Math.random = () => entropy.draw(0x100000000) / 0x100000000;
crypto.randomUUID = () => {
  const hex = Array.from({ length: 4 }, () => entropy.draw(0x100000000).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
};
module.syncBuiltinESMExports();
reset(1);
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
