import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getLocalAIStatus,
  askGemma,
  imageToDataUrl,
  loadGroqApiKey
} from '../server/localAI.js';

test('Groq API key loading strips surrounding whitespace and quote characters', () => {
  assert.equal(loadGroqApiKey(' \t""gsk_test_key\'\' \n'), 'gsk_test_key');
});

test('Groq API key loading rejects missing or invalid keys', () => {
  for (const value of [null, '', '   ', 'invalid_key', '"invalid_key"']) {
    assert.throws(
      () => loadGroqApiKey(value),
      { message: 'GROQ_API_KEY is not set or valid' }
    );
  }
});

test('image payloads use validated base64 data URLs with their declared MIME type', () => {
  assert.equal(imageToDataUrl('YWJj'), 'data:image/jpeg;base64,YWJj');
  assert.equal(
    imageToDataUrl('data:image/webp;base64,YWJj'),
    'data:image/webp;base64,YWJj'
  );
  assert.throws(() => imageToDataUrl('not base64'), /valid base64/);
});

test('Groq health check reports the HTTP status and provider message on failure', async () => {
  const status = await getLocalAIStatus({
    apiKey: 'gsk_test_key',
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: 'invalid API key' }
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  });

  assert.equal(status.connected, false);
  assert.equal(status.status, 401);
  assert.equal(status.error, 'Groq request failed (HTTP 401): invalid API key');
});

test('Groq health check preserves the underlying network error cause', async () => {
  const status = await getLocalAIStatus({
    apiKey: 'gsk_test_key',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND api.groq.com');
    }
  });

  assert.equal(status.connected, false);
  assert.match(status.error, /Connection error.*ENOTFOUND api\.groq\.com/);
});

test('provider errors redact the key in both the error and response body', async () => {
  const key = 'gsk_private_test_key';
  await assert.rejects(
    askGemma('test', [], undefined, {
      apiKey: key,
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: `rejected ${key}` }
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    }),
    error => {
      assert.equal(error.status, 401);
      assert.ok(!JSON.stringify(error.responseBody).includes(key));
      assert.ok(!error.message.includes(key));
      return true;
    }
  );
});
