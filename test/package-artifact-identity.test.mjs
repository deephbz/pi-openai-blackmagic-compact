import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const verifier = join(root, "scripts/verify-package.mjs");

function syntheticTarball(field, value) {
  const work = mkdtempSync(join(tmpdir(), "blackmagic-artifact-test-"));
  const packageDir = join(work, "package");
  execFileSync("mkdir", ["-p", packageDir]);
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson[field] = value;
  writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(packageJson)}\n`);
  const tarball = join(work, `${field}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", work, "package"]);
  return { work, tarball };
}

function runVerifier(tarball) {
  return spawnSync(process.execPath, [verifier], {
    cwd: root,
    env: { ...process.env, RELEASE_TARBALL: tarball },
    encoding: "utf8",
  });
}

test("rejects packed name and version changes against selected source", () => {
  for (const [field, value] of [["name", "invalid-name"], ["version", "0.0.0-invalid-test"]]) {
    const fixture = syntheticTarball(field, value);
    try {
      const result = runVerifier(fixture.tarball);
      assert.notEqual(result.status, 0, `${field} mutation was accepted`);
      assert.match(`${result.stdout}\n${result.stderr}`, /packed package (name|version) differs from selected source/);
    } finally {
      rmSync(fixture.work, { recursive: true, force: true });
    }
  }
});

test("accepts the normal packed artifact", () => {
  const filename = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0].filename;
  const tarball = join(root, filename);
  try {
    const result = runVerifier(tarball);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(tarball, { force: true });
  }
});
