function jsonOrThrow(response) {
  if (!response.ok) throw new Error(`server compaction HTTP ${response.status}`);
  return response.json().catch(() => { throw new Error("server compaction returned invalid JSON"); });
}

function providerWindow(body, compactionOnly) {
  const items = body?.output ?? body?.items ?? body?.compaction_items;
  const compactions = Array.isArray(items)
    ? items.filter((item) => item?.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content)
    : [];
  if (!Array.isArray(items) || compactions.length !== 1) throw new Error("server returned an invalid compaction window");
  return compactionOnly ? [compactions[0]] : items;
}

async function responseBody(response, codex) {
  if (!codex) return jsonOrThrow(response);
  if (!response.ok || typeof response.text !== "function") return jsonOrThrow(response);
  const text = await response.text();
  if (text.trim().startsWith("{")) return JSON.parse(text);
  const items = [];
  let completed;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === "response.output_item.done") items.push(event.item);
      if (event.type === "response.completed") completed = event.response;
    } catch {}
  }
  return Array.isArray(completed?.output) && completed.output.length ? completed : { ...(completed ?? {}), output: items };
}

function accountIdFromCodexToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const accountId = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId) return accountId;
  } catch {}
  throw new Error("Codex authorization has no ChatGPT account identity");
}

function requestHeaders(provider, auth) {
  if (!auth?.apiKey) throw new Error("provider authorization unavailable");
  const headers = { ...(auth.headers ?? {}), "content-type": "application/json" };
  const has = (name) => Object.keys(headers).some((key) => key.toLowerCase() === name);
  if (provider.surface === "azure_openai") {
    if (!has("api-key") && !has("authorization")) headers["api-key"] = auth.apiKey;
  } else if (!has("authorization")) headers.authorization = `Bearer ${auth.apiKey}`;
  if (provider.surface === "chatgpt_codex") {
    if (!has("chatgpt-account-id")) headers["chatgpt-account-id"] = accountIdFromCodexToken(auth.apiKey);
    if (!has("originator")) headers.originator = "pi";
    if (!has("openai-beta")) headers["OpenAI-Beta"] = "responses=experimental";
  }
  return headers;
}

function request(provider, prepared) {
  if (provider.surface === "chatgpt_codex") {
    return {
      url: `${provider.endpoint}/codex/responses`,
      body: { ...(prepared.payload ?? prepared), input: [...prepared.input, { type: "compaction_trigger" }] },
    };
  }
  const body = prepared.payload ?? prepared;
  return {
    url: `${provider.endpoint}/responses/compact`,
    body: {
      model: provider.surface === "azure_openai" ? provider.deployment : provider.model,
      input: prepared.input,
      ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      ...(body.previous_response_id === undefined ? {} : { previous_response_id: body.previous_response_id }),
      ...(body.prompt_cache_key === undefined ? {} : { prompt_cache_key: body.prompt_cache_key }),
    },
  };
}

export async function compactProvider({ provider, prepared, auth, fetchImpl, signal }) {
  try {
    const { url, body } = request(provider, prepared);
    const response = await fetchImpl(url, { method: "POST", headers: requestHeaders(provider, auth), body: JSON.stringify(body), signal });
    const result = await responseBody(response, provider.surface === "chatgpt_codex");
    return { input: providerWindow(result, provider.surface === "chatgpt_codex") };
  } catch (error) {
    return { error };
  }
}
