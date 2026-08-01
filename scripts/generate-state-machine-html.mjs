import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { STATE_MACHINE } from "../src/state-machine.mjs";

const templateUrl = new URL("../docs/design/compaction-state-machine.template.html", import.meta.url);
const outputUrl = new URL("../docs/design/compaction-state-machine.html", import.meta.url);
const token = "{{MACHINE_JSON}}";
const marker = "<!-- GENERATED FILE — DO NOT EDIT. Run npm run generate:state-machine. -->\n";
const template = await readFile(templateUrl, "utf8");
if ((template.match(/\{\{MACHINE_JSON\}\}/g) ?? []).length !== 1) throw new Error("state-machine template must contain exactly one machine token");
const generated = marker + template.replace(token, JSON.stringify(STATE_MACHINE, null, 2));
if (process.argv.includes("--check")) {
  const current = await readFile(outputUrl, "utf8").catch(() => "");
  if (current !== generated) throw new Error("generated state-machine HTML has drifted; run npm run generate:state-machine");
} else {
  await writeFile(outputUrl, generated);
}
