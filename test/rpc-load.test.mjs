import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("Pi 0.83 RPC loader resolves the extension from an unrelated working directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-openai-blackmagic-compact-rpc-"));
  try {
    const executable = process.platform === "win32" ? "pi.cmd" : "pi";
    const input = '{"id":"commands","type":"get_commands"}\n{"id":"disable","type":"prompt","message":"/blackmagic disable"}\n{"id":"status","type":"prompt","message":"/blackmagic status"}\n';
    const result = spawnSync(executable, ["--mode", "rpc", "--session-id", "controls", "--session-dir", join(cwd, "sessions"), "--no-extensions", "-e", join(root, "src", "extension.mjs")], {
      cwd,
      input,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") },
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"name":"blackmagic"/);
    assert.match(result.stdout, /status, enable, or disable/);
    assert.doesNotMatch(result.stdout, /server-compact|blackmagic-status/);
    assert.match(result.stdout, /persisted replay remains active/);
    assert.match(result.stdout, /"id":"status"[^\n]*"success":true/);
    assert.doesNotMatch(result.stderr, /Failed to load extension|Cannot find module/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
