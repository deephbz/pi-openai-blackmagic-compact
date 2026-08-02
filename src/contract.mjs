import { createHash } from "node:crypto";

export const BLACKMAGIC_DETAILS_TYPE = "pi-openai-blackmagic-compact";
const OFFICIAL_OPENAI = new Set(["api.openai.com"]);
const CODEX_HOSTS = new Set(["chatgpt.com", "chatgpt.com:443"]);

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function latestActiveCompaction(branch) {
  for (const entry of [...(branch ?? [])].reverse()) if (entry?.type === "compaction") return entry;
}

function safeUrl(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
}

export function identifySurface({ provider, baseUrl, api, model, deployment }) {
  let url;
  try { url = new URL(baseUrl); } catch { return { kind: "unsupported" }; }
  const host = url.host.toLowerCase();
  const pathname = url.pathname.replace(/\/$/, "");
  if (provider === "openai" && api === "openai-responses" && OFFICIAL_OPENAI.has(host) && (pathname === "/v1" || pathname === "")) {
    return { kind: "supported", surface: "openai_api", endpoint: safeUrl(baseUrl), model };
  }
  if (provider === "azure-openai-responses" && api === "azure-openai-responses" && host.endsWith(".openai.azure.com") && pathname === "/openai/v1" && typeof deployment === "string" && deployment) {
    return { kind: "supported", surface: "azure_openai", endpoint: safeUrl(baseUrl), model, deployment };
  }
  if (provider === "openai-codex" && api === "openai-codex-responses" && CODEX_HOSTS.has(host) && pathname === "/backend-api") {
    return { kind: "supported", surface: "chatgpt_codex", endpoint: safeUrl(baseUrl), model };
  }
  return { kind: "unsupported" };
}

export function sameProvider(stored, selected) {
  return stored?.surface === selected?.surface && stored?.endpoint === selected?.endpoint;
}

function validProvider(provider) {
  return provider && ["openai_api", "azure_openai", "chatgpt_codex"].includes(provider.surface) && typeof provider.endpoint === "string" && provider.endpoint;
}

function validProviderWindow(input) {
  if (!Array.isArray(input) || input.length === 0) return false;
  const compactions = input.filter((item) => item?.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content);
  return compactions.length === 1;
}

export function createCheckpoint({ provider, input, replacedItemHashes }) {
  if (!validProvider(provider)) throw new TypeError("supported provider required");
  if (!validProviderWindow(input)) throw new TypeError("provider compaction window required");
  if (!Array.isArray(replacedItemHashes) || replacedItemHashes.length === 0 || replacedItemHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new TypeError("replay segment hashes required");
  }
  return {
    type: BLACKMAGIC_DETAILS_TYPE,
    provider: { surface: provider.surface, endpoint: provider.endpoint },
    input,
    replacedItemHashes,
  };
}

export function readCheckpoint(entry) {
  const details = entry?.details;
  if (entry?.type !== "compaction" || entry.summary !== "" || details?.type !== BLACKMAGIC_DETAILS_TYPE) return undefined;
  if (!validProvider(details.provider) || !validProviderWindow(details.input)) return undefined;
  if (!Array.isArray(details.replacedItemHashes) || details.replacedItemHashes.length === 0 || details.replacedItemHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) return undefined;
  return { entry, details };
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
