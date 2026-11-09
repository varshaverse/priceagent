import axios from 'axios';
import * as cheerio from 'cheerio';
import {
  candidateUrlRejectionReason,
  isSuspiciousProductName,
  retailerSearchQueries,
  searchRetailerWebsite
} from './retailer-browser.js';
import { knownRetailerDomain } from './retailers.js';
import { sanitizeErrorText } from './errors.js';

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

function normalizedRetailerKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => !/^\d+$/.test(word))
    .filter(word => ![
      'the', 'and', 'of', 'at', 'inc', 'incorporated', 'llc', 'ltd',
      'limited', 'corp', 'corporation', 'company', 'store', 'stores',
      'wholesale', 'marketplace', 'services', 'online', 'retail',
      'com', 'net', 'org'
    ].includes(word))
    .filter(word => word.length > 2)
    .join('');
}

export function retailerMatchesHost(retailer, hostname) {
  const retailerKey = normalizedRetailerKey(retailer);
  const domainLabels = registrableDomain(hostname).split('.').slice(0, -1);
  const domainText = domainLabels.join('');
  const retailerWords = String(retailerKey || '')
    .match(/[a-z0-9]+/g) || [];

  return Boolean(retailerKey) && (
    domainLabels.some(label => retailerWords.includes(label)) ||
    domainText === retailerKey
  );
}

export function registrableDomain(hostname) {
  const labels = String(hostname || '').toLowerCase().replace(/^www\./, '').split('.');
  if (labels.length < 2) return '';
  const suffix = labels.slice(-2).join('.');
  const multiLabelSuffixes = new Set([
    'co.uk', 'org.uk', 'com.au', 'net.au', 'co.nz', 'com.br',
    'com.mx', 'co.jp', 'co.in', 'com.sg', 'com.tr'
  ]);
  return labels.slice(multiLabelSuffixes.has(suffix) ? -3 : -2).join('.');
}

function isWithinDomain(hostname, domain) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const root = String(domain || '').toLowerCase().replace(/^www\./, '');
  return Boolean(root) && (host === root || host.endsWith(`.${root}`));
}

export function isRetailerDomain(hostname, domain) {
  return isWithinDomain(hostname, domain);
}

export function saveVerifiedProductMatch(product, match) {
  product.url = match.url;
  product.originalUrlVerified = true;
  product.discoveryStatus = 'matched';
  product.monitoringStatus = 'URL VERIFIED';
  product.matchConfidence = match.matchConfidence ?? match.confidence ?? 0;
  product.matchEvidence = match.matchEvidence || match.reason || '';
  product.currentVerifiedPrice = match.priceVerified ? Number(match.price) : null;
  product.currentPrice = product.currentVerifiedPrice;
  product.lastError = null;
  return product;
}

// Best verified listing: prefer entries with a verified price, then the lowest
// price, then the highest identity confidence.
export function selectBestProductMatch(matches) {
  return [...matches].sort((left, right) => {
    const leftPrice = left.priceVerified ? Number(left.price) : Infinity;
    const rightPrice = right.priceVerified ? Number(right.price) : Infinity;
    if (leftPrice !== rightPrice) return leftPrice - rightPrice;
    return Number(right.matchConfidence || 0) - Number(left.matchConfidence || 0);
  })[0] || null;
}

export function saveFoundProductUrl(product, url) {
  product.url = url;
  product.originalUrlVerified = false;
  product.discoveryStatus = 'found';
  product.monitoringStatus = 'URL FOUND';
  product.lastError = null;
  return product;
}

export function saveFoundUrlBeforeVerification(product, url, verify) {
  saveFoundProductUrl(product, url);
  return verify();
}

export async function resolveOfficialRetailerDomain(
  retailer,
  search = searchPublicProductPages,
  logger = console.info
) {
  const knownDomain = knownRetailerDomain(retailer);
  if (knownDomain) {
    logger('[product-discovery]', JSON.stringify({
      event: 'retailer_resolved',
      retailer,
      domain: knownDomain
    }));
    return knownDomain;
  }
  const query = `${retailer} official website`;
  logger('[product-discovery]', JSON.stringify({
    event: 'retailer_domain_search',
    retailer,
    query,
    searchUrl: SEARCH_URL
  }));
  const retailerResults = await search(query, { limit: 8 });
  logger('[product-discovery]', JSON.stringify({
    event: 'retailer_domain_results',
    retailer,
    candidateUrls: retailerResults.map(result => result.url)
  }));
  const officialResult = retailerResults.find(result => {
    try {
      return retailerMatchesHost(retailer, new URL(result.url).hostname);
    } catch {
      return false;
    }
  });
  return officialResult
    ? registrableDomain(new URL(officialResult.url).hostname)
    : '';
}

