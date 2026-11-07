const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434')
  .replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b';
const RECEIPT_SYSTEM_PROMPT = 'You are PriceDrop Agent running locally. Extract only details supported by the provided receipt. Never invent prices, brands, dates, URLs, or product details. Return valid JSON only.';

async function ollamaRequest(endpoint, options = {}) {
  let response;
  try {
    response = await fetch(`${OLLAMA_URL}${endpoint}`, {
      ...options,
      signal: AbortSignal.timeout(options.timeout || 120000)
    });
  } catch (error) {
    throw new Error(
      `Could not connect to Ollama at ${OLLAMA_URL}. Make sure Ollama is running. ${error.message}`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Ollama returned ${response.status}: ${body.slice(0, 500)}`
    );
  }

  return response;
}

export async function getLocalAIStatus() {
  if (AI_PROVIDER !== 'ollama') {
    return {
      provider: AI_PROVIDER,
      model: OLLAMA_MODEL,
      connected: false,
      modelAvailable: false,
      error: `Unsupported AI_PROVIDER "${AI_PROVIDER}". Set AI_PROVIDER=ollama.`
    };
  }

  try {
    const response = await ollamaRequest('/api/tags', { timeout: 5000 });
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const modelAvailable = models.some(model =>
      model.name === OLLAMA_MODEL ||
      model.name === `${OLLAMA_MODEL}:latest` ||
      model.name?.split(':')[0] === OLLAMA_MODEL.split(':')[0] &&
        OLLAMA_MODEL.endsWith(':latest')
    );

    return {
      provider: AI_PROVIDER,
      model: OLLAMA_MODEL,
      connected: true,
      modelAvailable
    };
  } catch (error) {
    return {
      provider: AI_PROVIDER,
      model: OLLAMA_MODEL,
      connected: false,
      modelAvailable: false,
      error: error.message
    };
  }
}

export async function askGemma(prompt, images = [], systemPrompt = RECEIPT_SYSTEM_PROMPT) {
  const status = await getLocalAIStatus();
  if (!status.connected) {
    throw new Error(status.error);
  }
  if (!status.modelAvailable) {
    throw new Error(
      `Ollama is running but model "${OLLAMA_MODEL}" is not installed. Run: ollama pull ${OLLAMA_MODEL}`
    );
  }

  const response = await ollamaRequest('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 300000,
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: 'json',
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        {
          role: 'user',
          content: prompt,
          ...(images.length ? { images } : {})
        }
      ],
      options: { temperature: 0 }
    })
  });

  const data = await response.json();
  const content = data.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Ollama returned an empty response.');
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error('Ollama returned invalid JSON.');
  }
}

export async function matchProductWithGemma(product, candidate) {
  const prompt = `Compare the purchased product with the retailer product-page evidence below.
Return ONLY JSON with this shape:
{"equivalent":boolean,"confidence":number,"sameVariant":boolean,"sameCondition":boolean,"reason":"brief evidence-based reason"}

The candidate is a match only when it is the same product, model, size/bundle/variant, and condition. Treat missing or conflicting evidence as false. Do not use the price or retailer URL to infer product identity. Do not invent details.
Purchased item: ${JSON.stringify({
    name: product.name || product.product || '',
    brand: product.brand || '',
    model: product.model || '',
    attributes: product.attributes || product.identityAttributes || []
  })}
Retailer page evidence: ${JSON.stringify({
    title: candidate.title || '',
    brand: candidate.brand || '',
    model: candidate.model || '',
    sku: candidate.sku || '',
    description: candidate.description || ''
  })}`;
  const parsed = await askGemma(
    prompt,
    [],
    'You compare product identity using only the supplied evidence. Be conservative: missing, ambiguous, or conflicting model/variant/condition information is not a match. Return valid JSON only.'
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
    throw new Error('Ollama returned an invalid product-match assessment.');
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
