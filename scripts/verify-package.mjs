import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const expected = {
  name: "@hypercarrier/pi-openai-blackmagic-compact",
  version: "0.1.0-rc.1",
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
if (pkg.dependencies?.["@earendil-works/pi-coding-agent"]) throw new Error("Pi runtime must stay a peer dependency");

const packed = new Set(JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }))[0].files.map((file) => file.path));
const allowed = new Set([
  "LICENSE", "README.md", "package.json", "config/pi-openai-blackmagic-compact.example.json", "docs/current/README.md", "scripts/verify-package.mjs",
  "src/adapters.mjs", "src/contract.mjs", "src/controller.mjs", "src/extension.mjs", "src/index.mjs", "src/wrappers.mjs",
]);
for (const file of packed) if (!allowed.has(file)) throw new Error(`package contains unapproved file: ${file}`);
for (const file of allowed) if (!packed.has(file)) throw new Error(`package omits required file: ${file}`);
for (const file of packed) if (/hc-openai-server-compaction|(^|\/)test(\/|$)|package-lock\.json/.test(file)) throw new Error(`package contains forbidden boundary: ${file}`);
console.log("package verification passed");
