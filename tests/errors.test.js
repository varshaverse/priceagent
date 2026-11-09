import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTRACTION_RETRY_MESSAGE,
  RATE_LIMIT_MESSAGE,
  isGroqRateLimitError,
  isTransientExtractionError,
  sanitizeErrorText
} from '../server/errors.js';

test('Groq 429 errors are classified as transient rate limits', () => {
  const error = { status: 429, message: 'Groq returned 429: provider details' };
  assert.equal(isGroqRateLimitError(error), true);
  assert.equal(isGroqRateLimitError({ response: { status: 429 } }), true);
  assert.equal(isTransientExtractionError(error), true);
  assert.equal(isGroqRateLimitError({ status: 401 }), false);
});

test('sanitized rate-limit errors expose only the retry message', () => {
  assert.equal(
    sanitizeErrorText('Groq returned 429: {"secret":"private provider response"}'),
    RATE_LIMIT_MESSAGE
  );
  assert.equal(EXTRACTION_RETRY_MESSAGE.includes('retry automatically'), true);
});

test('sanitized provider failures omit response bodies, stack traces, and image data', () => {
  const output = sanitizeErrorText(
    'Groq returned 500: {"token":"private provider response"}\n' +
    'data:image/jpeg;base64,SGVsbG8='
  );
  assert.equal(output.includes('private provider response'), false);
  assert.equal(output.includes('SGVsbG8='), false);
  assert.ok(output.length <= 300);

  assert.equal(
    sanitizeErrorText('Receipt processing failed\n    at parseReceipt (/private/path.js:1:2)'),
    'Receipt processing failed'
  );
});
