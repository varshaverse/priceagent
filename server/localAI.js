import 'dotenv/config';

const AI_PROVIDER = 'groq';

const GROQ_URL = (
  process.env.GROQ_URL || 'https://api.groq.com/openai/v1'
).replace(/\/+$/, '');

const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim();

const GROQ_MODEL =
  process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

// This export name is kept for compatibility with the existing server/index.js.
const OLLAMA_MODEL = GROQ_MODEL;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

// Small output budgets keep requests under Groq's output-tokens-per-minute limit.
const RECEIPT_MAX_TOKENS = positiveInteger(process.env.GROQ_RECEIPT_MAX_TOKENS, 900);
const MATCH_MAX_TOKENS = positiveInteger(process.env.GROQ_MATCH_MAX_TOKENS, 200);
const MAX_RATE_LIMIT_RETRIES = positiveInteger(process.env.GROQ_MAX_RETRIES, 3);
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 20000;

export class GroqError extends Error {
  constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
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

const RECEIPT_SYSTEM_PROMPT =
  'You are PriceDrop Agent. Extract only details supported by the provided receipt. Never invent prices, brands, dates, URLs, or product details. Return valid JSON only.';

async function groqRequest(endpoint, options = {}) {
  const { fetchImpl = fetch, ...fetchOptions } = options;
  if (!GROQ_API_KEY) {
    throw new Error(
      'GROQ_API_KEY is missing. Add a real Groq API key to the .env file.'
    );
  }

  const requestUrl = `${GROQ_URL}${endpoint}`;

  let response;

  try {
    response = await fetchImpl(requestUrl, {
      ...fetchOptions,
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        ...(fetchOptions.headers || {})
      },
      signal: AbortSignal.timeout(fetchOptions.timeout || 120000)
    });
  } catch (error) {
    throw new GroqError(
      `Could not connect to Groq at ${requestUrl}. ${error.message}`
    );
  }

  if (!response.ok) {
    const body = await response.text();

    throw new GroqError(
      `Groq returned ${response.status}: ${body.slice(0, 500)}`,
      { status: response.status, retryAfterMs: retryAfterMilliseconds(response) }
    );
  }

  return response;
}

export async function getLocalAIStatus() {
  try {
    const response = await groqRequest('/models', {
      method: 'GET',
      timeout: 10000
    });

    const data = await response.json();
    const models = Array.isArray(data.data) ? data.data : [];
    const modelAvailable = models.some(model => model.id === GROQ_MODEL);

    return {
      provider: AI_PROVIDER,
      model: GROQ_MODEL,
      connected: true,
      modelAvailable,
      error: modelAvailable
        ? ''
        : `Groq is connected, but model "${GROQ_MODEL}" was not found.`
    };
  } catch (error) {
    return {
      provider: AI_PROVIDER,
      model: GROQ_MODEL,
      connected: false,
      modelAvailable: false,
      error: error.message
    };
  }
}

function imageToDataUrl(image) {
  if (typeof image !== 'string' || !image.trim()) {
    return null;
  }

  if (image.startsWith('data:image/')) {
    return image;
  }

  return `data:image/jpeg;base64,${image}`;
}

export async function askGemma(
  prompt,
  images = [],
  systemPrompt = RECEIPT_SYSTEM_PROMPT,
  {
    maxTokens = RECEIPT_MAX_TOKENS,
    fetchImpl = fetch,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    maxRetries = MAX_RATE_LIMIT_RETRIES,
    logger = console.warn
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
    method: 'POST',
    timeout: 300000,
    fetchImpl,
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: maxTokens,
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
    })
  };

  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await groqRequest('/chat/completions', requestOptions);
      break;
    } catch (error) {
      if (error.status !== 429 || attempt >= maxRetries) throw error;
      const delay = groqBackoffDelayMs(attempt, error.retryAfterMs);
      logger(`Groq rate limited (429); retrying in ${delay} ms (attempt ${attempt + 1} of ${maxRetries}).`);
      await sleep(delay);
    }
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new GroqError('Groq returned an empty response.');
  }

  const jsonText = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, '')
    .trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new GroqError('Groq returned invalid JSON.');
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
    { maxTokens: MATCH_MAX_TOKENS }
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
