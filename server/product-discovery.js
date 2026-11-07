import axios from 'axios';
import * as cheerio from 'cheerio';

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const SEARCH_HOSTS = new Set([
  'duckduckgo.com',
  'www.duckduckgo.com',
  'html.duckduckgo.com',
  'google.com',
  'www.google.com',
  'bing.com',
  'www.bing.com'
]);

export function parsePublicProductResults(html, { limit = 8 } = {}) {
  const $ = cheerio.load(html);
  const results = [];
  $('.result__a').each((_, element) => {
    if (results.length >= limit) return false;
    const href = $(element).attr('href');
    const title = $(element).text().trim();
    if (!href || !title) return;
    let url;
    try {
      const link = new URL(href, SEARCH_URL);
      if (link.hostname.endsWith('duckduckgo.com') && link.pathname === '/l/') {
        const target = link.searchParams.get('uddg');
        if (target) url = new URL(target);
      } else {
        url = link;
      }
    } catch {
      return;
    }
    if (!url || !['https:', 'http:'].includes(url.protocol) || SEARCH_HOSTS.has(url.hostname.toLowerCase())) {
      return;
    }
    results.push({ url: url.toString(), title });
  });
  const seen = new Set();
  return results.filter(result => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

export async function searchPublicProductPages(query, { limit = 8 } = {}) {
  const response = await axios.get(SEARCH_URL, {
    params: { q: query },
    timeout: 12000,
    maxRedirects: 0,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PriceDropAgent/2.0)',
      Accept: 'text/html'
    }
  });
  return parsePublicProductResults(response.data, { limit });
}

export function retailerMatchesHost(retailer, hostname) {
  const words = String(retailer || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const host = String(hostname || '')
  .toLowerCase()
  .replace(/^www\./, '');
  return words.some(word => word.length >= 3 && host.includes(word));
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function identityTokens(value) {
  return normalized(value).split(/\s+/).filter(token =>
    token.length > 1 && !['with', 'and', 'the', 'for', 'new'].includes(token)
  );
}

export function matchProductCandidate(product, candidate, aiMatch) {
  const brand = String(product.brand || '').trim();
  const model = String(product.model || '').trim();
  const name = String(product.name || product.product || '').trim();
  const candidateText = normalized([
    candidate.title,
    candidate.brand,
    candidate.model,
    candidate.sku,
    candidate.description
  ].join(' '));
  const nameTokens = identityTokens(name);
  const overlap = nameTokens.filter(token => candidateText.includes(token)).length /
    Math.max(1, nameTokens.length);
  const titleMatches = nameTokens.length > 1
    ? overlap >= 0.7
    : overlap === 1 && Boolean(brand || model);
  const brandMatches = !brand || candidateText.includes(normalized(brand));
  const modelMatches = !model || candidateText.includes(normalized(model));
  const priceVerified = candidate.verified === true &&
    String(candidate.currency || '').toUpperCase() === 'USD' &&
    Number.isFinite(Number(candidate.price)) &&
    Number(candidate.price) > 0;
  const confidence = Number(aiMatch?.confidence);
  const aiAccepted = aiMatch?.equivalent === true &&
    aiMatch?.sameVariant === true &&
    aiMatch?.sameCondition === true &&
    Number.isFinite(confidence) &&
    confidence >= 0.9;

  return {
    accepted: titleMatches &&
      brandMatches &&
      modelMatches &&
      aiAccepted,
    priceVerified,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: !titleMatches || !brandMatches || !modelMatches
        ? 'Product title, brand, or model did not match the tracked item.'
        : !aiAccepted
          ? String(aiMatch?.reason || 'Local AI could not confirm an exact product and variant match.')
          : priceVerified
            ? 'Product identity, variant, and condition match the available purchase details.'
            : 'Product identity matches, but the live USD price is not currently verifiable.'
  };
}

export function cheapestVerifiedAlternative(
  product,
  offers,
  now = new Date(),
  maxAgeMs = 48 * 60 * 60 * 1000
) {
  const originalCheckedAt = Date.parse(product.lastCheckedAt || '');
  const freshOffers = offers.filter(offer => {
    const timestamp = Date.parse(offer.lastVerifiedAt || '');
    const retailer = normalized(offer.retailer);
    const originalRetailer = normalized(product.retailer);
    return offer.verified === true &&
      String(offer.currency || '').toUpperCase() === 'USD' &&
      offer.matchConfidence >= 0.8 &&
      Number.isFinite(Number(offer.price)) &&
      Number(offer.price) > 0 &&
      Number.isFinite(Number(product.currentVerifiedPrice)) &&
      Number(offer.price) < Number(product.currentVerifiedPrice) &&
      product.monitoringStatus !== 'PRICE UNAVAILABLE' &&
      product.monitoringStatus !== 'WATCH EXPIRED' &&
      Number.isFinite(originalCheckedAt) &&
      originalCheckedAt <= now.getTime() &&
      now.getTime() - originalCheckedAt <= maxAgeMs &&
      Number.isFinite(timestamp) &&
      timestamp <= now.getTime() &&
      now.getTime() - timestamp <= maxAgeMs &&
      offer.url &&
      retailer !== originalRetailer;
  });
  return freshOffers.sort((left, right) => Number(left.price) - Number(right.price))[0] || null;
}
