import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import axios from 'axios';
import crypto from 'crypto';
import sharp from 'sharp';
import { extractRetailerProductPage } from './retailer-page.js';
import {
  askGemma,
  getLocalAIStatus,
  matchProductWithGemma,
  OLLAMA_MODEL
} from './localAI.js';
import {
  cheapestVerifiedAlternative,
  matchProductCandidate,
  retailerMatchesHost,
  searchPublicProductPages
} from './product-discovery.js';
import {
  createGmailAuthorizationUrl,
  finishGmailAuthorization,
  getGmailConnectionStatus,
  gmailCallbackRedirect,
  isGoogleOAuthConfigured,
  sendGmailMessage
} from './gmail.js';
import {
  checkMonitoredProduct,
  ensureMonitoringMetadata,
  isFutureDateOnly,
  isValidDateOnly,
  isWithinMonitoringWindow,
  localDateString,
  monitoringDashboardStats,
  monitoringStatusFor,
  monitoringWindow,
  startMonitoringScheduler
} from './monitoring.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const RECEIPTS_FILE = path.join(DATA_DIR, 'receipts.json');
const MANUAL_PRODUCTS_FILE = path.join(DATA_DIR, 'manual-products.json');
const EMAIL_SETTINGS_FILE = path.join(DATA_DIR, 'email-settings.json');
const PORT = Number(process.env.PORT || 4100);
const configuredMonitorInterval = Number(process.env.MONITOR_INTERVAL_MINUTES || 60);
const MONITOR_INTERVAL_MINUTES = Number.isFinite(configuredMonitorInterval)
  ? Math.max(15, configuredMonitorInterval)
  : 60;
const MONITOR_INTERVAL_MS = MONITOR_INTERVAL_MINUTES * 60 * 1000;
const configuredAlternativeInterval = Number(
  process.env.ALTERNATIVE_DISCOVERY_INTERVAL_HOURS || 24
);
const ALTERNATIVE_DISCOVERY_INTERVAL_MS =
  (Number.isFinite(configuredAlternativeInterval)
    ? Math.max(6, configuredAlternativeInterval)
    : 24) * 60 * 60 * 1000;
const ALTERNATIVE_OFFER_MAX_AGE_MS = Math.max(
  48 * 60 * 60 * 1000,
  2 * ALTERNATIVE_DISCOVERY_INTERVAL_MS
);
let nextScheduledCheckAt = new Date(Date.now() + MONITOR_INTERVAL_MS).toISOString();
const execFileAsync = promisify(execFile);

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/api/ready', (_, res) => res.sendStatus(204));

await fs.mkdir(UPLOADS_DIR, { recursive: true });

for (const file of [RECEIPTS_FILE, MANUAL_PRODUCTS_FILE]) {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, '[]');
  }
}

try {
  await fs.access(EMAIL_SETTINGS_FILE);
} catch {
  await fs.writeFile(
    EMAIL_SETTINGS_FILE,
    JSON.stringify({ recipient: process.env.ALERT_TO || '' }, null, 2)
  );
}

function validEmailAddress(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) &&
    value.length <= 254;
}

function normalizeRecipients(values) {
  const candidates = Array.isArray(values) ? values : [values];
  const recipients = [];
  const seen = new Set();
  for (const candidate of candidates.flatMap(value =>
    String(value || '').split(/[;,]/)
  )) {
    const recipient = candidate.trim();
    const key = recipient.toLowerCase();
    if (validEmailAddress(recipient) && !seen.has(key)) {
      recipients.push(recipient);
      seen.add(key);
    }
  }
  return recipients;
}

async function getAlertRecipients() {
  const settings = JSON.parse(
    await fs.readFile(EMAIL_SETTINGS_FILE, 'utf8')
  );
  const saved = Array.isArray(settings.recipients)
    ? settings.recipients
    : Object.hasOwn(settings, 'recipient')
      ? settings.recipient
      : process.env.ALERT_TO || '';
  return normalizeRecipients(saved);
}

async function saveAlertRecipients(recipients) {
  const settings = JSON.parse(
    await fs.readFile(EMAIL_SETTINGS_FILE, 'utf8')
  );
  await fs.writeFile(
    EMAIL_SETTINGS_FILE,
    JSON.stringify({
      ...settings,
      recipient: recipients[0] || '',
      recipients
    }, null, 2)
  );
}

async function readReceipts() {
  return JSON.parse(await fs.readFile(RECEIPTS_FILE, 'utf8'));
}

async function writeReceipts(receipts) {
  await writeJsonFile(RECEIPTS_FILE, receipts);
}

async function writeJsonFile(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function loadTrackedRecord(id) {
  const [receipts, manualProducts] = await Promise.all([
    readReceipts(),
    fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8').then(JSON.parse)
  ]);
  for (const receipt of receipts) {
    const product = (receipt.products || []).find(item => item.id === id);
    if (product) {
      product.date ||= receipt.purchaseDate;
      product.purchaseDate ||= receipt.purchaseDate;
      product.retailer ||= receipt.merchant;
      return {
        product,
        persist: () => writeReceipts(receipts)
      };
    }
  }
  const product = manualProducts.find(item => item.id === id);
  return product
    ? {
      product,
      persist: () => writeJsonFile(MANUAL_PRODUCTS_FILE, manualProducts)
    }
    : null;
}

function statusFor(purchaseDate) {
  return isWithinMonitoringWindow(purchaseDate)
    ? 'watch'
    : 'not_on_watch';
}

function daysRemaining(purchaseDate) {
  const purchaseTimestamp = timestampForDate(purchaseDate);
  const todayUtc = timestampForDate(localDateString());
  const age = Math.floor(
    (todayUtc - purchaseTimestamp) / 86400000
  );

  return Number.isFinite(age) ? Math.max(0, 30 - age) : 0;
}

function nextCheckForProduct(product, status) {
  if (status === 'URL DISCOVERY') {
    return product.nextProductDiscoveryAt || null;
  }
  if (
    status === 'WATCH EXPIRED' ||
    status === 'NEEDS CONFIRMATION' ||
    status === 'PURCHASE DATE NEEDS CONFIRMATION'
  ) {
    return null;
  }
  return product.nextCheckAt || nextScheduledCheckAt;
}

function timestampForDate(value) {
  if (!isValidDateOnly(value)) return Number.NaN;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return timestamp;
}

function isPublicAddress(address) {
  const version = isIP(address);

  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [first, second] = octets;

    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19))
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    const firstSegment = Number.parseInt(normalized.split(':')[0], 16);
    return firstSegment >= 0x2000 &&
      firstSegment <= 0x3fff &&
      !normalized.startsWith('2001:db8:');
  }

  return false;
}

async function validateProductUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid product URL.');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    isIP(url.hostname) ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local')
  ) {
    throw new Error('Product URL must use a public HTTP or HTTPS hostname.');
  }

  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Product URL must resolve to a public internet address.');
  }

  return { url, addresses };
}

