import { describe, expect, it, vi } from 'vitest';
import { runAnthropicProvider } from '../src/providers/anthropic.mjs';
import { runOpenAiCompatibleProvider } from '../src/providers/openai-compatible.mjs';

function response(events) {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  });
}
const cases = [
  { name: 'anthropic', run: runAnthropicProvider, type: 'anthropic-via-proxy',
    error: error => ({ type: 'error', error }),
    text: text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    reasoning: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking' } },
    tool: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'abandoned', name: 'shell', input: {} } }
  },
  { name: 'openai-compatible', run: runOpenAiCompatibleProvider, type: 'openai-via-proxy',
    error: error => ({ error }),
    text: content => ({ choices: [{ delta: { content } }] }),
    reasoning: { choices: [{ delta: { reasoning_content: 'thinking' } }] },
    tool: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'abandoned', function: { name: 'shell', arguments: '{}' } }] } }] }
  }
];
for (const c of cases) describe(`${c.name} SSE errors (#151)`, () => {
  const transient = c.error({ type: 'overloaded_error', message: 'overloaded' });
  const start = (fetchImpl, overrides = {}) => c.run({
    provider: { type: c.type, baseUrl: 'https://provider.test', maxRetries: 2, retryBaseDelayMs: 1, ...overrides.provider },
    model: 'test', prompt: 'hello', fetchImpl, sleepImpl: overrides.sleepImpl ?? (async () => {}), signal: overrides.signal
  });
  async function drain(result) {
    const chunks = [];
    for await (const chunk of result.deltaStream) chunks.push(chunk.deltaText);
    return chunks;
  }
  it('retries before output, discarding failed usage/tool state', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([c.tool, transient]))
      .mockResolvedValueOnce(response([c.text('recovered')]));
    const result = await start(fetchImpl);
    expect(await drain(result)).toEqual(['recovered']);
    const final = await result.finalize();
    expect(final.message.content).toBe('recovered');
    expect(final.toolCalls).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].body).toBe(fetchImpl.mock.calls[1][1].body);
  });
  it.each(['text', 'reasoning'])('never retries after %s output and rejects both interfaces', async kind => {
    const fetchImpl = vi.fn().mockResolvedValue(response([kind === 'text' ? c.text('partial') : c.reasoning, transient]));
    const result = await start(fetchImpl);
    await expect(drain(result)).rejects.toThrow('overloaded');
    await expect(result.finalize()).rejects.toThrow('overloaded');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(['authentication_error', 'unknown_error'])('rejects %s without retry', async type => {
    const fetchImpl = vi.fn().mockResolvedValue(response([c.error({ type, message: 'fatal failure' })]));
    const result = await start(fetchImpl);
    await expect(result.finalize()).rejects.toThrow('fatal failure');
    await expect(drain(result)).rejects.toThrow('fatal failure');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('bounds repeated transient frames with exponential backoff', async () => {
    const sleepImpl = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => response([transient]));
    const result = await start(fetchImpl, { sleepImpl });
    await expect(result.finalize()).rejects.toThrow('overloaded');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl.mock.calls.map(c => c[0])).toEqual([1, 2]);
  });
  it('shares the HTTP and SSE retry budget', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockImplementation(async () => response([transient]));
    const result = await start(fetchImpl);
    await expect(result.finalize()).rejects.toThrow('overloaded');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('supports maxRetries zero', async () => {
    const fetchImpl = vi.fn(async () => response([transient]));
    const result = await start(fetchImpl, { provider: { maxRetries: 0 } });
    await expect(result.finalize()).rejects.toThrow('overloaded');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not redial when aborted in backoff', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => response([transient]));
    const result = await start(fetchImpl, {
      signal: controller.signal,
      sleepImpl: async () => controller.abort(new Error('stopped'))
    });
    await expect(result.finalize()).rejects.toThrow('stopped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
