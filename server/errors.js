export const RATE_LIMIT_MESSAGE =
  'Receipt saved. AI extraction is temporarily rate limited and will retry automatically.';
export const EXTRACTION_RETRY_MESSAGE =
  'Receipt saved. AI extraction is temporarily unavailable and will retry automatically.';

export function isGroqRateLimitError(error) {
  return Number(error?.status || error?.response?.status) === 429 ||
    /\bGroq returned 429\b/i.test(String(error?.message || ''));
}

// Failures worth retrying later because the receipt itself was readable.
export function isTransientExtractionError(error) {
  if (isGroqRateLimitError(error)) return true;
  const status = Number(error?.status || 0);
  if (status >= 500) return true;
  return /\bGroq returned (?:5\d\d|408)\b|Could not connect to Groq|Groq returned (?:an empty response|invalid JSON)|GROQ_API_KEY is missing|timed? ?out|aborted|fetch failed|ECONN|ENOTFOUND/i
    .test(String(error?.message || ''));
}

// Never expose raw provider JSON, base64 image data, or stack traces.
export function sanitizeErrorText(value, fallback = 'Something went wrong. The agent will retry automatically.') {
  let text = String(value ?? '');
  if (/\bGroq returned 429\b/i.test(text)) return RATE_LIMIT_MESSAGE;
  text = text
    .split('\n')[0]
    .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '')
    .replace(/[A-Za-z0-9+/=]{60,}/g, '')
    .replace(/\s+at\s+\S+\s*\(.*\)/g, '')
    .replace(/Groq returned \d+:.*$/i, '')
    .replace(/\{[\s\S]*\}/g, '')
    .trim();
  return text && text.length <= 300 ? text : fallback;
}