function normalizeProduct(product, receipt) {
  const date = product.date || receipt.purchaseDate;

  return {
    ...product,
    date,
    purchaseDate: date,
    name: product.name || product.product || 'Product',
    product: product.product || product.name || 'Product',
    price: Number(product.price ?? product.purchasePrice ?? 0),
    purchasePrice: Number(
      product.purchasePrice ?? product.price ?? 0
    ),
    watch: statusFor(date) === 'watch' ? 'yes' : 'no'
  };
}

async function normalizeReceiptImage(buffer) {
  const imageOptions = {
    limitInputPixels: 40000000,
    animated: false
  };
  const normalize = input => sharp(input, imageOptions)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({
      width: 2000,
      height: 2000,
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();

  try {
    return await normalize(buffer);
  } catch (sharpError) {
    if (process.platform !== 'darwin') {
      throw new Error(`Image decoder rejected the file: ${sharpError.message}`);
    }

    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'pricedrop-receipt-')
    );
    const inputPath = path.join(tempDirectory, 'receipt-input');
    const outputPath = path.join(tempDirectory, 'receipt-output.jpg');

    try {
      await fs.writeFile(inputPath, buffer, { flag: 'wx' });
      await execFileAsync(
        '/usr/bin/sips',
        [
          '-s',
          'format',
          'jpeg',
          '-s',
          'formatOptions',
          '80',
          inputPath,
          '--out',
          outputPath
        ],
        {
          timeout: 20000,
          maxBuffer: 1024 * 1024
        }
      );

      return await normalize(await fs.readFile(outputPath));
    } catch (sipsError) {
      throw new Error(
        `Image decoder rejected the file (${sharpError.message}); macOS image conversion also failed (${sipsError.message}).`
      );
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true });
    }
  }
}

async function extractReceipt(file) {
  const isPdf = file.buffer.subarray(0, 1024).toString('latin1').includes('%PDF-');
  let text;
  let images = [];

  try {
    const converted = await normalizeReceiptImage(file.buffer);
    images = [converted.toString('base64')];
  } catch (imageError) {
    if (isPdf) {
      throw new Error(
        `Could not convert PDF "${file.originalname}" for local receipt reading: ${imageError.message}`
      );
    }

    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new Error(
        `Could not decode "${file.originalname}" as an image or text (${imageError.message}). Try exporting it as a JPEG, PNG, or PDF.`
      );
    }
  }

  const prompt = `
Read this purchase receipt and return ONLY valid JSON:

{
  "merchant": "store name or Unknown merchant",
  "purchaseDate": "YYYY-MM-DD or null",
  "total": number or null,
  "products": [
    {
      "name": "product line item",
      "brand": "brand or null",
      "model": "model number or null",
      "sku": "printed retailer item number or null",
      "description": "receipt description or null",
      "attributes": ["size, flavor, or other identifying details"],
      "quantity": number or null,
      "price": number or null
    }
  ]
}

Include purchased line items only.
Do not include tax, discounts, shipping, or totals as products.
Preserve brand, flavor/variant, size, and quantity in the product name
when shown. Do not treat discounts or the receipt total as the item price.
Do not guess missing values.
`;

const promptWithText = text !== undefined
  ? `${prompt}

Receipt text:
${text.slice(0, 18000)}`
  : prompt;
  const parsed = await askGemma(promptWithText, images);

  return {
    merchant: String(
      parsed.merchant || 'Unknown merchant'
    ).slice(0, 100),

    purchaseDate:
      isValidDateOnly(parsed.purchaseDate)
        ? parsed.purchaseDate
        : null,

    total:
      parsed.total != null &&
      Number.isFinite(Number(parsed.total)) &&
      Number(parsed.total) >= 0
        ? Number(parsed.total)
        : null,

    products: Array.isArray(parsed.products)
      ? parsed.products
          .map(item => ({
            name: String(
              item.name || 'Unknown product'
            ).slice(0, 150),
            brand: item.brand == null
              ? null
              : String(item.brand).slice(0, 100),
            model: item.model == null
              ? null
              : String(item.model).slice(0, 100),
            sku: item.sku == null
              ? null
              : String(item.sku).slice(0, 100),
            description: item.description == null
              ? null
              : String(item.description).slice(0, 300),
            attributes: Array.isArray(item.attributes)
              ? item.attributes.map(value => String(value).slice(0, 100)).slice(0, 10)
              : [],
            quantity: item.quantity != null &&
              Number.isFinite(Number(item.quantity))
              ? Number(item.quantity)
              : null,
            price:
              item.price != null &&
              Number.isFinite(Number(item.price)) &&
              Number(item.price) > 0
                ? Number(item.price)
                : null
          }))
          .filter(
            item =>
              item.name !== 'Unknown product' ||
              item.price != null
          )
      : []
  };
}

async function fetchPrice(url) {
  const { url: parsedUrl, addresses } = await validateProductUrl(url);
  const targetAddress = addresses[0];

  const response = await axios.get(parsedUrl.toString(), {
    timeout: 15000,
    maxRedirects: 0,
    lookup: (hostname, options, callback) => {
      if (hostname !== parsedUrl.hostname) {
        callback(new Error('Unexpected product URL host.'));
        return;
      }

      if (options?.all) {
        callback(null, addresses);
        return;
      }

      callback(null, targetAddress.address, targetAddress.family);
    },

    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; PriceDropAgent/2.0)',
      Accept: 'text/html,application/xhtml+xml'
    }
  });

  return extractRetailerProductPage(response.data, parsedUrl.toString());
}

function retailerLabelFromUrl(value) {
  const hostname = new URL(value).hostname.replace(/^www\./, '');
  const label = hostname.split('.')[0].replace(/[-_]/g, ' ');
  return label.replace(/\b\w/g, character => character.toUpperCase());
}

function productSearchTerms(product) {
  return [
    product.name || product.product,
    product.brand,
    product.model,
    product.sku,
    product.description,
    ...(Array.isArray(product.attributes) ? product.attributes : []),
    ...(Array.isArray(product.identityAttributes) ? product.identityAttributes : [])
  ].filter(Boolean).join(' ').slice(0, 400);
}

async function evaluateListing(product, searchResult) {
  const page = await fetchPrice(searchResult.url);
  const candidate = {
    ...page,
    title: page.title || searchResult.title
  };
  const aiMatch = await matchProductWithGemma(product, candidate);
  return {
    candidate,
    match: matchProductCandidate(product, candidate, aiMatch)
  };
}

