import { checkpointDetails, PROTOCOLS } from "./contract.mjs";

function failureClass(error) {
  if (error?.name === "AbortError") return "timeout";
  if (error?.status === 401 || error?.status === 403) return "auth";
  if (error?.status === 404 || error?.status === 422) return "model_or_protocol";
  return "remote_error";
}
async function jsonOrThrow(response) {
  if (!response.ok) { const error = new Error(`remote compaction HTTP ${response.status}`); error.status = response.status; throw error; }
  try { return await response.json(); } catch { throw new Error("remote compaction returned invalid JSON"); }
}
function compactItems(body, codex = false) {
  const items = body?.output ?? body?.items ?? body?.compaction_items;
  const compactions = Array.isArray(items) ? items.filter((item) => item?.type === "compaction" && typeof item?.encrypted_content === "string" && item.encrypted_content) : [];
  if (!Array.isArray(items) || compactions.length !== 1 || (codex && (items.length !== 1 || items[0] !== compactions[0]))) throw new Error("canonical encrypted compaction output is invalid");
  if (!codex && items.at(-1) !== compactions[0]) throw new Error("canonical compact response must end in one encrypted compaction item");
  return codex ? items : [...items.filter((item) => item?.type === "message" && item?.role === "user"), compactions[0]];
}
async function sseOrJson(response, codex) {
  if (!codex) return jsonOrThrow(response);
  if (!response.ok) return jsonOrThrow(response);
  if (typeof response.text !== "function") return jsonOrThrow(response);
  const text = await response.text(); if (text.trim().startsWith("{")) return JSON.parse(text); const items = []; let completed;
  for (const line of text.split(/\r?\n/)) if (line.startsWith("data: ")) { try { const event = JSON.parse(line.slice(6)); if (event.type === "response.output_item.done") items.push(event.item); if (event.type === "response.completed") completed = event.response; } catch {} }
  return Array.isArray(completed?.output) && completed.output.length ? completed : { ...(completed ?? {}), output: items };
}
function accountIdFromCodexToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId) return accountId;
  } catch { /* classified as auth below */ }
  throw new Error("Codex authorization has no ChatGPT account identity");
}
function mergeHeaders(defaults, overrides) {
  const merged = new Map();
  const apply = (name, value) => {
    const key = name.toLowerCase();
    if (value === null) merged.delete(key);
    else if (typeof value === "string") merged.set(key, [name, value]);
  };
  for (const [name, value] of Object.entries(defaults)) apply(name, value);
  for (const [name, value] of Object.entries(overrides ?? {})) apply(name, value);
  return { set: apply, toObject: () => Object.fromEntries([...merged.values()]) };
}
function requestHeaders(identity, auth) {
  if (!auth?.apiKey) throw new Error("resolved provider authorization is unavailable");
  // Pi 0.84 applies provider overrides after default headers. A null is a
  // case-insensitive delete, not a Fetch value. Codex restores its required
  // transport headers after overrides, matching Pi's native Codex ordering.
  const defaults = identity.surface === "azure_openai"
    ? { "content-type": "application/json", "api-key": auth.apiKey }
    : { "content-type": "application/json", authorization: `Bearer ${auth.apiKey}` };
  const headers = mergeHeaders(defaults, auth.headers);
  if (identity.surface === "chatgpt_codex") {
    headers.set("Authorization", `Bearer ${auth.apiKey}`);
    headers.set("chatgpt-account-id", accountIdFromCodexToken(auth.apiKey));
    headers.set("originator", "pi");
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("content-type", "application/json");
  }
  return headers.toObject();
}
function route(identity) {
  if (identity.surface === "chatgpt_codex") return `${identity.endpoint}/codex/responses`;
  return `${identity.endpoint}/responses/compact`;
}
function requestBody(identity, prepared) {
  if (identity.surface === "chatgpt_codex") return { ...(prepared.payload ?? prepared), input: [...prepared.input, { type: "compaction_trigger" }] };
  const body = prepared.payload ?? prepared;
  return { model: identity.surface === "azure_openai" ? identity.deployment : identity.model, input: prepared.input, ...(body.instructions === undefined ? {} : { instructions: body.instructions }), ...(body.previous_response_id === undefined ? {} : { previous_response_id: body.previous_response_id }), ...(body.prompt_cache_key === undefined ? {} : { prompt_cache_key: body.prompt_cache_key }) };
}
async function compact({ identity, prepared, auth, fetchImpl, signal, retention, checkpointItems = (items) => items }) {
  const started = Date.now();
  try {
    const response = await fetchImpl(route(identity), { method: "POST", headers: requestHeaders(identity, auth), body: JSON.stringify(requestBody(identity, prepared)), signal });
    const body = await sseOrJson(response, identity.surface === "chatgpt_codex");
    const opaqueWindow = checkpointItems(compactItems(body, identity.surface === "chatgpt_codex"));
    return { details: checkpointDetails({ identity, opaqueWindow, usage: body.usage, latencyMs: Date.now() - started, retention }) };
  } catch (error) { return { error, failureClass: failureClass(error) }; }
}
async function compactResponses(args) {
  return compact({ ...args, retention: "canonical_provider_window" });
}
async function compactCodex(args) {
  return compact({ ...args, retention: "recent_real_user_messages_64000_plus_canonical_provider_window", checkpointItems: (items) => [...retainCodexInput(args.prepared.input), ...items] });
}

const COMPACTION_ADAPTERS = Object.freeze({
  openai_api: { protocol: PROTOCOLS.openai_api, compact: compactResponses },
  azure_openai: { protocol: PROTOCOLS.azure_openai, compact: compactResponses },
  chatgpt_codex: { protocol: PROTOCOLS.chatgpt_codex, compact: compactCodex },
});

export async function compactProviderInput(args) {
  const adapter = COMPACTION_ADAPTERS[args.identity?.surface];
  if (!adapter || adapter.protocol !== args.identity?.protocol) {
    return { error: new Error("provider compaction identity has no matching adapter"), failureClass: "model_or_protocol" };
  }
  return adapter.compact(args);
}

function retainCodexInput(input, maxTokens = 64000) {
  const realUsers = (Array.isArray(input) ? input : []).filter((item) => item?.role === "user" && !item?.name?.startsWith("hc-"));
  const retained = []; let budget = 0;
  for (const item of realUsers.toReversed()) { const tokens = Math.ceil(JSON.stringify(item).length / 4); if (budget + tokens > maxTokens) break; retained.unshift(item); budget += tokens; }
  return retained;
}
