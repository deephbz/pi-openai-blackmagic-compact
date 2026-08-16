import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const peers = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];
const supportedPiPeerRange = ">=0.83.0";

test("package and lock keep all Pi peers unbounded from 0.83.0", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json")));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json")));
  for (const peer of peers) {
    assert.equal(pkg.peerDependencies?.[peer], supportedPiPeerRange);
    assert.equal(lock.packages?.[""]?.peerDependencies?.[peer], supportedPiPeerRange);
  }
});
