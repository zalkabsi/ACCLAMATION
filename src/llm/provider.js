/**
 * OpenAI-compatible chat completion client. No SDK: one fetch, a timeout and
 * an honest error message. Works with OpenAI, OpenRouter, Together, Ollama
 * (base URL with /v1) and anything else that speaks the same shape.
 */

export class ProviderError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

export async function complete({ messages, llm, fetchImpl = globalThis.fetch }) {
  const startedAt = performance.now();
  let response = await request(messages, llm, fetchImpl, true);
  if (response.status === 400) {
    const body = await response.text().catch(() => '');
    if (/response_format|json_object/i.test(body)) {
      // Some OpenAI-compatible servers reject structured output. Ask again
      // without it; the prompt still demands JSON and the contract still checks.
      response = await request(messages, llm, fetchImpl, false);
    } else {
      throw new ProviderError(`model rejected the request (400): ${summarize(body)}`, {
        status: 400,
      });
    }
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(`model request failed (${response.status}): ${summarize(body)}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new ProviderError('model returned no text content');
  }
  return {
    text,
    model: data.model || llm.model,
    latencyMs: Math.round(performance.now() - startedAt),
    usage: data.usage || null,
  };
}

function request(messages, llm, fetchImpl, structured) {
  const url = `${llm.baseUrl}/chat/completions`;
  const body = {
    model: llm.model,
    messages,
    temperature: llm.temperature,
    max_tokens: 400,
  };
  if (structured) body.response_format = { type: 'json_object' };
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(llm.timeoutMs),
  });
}

function summarize(body) {
  const text = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 220 ? `${text.slice(0, 217)}...` : text || 'empty response body';
}
