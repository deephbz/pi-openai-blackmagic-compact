import { home, reset, advance, installTimers } from './bootstrap.mjs';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import registerBlackmagic from '../src/extension.mjs';
import { performance } from 'node:perf_hooks';

const clone = (value) => structuredClone(value);
const item = { type: 'compaction', id: 'cmp_sim', encrypted_content: 'synthetic-opaque-v1' };

// https://developers.openai.com/api/reference/resources/responses/streaming-events
// Only documented message/output-item/completed events are emitted.
function streamReply(index) {
  const message = { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic answer.', annotations: [] }] };
  const response = { id: `resp_${index}`, object: 'response', status: 'completed', output: [message], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: message.id, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: 'Synthetic answer.' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: message.id, text: 'Synthetic answer.' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ];
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

export async function run(seed, actions, { mutant, old = false } = {}) {
  const started = performance.now();
  const entropy = reset(seed);
  const restoreTimers = installTimers();
  const history = [];
  let fault;
  let compacting = false;
  let epoch = 0;
  let requestIndex = 0;
  const originalFetch = globalThis.fetch;
  // One FIFO scheduler owns explicit user actions and all fetch effects. Each
  // fetch consumes seeded latency; no host timing determines a scenario choice.
  globalThis.fetch = async (url, init) => {
    const address = typeof url === 'string' ? url : url.url ?? String(url);
    if (!address.startsWith('https://api.openai.com/v1/responses')) throw new Error('sim network escape');
    const body = JSON.parse(init?.body ?? await url.text());
    const compact = address.endsWith('/compact');
    advance(1 + entropy.draw(20));
    history.push({ kind: 'request', at: Date.now(), compact, compacting, epoch, body: clone(body) });
    requestIndex += 1;
    if (compact) {
      if (fault === 'http') return Response.json({ error: { message: 'synthetic failure', type: 'server_error' } }, { status: 500 });
      if (fault === 'malformed') return Response.json({ output: [{ type: 'compaction', encrypted_content: '' }] });
      // https://developers.openai.com/api/reference/resources/responses/methods/compact
      // https://developers.openai.com/api/docs/guides/compaction
      // The output window preserves user input and an opaque compaction item.
      return Response.json({ id: 'cmp_response', object: 'response.compaction', output: [...body.input.filter((entry) => entry.role === 'user').map((entry) => ({ ...entry, type: 'message' })), item], usage: { input_tokens: 100, output_tokens: 10 } });
    }
    return streamReply(requestIndex);
  };
  let session;
  try {
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
    await modelRuntime.setRuntimeApiKey('openai', 'synthetic-key');
    const model = { ...getModel('openai', 'gpt-5'), baseUrl: 'https://api.openai.com/v1' };
    const cwd = '/sim/workspace';
    const manager = SessionManager.inMemory(cwd, { id: 'sim-session' });
    if (old) {
      const first = manager.appendMessage({ role: 'user', content: 'Old synthetic question', timestamp: Date.now() });
      manager.appendCompaction('Old native summary', first, 100);
    }
    async function open() {
      const settings = SettingsManager.inMemory({ transport: 'sse', compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 }, retry: { enabled: false, maxRetries: 0, provider: { timeoutMs: 1000, maxRetries: 0 } } });
      const mutate = (pi) => pi.on('before_provider_request', (event) => {
        if (!mutant) return;
        const payload = clone(event.payload);
        if (mutant === 'drop-encrypted') payload.input = payload.input.filter((entry) => entry.type !== 'compaction');
        if (mutant === 'rotate-key') payload.prompt_cache_key = `mutant-${requestIndex}`;
        return payload;
      });
      const loader = new DefaultResourceLoader({ cwd, agentDir: home, settingsManager: settings, extensionFactories: [registerBlackmagic, mutate], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPromptOverride: () => 'Synthetic simulator system.' });
      await loader.reload();
      const result = await createAgentSession({ cwd, agentDir: home, modelRuntime, model, thinkingLevel: 'off', tools: [], sessionManager: manager, settingsManager: settings, resourceLoader: loader });
      session = result.session;
      await session.bindExtensions({ mode: 'print', uiContext: { notify: (text, level) => history.push({ kind: 'notice', text, level }) } });
    }
    await open();
    for (const action of actions) {
      advance(1000 + entropy.draw(59000));
      history.push({ kind: 'action', action, at: Date.now() });
      const before = clone(manager.getEntries());
      if (action === 'reopen') { session.dispose(); await open(); }
      else if (action === 'compact' || action === 'http' || action === 'malformed') {
        fault = action === 'compact' ? undefined : action;
        epoch += 1;
        compacting = true;
        await session.compact();
        compacting = false;
        fault = undefined;
        const latest = manager.getBranch().filter((entry) => entry.type === 'compaction').at(-1);
        history.push({ kind: 'compacted', remote: latest?.details?.state === 'remote_applied', artifact: latest?.details?.checkpoint?.artifact });
      } else await session.prompt(`Synthetic user ${action}.`);
      const entries = clone(manager.getEntries());
      history.push({ kind: 'session', before, entries });
    }
    return { seed, actions, history, choices: entropy.choices, virtualMs: Date.now() - 1700000000000, wallMs: performance.now() - started };
  } finally { session?.dispose(); globalThis.fetch = originalFetch; restoreTimers(); }
}

export function violations(trace) {
  const failures = [];
  let previous;
  let encrypted;
  let action;
  for (const entry of trace.history) {
    if (entry.kind === 'action') action = entry.action;
    if (entry.kind === 'compacted') {
      if (action === 'http' || action === 'malformed') {
        if (entry.remote) failures.push('B4');
      } else if (!entry.remote) failures.push('B2');
      encrypted = entry.remote ? entry.artifact.find((part) => part.type === 'compaction') : undefined;
    }
    if (entry.kind === 'session') {
      if (JSON.stringify(entry.entries.slice(0, entry.before.length)) !== JSON.stringify(entry.before)) failures.push('B2');
    }
    if (entry.kind !== 'request') continue;
    const body = entry.body;
    if (!body.model || !Array.isArray(body.input)) failures.push('B1');
    if (entry.compact) {
      if (['stream', 'tools', 'store', 'max_output_tokens'].some((key) => key in body)) failures.push('B1');
      continue;
    }
    if (entry.compacting) continue;
    if (encrypted && !body.input.some((part) => JSON.stringify(part) === JSON.stringify(encrypted))) failures.push('B2');
    // https://developers.openai.com/api/docs/guides/prompt-caching
    // Exact prefix equality is necessary; this does not predict billed hits.
    if (previous?.epoch === entry.epoch) {
      if (JSON.stringify(body.input.slice(0, previous.body.input.length)) !== JSON.stringify(previous.body.input) || body.prompt_cache_key !== previous.body.prompt_cache_key) failures.push('B3');
    }
    previous = entry;
  }
  return [...new Set(failures)];
}
