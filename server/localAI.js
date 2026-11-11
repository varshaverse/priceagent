import './env.js';
import Groq from 'groq-sdk';

const AI_PROVIDER = 'groq';

function normalizeGroqApiKey(value) {
  return (typeof value === 'string' ? value : '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

const GROQ_API_KEY = normalizeGroqApiKey(process.env.GROQ_API_KEY);

export function loadGroqApiKey(value = GROQ_API_KEY) {
  const key = normalizeGroqApiKey(value);
  if (!key.startsWith('gsk_')) {
    throw new Error('GROQ_API_KEY is not set or valid');
  }
  return key;
}

const GROQ_MODEL = 'qwen/qwen3.8-27b';

// This export name is kept for compatibility with the existing server/index.js.
const OLLAMA_MODEL = GROQ_MODEL;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

const MAX_RATE_LIMIT_RETRIES = positiveInteger(process.env.GROQ_MAX_RETRIES, 3);
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 20000;

export class GroqError extends Error {
  constructor(message, {
    status = 0,
    retryAfterMs = 0,
    responseBody = null,
    causeMessage = null,
    operation = 'receipt_extraction'
  } = {}) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.responseBody = responseBody;
    this.causeMessage = causeMessage;
    this.operation = operation;
  }
}

export function groqBackoffDelayMs(attempt, retryAfterMs = 0) {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.min(BACKOFF_MAX_MS, Math.max(exponential, retryAfterMs || 0));
}

function retryAfterMilliseconds(response) {
  const header = response.headers?.get?.('retry-after');
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function getGroqClient(fetchImpl, apiKey = GROQ_API_KEY) {
  return new Groq({
    apiKey: loadGroqApiKey(apiKey),
    // The SDK otherwise implicitly honors GROQ_BASE_URL, including bad paths.
    ...(process.env.GROQ_BASE_URL ? { baseURL: 'https://api.groq.com' } : {}),
    maxRetries: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {})
  });
}

function redactProviderText(value, apiKey) {
  let text = String(value ?? '');
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return text.replace(/gsk_[A-Za-z0-9_-]+/g, '[REDACTED]');
}

function providerError(error, operation, apiKey = GROQ_API_KEY) {
  if (error instanceof GroqError) {
    error.operation = operation;
    return error;
  }
  const status = Number(error?.status) || 0;
  const rawBody = error?.error ?? null;
  const responseBody = rawBody == null ? null :
    JSON.parse(redactProviderText(JSON.stringify(rawBody), apiKey));
  const rawCause = error?.cause?.message ||
    error?.cause?.cause?.message ||
    null;
  const causeMessage = rawCause ? redactProviderText(rawCause, apiKey) : null;
  const bodyMessage = responseBody?.error?.message ||
    responseBody?.message ||
    responseBody?.error ||
    null;
  const message = status
    ? `Groq request failed (HTTP ${status})${bodyMessage ? `: ${bodyMessage}` : `: ${redactProviderText(error.message, apiKey)}`}`
    : causeMessage
      ? `${redactProviderText(error?.message || 'Groq request failed.', apiKey)} Cause: ${causeMessage}`
      : redactProviderText(error?.message || 'Groq request failed.', apiKey);
  return new GroqError(message, {
    status,
    retryAfterMs: retryAfterMilliseconds(error),
    responseBody,
    causeMessage,
    operation
  });
}

function logProviderFailure(error, receiptId, operation) {
  const details = error instanceof GroqError
    ? error
    : providerError(error, operation);
  console.error('[receipt]', JSON.stringify({
    event: 'provider_request_failed',
    receiptId: receiptId || null,
    operation,
    status: details.status || null,
    message: details.message,
    cause: details.causeMessage,
    responseBody: details.responseBody
  }));
}

const RECEIPT_SYSTEM_PROMPT =
  'You are PriceDrop Agent. Extract only details supported by the provided receipt. Never invent prices, brands, dates, URLs, or product details. Return valid JSON only.';

export async function checkGroqAvailability({
  fetchImpl = fetch,
  apiKey = GROQ_API_KEY,
  receiptId = null
} = {}) {
  const operation = 'health_check';
  console.info('[receipt]', JSON.stringify({
    event: 'provider_request_started',
    receiptId,
    operation,
    model: GROQ_MODEL
  }));
  try {
    loadGroqApiKey(apiKey);
    const response = await getGroqClient(fetchImpl, apiKey).chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 1
    }, {
      maxRetries: 0,
      timeout: 10000
    });
    if (!Array.isArray(response.choices) || response.choices.length === 0) {
      throw new GroqError('Groq health check returned an empty response.', {
        operation
      });
    }
    console.info('[receipt]', JSON.stringify({
      event: 'provider_request_succeeded',
      receiptId,
      operation,
      model: GROQ_MODEL
    }));
    return true;
  } catch (error) {
    const details = providerError(error, operation, apiKey);
    logProviderFailure(details, receiptId, operation);
    throw details;
  }
}

let cachedStatus;
let statusExpiresAt = 0;
let pendingStatus;
const HEALTH_CACHE_MS = 60 * 1000;

export async function getLocalAIStatus(options = {}) {
  const useCache = Object.keys(options).length === 0;
  if (useCache && cachedStatus && Date.now() < statusExpiresAt) return cachedStatus;
  if (useCache && pendingStatus) return pendingStatus;

  const request = (async () => {
    try {
      await checkGroqAvailability(options);
      return {
        provider: AI_PROVIDER,
        model: GROQ_MODEL,
        connected: true,
        modelAvailable: true,
        error: ''
      };
    } catch (error) {
      return {
        provider: AI_PROVIDER,
        model: GROQ_MODEL,
        connected: false,
        modelAvailable: false,
        error: error.message,
        status: error.status || null
      };
    }
  })();
  if (!useCache) return request;
  pendingStatus = request;
  try {
    cachedStatus = await request;
    statusExpiresAt = Date.now() + HEALTH_CACHE_MS;
    return cachedStatus;
  } finally {
    pendingStatus = undefined;
  }
}

