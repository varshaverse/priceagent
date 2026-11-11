import { chromium } from 'playwright';
import { extractRetailerProductPage } from './retailer-page.js';
import { sanitizeErrorText } from './errors.js';

const SEARCH_INPUT_SELECTORS = [
  'input[type="search"]',
  'input[name="q"]',
  'input[name="query"]',
  'input[name*="search" i]',
  'input[aria-label*="search" i]',
  'input[placeholder*="search" i]',
  '[role="search"] input'
];

const SEARCH_PATHS = [
  (query) => `/search?q=${encodeURIComponent(query)}`,
  (query) => `/search?query=${encodeURIComponent(query)}`,
  (query) => `/search?keyword=${encodeURIComponent(query)}`,
  (query) => `/?q=${encodeURIComponent(query)}`
];

const EXCLUDED_PATH = /(?:^|[\/._-])(?:search|s|c|browse|departments?|category|categories|collections|brands|cart|shopcartdisplay|checkout|account|login|logonform|signin|sign-in|orderstatuscmd|order-status|orders?|warehouse-locations?|locations?|store-locations?|store-locator|concierge|support|help|customer-service|privacy|policy|terms|returns?|costco-app|photo|photocenter)(?=$|[\/._-])/i;

const PRODUCT_PATH = /(?:\.product\.\d+(?:\.html)?$|\.html$|\/(?:p|product|products|item|dp|gp\/product|ip)\/[^/]+(?:\/|$))/i;
const PRODUCT_CARD_SELECTOR = [
  '[data-testid*="product-card" i]',
  '[data-testid*="product-tile" i]',
  '[data-automation-id*="product-card" i]',
  '[data-product-id]',
  '[data-item-id]',
  '[class*="product-card" i]',
  '[class*="product-tile" i]',
  '[class*="producttile" i]',
  '[itemtype$="/Product"][itemscope]'
].join(', ');

export function navigationUrlRejectionReason(value, title = '') {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Candidate URL is invalid.';
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return 'Candidate path is malformed.';
  }
  const query = url.searchParams;
  if (
    EXCLUDED_PATH.test(pathname) ||
    /^(?:cart|photo|orders?(?:\s*(?:&|and)\s*returns?)?|sign\s*in|log\s*in|support|help|store\s*locations?)$/i.test(String(title).trim()) ||
    [...query.keys()].some(key => /^(?:q|query|keyword|searchterm|search|k)$/i.test(key))
  ) {
    return 'Candidate is a search, login, order, policy, location, support, or navigation page.';
  }
  return '';
}

export function candidateUrlRejectionReason(value, domain, title = '') {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Candidate URL is invalid.';
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return 'Candidate URL is not HTTP(S).';
  }
  if (!isRetailerDomain(url.hostname, domain)) {
    return 'Candidate belongs to a different retailer.';
  }
  const navigationReason = navigationUrlRejectionReason(value, title);
  if (navigationReason) return navigationReason;
  const pathname = url.pathname.toLowerCase();
  const isCostco = String(domain).toLowerCase().replace(/^www\./, '') === 'costco.com';
  if (isCostco ? !pathname.replace(/\//g, '') : !PRODUCT_PATH.test(pathname)) {
    return 'URL does not contain product-page path evidence.';
  }
  if (!String(title || '').trim()) {
    return 'Candidate link has no product title.';
  }
  return '';
}

export function productPageEvidenceRejectionReason(candidate) {
  if (
    !String(candidate?.title || '').trim() ||
    candidate.productTitle !== true
  ) {
    return 'Page has no product title.';
  }
  const hasProductEvidence = candidate.productSchema === true ||
    candidate.productSku === true ||
    candidate.addToCart === true ||
    candidate.verified === true ||
    candidate.productDetails === true;
  if (!hasProductEvidence) {
    return 'Page has no product schema, SKU, add-to-cart control, verified price, or product details.';
  }
  return '';
}