export async function searchRetailerProductPages(
  retailer,
  product,
  search = searchPublicProductPages,
  searchWebsite = searchRetailerWebsite,
  logger = console.info
) {
  let domain = String(product.officialRetailerDomain || '')
    .toLowerCase()
    .replace(/^www\./, '');

  if (domain && !retailerMatchesHost(retailer, domain) &&
    knownRetailerDomain(retailer) !== domain) domain = '';
  if (!domain) {
    domain = await resolveOfficialRetailerDomain(retailer, search, logger);
  }

  if (!domain) return { domain: '', results: [] };

  const queries = retailerSearchQueries(product);
  if (!queries.length) return { domain, results: [] };

  const inDomain = list => list.filter(result => {
    try {
      return isWithinDomain(new URL(result.url).hostname, domain) &&
        !candidateUrlRejectionReason(result.url, domain, result.title);
    } catch {
      return false;
    }
  });

  let results = [];
  try {
    results = inDomain(await searchWebsite({ retailer, domain, product, logger }));
  } catch (error) {
    logger('[product-discovery]', JSON.stringify({
      event: 'retailer_search_failed',
      retailer,
      domain,
      reason: sanitizeErrorText(error.message)
    }));
  }

  // A public search engine is used only to find pages on the retailer's own domain.
  if (!results.length) {
    const seen = new Map();
    for (const query of queries.slice(0, 2)) {
      try {
        const publicQuery = `site:${domain} ${query}`;
        logger('[product-discovery]', JSON.stringify({
          event: 'public_search_fallback',
          retailer,
          query: publicQuery
        }));
        for (const result of inDomain(await search(publicQuery, { limit: 8 }))) {
          if (!seen.has(result.url)) seen.set(result.url, result);
        }
      } catch (error) {
        logger('[product-discovery]', JSON.stringify({
          event: 'public_search_failed',
          retailer,
          reason: sanitizeErrorText(error.message)
        }));
      }
      if (seen.size) break;
    }
    results = [...seen.values()];
  }

  return { domain, results };
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function identityTokens(value) {
  return [...new Set(normalized(value).split(/\s+/).filter(token =>
    token.length > 1 && !['with', 'and', 'the', 'for', 'new'].includes(token)
  ))];
}

function similarToken(left, right) {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 4 ||
    Math.abs(left.length - right.length) > 2) return false;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length) >= 0.78;
}

function textMatchesIdentity(value, candidateText) {
  const wanted = identityTokens(value);
  const available = identityTokens(candidateText);
  return wanted.length > 0 &&
    wanted.every(token => available.some(candidate => similarToken(token, candidate)));
}

export function matchProductCandidate(product, candidate, aiMatch) {
  const brand = String(product.brand || '').trim();
  const model = String(product.model || '').trim();
  const name = String(product.name || product.product || '').trim();
  const identityName = isSuspiciousProductName(name)
    ? [
      product.brand,
      product.model,
      product.description,
      product.productLineDetails,
      product.nearbyReceiptText,
      product.ocrText,
      product.sku
    ].filter(Boolean).join(' ')
    : name;
  const candidateText = normalized([
    candidate.title,
    candidate.brand,
    candidate.model,
    candidate.sku,
    candidate.description
  ].join(' '));
  const nameTokens = identityTokens(identityName);
  const candidateTokens = identityTokens(candidateText);
  const overlap = nameTokens.filter(token =>
    candidateTokens.some(candidateToken => similarToken(token, candidateToken))
  ).length /
    Math.max(1, nameTokens.length);
  const titleMatches = overlap >= 0.7;
  const brandMatches = !brand || textMatchesIdentity(brand, candidateText);
  const modelMatches = !model || candidateText.includes(normalized(model));
  const sku = normalized(product.sku);
  const candidateSku = normalized(candidate.sku);
  const skuMatches = !sku || sku === candidateSku;
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

  const aiUnavailable = aiMatch == null;
  const strongIdentity = titleMatches && brandMatches && (
    (model && modelMatches) || (sku && candidateSku && skuMatches)
  );
  const identityMatches = titleMatches && brandMatches && modelMatches && skuMatches;

  return {
    accepted: identityMatches &&
      (aiAccepted || (aiUnavailable && Boolean(strongIdentity))),
    priceVerified,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: !identityMatches
        ? 'Product title, brand, or model did not match the tracked item.'
        : aiUnavailable && !strongIdentity
          ? 'Product identity could not be confirmed without a matching model or SKU. The agent will retry automatically.'
          : !aiAccepted && !aiUnavailable
          ? String(aiMatch?.reason || 'The product page could not be confirmed as an exact product and variant match.')
          : priceVerified
            ? 'Product identity, variant, and condition match the available purchase details.'
            : 'Product identity matches, but the live USD price is not currently verifiable.'
  };
}

export async function compareProductIdentity(product, candidate, compareWithAI) {
  const preliminary = matchProductCandidate(product, candidate, null);
  if (preliminary.reason.startsWith('Product title, brand, or model did not match')) {
    return { match: preliminary, aiMatch: null, identityComparisonSkipped: true };
  }
  const aiMatch = await compareWithAI(product, candidate);
  return {
    match: matchProductCandidate(product, candidate, aiMatch),
    aiMatch,
    identityComparisonSkipped: false
  };
}

function buildRetailerSearchQuery(product) {
  const retailer = String(product.retailer || '').toLowerCase();
  const normalizedRetailer = retailer
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join('');

  const retailerDomains = {
    costco: 'costco.com',
    walmart: 'walmart.com',
    target: 'target.com',
    amazon: 'amazon.com',
    bestbuy: 'bestbuy.com',
    homedepot: 'homedepot.com'
  };

  const domain = Object.entries(retailerDomains)
    .find(([name]) => normalizedRetailer.includes(name))?.[1];

  const productName = [
    product.brand,
    product.name || product.product,
    product.model,
    product.sku
  ]
    .filter(Boolean)
    .join(' ');

  return domain
    ? `site:${domain} "${productName}"`
    : `"${productName}" ${product.retailer}`;
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
