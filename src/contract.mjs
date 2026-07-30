import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;
export const SURFACES = Object.freeze(["openai_api", "azure_openai", "chatgpt_codex"]);
export const PROTOCOLS = Object.freeze({
  openai_api: "responses_compact_v1",
  azure_openai: "responses_compact_v1",
  chatgpt_codex: "codex_compaction_trigger_v2",
});
export const TELEMETRY_EVENTS = Object.freeze([
  "remote_applied", "remote_replayed", "remote_invalidated", "unsupported_surface", "local_fallback", "prepared_state_unavailable", "auxiliary_call_ignored",
]);
export const COMPACTION_METHOD_LABELS = Object.freeze({
  none: "no active compaction",
  native: "Pi-native local summary",
  codex: "remote ChatGPT Codex (codex_compaction_trigger_v2)",
  responses: "remote OpenAI/Azure (responses_compact_v1)",
  replay: "remote replay",
  invalidated: "remote invalidated",
  unsupported: "unsupported surface",
});

const SAFE_FAILURE_CLASSES = new Set([
  "auth", "auth_unavailable", "callback_error", "calibration_mismatch", "calibration_unverified", "capture_stale", "capture_unverified", "duplicate_provider_callback",
  "identity_or_auth", "missing_or_malformed_correlation", "model_or_protocol", "native_tail_unverified",
  "post_compaction_segment_unavailable", "remote_error", "timeout", "tail_or_fence_mismatch", "tail_calibration_mismatch",
]);
const OFFICIAL_OPENAI = new Set(["api.openai.com"]);
const CODEX_HOSTS = new Set(["chatgpt.com", "chatgpt.com:443"]);

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
export function latestActiveCompaction(branch) {
  for (const entry of [...(branch ?? [])].reverse()) if (entry?.type === "compaction") return entry;
}
/** A redacted projection of the latest active-branch Pi CompactionEntry. */
export function projectCompactionMethod(branch) {
  const entry = latestActiveCompaction(branch);
  if (!entry) return COMPACTION_METHOD_LABELS.none;
  const details = entry.details;
  if (!details || typeof details !== "object" || details.schemaVersion !== SCHEMA_VERSION) return COMPACTION_METHOD_LABELS.native;
  if (details.state === "remote_applied") return details.identity?.protocol === PROTOCOLS.chatgpt_codex ? COMPACTION_METHOD_LABELS.codex : details.identity?.protocol === PROTOCOLS.openai_api ? COMPACTION_METHOD_LABELS.responses : COMPACTION_METHOD_LABELS.unsupported;
  if (details.state === "remote_replayed") return COMPACTION_METHOD_LABELS.replay;
  if (details.state === "remote_invalidated") return COMPACTION_METHOD_LABELS.invalidated;
  if (details.state === "unsupported_surface") return COMPACTION_METHOD_LABELS.unsupported;
  if (details.state === "local_fallback") return `local fallback (${SAFE_FAILURE_CLASSES.has(details.failureClass) ? details.failureClass : "unclassified"})`;
  return COMPACTION_METHOD_LABELS.unsupported;
}
/** A redacted projection of ephemeral conditions required for the next remote compaction. */
export function projectNextRemoteReadiness({ prepared, calibration, lastRewriterAsserted, identity } = {}) {
  if (identity?.kind === "unsupported") return "unsupported";
  if (!lastRewriterAsserted) return "capture_unverified";
  if (calibration === "passed" && prepared && identity?.kind === "supported") return "ready";
  return calibration === "mismatch" ? "calibration_mismatch" : "calibration_unverified";
}
export function footerCompactionStatus(method) {
  if (method === COMPACTION_METHOD_LABELS.none) return undefined;
  if (method === COMPACTION_METHOD_LABELS.native) return "Compaction: Pi local";
  if (method === COMPACTION_METHOD_LABELS.codex) return "Compaction: Codex remote v2";
  if (method === COMPACTION_METHOD_LABELS.responses) return "Compaction: OpenAI/Azure remote v1";
  if (method === COMPACTION_METHOD_LABELS.replay) return "Compaction: remote replay";
  if (method === COMPACTION_METHOD_LABELS.invalidated) return "Compaction: remote invalidated";
  if (method === COMPACTION_METHOD_LABELS.unsupported) return "Compaction: unsupported surface";
  return `Compaction: Pi ${method}`;
}
export function describeRemoteRoute(identity) {
  if (identity?.surface === "chatgpt_codex" && identity?.protocol === PROTOCOLS.chatgpt_codex) return "ChatGPT Codex / codex_compaction_trigger_v2";
  if (identity?.surface === "openai_api" && identity?.protocol === PROTOCOLS.openai_api) return "OpenAI Responses / responses_compact_v1";
  if (identity?.surface === "azure_openai" && identity?.protocol === PROTOCOLS.azure_openai) return "Azure OpenAI Responses / responses_compact_v1";
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
  const { identity, usage, latencyMs, failureClass, retention, checkpoint } = data;
  return { type, surface: identity?.surface, protocol: identity?.protocol, model: identity?.model, usage: safeUsage(usage), latencyMs, failureClass, retention, artifactHash: checkpoint?.hash, artifactLength: checkpoint?.length };
}