async function discoverOriginalListing(product) {
  if (!product.retailer) {
    throw new Error('Enter the original retailer to search for its product page.');
  }
  const query = `"${product.retailer}" ${productSearchTerms(product)}`;
  const results = await searchPublicProductPages(query);
  const matches = [];
  for (const result of results) {
    let hostname;
    try {
      hostname = new URL(result.url).hostname;
    } catch {
      continue;
    }
    if (!retailerMatchesHost(product.retailer, hostname)) continue;
    try {
      const { candidate, match } = await evaluateListing(product, result);
      if (match.accepted) {
        matches.push({
          title: candidate.title,
          url: candidate.url,
          retailer: product.retailer,
          price: match.priceVerified ? candidate.price : null,
          currency: match.priceVerified ? candidate.currency : null,
          priceVerified: match.priceVerified,
          matchConfidence: match.confidence,
          matchEvidence: match.reason
        });
      }
    } catch (error) {
      product.productDiscoveryError = error.message;
    }
  }
  product.lastProductDiscoveryAt = new Date().toISOString();
  product.discoveryCandidates = matches;
  if (matches.length === 1) {
    const [match] = matches;
    product.url = match.url;
    product.originalUrlVerified = true;
    product.discoveryStatus = 'matched';
    product.matchConfidence = match.matchConfidence;
    product.matchEvidence = match.matchEvidence;
    product.lastError = null;
    return true;
  }
  if (matches.length > 1) {
    product.discoveryStatus = 'needs_confirmation';
    product.lastError = 'More than one matching product page was verified. Select the correct original-retailer listing.';
    return false;
  }
  product.discoveryStatus = 'searching';
  product.lastProductDiscoveryAt = new Date().toISOString();
  product.lastError = product.productDiscoveryError ||
    `No exact ${product.retailer} product listing was verified. The agent will retry, or you can add a direct URL.`;
  return false;
}

async function verifyOriginalProductUrl(product) {
  let hostname;
  try {
    hostname = new URL(product.url).hostname;
  } catch {
    product.originalUrlVerified = false;
    product.discoveryStatus = 'needs_review';
    product.lastError = 'The submitted URL is not a valid public retailer product page.';
    return false;
  }
  if (!retailerMatchesHost(product.retailer, hostname)) {
    product.originalUrlVerified = false;
    product.discoveryStatus = 'needs_review';
    product.lastError = `The submitted product URL does not belong to the original retailer (${product.retailer || 'unknown'}).`;
    return false;
  }
  const { candidate, match } = await evaluateListing(product, {
    url: product.url,
    title: ''
  });
  if (!match.accepted) {
    product.originalUrlVerified = false;
    product.discoveryStatus = 'needs_review';
    product.lastError = match.reason;
    return false;
  }
  product.originalUrlVerified = true;
  product.discoveryStatus = 'matched';
  product.matchConfidence = match.confidence;
  product.matchEvidence = match.reason;
  product.url = candidate.url;
  product.lastError = null;
  return true;
}

