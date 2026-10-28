/**
 * Minimal OpenAI-compatible embeddings client. Uses built-in fetch and keeps a
 * bounded in-memory cache so repeated triggers only embed new chat text.
 */

export class EmbeddingError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.status = status;
  }
}

export function createOpenAIEmbedder(
  { baseUrl, apiKey, model = 'text-embedding-3-small', timeoutMs = 3500 },
  { fetchImpl = globalThis.fetch, cacheLimit = 4096, batchSize = 2048 } = {},
) {
  const cache = new Map();

  return async function embed(texts) {
    if (!apiKey) throw new EmbeddingError('embedding API key is empty');
    if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) {
      throw new EmbeddingError('embedding input must be an array of strings');
    }

    const result = new Array(texts.length);
    const missing = new Map();
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index];
      if (cache.has(text)) {
        const vector = cache.get(text);
        cache.delete(text);
        cache.set(text, vector);
        result[index] = vector;
      } else {
        const indices = missing.get(text) || [];
        indices.push(index);
        missing.set(text, indices);
      }
    }

    const unique = [...missing.keys()];
    for (let offset = 0; offset < unique.length; offset += batchSize) {
      const batch = unique.slice(offset, offset + batchSize);
      const vectors = await requestEmbeddings(batch, { baseUrl, apiKey, model, timeoutMs, fetchImpl });
      for (let index = 0; index < batch.length; index += 1) {
        const text = batch[index];
        const vector = vectors[index];
        cache.set(text, vector);
        for (const resultIndex of missing.get(text)) result[resultIndex] = vector;
      }
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    }
    return result;
  };
}

async function requestEmbeddings(texts, { baseUrl, apiKey, model, timeoutMs, fetchImpl }) {
  const response = await fetchImpl(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new EmbeddingError(
      `embedding request failed (${response.status}): ${summarize(body)}`,
      { status: response.status },
    );
  }

  const data = await response.json();
  if (!Array.isArray(data?.data) || data.data.length !== texts.length) {
    throw new EmbeddingError('embedding provider returned an unexpected number of vectors');
  }
  const ordered = new Array(texts.length);
  for (const item of data.data) {
    const index = item?.index;
    const vector = item?.embedding;
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= ordered.length ||
      !Array.isArray(vector) ||
      vector.length === 0 ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw new EmbeddingError('embedding provider returned an invalid vector');
    }
    ordered[index] = vector;
  }
  if (ordered.some((vector) => !vector)) {
    throw new EmbeddingError('embedding provider omitted a vector');
  }
  return ordered;
}

function summarize(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text || 'empty response body';
}
