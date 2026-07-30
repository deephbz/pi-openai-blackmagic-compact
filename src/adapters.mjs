import { checkpointDetails } from "./contract.mjs";

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
function requestHeaders(identity, auth) {
  if (!auth?.apiKey) throw new Error("resolved provider authorization is unavailable");
  const headers = { ...(auth.headers ?? {}), "content-type": "application/json" };
  const has = (name) => Object.keys(headers).some((key) => key.toLowerCase() === name);
  if (identity.surface === "azure_openai") {
    if (!has("api-key") && !has("authorization")) headers["api-key"] = auth.apiKey;
  } else if (!has("authorization")) headers.authorization = `Bearer ${auth.apiKey}`;
  if (identity.surface === "chatgpt_codex") {
    if (!has("chatgpt-account-id")) headers["chatgpt-account-id"] = accountIdFromCodexToken(auth.apiKey);
    if (!has("originator")) headers.originator = "pi";
    if (!has("openai-beta")) headers["OpenAI-Beta"] = "responses=experimental";
  }
  return headers;
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
export async function compactResponses(args) {
  return compact({ ...args, retention: "canonical_provider_window" });
}
export async function compactCodex(args) {
  return compact({ ...args, retention: "recent_real_user_messages_64000_plus_canonical_provider_window", checkpointItems: (items) => [...retainCodexInput(args.prepared.input), ...items] });
}
export function retainCodexInput(input, maxTokens = 64000) {
  const realUsers = (Array.isArray(input) ? input : []).filter((item) => item?.role === "user" && !item?.name?.startsWith("hc-"));
  const retained = []; let budget = 0;
  for (const item of realUsers.toReversed()) { const tokens = Math.ceil(JSON.stringify(item).length / 4); if (budget + tokens > maxTokens) break; retained.unshift(item); budget += tokens; }
  return retained;
}