async function refreshAlternativeOffers(product, now, persistStores) {
  const nextSearch = Date.parse(product.nextAlternativeSearchAt || '');
  if (Number.isFinite(nextSearch) && now.getTime() < nextSearch) return;

  product.lastAlternativeSearchAt = now.toISOString();
  product.nextAlternativeSearchAt = new Date(
    now.getTime() + ALTERNATIVE_DISCOVERY_INTERVAL_MS
  ).toISOString();
  product.alternativeDiscoveryStatus = 'searching';
  product.alternativeDiscoveryError = null;
  await persistStores();

  try {
    const query = productSearchTerms(product);
    const searchResults = await searchPublicProductPages(query, { limit: 8 });
    const previousOffers = Array.isArray(product.alternativeOffers)
      ? product.alternativeOffers
      : [];
    const candidates = [
      ...searchResults,
      ...previousOffers.map(offer => ({ url: offer.url, title: offer.title }))
    ];
    const uniqueCandidates = [...new Map(candidates.map(candidate => [
      candidate.url,
      candidate
    ])).values()].slice(0, 5);
    let acceptedCount = 0;

    for (const candidate of uniqueCandidates) {
      let candidateHost;
      try {
        candidateHost = new URL(candidate.url).hostname;
      } catch {
        continue;
      }
      let originalHost = '';
      try {
        originalHost = product.url ? new URL(product.url).hostname : '';
      } catch {
        originalHost = '';
      }
      if (
        candidateHost === originalHost ||
        retailerMatchesHost(product.retailer, candidateHost)
      ) continue;

      try {
        const { candidate: verified, match } = await evaluateListing(product, candidate);
        if (!match.accepted || !match.priceVerified) continue;

        const checkedAt = now.toISOString();
        const offers = Array.isArray(product.alternativeOffers)
          ? product.alternativeOffers
          : [];
        const existing = offers.find(offer => offer.url === verified.url);
        const priceHistory = existing?.priceHistory || [];
        priceHistory.push({
          price: verified.price,
          checkedAt,
          verified: true,
          source: verified.priceSource
        });
        const offer = {
          id: existing?.id || crypto.randomUUID(),
          title: verified.title,
          retailer: retailerLabelFromUrl(verified.url),
          url: verified.url,
          price: verified.price,
          currency: 'USD',
          imageUrl: verified.imageUrl,
          verified: true,
          priceSource: verified.priceSource,
          matchConfidence: match.confidence,
          matchEvidence: match.reason,
          lastVerifiedAt: checkedAt,
          lowestVerifiedPrice: Math.min(
            Number(existing?.lowestVerifiedPrice ?? verified.price),
            verified.price
          ),
          highestVerifiedPrice: Math.max(
            Number(existing?.highestVerifiedPrice ?? verified.price),
            verified.price
          ),
          priceHistory: priceHistory.slice(-1000)
        };
        product.alternativeOffers = [
          ...offers.filter(item => item.url !== offer.url),
          offer
        ];
        acceptedCount++;
      } catch (error) {
        product.alternativeDiscoveryError = error.message;
        if (/Ollama|model .*not installed/i.test(error.message)) break;
      }
    }

    product.alternativeDiscoveryStatus = acceptedCount
      ? 'verified_offers_found'
      : product.alternativeDiscoveryError
        ? 'unavailable'
        : 'no_verified_matches';
    product.alternativeOffers ||= [];
    product.cheapestAlternative = cheapestVerifiedAlternative(
      product,
      product.alternativeOffers,
      now,
      ALTERNATIVE_OFFER_MAX_AGE_MS
    );
    if (acceptedCount) product.alternativeDiscoveryError = null;
  } catch (error) {
    product.alternativeDiscoveryStatus = 'unavailable';
    product.alternativeDiscoveryError = error.message;
  }
  await persistStores();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

async function sendAlert(receipt, product, { price, savings, savingsPercent, detectedAt }) {
  const recipients = await getAlertRecipients();
  if (!recipients.length) {
    throw new Error('Add at least one alert recipient in Price monitor settings.');
  }

  const purchasePrice = Number(product.purchasePrice || 0);
  const purchaseDate = product.date || receipt.purchaseDate;
  const remainingDays = daysRemaining(purchaseDate);
  const detectedAtLabel = new Date(detectedAt).toLocaleString();
  const safeName = escapeHtml(product.name);
  const safeRetailer = escapeHtml(product.retailer || receipt.merchant || 'Retailer');
  const safeUrl = escapeHtml(product.url);
  const safePolicyUrl = product.returnPolicyUrl
    ? escapeHtml(product.returnPolicyUrl)
    : '';
  const alternative = cheapestVerifiedAlternative(
    product,
    product.alternativeOffers || [],
    new Date(detectedAt),
    ALTERNATIVE_OFFER_MAX_AGE_MS
  );
  const alternativeText = alternative
    ? [
      '',
      'Cheaper alternative found at another retailer (separate from this original-retailer price-drop alert):',
      `${alternative.retailer}: $${Number(alternative.price).toFixed(2)}`,
      `Last verified: ${new Date(alternative.lastVerifiedAt).toLocaleString()}`,
      `View alternative: ${alternative.url}`
    ].join('\n')
    : '';
  const alternativeHtml = alternative
    ? `<section><h3>Cheaper alternative found</h3><p>${escapeHtml(alternative.retailer)}: $${Number(alternative.price).toFixed(2)} · verified ${escapeHtml(new Date(alternative.lastVerifiedAt).toLocaleString())}</p><p><a href="${escapeHtml(alternative.url)}">View alternative</a></p><p>This is another retailer's offer. It did not trigger the original retailer's price-drop alert.</p></section>`
    : '';

  await sendGmailMessage({
    recipients,
    subject: `PRICE DROP DETECTED: ${product.name} — You Could Save $${savings.toFixed(2)}`,
    text: [
      'PRICE DROP DETECTED',
      '',
      `Product: ${product.name}`,
      `Retailer: ${product.retailer || receipt.merchant || 'Retailer'}`,
      `Original purchase price: $${purchasePrice.toFixed(2)}`,
      `Current verified price: $${price.toFixed(2)}`,
      `Potential savings: $${savings.toFixed(2)} (${savingsPercent.toFixed(1)}%)`,
      `Detected: ${detectedAtLabel}`,
      `Days remaining in the 30-day watch: ${remainingDays}`,
      `View product: ${product.url}`,
      alternativeText,
      ...(product.returnPolicyUrl ? [`Official retailer policy: ${product.returnPolicyUrl}`] : []),
      '',
      `Check ${product.retailer || receipt.merchant || 'the retailer'}'s official return, price-adjustment, price-match, or price-protection policy. Eligibility is not guaranteed; confirm directly with the retailer.`
    ].join('\n'),
    html: `<h2>PRICE DROP DETECTED</h2><p><strong>${safeName}</strong> at ${safeRetailer}</p><ul><li>Original purchase price: $${purchasePrice.toFixed(2)}</li><li>Current verified price: $${price.toFixed(2)}</li><li>Potential savings: $${savings.toFixed(2)} (${savingsPercent.toFixed(1)}%)</li><li>Detected: ${escapeHtml(detectedAtLabel)}</li><li>Days remaining in the 30-day monitoring window: ${remainingDays}</li></ul><p><a href="${safeUrl}">View Product</a></p><p>Consider checking whether the retailer offers price adjustment, price matching, or a return/price-protection policy. ${safePolicyUrl ? `<a href="${safePolicyUrl}">Open the retailer's official policy</a>.` : `Visit <a href="${safeUrl}">${safeRetailer}</a> to review its official policy.`} Eligibility is not guaranteed; confirm directly with the retailer. PriceDrop Agent will not initiate a return, refund, or purchase.</p>${alternativeHtml}`
  });
}

async function sendTestEmail(product) {
  await sendGmailMessage({
    recipients: product.recipients,
    subject: `TEST price drop: ${product.name}`,
    text: [
      'TEST ONLY — this is a simulated price-drop alert to verify your email setup.',
      '',
      `Product: ${product.name}`,
      `Retailer: ${product.retailer || 'Your tracked retailer'}`,
      `Purchase price: $${Number(product.purchasePrice).toFixed(2)}`,
      `Simulated current price: $${Number(product.testPrice).toFixed(2)}`,
      `Simulated savings: $${(Number(product.purchasePrice) - Number(product.testPrice)).toFixed(2)}`,
      `Purchase date: ${product.date}`,
      `Days remaining in the 30-day watch: ${daysRemaining(product.date)}`,
      product.url ? `Product link: ${product.url}` : '',
      '',
      'This is only a test. No live price was checked and no monitoring data was changed.'
    ].join('\n')
  });
}

app.get('/api/health', async (_, res) => {
  try {
    const [aiStatus, recipients] = await Promise.all([
      getLocalAIStatus(),
      getAlertRecipients()
    ]);
    res.json({
      ok: true,
      aiProvider: aiStatus.provider,
      aiModel: aiStatus.model,
      aiConnected: aiStatus.connected,
      aiModelAvailable: aiStatus.modelAvailable,
      aiError: aiStatus.error || null,
      gmailOAuthConfigured: isGoogleOAuthConfigured(),
      recipients
    });
  } catch (error) {
    console.error('Could not load app health:', error.message);
    res.status(500).json({ error: 'Could not load app health.' });
  }
});

app.get('/api/email/settings', async (_, res) => {
  try {
    res.json({
      gmailOAuthConfigured: isGoogleOAuthConfigured(),
      recipients: await getAlertRecipients()
    });
  } catch (error) {
    console.error('Could not read email settings:', error.message);
    res.status(500).json({ error: 'Could not load email settings.' });
  }
});

app.put('/api/email/settings', async (req, res) => {
  const rawRecipients = req.body?.recipients ?? req.body?.recipient;
  if (!Array.isArray(rawRecipients) && typeof rawRecipients !== 'string') {
    return res.status(400).json({
      error: 'Provide one or more recipient email addresses.'
    });
  }
  const entries = Array.isArray(rawRecipients)
    ? rawRecipients.map(value => String(value || '').trim())
    : String(rawRecipients).split(/[;,]/).map(value => value.trim());
  if (entries.some(value => value && !validEmailAddress(value))) {
    return res.status(400).json({
      error: 'One or more recipient email addresses are invalid.'
    });
  }
  const recipients = normalizeRecipients(entries);

  try {
    await saveAlertRecipients(recipients);
    res.json({
      ok: true,
      recipients,
      emailConfigured: recipients.length > 0
    });
  } catch (error) {
    console.error('Could not save email settings:', error.message);
    res.status(500).json({ error: 'Could not save email settings.' });
  }
});

app.get('/api/email/oauth/connect', (_, res) => {
  try {
    res.redirect(createGmailAuthorizationUrl());
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get('/api/email/oauth/callback', async (req, res) => {
  try {
    const result = await finishGmailAuthorization({
      code: String(req.query.code || ''),
      state: String(req.query.state || ''),
      providerError: String(req.query.error || '')
    });
    res.redirect(gmailCallbackRedirect({ success: true, message: result.email }));
  } catch (error) {
    res.redirect(gmailCallbackRedirect({
      success: false,
      message: error.message || 'Gmail authorization failed.'
    }));
  }
});

app.get('/api/email/status', async (_, res) => {
  try {
    res.json(await getGmailConnectionStatus());
  } catch (error) {
    console.error('Could not verify Gmail connection:', error.message);
    res.status(500).json({
      configured: isGoogleOAuthConfigured(),
      connected: false,
      email: '',
      error: error.message || 'Could not verify Gmail connection.'
    });
  }
});

app.get('/api/receipts', async (_, res) => {
  try {
    const receipts = await readReceipts();

    res.json(
      receipts.map(receipt => ({
        ...receipt,

        status: statusFor(
          receipt.purchaseDate
        ),

        products: (
          receipt.products || []
        ).map(product => {
          const normalized = normalizeProduct(product, receipt);
          return {
            ...normalized,
            originalUrlVerified: product.originalUrlVerified === true,
            monitoringStatus: monitoringStatusFor(normalized),
            purchaseDateNeedsConfirmation:
              monitoringStatusFor(normalized) === 'PURCHASE DATE NEEDS CONFIRMATION',
            currentPrice: product.originalUrlVerified === true &&
              product.currentVerifiedPrice != null &&
              Number.isFinite(Number(product.currentVerifiedPrice))
              ? Number(product.currentVerifiedPrice)
              : null
          };
        })
      }))
    );
  } catch {
    res.status(500).json({
      error: 'Could not read receipts.'
    });
  }
});

app.post(
  '/api/receipts',
  upload.single('receipt'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'Choose a receipt file first.'
        });
      }

      const parsed = await extractReceipt(
        req.file
      );

      const purchaseDate = parsed.purchaseDate;
      const purchaseDateConfirmed = isValidDateOnly(purchaseDate) &&
        !isFutureDateOnly(purchaseDate);

      const receiptId = crypto.randomUUID();

      const safeName =
        req.file.originalname
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .slice(-120) || 'receipt';

      const storedFile =
        `${receiptId}-${safeName}`;

      await fs.writeFile(
        path.join(UPLOADS_DIR, storedFile),
        req.file.buffer
      );

      const products = [];

      for (const item of parsed.products) {
        const product = {
          id: crypto.randomUUID(),
          date: purchaseDate,
          name: item.name,
          product: item.name,
          brand: item.brand || '',
          model: item.model || '',
          sku: item.sku || '',
          description: item.description || '',
          attributes: item.attributes || [],
          identityAttributes: item.attributes || [],
          price:
            item.price == null
              ? 0
              : Number(item.price),
          purchasePrice:
            item.price == null
              ? 0
              : Number(item.price),

          watch:
            statusFor(purchaseDate) === 'watch'
              ? 'yes'
              : 'no',

          url: '',
          retailer: parsed.merchant,
          purchaseDateConfirmed,
          purchaseDateNeedsConfirmation: !purchaseDateConfirmed,
          discoveryStatus: 'searching',
          currentPrice: null,
          matchConfidence: 0,
          lastCheckedAt: null,
          lastAlertedPrice: null,
          alertSent: false,
          lastError: null
        };

        products.push(product);
      }

      const receipt = {
        id: receiptId,
        merchant: parsed.merchant,
        purchaseDate,
        total: parsed.total,
        fileName: req.file.originalname,
        storedFile,
        uploadedAt: new Date().toISOString(),
        extractionMethod: `Ollama (${OLLAMA_MODEL})`,
        products
      };

      const receipts = await readReceipts();

      receipts.unshift(receipt);

      await writeReceipts(receipts);
      await monitorPrices();

      const updatedReceipts = await readReceipts();
      res.status(201).json({
        ...updatedReceipts.find(item => item.id === receiptId),
        status: statusFor(purchaseDate)
      });
    } catch (error) {
      console.error(
        'Receipt processing error:',
        error.message
      );

      const aiUnavailable = /Ollama|model .*not installed|local receipt reading/i.test(
        error.message || ''
      );
      res.status(aiUnavailable ? 503 : 400).json({
        error:
          error.message ||
          'Could not process receipt.'
      });
    }
  }
);