function isRetailerDomain(hostname, domain) {
  const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
  const root = String(domain || '').toLowerCase().replace(/^www\./, '');
  return Boolean(root) && (host === root || host.endsWith(`.${root}`));
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function cleanRetailerSearchText(value) {
  return String(value || '')
    .replace(/^[\s/\\|*#]+/, '')
    .replace(/[€£$]\s*\d[\d,]*(?:\.\d{1,2})?/g, ' ')
    .replace(/\b\d[\d,]*\.\d{1,2}\b(?!\s*(?:oz|ounce|ounces|lb|lbs|pound|pounds|g|kg|ml|l|liter|litre)\b)/gi, ' ')
    .replace(/\b(?:sales\s+tax|tax|subtotal|sub-total|total|price|prices|discount|disc|coupon|promo|markdown|savings|balance\s+due|amount\s+due|receipt|each|ea)\b/gi, ' ')
    .replace(/\b(?:qty|quantity|item|sku|upc|item\s*no\.?)\b\s*#?\s*\d{3,}\b/gi, ' ')
    .replace(/\b(?:qty|quantity|item|sku|upc|item\s*no\.?)\b/gi, ' ')
    .replace(/\b(?:usd|cad|eur|gbp)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function productResultEvidenceRejectionReason(candidate) {
  const evidence = [
    Boolean(String(candidate?.title || '').trim()),
    candidate?.image === true,
    candidate?.price === true,
    candidate?.addToCart === true,
    candidate?.productSku === true,
    candidate?.productDetails === true,
    candidate?.productSchema === true,
    candidate?.canonicalProductUrl === true
  ];
  const count = evidence.filter(Boolean).length;
  return count >= 2
    ? ''
    : `Product result has fewer than two product-specific evidence signals (${count}/8).`;
}

export function retailerSearchQueries(product) {
  const name = cleanRetailerSearchText(product.name || product.product)
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const brand = cleanRetailerSearchText(product.brand);
  const model = cleanRetailerSearchText(product.model);
  const sku = cleanRetailerSearchText(product.sku);
  const supportingDetails = [
    product.size,
    product.variant,
    product.bundle,
    product.condition,
    product.description
  ].map(cleanRetailerSearchText).filter(Boolean);
  const identityDetails = [
    ...supportingDetails,
    cleanRetailerSearchText(product.quantity)
  ].filter(Boolean);
  const simplifiedName = (isSuspiciousProductName(name) ? '' : name)
    .replace(/\b(?:qty|quantity|item|sku)\s*#?\s*[a-z0-9-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const attributes = [
    ...(Array.isArray(product.attributes) ? product.attributes : []),
    ...(Array.isArray(product.identityAttributes) ? product.identityAttributes : [])
  ].map(cleanRetailerSearchText).filter(Boolean);
  const suspiciousName = isSuspiciousProductName(name);
  const meaningfulName = suspiciousName ? '' : name;
  const suspiciousTokens = new Set(
    suspiciousName ? normalized(name).split(/\s+/) : []
  );
  const receiptEvidence = [
    product.productLineDetails,
    product.nearbyReceiptText,
    product.ocrText
  ].map(cleanRetailerSearchText)
    .map(value => suspiciousName
      ? value.split(/\s+/)
        .filter(token => !suspiciousTokens.has(normalized(token)))
        .join(' ')
      : value)
    .filter(Boolean);

  const queries = [
    meaningfulName,
    simplifiedName,
    [brand, model].filter(Boolean).join(' '),
    [brand, meaningfulName].filter(Boolean).join(' '),
    [brand, model, meaningfulName].filter(Boolean).join(' '),
    sku,
    ...identityDetails,
    ...attributes,
    ...receiptEvidence,
    [brand, product.description, ...receiptEvidence].filter(Boolean).join(' '),
    [product.retailer, meaningfulName].filter(Boolean).join(' '),
    ...meaningfulName.split(/\s+/).filter(token => token.length > 2),
    ...receiptEvidence.flatMap(value =>
      String(value).split(/\s+/).filter(token => token.length > 2)
    )
  ].map(cleanRetailerSearchText)
    .filter(query => /[a-z]/i.test(query) || (query === sku && /^\d{4,}$/.test(sku)));

  const seen = new Set();
  return queries
    .map(query => query.slice(0, 240))
    .filter(query => {
      const key = query.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function isSuspiciousProductName(value) {
  const name = normalized(value);
  if (!name || /^(?:unknown|item|product|merchandise)(?:\s+(?:unknown|item|product|merchandise))?$/.test(name)) {
    return true;
  }
  const tokens = name.split(/\s+/);
  return tokens.length <= 3 &&
    tokens.length > 1 &&
    new Set(tokens).size === 1;
}

function rankCandidate(candidate, product) {
  const candidateText = normalized(cleanRetailerSearchText(
    `${candidate.title} ${candidate.details || ''} ${candidate.url}`
  ));
  const productName = String(product.name || product.product || '');
  const identifyingText = [
    isSuspiciousProductName(productName) ? '' : productName,
    product.brand,
    product.model,
    product.sku,
    product.description,
    product.productLineDetails,
    product.nearbyReceiptText,
    product.ocrText,
    ...(Array.isArray(product.attributes) ? product.attributes : []),
    ...(Array.isArray(product.identityAttributes) ? product.identityAttributes : [])
  ].filter(Boolean).map(cleanRetailerSearchText).filter(Boolean).join(' ');
  const tokens = normalized([
    identifyingText
  ].join(' ')).split(/\s+/).filter(token => token.length > 2);
  if (!tokens.length) return 0;
  const score = token => {
    if (candidateText.includes(token)) return 1;
    const candidateTokens = candidateText.split(/\s+/);
    return Math.max(0, ...candidateTokens.map(value => {
      if (Math.abs(value.length - token.length) > 2) return 0;
      const previous = Array.from({ length: value.length + 1 }, (_, index) => index);
      for (let row = 1; row <= token.length; row++) {
        let diagonal = previous[0];
        previous[0] = row;
        for (let column = 1; column <= value.length; column++) {
          const above = previous[column];
          previous[column] = Math.min(
            previous[column] + 1,
            previous[column - 1] + 1,
            diagonal + (token[row - 1] === value[column - 1] ? 0 : 1)
          );
          diagonal = above;
        }
      }
      return 1 - previous[value.length] / Math.max(token.length, value.length);
    }));
  };
  const scores = tokens.map(score);
  const threshold = tokens.length === 1 ? 0.7 : 0.45;
  return scores.filter(value => value >= threshold).length / tokens.length;
}

function candidateMatchesProductKeywords(candidate, product) {
  const name = cleanRetailerSearchText(product.name || product.product);
  const keywords = normalized(
    isSuspiciousProductName(name)
      ? [
        product.brand,
        product.model,
        product.description,
        product.productLineDetails,
        product.nearbyReceiptText,
        product.ocrText
      ].filter(Boolean).map(cleanRetailerSearchText).join(' ')
      : name
  ).split(/\s+/).filter(token => token.length > 2);
  if (!keywords.length) return rankCandidate(candidate, product) > 0;
  const text = normalized(cleanRetailerSearchText(
    `${candidate.title} ${candidate.details || ''}`
  ));
  const available = text.split(/\s+/);
  const matched = keywords.filter(keyword =>
    available.some(token => searchTokensMatch(keyword, token))
  ).length;
  return matched >= (keywords.length === 1 ? 1 : Math.ceil(keywords.length * 0.6));
}

function searchTokensMatch(left, right) {
  const singular = value => value.replace(/s$/, '');
  if (left === right || singular(left) === singular(right)) return true;
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

async function validateRequest(route, validateUrl) {
  const requestUrl = route.request().url();
  if (!/^https?:\/\//i.test(requestUrl)) {
    await route.abort();
    return;
  }
  try {
    await validateUrl(requestUrl);
    await route.continue();
  } catch {
    await route.abort();
  }
}

async function goto(page, url, validateUrl) {
  await validateUrl(url);
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 20000
  });
  if (response && !response.ok()) return false;
  await validateUrl(page.url());
  return true;
}

async function closeBrowserResources(page, context, browser, operationError) {
  const failures = [];
  for (const resource of [page, context, browser]) {
    if (typeof resource?.close !== 'function') continue;
    try {
      await resource.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;

  const cleanupError = new AggregateError(
    failures,
    'Could not close all Playwright resources.'
  );
  if (operationError) {
    console.error('Playwright cleanup failed after an operation error:', cleanupError.message);
    return;
  }
  throw cleanupError;
}

async function findSearchInput(page) {
  for (const selector of SEARCH_INPUT_SELECTORS) {
    const input = page.locator(selector).first();
    if (await input.count() && await input.isVisible().catch(() => false)) {
      return input;
    }
  }
  return null;
}

async function acceptCookiePrompt(page) {
  const consent = page.getByRole('button', {
    name: /^(?:accept(?: all(?: cookies)?)?|allow all(?: cookies)?|agree|i agree|allow cookies)$/i
  });
  for (let index = 0; index < await consent.count(); index++) {
    const button = consent.nth(index);
    if (await button.isVisible()) {
      await button.click({ timeout: 3000 });
      break;
    }
  }
}

export async function prepareCostcoResults(page, log = console.info) {
  try {
    await page.waitForLoadState('load', { timeout: 10000 });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    log({ event: 'search_load_timeout', searchUrl: page.url() });
  }
  await acceptCookiePrompt(page);
  try {
    await page.waitForFunction(selector => {
      if (document.querySelector(selector)) return true;
      const hasProduct = value => {
        if (Array.isArray(value)) return value.some(hasProduct);
        if (!value || typeof value !== 'object') return false;
        const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
        return types.some(type => /(?:^|[/#])product$/i.test(String(type || ''))) ||
          Object.values(value).some(hasProduct);
      };
      return [...document.querySelectorAll('script[type="application/ld+json"]')].some(script => {
        try { return hasProduct(JSON.parse(script.textContent)); } catch { return false; }
      });
    }, PRODUCT_CARD_SELECTOR, { timeout: 8000 });
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    log({ event: 'product_results_timeout', searchUrl: page.url() });
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
}

export async function readProductLinks(page, domain, onRejected = () => {}) {
  const links = await page.locator('a[href]').evaluateAll((anchors, cardSelector) => {
    const cards = anchors.filter(anchor => anchor.closest(cardSelector)).map(anchor => ({
      url: anchor.href,
      title: (
        anchor.innerText ||
        anchor.getAttribute('aria-label') ||
        anchor.getAttribute('title') ||
        anchor.querySelector('img')?.getAttribute('alt') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim(),
      ...(() => {
        const card = anchor.closest(cardSelector);
        const cardText = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
        const canonical = card?.querySelector('link[rel="canonical"]')?.href || '';
        let productSchema = false;
        try {
          productSchema = [...(card?.querySelectorAll('script[type="application/ld+json"]') || [])]
            .some(script => /"@type"\s*:\s*"?Product/i.test(script.textContent || ''));
        } catch {}
        return {
          image: Boolean(card?.querySelector('img[src], img[alt]')),
          price: Boolean(
            card?.querySelector('[itemprop="price"], [data-testid*="price" i], [class*="price" i]') ||
            /(?:\$|USD)\s*\d[\d,]*(?:\.\d{1,2})?/i.test(cardText)
          ),
          addToCart: /add to (?:cart|bag)|buy now/i.test(cardText),
          productSku: Boolean(
            card?.querySelector('[itemprop="sku"], [itemprop="mpn"], [data-testid*="sku" i]') ||
            /\b(?:sku|item\s*(?:number|#))\s*[:#-]?\s*[a-z0-9-]+/i.test(cardText)
          ),
          productDetails: Boolean(card?.querySelector(
            '[itemprop="description"], [data-testid*="description" i], [class*="description" i]'
          )),
          productSchema,
          canonicalProductUrl: Boolean(canonical && canonical === anchor.href),
          details: cardText
        };
      })()
    }));
    const structured = [];
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
      if (types.some(type => /(?:^|[/#])product$/i.test(String(type || '')))) {
        const offer = Array.isArray(value.offers) ? value.offers[0] : value.offers;
        const target = value.url || offer?.url;
        if (typeof target === 'string' && typeof value.name === 'string') {
          try {
            structured.push({
              url: new URL(target, document.baseURI).href,
              title: value.name.trim(),
              productSchema: true
            });
          } catch {}
        }
      }
      Object.values(value).forEach(visit);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(script.textContent)); } catch {}
    }
    return [...cards, ...structured];
  }, PRODUCT_CARD_SELECTOR);
  const unique = new Map();
  for (const link of links) {
    try {
      const url = new URL(link.url);
      url.hash = '';
      const candidate = { url: url.toString(), title: link.title };
      const rejectionReason = candidateUrlRejectionReason(
        candidate.url,
        domain,
        candidate.title
      );
      const evidenceCandidate = { ...link, ...candidate };
      const evidenceRejection = productResultEvidenceRejectionReason(evidenceCandidate);
      if (rejectionReason || candidate.title.length > 300 || evidenceRejection) {
        onRejected(
          evidenceCandidate,
          rejectionReason ||
            (candidate.title.length > 300
              ? 'Candidate link title is too long.'
              : evidenceRejection)
        );
        continue;
      }
      unique.set(candidate.url, evidenceCandidate);
    } catch {
      onRejected(link, 'Candidate URL is invalid.');
      continue;
    }
  }
  return [...unique.values()];
}

async function nextPageUrl(page, domain) {
  const links = await page.locator('a[href]').evaluateAll(anchors =>
    anchors
      .filter(anchor =>
        anchor.rel === 'next' ||
        /^(next|next page|more results|›|»|→)$/i.test(
          (anchor.innerText || anchor.getAttribute('aria-label') || '').trim()
        )
      )
      .map(anchor => anchor.href)
  );
  return links.find(href => {
    try {
      return isRetailerDomain(new URL(href).hostname, domain);
    } catch {
      return false;
    }
  }) || '';
}

function searchUrls(domain, retailer, query) {
  const hostname = domain.toLowerCase();
  const encoded = encodeURIComponent(query);
  const lowerRetailer = String(retailer || '').toLowerCase();
  if (lowerRetailer.includes('walmart') || hostname.includes('walmart.')) {
    return [`https://${domain}/search?q=${encoded}`];
  }
  if (lowerRetailer.includes('target') || hostname.includes('target.')) {
    return [`https://${domain}/s?searchTerm=${encoded}`];
  }
  if (lowerRetailer.includes('amazon') || hostname.includes('amazon.')) {
    return [`https://${domain}/s?k=${encoded}`];
  }
  if (lowerRetailer.includes('costco') || hostname.includes('costco.')) {
    return [`https://${domain}/s?keyword=${encoded}`];
  }
  return SEARCH_PATHS.map(buildPath => `https://${domain}${buildPath(query)}`);
}

export async function searchRetailerWebsite({
  retailer,
  domain,
  product,
  launchBrowser = () => chromium.launch({ headless: true }),
  validateUrl = async () => {},
  logger = console.info
}) {
  if (!domain || !retailer || !product) {
    throw new Error('Retailer, official domain, and product details are required for browser discovery.');
  }
  const queries = retailerSearchQueries(product);
  if (!queries.length) return [];
  const isCostco = domain.toLowerCase().replace(/^www\./, '') === 'costco.com';

  const browser = await launchBrowser();
  let context;
  let page;
  let operationError;
  const results = new Map();
  const log = entry => {
    try {
      logger('[product-discovery]', JSON.stringify(entry));
    } catch (error) {
      console.error('Could not write product-discovery log:', error.message);
    }
  };
  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; PriceDropAgent/2.0)'
    });
    page = await context.newPage();
    await page.route('**/*', route => validateRequest(route, validateUrl));
    log({
      event: 'attempt_started',
      retailer,
      product: product.name || product.product || '',
      queries
    });

    const homeUrl = `https://${domain}/`;
    try {
      await goto(page, homeUrl, validateUrl);
      if (isCostco) await acceptCookiePrompt(page);
    } catch {
      // Some retailers block their homepage while still serving direct search pages.
    }
    for (const query of queries) {
      let searchedWithForm = false;
      try {
        const searchInput = await findSearchInput(page);
        if (searchInput) {
          await searchInput.fill(query);
          if (isCostco) {
            const previousUrl = page.url();
            await Promise.all([
              page.waitForURL(url => url.toString() !== previousUrl, { timeout: 8000 }),
              searchInput.press('Enter')
            ]);
          } else {
            await searchInput.press('Enter');
          }
          try {
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
          } catch (error) {
            if (error.name !== 'TimeoutError') throw error;
            log({ event: 'search_dom_load_timeout', retailer, query });
          }
          await validateUrl(page.url());
          if (!isRetailerDomain(new URL(page.url()).hostname, domain)) {
            throw new Error('Search navigated away from the original retailer.');
          }
          if (isCostco) await prepareCostcoResults(page, log);
          else await page.waitForTimeout(500);
          searchedWithForm = true;
        }
      } catch (error) {
        log({ event: 'search_form_failed', retailer, query, reason: sanitizeErrorText(error.message) });
        searchedWithForm = false;
      }

      let candidateLinks = searchedWithForm
        ? await readProductLinks(page, domain, (candidate, reason) => log({
          event: 'candidate_rejected',
          retailer,
          query,
          candidateUrl: candidate.url,
          candidateTitle: candidate.title,
          reason
        }))
        : [];
      let activeSearchUrl = searchedWithForm ? page.url() : '';
      if (searchedWithForm) {
        log({ event: 'search_query', retailer, query, searchUrl: activeSearchUrl });
      }
      if (!candidateLinks.length) {
        for (const searchUrl of searchUrls(domain, retailer, query)) {
          activeSearchUrl = searchUrl;
          log({ event: 'search_query', retailer, query, searchUrl });
          try {
            if (!await goto(page, searchUrl, validateUrl)) continue;
            if (isCostco) await prepareCostcoResults(page, log);
            else await page.waitForTimeout(500);
            candidateLinks = await readProductLinks(page, domain, (candidate, reason) => log({
              event: 'candidate_rejected',
              retailer,
              query,
              candidateUrl: candidate.url,
              candidateTitle: candidate.title,
              reason
            }));
            if (candidateLinks.length) break;
          } catch (error) {
            log({ event: 'search_page_failed', retailer, query, searchUrl, reason: sanitizeErrorText(error.message) });
            continue;
          }
        }
      }
      log({
        event: 'search_results',
        retailer,
        query,
        searchUrl: activeSearchUrl,
        candidateUrls: candidateLinks.map(candidate => candidate.url)
      });
      if (isCostco && candidateLinks.length === 0) break;

      const selectedCandidates = candidateLinks.filter(candidate => {
        const score = rankCandidate(candidate, product);
        const matchesKeywords = candidateMatchesProductKeywords(candidate, product);
        if (!matchesKeywords) {
          log({
            event: 'candidate_rejected',
            retailer,
            product: product.name || product.product || '',
            query,
            candidateUrl: candidate.url,
            candidateTitle: candidate.title,
            reason: 'Product result does not match the cleaned product-name keywords.',
            score
          });
        }
        return matchesKeywords;
      });
      if (selectedCandidates.length) {
        const selectedCandidate = selectedCandidates[0];
        log({
          event: 'first_valid_product_selected',
          retailer,
          product: product.name || product.product || '',
          query,
          searchUrl: activeSearchUrl,
          candidateUrl: selectedCandidate.url,
          candidateTitle: selectedCandidate.title,
          score: rankCandidate(selectedCandidate, product)
        });
        return selectedCandidates;
      }

      for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
        for (const candidate of candidateLinks) {
          const score = rankCandidate(candidate, product);
          log({
            event: 'candidate_ranked',
            retailer,
            query,
            searchUrl: activeSearchUrl,
            candidateUrl: candidate.url,
            candidateTitle: candidate.title,
            score
          });
          if (score > 0) {
            results.set(candidate.url, candidate);
          }
        }
        if (pageNumber === 2) break;
        const nextUrl = await nextPageUrl(page, domain).catch(() => '');
        if (!nextUrl) break;
        try {
          if (!await goto(page, nextUrl, validateUrl)) break;
          if (isCostco) await prepareCostcoResults(page, log);
          candidateLinks = await readProductLinks(page, domain, (candidate, reason) => log({
            event: 'candidate_rejected',
            retailer,
            query,
            candidateUrl: candidate.url,
            candidateTitle: candidate.title,
            reason
          }));
        } catch {
          break;
        }
      }
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await closeBrowserResources(page, context, browser, operationError);
  }

  return [...results.values()]
    .sort((left, right) =>
      rankCandidate(right, product) - rankCandidate(left, product)
    )
    .slice(0, 8);
}

function parseVisiblePrice(text) {
  const matches = [...String(text || '').matchAll(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g)];
  const values = [...new Set(matches.map(match => Number(match[1].replace(/,/g, ''))))]
    .filter(value => Number.isFinite(value) && value > 0);
  return values.length === 1 ? values[0] : null;
}

export function readCostcoWarehousePrice() {
  const root = document.querySelector('main');
  if (!root || !root.querySelector('h1')) return { found: false, price: null };
  const amounts = [];
  let found = false;
  let ambiguous = false;
  for (const label of root.querySelectorAll('*')) {
    if (label.children.length || label.textContent.trim().toLowerCase() !== 'warehouse price') continue;
    const style = window.getComputedStyle(label);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    found = true;
    let container = label.parentElement;
    for (let depth = 0; container && container !== root && depth < 3; depth++, container = container.parentElement) {
      const text = (container.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length > 200) break;
      const values = [...text.matchAll(/\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/g)];
      if (!values.length) continue;
      if (values.length !== 1 || /\b(?:save|savings|discount|off|per|each|unit|delivery|shipping|fee)\b/i.test(text)) {
        ambiguous = true;
        break;
      }
      const price = Number(values[0][1].replace(/,/g, ''));
      if (Number.isFinite(price) && price > 0) amounts.push(price);
      break;
    }
  }
  const unique = [...new Set(amounts)];
  return { found, price: !ambiguous && unique.length === 1 ? unique[0] : null };
}

export async function readRetailerProductPage(
  productUrl,
  {
    launchBrowser = () => chromium.launch({ headless: true }),
    validateUrl = async () => {}
  } = {}
) {
  const browser = await launchBrowser();
  let context;
  let page;
  let operationError;
  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; PriceDropAgent/2.0)'
    });
    page = await context.newPage();
    await page.route('**/*', route => validateRequest(route, validateUrl));

    if (!await goto(page, productUrl, validateUrl)) {
      throw new Error('The retailer product page did not load successfully.');
    }
    await page.waitForTimeout(500);
    const html = await page.content();
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href').catch(() => '');
    const canonicalUrl = canonical ? new URL(canonical, page.url()).toString() : page.url();
    await validateUrl(canonicalUrl);
    const pageData = extractRetailerProductPage(html, canonicalUrl);
    const visibleData = await page.evaluate(() => {
      const firstText = selectors => {
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          const value = element?.getAttribute('content') ||
            element?.innerText ||
            element?.textContent ||
            '';
          if (value.trim()) return value.trim().slice(0, 500);
        }
        return '';
      };
      const priceSelectors = [
        '[data-testid*="price" i]',
        '[data-automation-id*="price" i]',
        '[data-test*="price" i]',
        '[itemprop="price"]',
        '[class*="price" i]'
      ];
      const prices = [];
      for (const selector of priceSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const text = (element.innerText || element.textContent || '').trim();
          if (text && text.length <= 100) prices.push(text);
          if (prices.length >= 12) break;
        }
        if (prices.length >= 12) break;
      }
      return {
        title: firstText(['h1', '[data-testid*="product-title" i]', '[itemprop="name"]']),
        brand: firstText(['[itemprop="brand"]', '[data-testid*="brand" i]']),
        model: firstText(['[itemprop="model"]', '[data-testid*="model" i]']),
        sku: firstText(['[itemprop="sku"]', '[itemprop="mpn"]', '[data-testid*="sku" i]']),
        description: firstText(['[itemprop="description"]', '[data-testid*="description" i]']),
        size: firstText(['[itemprop="size"]', '[data-testid*="size" i]']),
        variant: firstText(['[data-testid*="variant" i]', '[class*="variant" i]']),
        bundle: firstText(['[data-testid*="bundle" i]', '[class*="bundle" i]']),
        quantity: firstText(['[itemprop="quantity"]', '[data-testid*="quantity" i]']),
        condition: firstText(['[itemprop="itemCondition"]', '[data-testid*="condition" i]']),
        addToCart: [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
          .some(element => /add to (?:cart|bag)|buy now/i.test(
            element.innerText || element.value || element.getAttribute('aria-label') || ''
          )),
        currency: firstText([
          'meta[property="product:price:currency"]',
          '[itemprop="priceCurrency"]',
          '[data-currency]'
        ]),
        priceTexts: prices
      };
    });
    const visiblePrice = parseVisiblePrice(visibleData.priceTexts.join(' '));
    const hostname = new URL(canonicalUrl).hostname.toLowerCase();
    const warehouse = hostname === 'costco.com' || hostname.endsWith('.costco.com')
      ? await page.evaluate(readCostcoWarehousePrice)
      : { found: false, price: null };
    const visiblePriceVerified =
      String(visibleData.currency || '').toUpperCase() === 'USD' &&
      visiblePrice != null;
    const finalPrice = warehouse.found
      ? warehouse.price
      : visiblePriceVerified
      ? visiblePrice
      : pageData.verified
        ? pageData.price
        : null;
    return {
      ...pageData,
      title: pageData.title || visibleData.title || '',
      productTitle: pageData.productTitle || Boolean(visibleData.title),
      productSku: pageData.productSku || Boolean(visibleData.sku),
      productDetails: pageData.productDetails || Boolean(
        visibleData.description || visibleData.size || visibleData.variant ||
        visibleData.bundle || visibleData.quantity || visibleData.condition
      ),
      addToCart: visibleData.addToCart,
      canonicalUrl: Boolean(canonical),
      brand: pageData.brand || visibleData.brand || '',
      model: pageData.model || visibleData.model || '',
      sku: pageData.sku || visibleData.sku || '',
      description: pageData.description || visibleData.description || '',
      attributes: [
        visibleData.size,
        visibleData.variant,
        visibleData.bundle,
        visibleData.quantity,
        visibleData.condition
      ].filter(Boolean),
      quantity: visibleData.quantity || null,
      condition: visibleData.condition || '',
      price: finalPrice,
      currency: finalPrice == null ? '' : 'USD',
      verified: finalPrice != null,
      priceSource: warehouse.found && warehouse.price != null
        ? 'Costco warehouse price'
        : !warehouse.found && visiblePriceVerified
        ? 'visible retailer price'
        : !warehouse.found ? pageData.priceSource : null
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await closeBrowserResources(page, context, browser, operationError);
  }
}
