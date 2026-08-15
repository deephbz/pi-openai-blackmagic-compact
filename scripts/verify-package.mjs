import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const expected = {
  name: "@hypercarrier/pi-openai-blackmagic-compact",
  version: "0.1.0-rc.7",
  repository: "git+https://github.com/deephbz/pi-openai-blackmagic-compact.git",
  homepage: "https://github.com/deephbz/pi-openai-blackmagic-compact#readme",
  bugs: "https://github.com/deephbz/pi-openai-blackmagic-compact/issues",
  author: "Mark Burggraf",
};
for (const [field, value] of Object.entries(expected)) {
  const actual = field === "repository" ? pkg.repository?.url : field === "bugs" ? pkg.bugs?.url : pkg[field];
  if (actual !== value) throw new Error(`package ${field} must be ${value}`);
}
if (pkg.publishConfig?.access !== "public") throw new Error("package must publish with public access");
if (!pkg.pi?.extensions?.includes("./src/extension.mjs")) throw new Error("Pi extension manifest missing");
if (JSON.stringify(pkg.exports) !== JSON.stringify({ ".": "./src/extension.mjs" })) throw new Error("package must expose only the Pi extension entry point");
if (pkg.dependencies?.["@earendil-works/pi-coding-agent"] || pkg.dependencies?.["@earendil-works/pi-tui"]) throw new Error("Pi runtime must stay a peer dependency");
const supportedPiPeerRange = ">=0.83.0 <0.85.0";
for (const dependency of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
  if (pkg.peerDependencies?.[dependency] !== supportedPiPeerRange) throw new Error(`${dependency} must declare the verified Pi peer range`);
}

const packed = new Set(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))[0].files.map((file) => file.path));
const allowed = new Set([
  "LICENSE", "README.md", "package.json", "docs/current/README.md", "scripts/verify-package.mjs",
  "src/adapters.mjs", "src/contract.mjs", "src/controller.mjs", "src/extension.mjs",
]);
const sourceOnly = new Set([
  "release/privacy-lineage.v1.json",
  "release/tools/git-privacy-scan.py",
  "scripts/sanitize-review-history.py",
]);
for (const file of packed) if (!allowed.has(file)) throw new Error(`package contains unapproved file: ${file}`);
for (const file of allowed) if (!packed.has(file)) throw new Error(`package omits required file: ${file}`);
for (const file of sourceOnly) if (packed.has(file)) throw new Error(`package contains source-only release record: ${file}`);
for (const file of packed) if (/hc-openai-server-compaction|(^|\/)test(\/|$)|package-lock\.json/.test(file)) throw new Error(`package contains forbidden boundary: ${file}`);
console.log("package verification passed");