app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const receipts = await readReceipts();

    const receipt = receipts.find(
      item => item.id === req.params.id
    );

    if (!receipt) {
      return res.status(404).json({
        error: 'Receipt not found.'
      });
    }

    if (receipt.storedFile) {
      try {
        await fs.unlink(
          path.join(
            UPLOADS_DIR,
            path.basename(receipt.storedFile)
          )
        );
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    await writeReceipts(
      receipts.filter(
        item => item.id !== req.params.id
      )
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({
      error: 'Could not delete receipt.'
    });
  }
});

app.get('/api/monitor/products', async (_, res) => {
  try {
    const [receipts, manualProducts] = await Promise.all([
      readReceipts(),
      fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8').then(JSON.parse)
    ]);

    const products = [
      ...receipts.flatMap(receipt =>
        (receipt.products || []).map(product => {
          const normalized = normalizeProduct(product, receipt);
          ensureMonitoringMetadata(normalized, normalized.date);
          const window = monitoringWindow(normalized.date);
          const currentMonitoringStatus = monitoringStatusFor(normalized);
          return {
            ...normalized,
            source: 'receipt',
            merchant: product.retailer || receipt.merchant,
            receiptId: receipt.id,
            monitoringStartDate: normalized.monitoringStartDate || window.startDate,
            monitoringExpirationDate: normalized.monitoringExpirationDate || window.expirationDate,
            monitoringStatus: currentMonitoringStatus,
            purchaseDateNeedsConfirmation:
              currentMonitoringStatus === 'PURCHASE DATE NEEDS CONFIRMATION',
            originalUrlVerified: product.originalUrlVerified === true,
            status: statusFor(normalized.date),
            daysRemaining: daysRemaining(normalized.date),
            nextCheckAt: nextCheckForProduct(product, currentMonitoringStatus),
            priceHistory: Array.isArray(product.priceHistory)
              ? product.priceHistory
              : [],
            alternativeOffers: Array.isArray(product.alternativeOffers)
              ? product.alternativeOffers
              : [],
            cheapestAlternative: cheapestVerifiedAlternative(
              normalized,
              product.alternativeOffers || [],
              new Date(),
              ALTERNATIVE_OFFER_MAX_AGE_MS
            ),
            potentialSavings: normalized.currentVerifiedPrice == null
              ? null
              : Math.max(0, Number(normalized.purchasePrice) - Number(normalized.currentVerifiedPrice))
          };
        })
      ),
      ...manualProducts.map(product => {
        ensureMonitoringMetadata(product, product.purchaseDate || product.date);
        const window = monitoringWindow(product.purchaseDate || product.date);
        const currentMonitoringStatus = monitoringStatusFor(product);
        let host = '';
        try {
          host = new URL(product.url).hostname.replace(/^www\./, '');
        } catch {
          host = '';
        }
        return {
          ...product,
          source: 'manual',
          merchant: product.retailer || host,
          date: product.purchaseDate || product.date,
          purchaseDate: product.purchaseDate || product.date,
          monitoringStartDate: product.monitoringStartDate || window.startDate,
          monitoringExpirationDate: product.monitoringExpirationDate || window.expirationDate,
          monitoringStatus: currentMonitoringStatus,
          purchaseDateNeedsConfirmation:
            currentMonitoringStatus === 'PURCHASE DATE NEEDS CONFIRMATION',
          originalUrlVerified: product.originalUrlVerified === true,
          status: statusFor(product.purchaseDate || product.date),
          watch: statusFor(product.purchaseDate || product.date) === 'watch' ? 'yes' : 'no',
          daysRemaining: daysRemaining(product.purchaseDate || product.date),
          nextCheckAt: nextCheckForProduct(product, currentMonitoringStatus),
          potentialSavings: product.currentVerifiedPrice == null
            ? null
            : Math.max(0, Number(product.purchasePrice) - Number(product.currentVerifiedPrice)),
          priceHistory: Array.isArray(product.priceHistory) ? product.priceHistory : [],
          alternativeOffers: Array.isArray(product.alternativeOffers)
            ? product.alternativeOffers
            : [],
          cheapestAlternative: cheapestVerifiedAlternative(
            product,
            product.alternativeOffers || [],
            new Date(),
            ALTERNATIVE_OFFER_MAX_AGE_MS
          )
        };
      })
    ];

    res.json({
      ok: true,
      products,
      stats: monitoringDashboardStats(products)
    });
  } catch (error) {
    console.error('Could not read monitored products:', error.message);
    res.status(500).json({
      error: 'Could not load monitored products.'
    });
  }
});