export function imageToDataUrl(image) {
  if (typeof image !== 'string' || !image.trim()) {
    return null;
  }

  const dataUrl = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (dataUrl) {
    if (dataUrl[2].length % 4 === 1) {
      throw new Error('Receipt image is not valid base64 data.');
    }
    return image;
  }

  const base64 = image.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) {
    throw new Error('Receipt image is not valid base64 data.');
  }
  return `data:image/jpeg;base64,${base64}`;
}

export async function askGemma(
  prompt,
  images = [],
  systemPrompt = RECEIPT_SYSTEM_PROMPT,
  {
    fetchImpl = fetch,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    maxRetries = MAX_RATE_LIMIT_RETRIES,
    logger = console.warn,
    receiptId = null,
    operation = 'receipt_extraction',
    apiKey = GROQ_API_KEY
  } = {}
) {
  const imageContent = images
    .map(imageToDataUrl)
    .filter(Boolean)
    .map(imageUrl => ({
      type: 'image_url',
      image_url: { url: imageUrl }
    }));

  const requestOptions = {
    model: GROQ_MODEL,
    temperature: 0,
    max_tokens: 2000,
    response_format: {
      type: 'json_object'
    },
    messages: [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: String(prompt)
          },
          ...imageContent
        ]
      }
    ]
  };

  let response;
  for (let attempt = 0; ; attempt++) {
    console.info('[receipt]', JSON.stringify({
      event: 'provider_request_started',
      receiptId,
      operation,
      model: GROQ_MODEL
    }));
    try {
      const client = getGroqClient(fetchImpl, apiKey);
      response = await client.chat.completions.create(requestOptions, {
        timeout: 300000,
        maxRetries: 0
      });
      console.info('[receipt]', JSON.stringify({
        event: 'provider_request_succeeded',
        receiptId,
        operation,
        model: GROQ_MODEL
      }));
      break;
    } catch (error) {
      const details = providerError(error, operation, apiKey);
      logProviderFailure(details, receiptId, operation);
      if (details.status !== 429 || attempt >= maxRetries) throw details;
      const delay = groqBackoffDelayMs(attempt, details.retryAfterMs);
      logger(`Groq rate limited (429); retrying in ${delay} ms (attempt ${attempt + 1} of ${maxRetries}).`);
      await sleep(delay);
    }
  }

  const content = response.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    const error = new GroqError('Groq returned an empty response.', { operation });
    logProviderFailure(error, receiptId, operation);
    throw error;
  }

  const jsonText = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '')
    .trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('Expected a JSON object.');
    }
    return parsed;
  } catch {
    const error = new GroqError('Groq returned invalid JSON.', { operation });
    logProviderFailure(error, receiptId, operation);
    throw error;
  }
}

export async function matchProductWithGemma(product, candidate) {
  const prompt = `Compare the purchased product with the retailer product-page evidence below.

Return ONLY JSON with this shape:
{"equivalent":boolean,"confidence":number,"sameVariant":boolean,"sameCondition":boolean,"reason":"brief evidence-based reason"}

The candidate is a match when it is the same base product and any model, variant, and condition printed on the receipt do not conflict with the page. Package size, count, or minor wording differences (for example "AVOCADOS" versus "Avocados, 5 lb bag") are acceptable for generic grocery items when the receipt gives no conflicting size. A different model, flavor, variant, brand, or used/refurbished condition is not a match. Treat conflicting evidence as false. Do not use price or retailer URL to infer product identity. Do not invent details.

Purchased item:
${JSON.stringify({
    name: product.name || product.product || '',
    brand: product.brand || '',
    model: product.model || '',
    sku: product.sku || '',
    description: product.description || '',
    productLineDetails: product.productLineDetails || '',
    nearbyReceiptText: product.nearbyReceiptText || '',
    ocrText: product.ocrText || '',
    quantity: product.quantity ?? null,
    attributes: product.attributes || product.identityAttributes || [],
    variant: product.variant || '',
    size: product.size || '',
    bundle: product.bundle || '',
    condition: product.condition || ''
  })}

  Retailer page evidence:
  ${JSON.stringify({
    title: candidate.title || '',
    brand: candidate.brand || '',
    model: candidate.model || '',
    sku: candidate.sku || '',
    description: candidate.description || '',
    quantity: candidate.quantity ?? null,
    attributes: candidate.attributes || [],
    variant: candidate.variant || '',
    size: candidate.size || '',
    bundle: candidate.bundle || '',
    condition: candidate.condition || ''
  })}`;

  const parsed = await askGemma(
    prompt,
    [],
    'You compare product identity using only the supplied evidence. Be conservative: conflicting or ambiguous model, variant, or condition evidence is not a match. Return valid JSON only.',
    { operation: 'product_match' }
  );

  const confidence = Number(parsed.confidence);

  if (
    typeof parsed.equivalent !== 'boolean' ||
    typeof parsed.sameVariant !== 'boolean' ||
    typeof parsed.sameCondition !== 'boolean' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error('Groq returned an invalid product-match assessment.');
  }

  return {
    equivalent: parsed.equivalent,
    confidence,
    sameVariant: parsed.sameVariant,
    sameCondition: parsed.sameCondition,
    reason: String(parsed.reason || '').slice(0, 300)
  };
}

export { OLLAMA_MODEL };
