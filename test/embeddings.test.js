import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIEmbedder } from '../src/llm/embeddings.js';

test('OpenAI embedding client batches unique text and restores input order from response indexes', async () => {
  const requests = [];
  const embed = createOpenAIEmbedder(
    {
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'test-key',
      model: 'text-embedding-3-small',
      timeoutMs: 1000,
    },
    {
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, options, body });
        return {
          ok: true,
          json: async () => ({
            data: body.input
              .map((text, index) => ({ index, embedding: text === 'different' ? [0, 1] : [1, 0] }))
              .reverse(),
          }),
        };
      },
    },
  );

  assert.deepEqual(await embed(['same', 'different', 'same']), [[1, 0], [0, 1], [1, 0]]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.example.test/v1/embeddings');
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-key');
  assert.deepEqual(requests[0].body.input, ['same', 'different']);
  assert.deepEqual(await embed(['different', 'same']), [[0, 1], [1, 0]]);
  assert.equal(requests.length, 1, 'cached texts should not be requested again');
});