app.post('/api/monitor/products/:id/discover', async (req, res) => {
  try {
    const record = await loadTrackedRecord(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'Tracked product not found.' });
    }

    const { product } = record;
    if (product.url && product.originalUrlVerified !== true) {
      await verifyOriginalProductUrl(product);
    } else if (!product.url) {
      await discoverOriginalListing(product);
    } else {
      return res.json({
        ok: true,
        message: 'The original retailer product URL is already verified.',
        product,
        monitoringStatus: monitoringStatusFor(product)
      });
    }
    await record.persist();
    return res.json({
      ok: true,
      message: product.originalUrlVerified
        ? 'Original retailer product URL verified and saved.'
        : product.discoveryStatus === 'needs_confirmation'
          ? 'Multiple matching product pages need your confirmation.'
          : product.lastError || 'No matching product page could be verified.',
      product,
      monitoringStatus: monitoringStatusFor(product)
    });
  } catch (error) {
    console.error('Product URL discovery failed:', error.message);
    res.status(502).json({
      ok: false,
      error: `Could not complete product URL discovery: ${error.message}`
    });
  }
});

app.post('/api/monitor/products/:id/confirm-url', async (req, res) => {
  try {
    const record = await loadTrackedRecord(req.params.id);

    if (!record) {
      return res.status(404).json({
        error: 'Tracked product not found.'
      });
    }

    const requestedUrl = String(req.body?.url || '').trim();

    if (!requestedUrl) {
      return res.status(400).json({
        error: 'Enter the official product URL.'
      });
    }

    try {
      const parsedUrl = new URL(requestedUrl);

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error();
      }
    } catch {
      return res.status(400).json({
        error: 'Enter a valid product URL.'
      });
    }

    record.product.url = requestedUrl;

    const verified = await verifyOriginalProductUrl(record.product);

    if (!verified) {
      await record.persist();

      return res.status(400).json({
        error:
          record.product.lastError ||
          'The URL could not be verified as the exact product from the original retailer.'
      });
    }

    record.product.discoveryCandidates = [];

    record.product.monitoringStatus =
      isFutureDateOnly(
        record.product.purchaseDate || record.product.date
      ) && !record.product.purchaseDateConfirmed
        ? 'PURCHASE DATE NEEDS CONFIRMATION'
        : 'MONITORING';

    await record.persist();

    res.json({
      ok: true,
      message:
        record.product.monitoringStatus === 'MONITORING'
          ? 'Product URL verified. Price monitoring is now active.'
          : 'Product URL verified. Confirm the purchase date to start monitoring.'
    });
  } catch (error) {
    console.error('Could not confirm product URL:', error.message);

    res.status(500).json({
      error: error.message || 'Could not verify product URL.'
    });
  }
});

app.post('/api/monitor/products/:id/confirm-date', async (req, res) => {
  const purchaseDate = String(req.body?.purchaseDate || '');
  if (!isValidDateOnly(purchaseDate)) {
    return res.status(400).json({
      error: 'Choose a valid purchase date in YYYY-MM-DD format.'
    });
  }
  const future = isFutureDateOnly(purchaseDate);
  if (future && req.body?.confirmFutureDate !== true) {
    return res.status(400).json({
      error: 'This date is in the future. Explicitly confirm it before continuing.'
    });
  }

  try {
    const record = await loadTrackedRecord(req.params.id);
    if (!record) {
      return res.status(404).json({ error: 'Tracked product not found.' });
    }
    const window = monitoringWindow(purchaseDate);
    record.product.date = purchaseDate;
    record.product.purchaseDate = purchaseDate;
    record.product.purchaseDateConfirmed = true;
    record.product.purchaseDateNeedsConfirmation = false;
    record.product.monitoringStartDate = purchaseDate;
    record.product.monitoringExpirationDate = window.expirationDate;
    record.product.monitoringStatus = 'MONITORING';
    await record.persist();
    res.json({
      ok: true,
      message: future
        ? 'Purchase date confirmed. Monitoring will begin on that date.'
        : 'Purchase date confirmed and saved.',
      product: record.product,
      monitoringStatus: monitoringStatusFor(record.product)
    });
  } catch (error) {
    console.error('Could not confirm purchase date:', error.message);
    res.status(500).json({ error: 'Could not save the confirmed purchase date.' });
  }
});

