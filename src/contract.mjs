import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;
export const SURFACES = Object.freeze(["openai_api", "azure_openai", "chatgpt_codex"]);
export const PROTOCOLS = Object.freeze({
  openai_api: "responses_compact_v1",
  azure_openai: "responses_compact_v1",
  chatgpt_codex: "codex_compaction_trigger_v2",
});
export const TELEMETRY_EVENTS = Object.freeze([
  "remote_applied", "remote_replayed", "remote_invalidated", "unsupported_surface", "local_fallback",
]);
const OFFICIAL_OPENAI = new Set(["api.openai.com"]);
const CODEX_HOSTS = new Set(["chatgpt.com", "chatgpt.com:443"]);

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
export function latestActiveCompaction(branch) {
  for (const entry of [...(branch ?? [])].reverse()) if (entry?.type === "compaction") return entry;
}
export function safeUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
}
export function identifySurface({ provider, baseUrl, api, model, deployment }) {
  let url;
  try { url = new URL(baseUrl); } catch { return { kind: "unsupported", reason: "invalid_endpoint" }; }
  const host = url.host.toLowerCase();
  const pathname = url.pathname.replace(/\/$/, "");
  if (provider === "openai" && api === "openai-responses" && OFFICIAL_OPENAI.has(host) && (pathname === "/v1" || pathname === ""))
    return { kind: "supported", surface: "openai_api", protocol: PROTOCOLS.openai_api, endpoint: safeUrl(baseUrl), model, api: api ?? "openai-responses" };
  if (provider === "azure-openai-responses" && api === "azure-openai-responses" && host.endsWith(".openai.azure.com") && pathname === "/openai/v1" && typeof deployment === "string" && deployment)
    return { kind: "supported", surface: "azure_openai", protocol: PROTOCOLS.azure_openai, endpoint: safeUrl(baseUrl), model, deployment, api: api ?? "openai-responses" };
  if (provider === "openai-codex" && api === "openai-codex-responses" && CODEX_HOSTS.has(host) && pathname === "/backend-api")
    return { kind: "supported", surface: "chatgpt_codex", protocol: PROTOCOLS.chatgpt_codex, endpoint: safeUrl(baseUrl), model, api: api ?? "openai-codex-responses" };
  return { kind: "unsupported", reason: "surface_not_allowlisted" };
}
export function identityMatches(checkpoint, identity) {
  return checkpoint?.schemaVersion === SCHEMA_VERSION && checkpoint?.identity?.surface === identity?.surface && checkpoint?.identity?.protocol === identity?.protocol && checkpoint?.identity?.endpoint === identity?.endpoint && checkpoint?.identity?.model === identity?.model && checkpoint?.identity?.deployment === identity?.deployment && checkpoint?.identity?.api === identity?.api;
}
export function checkpointDetails({ identity, opaqueWindow, usage, latencyMs, retention }) {
  if (!Array.isArray(opaqueWindow) || opaqueWindow.length === 0) throw new TypeError("opaque provider window must be non-empty");
  const serialized = JSON.stringify(opaqueWindow);
  return { schemaVersion: SCHEMA_VERSION, state: "remote_applied", identity, checkpoint: { artifact: opaqueWindow, hash: sha256(serialized), length: serialized.length, retention }, usage: safeUsage(usage), latencyMs };
}
export function replaceOneHashSegment(input, hashes, replacement) {
  if (!Array.isArray(input) || !Array.isArray(hashes) || hashes.length === 0 || !Array.isArray(replacement)) return undefined;
  const itemHashes = input.map((item) => sha256(item));
  const matches = [];
  for (let start = 0; start <= itemHashes.length - hashes.length; start += 1) {
    if (hashes.every((hash, index) => itemHashes[start + index] === hash)) matches.push(start);
  }
  if (matches.length !== 1) return undefined;
  const start = matches[0];
  return [...input.slice(0, start), ...replacement, ...input.slice(start + hashes.length)];
}
export function safeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const allow = ["input_tokens", "output_tokens", "total_tokens", "cached_tokens"];
  return Object.fromEntries(allow.filter((key) => Number.isFinite(usage[key])).map((key) => [key, usage[key]]));
}
export function safeTelemetry(type, data = {}) {
  if (!TELEMETRY_EVENTS.includes(type)) throw new TypeError(`unknown telemetry event: ${type}`);
  const { identity, usage, latencyMs, failureClass, retention } = data;
  return { type, surface: identity?.surface, protocol: identity?.protocol, model: identity?.model, usage: safeUsage(usage), latencyMs, failureClass, retention };
}