app.post('/api/monitor/products', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 150);
  const requestedRetailer = String(req.body?.retailer || '').trim().slice(0, 120);
  const brand = String(req.body?.brand || '').trim().slice(0, 100);
  const model = String(req.body?.model || '').trim().slice(0, 100);
  const purchasePrice = Number(req.body?.purchasePrice);
  const urlValue = String(req.body?.url || '').trim();
  const returnPolicyUrlValue = String(req.body?.returnPolicyUrl || '').trim();
  const date = String(req.body?.purchaseDate || localDateString());

  if (!name) {
    return res.status(400).json({ error: 'Product name is required.' });
  }

  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
    return res.status(400).json({
      error: 'Purchase price must be a positive number.'
    });
  }

  if (!isValidDateOnly(date)) {
    return res.status(400).json({
      error: 'Purchase date must be a valid YYYY-MM-DD date.'
    });
  }

  let url = null;
  if (urlValue) {
    try {
      ({ url } = await validateProductUrl(urlValue));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  } else if (!requestedRetailer) {
    return res.status(400).json({
      error: 'Enter the retailer when you do not have a product URL so the agent can search for the correct listing.'
    });
  }
  let returnPolicyUrl = '';
  if (returnPolicyUrlValue) {
    try {
      const validatedPolicy = await validateProductUrl(returnPolicyUrlValue);
      returnPolicyUrl = validatedPolicy.url.toString();
    } catch (error) {
      return res.status(400).json({ error: `Retailer policy URL: ${error.message}` });
    }
  }

  const window = monitoringWindow(date);
  const product = {
    id: crypto.randomUUID(),
    name,
    product: name,
    brand,
    model,
    attributes: [],
    identityAttributes: [],
    price: purchasePrice,
    purchasePrice,
    date,
    purchaseDate: date,
    retailer: requestedRetailer || url.hostname.replace(/^www\./, ''),
    url: url?.toString() || '',
    returnPolicyUrl,
    source: 'manual',
    monitoringStartDate: date,
    monitoringExpirationDate: window.expirationDate,
    monitoringStatus: 'MONITORING',
    purchaseDateConfirmed: !isFutureDateOnly(date),
    purchaseDateNeedsConfirmation: isFutureDateOnly(date),
    discoveryStatus: url ? 'matched' : 'searching',
    matchConfidence: url ? 1 : 0,
    currentPrice: null,
    previousVerifiedPrice: null,
    currentVerifiedPrice: null,
    lowestVerifiedPrice: null,
    highestVerifiedPrice: null,
    potentialSavings: null,
    savingsPercent: null,
    priceDropSavings: null,
    priceDropSavingsPercent: null,
    priceDropDetectedAt: null,
    firstPriceDropAt: null,
    lastCheckedAt: null,
    lastAlertedPrice: null,
    alertSent: false,
    notificationStatus: 'not_sent',
    notificationCount: 0,
    notificationHistory: [],
    alternativeOffers: [],
    lastError: null,
    priceHistory: []
  };

  try {
    const manualProducts = JSON.parse(
      await fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8')
    );
    manualProducts.unshift(product);
    await fs.writeFile(
      MANUAL_PRODUCTS_FILE,
      JSON.stringify(manualProducts, null, 2)
    );

    await monitorPrices();
    const savedProducts = JSON.parse(
      await fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8')
    );
    const savedProduct = savedProducts.find(
      item => item.id === product.id
    );

    res.status(201).json({
      ...savedProduct,
      status: statusFor(savedProduct.date),
      daysRemaining: daysRemaining(savedProduct.date)
    });
  } catch (error) {
    console.error('Could not save manual product:', error.message);
    res.status(500).json({ error: 'Could not save product tracking.' });
  }
});

app.delete('/api/monitor/products/:id', async (req, res) => {
  try {
    const products = JSON.parse(
      await fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8')
    );
    const remaining = products.filter(
      product => product.id !== req.params.id
    );

    if (remaining.length === products.length) {
      return res.status(404).json({ error: 'Manual product not found.' });
    }

    await fs.writeFile(
      MANUAL_PRODUCTS_FILE,
      JSON.stringify(remaining, null, 2)
    );
    res.json({ ok: true });
  } catch (error) {
    console.error('Could not delete manual product:', error.message);
    res.status(500).json({ error: 'Could not delete product.' });
  }
});

let checking = false;

async function monitorPrices() {
  if (checking) {
    return {
      ok: false,
      message: 'A price check is already running.',
      results: []
    };
  }

  checking = true;

  const results = [];

  try {
    const [receipts, manualProducts] = await Promise.all([
      readReceipts(),
      fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8').then(JSON.parse)
    ]);
    const persistStores = async () => {
      await Promise.all([
        writeReceipts(receipts),
        writeJsonFile(MANUAL_PRODUCTS_FILE, manualProducts)
      ]);
    };
    const trackedProducts = [
      ...receipts.flatMap(receipt =>
        (receipt.products || []).map(product => ({
          product,
          receipt,
          source: 'receipt'
        }))
      ),
      ...manualProducts.map(product => ({
        product,
        receipt: {
          merchant: product.retailer,
          purchaseDate: product.date
        },
        source: 'manual'
      }))
    ];

    for (const { product, receipt, source } of trackedProducts) {
      if (source === 'receipt') {
        Object.assign(product, normalizeProduct(product, receipt));
        product.retailer ||= receipt.merchant;
      }

      ensureMonitoringMetadata(product, product.date || receipt.purchaseDate);
      const now = new Date();
      const activeWindow = isWithinMonitoringWindow(
        product.date || receipt.purchaseDate,
        now
      );
      if (activeWindow && !product.url) {
        const nextDiscovery = Date.parse(product.nextProductDiscoveryAt || '');
        if (!Number.isFinite(nextDiscovery) || now.getTime() >= nextDiscovery) {
          product.lastProductDiscoveryAttemptAt = now.toISOString();
          product.nextProductDiscoveryAt = new Date(
            now.getTime() + ALTERNATIVE_DISCOVERY_INTERVAL_MS
          ).toISOString();
          await persistStores();
          try {
            await discoverOriginalListing(product);
          } catch (error) {
            product.discoveryStatus = 'needs_review';
            product.productDiscoveryError = error.message;
            product.lastError = error.message;
          }
          await persistStores();
        }
      } else if (activeWindow && product.url && product.originalUrlVerified !== true) {
        const nextDiscovery = Date.parse(product.nextProductDiscoveryAt || '');
        if (!Number.isFinite(nextDiscovery) || now.getTime() >= nextDiscovery) {
          product.lastProductDiscoveryAttemptAt = now.toISOString();
          product.nextProductDiscoveryAt = new Date(
            now.getTime() + ALTERNATIVE_DISCOVERY_INTERVAL_MS
          ).toISOString();
          try {
            await verifyOriginalProductUrl(product);
          } catch (error) {
            product.discoveryStatus = 'needs_review';
            product.lastError = `Could not verify the supplied product URL: ${error.message}`;
          }
          await persistStores();
        }
      }
      if (activeWindow) {
        await refreshAlternativeOffers(product, now, persistStores);
      }
      const monitoringResult = await checkMonitoredProduct({
        product,
        purchaseDate: product.date || receipt.purchaseDate,
        now,
        intervalMs: MONITOR_INTERVAL_MS,
        fetchVerifiedPrice: fetchPrice,
        sendNotification: (trackedProduct, details) =>
          sendAlert(receipt, trackedProduct, details),
        persist: persistStores
      });
      if (monitoringResult.status === 'URL DISCOVERY') {
        product.nextCheckAt = product.nextProductDiscoveryAt || null;
      } else if (
        ['WATCH EXPIRED', 'NEEDS CONFIRMATION', 'PURCHASE DATE NEEDS CONFIRMATION'].includes(
          monitoringResult.status
        )
      ) {
        product.nextCheckAt = null;
      } else if (monitoringResult.checked) {
        product.nextCheckAt = nextScheduledCheckAt;
      }
      product.watch = monitoringResult.status === 'WATCH EXPIRED'
        ? 'no'
        : statusFor(product.date || receipt.purchaseDate) === 'watch'
          ? 'yes'
          : 'no';
      await persistStores();
      results.push({
        product: product.name,
        status: monitoringResult.notification === 'sent'
          ? 'price_drop_alert_sent'
          : monitoringResult.notification === 'failed'
            ? 'price_drop_email_failed'
            : monitoringResult.status,
        monitoringStatus: monitoringResult.status,
        currentPrice: product.currentVerifiedPrice,
        reason: monitoringResult.reason || null
      });
    }

    return {
      ok: true,
      message: 'Price check completed.',
      results
    };
  } finally {
    checking = false;
  }
}

app.post('/api/monitor/run', async (_, res) => {
  try {
    const result = await monitorPrices();
    res
      .status(result.ok ? 200 : 409)
      .json(result);
  } catch (error) {
    console.error('Manual price check failed:', error.message);
    res.status(500).json({
      ok: false,
      message: 'Price check failed.',
      error: error.message
    });
  }
});

app.post('/api/email/test', async (req, res) => {
  try {
    const testRecipient = String(req.body?.recipient || '').trim();
    if (testRecipient && !validEmailAddress(testRecipient)) {
      return res.status(400).json({
        error: 'Enter a valid email address for this test.'
      });
    }

    const recipients = testRecipient
      ? normalizeRecipients([testRecipient])
      : await getAlertRecipients();
    if (!recipients.length) {
      return res.status(400).json({
        error: 'Add at least one recipient or enter an address for this test.'
      });
    }

    const gmailStatus = await getGmailConnectionStatus();
    if (!gmailStatus.connected) {
      return res.status(401).json({
        error: gmailStatus.error || 'Connect Gmail before sending email notifications.'
      });
    }

    const requestedId = String(req.body?.productId || '');
    let product;

    if (requestedId) {
      const [receipts, manualProducts] = await Promise.all([
        readReceipts(),
        fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8').then(JSON.parse)
      ]);
      const receiptProduct = receipts.flatMap(receipt =>
        (receipt.products || []).map(item => ({
          ...item,
          date: item.date || receipt.purchaseDate,
          retailer: item.retailer || receipt.merchant,
          url: item.url || ''
        }))
      ).find(item => item.id === requestedId);
      product = receiptProduct ||
        manualProducts.find(item => item.id === requestedId);

      if (!product || statusFor(product.date) !== 'watch') {
        return res.status(404).json({
          error: 'Choose a product that is currently on the active watchlist.'
        });
      }
    } else {
      product = {
        name: 'Example grocery item',
        purchasePrice: 70,
        date: localDateString(),
        retailer: 'Example grocery store',
        url: ''
      };
    }

    const purchasePrice = Number(product.purchasePrice);
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      return res.status(400).json({
        error: 'This product has no valid purchase price for the test alert.'
      });
    }

    product.testPrice = Math.max(
      0.01,
      Math.round((purchasePrice - Math.min(50, purchasePrice / 2)) * 100) / 100
    );
    product.recipients = recipients;
    await sendTestEmail(product);
    res.json({
      ok: true,
      message: `Gmail accepted the test email for delivery to ${recipients.join(', ')}.`
    });
  } catch (error) {
    console.error('Email test failed:', error.message);
    res.status(502).json({
      ok: false,
      error: error.message || 'Could not send test email.'
    });
  }
});

app.get('/api/agent/status', async (_, res) => {
  try {
    const { products } = await readReceipts().then(async receipts => {
      const manualProducts = JSON.parse(
        await fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8')
      );
      return {
        products: [
          ...receipts.flatMap(receipt =>
            (receipt.products || []).map(product => ({
              id: product.id,
              product: product.name || product.product,
              merchant: receipt.merchant,
              purchaseDate: product.date || receipt.purchaseDate,
              purchasePrice: product.purchasePrice,
              currentPrice: product.currentPrice ?? null,
              url: product.url || '',
              discoveryStatus: product.discoveryStatus || 'unknown',
              matchConfidence: product.matchConfidence || 0,
              watch: normalizeProduct(product, receipt).watch,
              lastCheckedAt: product.lastCheckedAt || null,
              alertSent: Boolean(product.alertSent),
              lastError: product.lastError || null
            }))
          ),
          ...manualProducts.map(product => ({
            id: product.id,
            product: product.name,
            merchant: product.retailer,
            purchaseDate: product.date,
            purchasePrice: product.purchasePrice,
            currentPrice: product.currentPrice ?? null,
            url: product.url,
            discoveryStatus: product.discoveryStatus,
            matchConfidence: product.matchConfidence,
            watch: statusFor(product.date) === 'watch' ? 'yes' : 'no',
            lastCheckedAt: product.lastCheckedAt || null,
            alertSent: Boolean(product.alertSent),
            lastError: product.lastError || null
          }))
        ]
      };
    });

    const [recipients, aiStatus] = await Promise.all([
      getAlertRecipients(),
      getLocalAIStatus()
    ]);
    res.json({
      ok: true,
      agentConnected: aiStatus.connected && aiStatus.modelAvailable,
      aiProvider: aiStatus.provider,
      aiModel: aiStatus.model,
      aiConnected: aiStatus.connected,
      aiModelAvailable: aiStatus.modelAvailable,
      emailConfigured: recipients.length > 0 && isGoogleOAuthConfigured(),
      products
    });
  } catch (error) {
    console.error('Could not load agent status:', error.message);
    res.status(500).json({ error: 'Could not load agent status.' });
  }
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `PriceDrop Agent API running on http://127.0.0.1:${PORT}`
  );

  console.log(
    `Local AI: ${
      `Ollama (${OLLAMA_MODEL})`
    } | Gmail: ${
      isGoogleOAuthConfigured()
        ? 'configured'
        : 'not configured'
    } | Price monitoring interval: ${MONITOR_INTERVAL_MINUTES} minutes | Public product discovery interval: ${ALTERNATIVE_DISCOVERY_INTERVAL_MS / (60 * 60 * 1000)} hours`
  );
  startMonitoringScheduler(
    () => {
      nextScheduledCheckAt = new Date(Date.now() + MONITOR_INTERVAL_MS).toISOString();
      return monitorPrices();
    },
    {
      intervalMs: MONITOR_INTERVAL_MS,
      onError: error => console.error('Scheduled price check failed:', error.message)
    }
  );
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `PriceDrop Agent API could not start: port ${PORT} is already in use. Stop the other process or configure a matching Vite proxy target.`
    );
  } else {
    console.error(
      `PriceDrop Agent API could not listen on 127.0.0.1:${PORT}: ${error.message}`
    );
  }
  process.exit(1);
});