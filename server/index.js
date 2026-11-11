import './env.js';

import express from 'express';

import cors from 'cors';

import multer from 'multer';

import fs from 'fs/promises';

import os from 'node:os';

import path from 'path';

import { fileURLToPath } from 'url';

import { execFile } from 'node:child_process';

import { promisify } from 'node:util';

import { lookup } from 'node:dns/promises';

import { isIP } from 'node:net';

import crypto from 'crypto';

import sharp from 'sharp';
import { renderReceiptPdf } from './receipt-pdf.js';
import { convertReceiptHeif, HEIF_CONVERSION_ERROR } from './receipt-heif.js';

import {
  candidateUrlRejectionReason,
  navigationUrlRejectionReason,
  productPageEvidenceRejectionReason,
  readRetailerProductPage
} from './retailer-browser.js';
import {
  appendReceiptToHistory,
  deleteReceiptFromHistory
} from './tracking-store.js';
import { createReceiptExtractionRetryScheduler } from './receipt-retry.js';
import {
  EXTRACTION_RETRY_MESSAGE,
  isGroqRateLimitError,
  sanitizeErrorText
} from './errors.js';
import { knownRetailerDomain, resolveReceiptRetailer } from './retailers.js';
import { receiptDateForMerchant, recoverReceiptDate } from './receipt-dates.js';

import {

  askGemma,

  GroqError,

  getLocalAIStatus,

  matchProductWithGemma,

  OLLAMA_MODEL

} from './localAI.js';

import {

  cheapestVerifiedAlternative,
  compareProductIdentity,
  isRetailerDomain,
  matchProductCandidate,
  registrableDomain,
  resolveOfficialRetailerDomain,
  retailerMatchesHost,
  saveFoundProductUrl,
  saveVerifiedProductMatch,
  searchRetailerProductPages,
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

  hasMonitorableUrl,

  isFutureDateOnly,

  isValidDateOnly,

  isWithinMonitoringWindow,

  localDateString,
  monitoringDashboardStats,
  monitoringStatusFor,
  priceStatusFor,
  monitoringWindow,
  receiptDateState,
  receiptDateNeedsConfirmation,
  shouldAutomaticallyDiscoverProduct,
  watchStatusFor,
  startMonitoringScheduler

} from './monitoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.join(__dirname, '..', 'data');

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

const RECEIPTS_FILE = path.join(DATA_DIR, 'receipts.json');

const MANUAL_PRODUCTS_FILE = path.join(DATA_DIR, 'manual-products.json');

const EMAIL_SETTINGS_FILE = path.join(DATA_DIR, 'email-settings.json');

const PORT = Number(process.env.PORT || 4100);

const configuredPriceInterval = Number(process.env.PRICE_CHECK_INTERVAL_HOURS || 24);
if (!Number.isFinite(configuredPriceInterval) || configuredPriceInterval < 24) {
  console.warn('PRICE_CHECK_INTERVAL_HOURS must be at least 24; using 24 hours.');
}
const PRICE_CHECK_INTERVAL_HOURS = Number.isFinite(configuredPriceInterval) &&
  configuredPriceInterval >= 24 ? configuredPriceInterval : 24;

const activeDiscoveries = new Set();

const MONITOR_INTERVAL_MS = PRICE_CHECK_INTERVAL_HOURS * 60 * 60 * 1000;
const configuredProductDiscoveryInterval = Number(
  process.env.PUBLIC_PRODUCT_DISCOVERY_INTERVAL_HOURS || 24
);
if (!Number.isFinite(configuredProductDiscoveryInterval) || configuredProductDiscoveryInterval <= 0) {
  console.warn('PUBLIC_PRODUCT_DISCOVERY_INTERVAL_HOURS must be positive; using 24 hours.');
}
const PRODUCT_DISCOVERY_INTERVAL_MS = (
  Number.isFinite(configuredProductDiscoveryInterval) && configuredProductDiscoveryInterval > 0
    ? configuredProductDiscoveryInterval
    : 24
) * 60 * 60 * 1000;
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
  const address = String(value || '').trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) &&
    address.length <= 254;
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
  const receipts = JSON.parse(await fs.readFile(RECEIPTS_FILE, 'utf8'));
  return receipts.map(receipt => {
    recoverReceiptDate(receipt);
    for (const product of receipt.products || []) {
      if (product.discoveryStatus === 'searching' && !activeDiscoveries.has(product.id)) {
        product.discoveryStatus = 'queued';
      }
    }
    return receipt;
  });
}



async function writeReceipts(receipts) {

  await writeJsonFile(RECEIPTS_FILE, receipts);

}



async function writeJsonFile(file, value) {

  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;

  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });

  await fs.rename(temporary, file);
}

let fileQueue = Promise.resolve();

// Serializes short read-modify-write operations on the JSON stores so uploads,
// deletes, and background monitoring never overwrite each other.
function withFileMutex(operation) {
  const run = fileQueue.then(operation, operation);
  fileQueue = run.catch(() => {});
  return run;
}

async function withTrackingStoreLock(operation) {
  while (checking) {
    await checkFinished;
  }
  checking = true;
  let releaseLock;
  checkFinished = new Promise(resolve => { releaseLock = resolve; });
  try {
    return await withFileMutex(operation);
  } finally {
    checking = false;
    releaseLock();
  }
}

const deletedProductIds = new Set();

async function saveNewReceipt(receipt) {
  return withFileMutex(async () => {
    await appendReceiptToHistory({
      receiptsFile: RECEIPTS_FILE,
      receipt
    });
  });
}

// Writes in-memory monitoring state without resurrecting records that were
// deleted, or dropping receipts uploaded, while a check was running.
function persistMonitoringState(receipts, manualProducts) {
  return withFileMutex(async () => {
    const [diskReceipts, diskManual] = await Promise.all([
      readReceipts(),
      fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8').then(JSON.parse)
    ]);
    const memoryReceipts = new Map(receipts.map(item => [item.id, item]));
    const mergedReceipts = diskReceipts.map(diskReceipt => {
      const memory = memoryReceipts.get(diskReceipt.id);
      if (!memory) return diskReceipt;
      const memoryProducts = new Map((memory.products || []).map(item => [item.id, item]));
      return {
        ...memory,
        products: (memory.products || []).filter(item => !deletedProductIds.has(item.id))
          .concat((diskReceipt.products || []).filter(item => !memoryProducts.has(item.id)))
      };
    });
    const memoryManual = new Map(manualProducts.map(item => [item.id, item]));
    const mergedManual = diskManual.map(item => memoryManual.get(item.id) || item);
    await Promise.all([
      writeReceipts(mergedReceipts),
      writeJsonFile(MANUAL_PRODUCTS_FILE, mergedManual)
    ]);
  });
}

async function loadTrackedRecord(id) {

  const [receipts, manualProducts] = await Promise.all([

    readReceipts(),

    fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8').then(JSON.parse)

  ]);

  for (const receipt of receipts) {

    const product = (receipt.products || []).find(item => item.id === id);

    if (product) {

      const purchaseDate = receiptPurchaseDate(receipt, product);
      product.date = purchaseDate;
      product.purchaseDate = purchaseDate;
      product.purchaseDateNeedsConfirmation = normalizeProduct(product, receipt)
        .purchaseDateNeedsConfirmation;

      product.retailer = receipt.merchant || product.retailer;

      return {
        product,
        receipt,
        persist: () => withTrackingStoreLock(async () => {
          const currentReceipts = await readReceipts();
          const receiptIndex = currentReceipts.findIndex(item => item.id === receipt.id);
          if (receiptIndex < 0) {
            throw new Error('This receipt was replaced by a newer upload.');
          }
          const currentReceipt = currentReceipts[receiptIndex];
          currentReceipts[receiptIndex] = {
            ...currentReceipt,
            ...receipt,
            products: (currentReceipt.products || []).map(currentProduct => {
              const updatedProduct = (receipt.products || []).find(
                item => item.id === currentProduct.id
              );
              return updatedProduct
                ? { ...currentProduct, ...updatedProduct }
                : currentProduct;
            })
          };
          await writeReceipts(currentReceipts);
        })
      };

    }

  }

  const product = manualProducts.find(item => item.id === id);

  return product

    ? {

      product,

      persist: () => withTrackingStoreLock(async () => {
        const currentProducts = JSON.parse(
          await fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8')
        );
        const productIndex = currentProducts.findIndex(item => item.id === product.id);
        if (productIndex < 0) {
          throw new Error('This product was removed by a newer receipt upload.');
        }
        currentProducts[productIndex] = {
          ...currentProducts[productIndex],
          ...product
        };
        await writeJsonFile(MANUAL_PRODUCTS_FILE, currentProducts);
      })

    }

    : null;

}



function statusFor(purchaseDate) {
  return watchStatusFor(purchaseDate);
}

function receiptPurchaseDate(receipt, product) {
  if (isValidDateOnly(receipt.purchaseDate)) return receipt.purchaseDate;
  return product?.purchaseDate || product?.date || receipt.purchaseDate || null;
}

function receiptStatusFor(receipt, purchaseDate = receipt.purchaseDate) {
  if (receipt.extractionStatus === 'failed') return 'EXTRACTION FAILED';
  if (receipt.extractionStatus === 'retry_pending') return 'RETRY PENDING';
  if (receiptDateNeedsConfirmation(
    purchaseDate,
    receipt.uploadedAt,
    receipt.purchaseDateConfirmedByUser === true
  )) return 'PURCHASE DATE NEEDS CONFIRMATION';
  return statusFor(purchaseDate);
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
  if (status !== 'ON WATCH' || !hasMonitorableUrl(product)) {

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

  const date = receiptPurchaseDate(receipt, product);
  const purchaseDateNeedsConfirmation = receiptDateNeedsConfirmation(
    date,
    receipt.uploadedAt,
    receipt.purchaseDateConfirmedByUser === true ||
      product.purchaseDateConfirmedByUser === true
  ) || (receipt.purchaseDateNeedsConfirmation === true ||
    product.purchaseDateNeedsConfirmation === true) &&
      receipt.purchaseDateConfirmedByUser !== true &&
      product.purchaseDateConfirmedByUser !== true;



  return {

    ...product,
    date,
    purchaseDate: date,
    purchaseDateNeedsConfirmation,
    retailer: receipt.merchant || product.retailer || '',

    name: product.name || product.product || 'Product',

    product: product.product || product.name || 'Product',

    price: Number(product.price ?? product.purchasePrice ?? 0),

    purchasePrice: Number(

      product.purchasePrice ?? product.price ?? 0

    ),

    watch: statusFor(date)

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

async function receiptImageViews(buffer) {
  const fullImage = await normalizeReceiptImage(buffer);
  const metadata = await sharp(fullImage).metadata();
  if (!metadata.width || !metadata.height) return [fullImage];

  const views = [fullImage];
  if (metadata.height >= metadata.width) {
    const cropHeight = Math.ceil(metadata.height * 0.4);
    views.push(await sharp(fullImage)
      .extract({ left: 0, top: 0, width: metadata.width, height: cropHeight })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer());
    const dateHeight = Math.ceil(metadata.height * 0.25);
    views.push(await sharp(fullImage)
      .extract({
        left: 0,
        top: metadata.height - dateHeight,
        width: metadata.width,
        height: dateHeight
      })
      .greyscale()
      .normalize()
      .resize({ width: 2000 })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer());
  } else {
    const cropWidth = Math.ceil(metadata.width * 0.4);
    for (const left of [0, metadata.width - cropWidth]) {
      views.push(await sharp(fullImage)
        .extract({ left, top: 0, width: cropWidth, height: metadata.height })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer());
    }
  }
  return views.slice(0, 3);
}



async function extractReceipt(file, receiptId) {

  const isPdf = file.buffer.subarray(0, 1024).toString('latin1').includes('%PDF-');

  let text;

  let images = [];



  try {

    const pdfPages = isPdf ? await renderReceiptPdf(file.buffer) : [file.buffer];
    const views = pdfPages.length === 1
      ? await receiptImageViews(pdfPages[0])
      : await Promise.all(pdfPages.map(normalizeReceiptImage));
    images = views.map(image =>
      `data:image/jpeg;base64,${image.toString('base64')}`
    );

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

  console.info('[receipt]', JSON.stringify({
    event: 'image_loaded',
    receiptId,
    source: images.length ? 'image' : 'text',
    mimeType: images.length ? 'image/jpeg' : 'text/plain',
    imageCount: images.length,
    byteLength: file.buffer.length
  }));

  const prompt = `Read this purchase receipt. Return ONLY compact JSON, using null for anything not printed:
{"merchant":"store name as printed","merchantEvidence":"store header text, web address, or store number as printed","purchaseDateEvidence":"exact printed purchase date text including year","purchaseDate":"YYYY-MM-DD","total":number,"currency":"ISO 4217 currency code such as USD","products":[{"name":"item as printed","brand":"","model":"","sku":"printed item number","size":"","variant":"","quantity":number,"paidPrice":number,"price":number,"ocrText":"literal item-line text"}]}
Rules:
- Include purchased line items only; never tax, discounts, savings, shipping, or totals.
- Never invent a brand, model, SKU, quantity, price, or date. Use null when not readable.
- price is what was paid for that line, not a discount or the receipt total.
- Return the receipt currency as an ISO 4217 code when printed or unambiguous; otherwise use null.
- Find the transaction date (top, bottom, or beside the total) in every image. Copy it exactly into purchaseDateEvidence; it is not a time, card expiry, member number, or barcode. Do not use today's date or the upload date.
- If the date or its year is not legible, return null for purchaseDateEvidence and purchaseDate.
- If an item name is suspicious OCR, keep it as printed and put its SKU and nearby text in ocrText.`;



const promptWithText = text !== undefined

  ? `${prompt}



Receipt text:

${text.slice(0, 18000)}`

  : prompt;

  const parsed = await askGemma(promptWithText, images, undefined, { receiptId });
  const products = Array.isArray(parsed.products)
    ? parsed.products.filter(item => item && typeof item === 'object' && !Array.isArray(item))
    : [];
  const purchaseDateEvidence = typeof parsed.purchaseDateEvidence === 'string'
    ? parsed.purchaseDateEvidence.trim().slice(0, 50)
    : '';
  const retailer = resolveReceiptRetailer(
    typeof parsed.merchant === 'string' ? parsed.merchant : '',
    typeof parsed.merchantEvidence === 'string' ? parsed.merchantEvidence : ''
  );
  const purchaseDate = receiptDateForMerchant(purchaseDateEvidence, retailer.merchant);
  const currency = typeof parsed.currency === 'string' &&
    /^[A-Z]{3}$/.test(parsed.currency.trim().toUpperCase())
    ? parsed.currency.trim().toUpperCase()
    : null;
  console.info('[receipt]', JSON.stringify({
    event: 'extraction_parsed',
    receiptId,
    merchant: retailer.merchant,
    retailerResolved: retailer.known,
    officialDomain: retailer.domain || null,
    purchaseDate,
    total: parsed.total ?? null,
    currency,
    products: products.length
  }));



  return {

    merchant: retailer.merchant,
    officialRetailerDomain: retailer.domain,



    purchaseDate,
    purchaseDateEvidence: purchaseDateEvidence || null,



    total:

      parsed.total != null &&

      Number.isFinite(Number(parsed.total)) &&

      Number(parsed.total) >= 0

        ? Number(parsed.total)

        : null,

    currency,

    products: products


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
            productLineDetails: item.productLineDetails == null
              ? null
              : String(item.productLineDetails).slice(0, 300),
            nearbyReceiptText: item.nearbyReceiptText == null
              ? null
              : String(item.nearbyReceiptText).slice(0, 300),
            ocrText: item.ocrText == null
              ? null
              : String(item.ocrText).slice(0, 300),

            size: item.size == null ? null : String(item.size).slice(0, 100),

            variant: item.variant == null ? null : String(item.variant).slice(0, 100),

            bundle: item.bundle == null ? null : String(item.bundle).slice(0, 100),

            condition: item.condition == null
              ? null
              : String(item.condition).slice(0, 100),

            attributes: Array.isArray(item.attributes)

              ? item.attributes.map(value => String(value).slice(0, 100)).slice(0, 10)

              : [],

            quantity: item.quantity != null &&

              Number.isFinite(Number(item.quantity))

              ? Number(item.quantity)

              : null,

            price:

              (item.paidPrice ?? item.price) != null &&

              Number.isFinite(Number(item.paidPrice ?? item.price)) &&

              Number(item.paidPrice ?? item.price) > 0

                ? Number(item.paidPrice ?? item.price)

                : null

          }))

          .filter(

            item =>

              item.name !== 'Unknown product' ||

              item.price != null

          )

  };

}

function createReceiptProducts(
  parsed,
  purchaseDate,
  purchaseDateConfirmed,
  purchaseDateNeedsConfirmation,
  purchaseDateConfirmedByUser = false
) {
  const dateState = receiptDateState(purchaseDate);
  return parsed.products.map(item => ({
    id: crypto.randomUUID(),
    date: purchaseDate,
    name: item.name,
    product: item.name,
    brand: item.brand || '',
    model: item.model || '',
    sku: item.sku || '',
    description: item.description || '',
    productLineDetails: item.productLineDetails || '',
    nearbyReceiptText: item.nearbyReceiptText || '',
    ocrText: item.ocrText || '',
    size: item.size || '',
    variant: item.variant || '',
    bundle: item.bundle || '',
    condition: item.condition || '',
    attributes: item.attributes || [],
    identityAttributes: item.attributes || [],
    quantity: item.quantity,
    price: item.price == null ? 0 : Number(item.price),
    purchasePrice: item.price == null ? 0 : Number(item.price),
    currency: parsed.currency || null,
    watch: dateState.watch,
    status: dateState.status,
    url: '',
    retailer: parsed.merchant,
    officialRetailerDomain: parsed.officialRetailerDomain || '',
    purchaseDateConfirmed,
    purchaseDateNeedsConfirmation,
    purchaseDateConfirmedByUser,
    discoveryStatus: 'queued',
    monitoringStatus: monitoringStatusFor({ purchaseDate, purchaseDateNeedsConfirmation }),
    currentPrice: null,
    matchConfidence: 0,
    lastCheckedAt: null,
    lastAlertedPrice: null,
    alertSent: false,
    lastError: null,
    priceHistory: [],
    notificationHistory: []
  }));
}

async function fetchPrice(url, expectedDomain = '') {

  const { url: parsedUrl } = await validateProductUrl(url);
  const page = await readRetailerProductPage(parsedUrl.toString(), {
    validateUrl: validateProductUrl
  });
  const verifiedUrl = new URL(page.url);
  if (expectedDomain && !isRetailerDomain(verifiedUrl.hostname, expectedDomain)) {
    throw new Error('The retailer redirected away from its official product website.');
  }
  return page;

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
    product.productLineDetails,
    product.nearbyReceiptText,
    product.ocrText,
    product.size,
    product.variant,
    product.bundle,
    product.condition,

    ...(Array.isArray(product.attributes) ? product.attributes : []),

    ...(Array.isArray(product.identityAttributes) ? product.identityAttributes : [])

  ].filter(Boolean).join(' ').slice(0, 400);

}



async function evaluateListing(
  product,
  searchResult,
  expectedDomain = product.officialRetailerDomain
) {

  const page = await fetchPrice(searchResult.url, expectedDomain);

  const candidate = {
    ...page,
    title: page.title || searchResult.title
  };
  console.info('[product-discovery]', JSON.stringify({
    event: 'candidate_page_opened',
    retailer: product.retailer || '',
    product: product.name || product.product || '',
    candidateUrl: candidate.url,
    title: candidate.title,
    brand: candidate.brand || '',
    model: candidate.model || '',
    sku: candidate.sku || '',
    specifications: candidate.attributes || [],
    currentPrice: candidate.price,
    currency: candidate.currency || '',
    priceVerified: candidate.verified === true
  }));
  const urlRejection = candidateUrlRejectionReason(
    candidate.url,
    expectedDomain,
    candidate.title
  );
  const pageRejection = productPageEvidenceRejectionReason(candidate);
  if (!expectedDomain || urlRejection || pageRejection) {
    const reason = !expectedDomain
      ? 'No official retailer domain is verified.'
      : urlRejection || pageRejection;
    console.info('[product-discovery]', JSON.stringify({
      event: 'candidate_rejected',
      candidateUrl: candidate.url,
      title: candidate.title,
      productSchema: candidate.productSchema === true,
      productSku: candidate.productSku === true,
      addToCart: candidate.addToCart === true,
      verifiedPrice: candidate.verified === true,
      productDetails: candidate.productDetails === true,
      reason
    }));
    throw new Error(reason);
  }
  let comparison;
  try {
    comparison = await compareProductIdentity(product, candidate, matchProductWithGemma);
  } catch (error) {
    console.info('[product-discovery]', JSON.stringify({
      event: 'candidate_identity_verification_unavailable',
      retailer: product.retailer || '',
      product: product.name || product.product || '',
      candidateUrl: candidate.url,
      reason: sanitizeErrorText(error.message)
    }));
    return {
      candidate,
      match: matchProductCandidate(product, candidate, null),
      aiMatch: null,
      verificationError: error
    };
  }
  const { match, aiMatch, identityComparisonSkipped } = comparison;
  console.info('[product-discovery]', JSON.stringify({
    event: match.accepted ? 'candidate_accepted' : 'candidate_rejected',
    retailer: product.retailer || '',
    product: product.name || product.product || '',
    candidateUrl: candidate.url,
    groqConfidence: aiMatch?.confidence ?? null,
    reason: match.reason,
    priceVerified: match.priceVerified
  }));
  return {
    candidate,
    match,
    aiMatch,
    identityComparisonSkipped
  };

}



async function discoverOriginalListing(product, persist = async () => {}, searchCache = null) {
  if (!product.retailer) {
    throw new Error('Enter the original retailer to search for its product page.');
  }
  const searchKey = JSON.stringify([
    product.retailer, product.officialRetailerDomain, product.name || product.product,
    product.sku, product.brand, product.model, product.variant, product.size,
    product.bundle, product.condition, product.description, product.quantity,
    product.productLineDetails, product.nearbyReceiptText, product.ocrText,
    ...(Array.isArray(product.attributes) ? product.attributes : []),
    ...(Array.isArray(product.identityAttributes) ? product.identityAttributes : [])
  ].map(value => String(value || '').trim().toLowerCase()));
  let search = searchCache?.get(searchKey);
  if (!search) {
    search = searchRetailerProductPages(product.retailer, product);
    searchCache?.set(searchKey, search);
  }
  const { domain, results, blocked } = await search;
  console.info('[product-discovery]', JSON.stringify({
    event: 'retailer_search_completed',
    retailer: product.retailer,
    product: product.name || product.product || '',
    domain,
    candidateUrls: results.map(result => result.url)
  }));
  product.discoveryCandidates = results.map(result => ({
    url: result.url,
    title: result.title || '',
    priceVerified: false
  }));
  await persist();
  if (!domain) {
    product.discoveryStatus = 'awaiting_url';
    product.lastError = 'The official retailer domain could not be determined.';
    product.discoveryMessage =
      'The agent could not verify the product page yet. It will continue searching automatically. You may paste the product URL as a fallback.';
    product.monitoringStatus = monitoringStatusFor(product);
    console.info('[product-discovery]', JSON.stringify({
      event: 'discovery_finished',
      retailer: product.retailer,
      product: product.name || product.product || '',
      status: product.monitoringStatus
    }));
    return false;
  }
  product.officialRetailerDomain = domain;
  for (const result of results) {
    const urlRejection = candidateUrlRejectionReason(
      result.url,
      domain,
      result.title
    );
    if (urlRejection) {
      console.info('[product-discovery]', JSON.stringify({
        event: 'candidate_rejected',
        retailer: product.retailer,
        product: product.name || product.product || '',
        candidateUrl: result.url,
        candidateTitle: result.title || '',
        reason: urlRejection
      }));
      continue;
    }
    saveFoundProductUrl(product, result.url);
    product.discoveryMessage = 'Product link saved. Product identity is not verified.';
    product.productDiscoveryError = null;
    await persist();
    try {
      const { candidate, match } = await evaluateListing(product, result);
      if (match.accepted) {
        const verifiedMatch = {
          title: candidate.title,
          url: candidate.url,
          retailer: product.retailer,
          price: match.priceVerified ? candidate.price : null,
          currency: match.priceVerified ? candidate.currency : null,
          priceVerified: match.priceVerified,
          exactSku: match.exactSku,
          matchConfidence: match.confidence,
          matchEvidence: match.reason
        };
        product.discoveryCandidates[product.discoveryCandidates.findIndex(item => item.url === result.url)] = verifiedMatch;
        saveVerifiedProductMatch(product, verifiedMatch);
        product.discoveryMessage = '';
      } else {
        product.productDiscoveryError = match.reason;
      }
    } catch (error) {
      console.info('[product-discovery]', JSON.stringify({
        event: 'candidate_page_failed',
        retailer: product.retailer,
        product: product.name || product.product || '',
        candidateUrl: result.url,
        reason: sanitizeErrorText(error.message)
      }));
      product.productDiscoveryError = isGroqRateLimitError(error)
        ? 'Product identity comparison is temporarily rate limited. The agent will retry automatically.'
        : sanitizeErrorText(error.message);
    }
    product.monitoringStatus = monitoringStatusFor(product);
    console.info('[product-discovery]', JSON.stringify({
      event: 'product_url_saved',
      retailer: product.retailer,
      product: product.name || product.product || '',
      candidateUrl: product.url,
      identityVerified: product.originalUrlVerified === true
    }));
    return product.originalUrlVerified === true;
  }

  product.discoveryStatus = blocked || domain === 'costco.com' && !results.length
    ? 'blocked' : 'awaiting_url';
  product.lastError = product.discoveryStatus === 'blocked'
    ? 'Costco search was blocked or returned no results'
    : product.productDiscoveryError || 'The product page could not be verified.';
  product.discoveryMessage = product.lastError;
  product.monitoringStatus = monitoringStatusFor(product);
  console.info('[product-discovery]', JSON.stringify({
    event: 'discovery_finished',
    retailer: product.retailer,
    product: product.name || product.product || '',
    status: product.monitoringStatus
  }));
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

  let domain = product.officialRetailerDomain || '';
  if (domain && !retailerMatchesHost(product.retailer, domain)) {
    domain = '';
    delete product.officialRetailerDomain;
  }
  if (!domain && product.retailer) {
    try {
      domain = await resolveOfficialRetailerDomain(product.retailer);
    } catch {
      domain = '';
    }
  }
  if (!domain && product.retailer && retailerMatchesHost(product.retailer, hostname)) {
    domain = registrableDomain(hostname);
  }
  if (domain) product.officialRetailerDomain = domain;
  if (!domain || !isRetailerDomain(hostname, domain)) {
    product.originalUrlVerified = false;
    product.discoveryStatus = 'needs_review';
    product.lastError = domain
      ? `The submitted product URL does not belong to the original retailer (${product.retailer}).`
      : `Could not verify the official website for the original retailer (${product.retailer || 'unknown'}).`;
    return false;
  }

  const { candidate, match } = await evaluateListing(product, {

    url: product.url,

    title: ''

  });

  if (!match.accepted) {
    product.originalUrlVerified = false;
    product.discoveryStatus = 'found';
    product.lastError = match.reason;
    product.discoveryMessage =
      'The product page was found. Product identity and price verification will retry automatically.';
    product.monitoringStatus = monitoringStatusFor(product);
    return false;
  }

  product.originalUrlVerified = true;

  product.discoveryStatus = 'verified';
  product.monitoringStatus = monitoringStatusFor(product);

  product.matchConfidence = match.confidence;

  product.matchEvidence = match.reason;

  product.currentVerifiedPrice = match.priceVerified ? candidate.price : null;
  product.currentPrice = product.currentVerifiedPrice;
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

        const { candidate: verified, match } = await evaluateListing(
          product,
          candidate,
          candidateHost
        );

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

        if (/Groq returned 429/i.test(error.message)) break;

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

    ? `\<section>\<h3>Cheaper alternative found\</h3>\<p>${escapeHtml(alternative.retailer)}: $${Number(alternative.price).toFixed(2)} · verified ${escapeHtml(new Date(alternative.lastVerifiedAt).toLocaleString())}\</p>\<p>\<a href="${escapeHtml(alternative.url)}">View alternative\</a>\</p>\<p>This is another retailer's offer. It did not trigger the original retailer's price-drop alert.\</p>\</section>`

    : '';



  const retailerName = product.retailer || receipt.merchant || 'Retailer';
  const identityWarning = product.originalUrlVerified === true
    ? ''
    : 'The saved product link has not been identity-verified; check that it is the correct item.';
  const priceSourceWarning = product.currentPriceSource === 'Costco warehouse price'
    ? 'Costco warehouse prices may vary by location and may differ from online prices.'
    : '';
  const html = [
    '<h2>Price drop detected</h2>',
    `<p><strong>Product:</strong> ${safeName}<br>`,
    `<strong>Retailer:</strong> ${safeRetailer}<br>`,
    `<strong>Purchase price:</strong> $${purchasePrice.toFixed(2)}<br>`,
    `<strong>Current price:</strong> $${price.toFixed(2)}<br>`,
    `<strong>Savings:</strong> $${savings.toFixed(2)} (${savingsPercent.toFixed(1)}%)<br>`,
    `<strong>Product link:</strong> <a href="${safeUrl}">${safeUrl}</a></p>`,
    ...(identityWarning ? [`<p>${escapeHtml(identityWarning)}</p>`] : []),
    ...(priceSourceWarning ? [`<p>${escapeHtml(priceSourceWarning)}</p>`] : []),
    `<p>Detected ${escapeHtml(detectedAtLabel)}. ${remainingDays} day${remainingDays === 1 ? '' : 's'} remain in the 30-day watch. Check ${safeRetailer}'s official return, price-adjustment, or price-match policy${safePolicyUrl ? ` (<a href="${safePolicyUrl}">policy</a>)` : ''}; eligibility is not guaranteed. PriceDrop Agent will not initiate a return, refund, or purchase.</p>`,
    alternativeHtml
  ].join('');
  await sendGmailMessage({
    recipients,
    subject: `Price drop detected: ${product.name}`,
    text: [
      'Price drop detected.',
      `Product: ${product.name}`,
      `Retailer: ${retailerName}`,
      `Purchase price: $${purchasePrice.toFixed(2)}`,
      `Current price: $${price.toFixed(2)}`,
      `Savings: $${savings.toFixed(2)}`,
        `Savings percentage: ${savingsPercent.toFixed(1)}%`,
      `Product link: ${product.url}`,
      ...(identityWarning ? [identityWarning] : []),
      ...(priceSourceWarning ? [priceSourceWarning] : []),
      '',
      `Detected: ${detectedAtLabel}. Days remaining in the 30-day watch: ${remainingDays}.`,
      `Check ${retailerName}'s official return, price-adjustment, or price-match policy. Eligibility is not guaranteed.`,
      ...(product.returnPolicyUrl ? [`Official retailer policy: ${product.returnPolicyUrl}`] : []),
      alternativeText
    ].join('\n'),
    html
  });
  console.info('[alert]', JSON.stringify({
    event: 'email_sent',
    product: product.name,
    retailer: retailerName,
    price
  }));
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



const updateEmailSettings = async (req, res) => {

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

};

app.post('/api/email/settings', updateEmailSettings);
app.put('/api/email/settings', updateEmailSettings);



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

        purchaseDateNeedsConfirmation: receiptDateNeedsConfirmation(
          receipt.purchaseDate,
          receipt.uploadedAt,
          receipt.purchaseDateConfirmedByUser === true
        ),

        status: receiptStatusFor(receipt),



        products: (

          receipt.products || []

        ).map(product => {

          const normalized = normalizeProduct(product, receipt);
          ensureMonitoringMetadata(normalized, normalized.date);

          return {

            ...normalized,

            originalUrlVerified: product.originalUrlVerified === true,

            monitoringStatus: monitoringStatusFor(normalized),
            priceStatus: priceStatusFor(normalized),

            purchaseDateNeedsConfirmation:

              monitoringStatusFor(normalized) === 'PURCHASE DATE NEEDS CONFIRMATION',

            currentPrice: hasMonitorableUrl(normalized) &&

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
  ['/api/receipts', '/api/receipts/upload'],
  upload.single('receipt'),
  async (req, res) => {
    let storedFile = '';
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'Choose a receipt file first.'
        });
      }

      const submittedDate = req.body?.purchaseDate;
      if (submittedDate != null && typeof submittedDate !== 'string') {
        return res.status(400).json({ error: 'Enter one valid purchase date in YYYY-MM-DD format.' });
      }
      const userPurchaseDate = submittedDate?.trim() || '';
      if (userPurchaseDate && (!isValidDateOnly(userPurchaseDate) || isFutureDateOnly(userPurchaseDate))) {
        return res.status(400).json({ error: 'Enter a valid purchase date that is not in the future.' });
      }

      const receiptId = crypto.randomUUID();
      console.info('[receipt]', JSON.stringify({
        event: 'receipt_received',
        receiptId,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        byteLength: req.file.size
      }));
      let receiptFile;
      try {
        receiptFile = await convertReceiptHeif(req.file);
      } catch (error) {
        console.error('[receipt]', JSON.stringify({
          event: 'heif_conversion_failed',
          receiptId,
          message: sanitizeErrorText(error.message, 'HEIF conversion failed')
        }));
        return res.status(400).json({ error: HEIF_CONVERSION_ERROR });
      }
      const safeName =
        req.file.originalname
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .slice(-120) || 'receipt';
      const storedName = receiptFile !== req.file
        ? `${path.parse(safeName).name || 'receipt'}.jpg`
        : safeName;
      storedFile = `${receiptId}-${storedName}`;
      await fs.writeFile(path.join(UPLOADS_DIR, storedFile), receiptFile.buffer);

      let parsed;
      try {
        parsed = await extractReceipt(receiptFile, receiptId);
      } catch (error) {
        if (!(error instanceof GroqError)) throw error;

        const rateLimited = error.status === 429 &&
          error.operation === 'receipt_extraction';
        const receipt = {
          id: receiptId,
          merchant: 'Unknown merchant',
          purchaseDate: userPurchaseDate || null,
          purchaseDateConfirmed: Boolean(userPurchaseDate),
          purchaseDateConfirmedByUser: Boolean(userPurchaseDate),
          purchaseDateNeedsConfirmation: !userPurchaseDate,
          total: null,
          currency: null,
          fileName: req.file.originalname,
          mimeType: receiptFile.mimetype,
          storedFile,
          uploadedAt: new Date().toISOString(),
          extractionMethod: `Groq (${OLLAMA_MODEL})`,
          extractionStatus: 'failed',
          extractionReason: rateLimited ? 'rate_limited' : 'groq_error',
          extractionHttpStatus: error.status || null,
          extractionMessage: error.message,
          status: 'EXTRACTION FAILED',
          products: []
        };
        console.error('[receipt]', JSON.stringify({
          event: 'extraction_failed',
          receiptId,
          operation: error.operation,
          reason: receipt.extractionReason,
          status: error.status || null,
          message: error.message,
          responseBody: error.responseBody
        }));
        await saveNewReceipt(receipt);
        console.info('[receipt]', JSON.stringify({
          event: 'receipt_updated',
          receiptId,
          extractionStatus: receipt.extractionStatus
        }));
        return res.status(201).json({
          ...receipt,
          status: 'failed',
          reason: receipt.extractionReason,
          message: receipt.extractionMessage
        });
      }

      const purchaseDate = userPurchaseDate || parsed.purchaseDate;
      const purchaseDateConfirmed = isValidDateOnly(purchaseDate) &&
        !isFutureDateOnly(purchaseDate);
      const uploadedAt = new Date().toISOString();
      const purchaseDateNeedsConfirmation = receiptDateNeedsConfirmation(
        purchaseDate,
        uploadedAt
      );
      const dateState = receiptDateState(purchaseDate);
      const receipt = {
        id: receiptId,
        merchant: parsed.merchant,
        purchaseDate,
        purchaseDateConfirmed,
        total: parsed.total,
        currency: parsed.currency,
        fileName: req.file.originalname,
        mimeType: receiptFile.mimetype,
        storedFile,
        uploadedAt,
        extractionMethod: `Groq (${OLLAMA_MODEL})`,
        extractionStatus: 'complete',
        purchaseDateEvidence: parsed.purchaseDateEvidence || null,
        purchaseDateNeedsConfirmation,
        purchaseDateConfirmedByUser: Boolean(userPurchaseDate),
        watch: dateState.watch,
        status: dateState.status,
        products: createReceiptProducts(
          parsed,
          purchaseDate,
          purchaseDateConfirmed,
          purchaseDateNeedsConfirmation,
          Boolean(userPurchaseDate)
        )
      };
      await saveNewReceipt(receipt);
      console.info('[receipt]', JSON.stringify({
        event: 'receipt_updated',
        receiptId,
        extractionStatus: receipt.extractionStatus,
        merchant: receipt.merchant,
        purchaseDate: receipt.purchaseDate,
        currency: receipt.currency,
        products: receipt.products.length
      }));
      // Discovery starts right away but never blocks the upload response; the
      // dashboard polls for progress.
      runMonitoringWhenIdle().catch(error => {
        console.error('Initial monitoring after receipt upload failed:', sanitizeErrorText(error.message));
      });
      const count = receipt.products.length;
      const status = receiptStatusFor(receipt);
      res.status(201).json({
        ...receipt,
        status,
        message: status === 'PURCHASE DATE NEEDS CONFIRMATION'
          ? `Receipt saved with ${count} product${count === 1 ? '' : 's'}. Only the purchase date is blocking monitoring; please confirm it.`
          : status === 'WATCH EXPIRED'
            ? `Receipt saved with ${count} product${count === 1 ? '' : 's'}. The purchase is more than 30 days old, so it will not be monitored.`
            : `Receipt saved with ${count} product${count === 1 ? '' : 's'}. Searching for product pages now.`
      });
    } catch (error) {
      if (storedFile) {
        try {
          await fs.unlink(path.join(UPLOADS_DIR, storedFile));
        } catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') {
            console.error('Could not remove unprocessed receipt upload:', cleanupError.message);
          }
        }
      }
      console.error('Receipt processing error:', sanitizeErrorText(error.message, 'unreadable'));
      res.status(/Groq|model .*not installed|local receipt reading/i.test(error.message || '')
        ? 503
        : 400).json({
        error: sanitizeErrorText(
          error.message,
          'We could not read this receipt. Try a clearer JPEG, PNG, or PDF.'
        )
      });
    }
  }
);



app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const result = await withFileMutex(async () => {
      const receipt = (await readReceipts()).find(item => item.id === req.params.id);
      const productIds = (receipt?.products || []).map(product => product.id);
      const outcome = await deleteReceiptFromHistory({
        receiptsFile: RECEIPTS_FILE,
        uploadsDirectory: UPLOADS_DIR,
        receiptId: req.params.id
      });
      if (outcome.deleted) {
        for (const id of productIds) {
          deletedProductIds.add(id);
        }
      }
      return outcome;
    });
    if (!result.deleted) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    console.info('[receipt]', JSON.stringify({ event: 'receipt_deleted', id: req.params.id }));
    res.json({
      ok: true,
      id: req.params.id,
      message: 'Receipt and its products were deleted.',
      warning: result.uploadCleanupWarning || undefined
    });
  } catch (error) {
    console.error('Could not delete receipt:', sanitizeErrorText(error.message));
    res.status(500).json({
      error: 'Could not delete the receipt. Please try again.'
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

            merchant: receipt.merchant || product.retailer,

            receiptId: receipt.id,

            monitoringStartDate: normalized.monitoringStartDate || window.startDate,

            monitoringExpirationDate: normalized.monitoringExpirationDate || window.expirationDate,

            monitoringStatus: currentMonitoringStatus,
            priceStatus: priceStatusFor(normalized),

            purchaseDateNeedsConfirmation:

              currentMonitoringStatus === 'PURCHASE DATE NEEDS CONFIRMATION',

            originalUrlVerified: product.originalUrlVerified === true,

            status: receiptStatusFor(receipt, normalized.date),

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
          priceStatus: priceStatusFor(product),

          purchaseDateNeedsConfirmation:

            currentMonitoringStatus === 'PURCHASE DATE NEEDS CONFIRMATION',

          originalUrlVerified: product.originalUrlVerified === true,

          status: statusFor(product.purchaseDate || product.date),

          watch: statusFor(product.purchaseDate || product.date),

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
    if (monitoringStatusFor(product) !== 'ON WATCH') {
      return res.status(400).json({
        error: monitoringStatusFor(product) === 'OFF WATCH'
          ? 'Product search is paused because the purchase is outside the 30-day watch window.'
          : 'Confirm the purchase date before searching for a product page.'
      });
    }
    if (product.url) {
      return res.json({
        ok: true,
        message: product.originalUrlVerified
          ? 'The original retailer product URL is already verified.'
          : 'Product link already saved; product identity is unverified.',

        product,

        monitoringStatus: monitoringStatusFor(product)
      });
    }
    if (activeDiscoveries.has(product.id)) {
      return res.status(409).json({ ok: false, error: 'Product discovery is already running.' });
    }
    activeDiscoveries.add(product.id);
    try {
      product.lastProductDiscoveryAt = new Date().toISOString();
      product.productDiscoveryError = null;
      product.discoveryStatus = 'searching';
      product.monitoringStatus = monitoringStatusFor(product);
      product.nextProductDiscoveryAt = new Date(
        Date.parse(product.lastProductDiscoveryAt) + PRODUCT_DISCOVERY_INTERVAL_MS
      ).toISOString();
      await record.persist();
      if (product.url) {
        await verifyOriginalProductUrl(product);
      } else {
        await discoverOriginalListing(product, record.persist);
      }
    } catch (error) {
      product.discoveryStatus = product.url ? 'found' : 'awaiting_url';
      product.discoveryMessage =
        product.url
          ? 'The product page was found. Product identity and price verification will retry automatically.'
          : 'The agent could not verify the product page yet. It will continue searching automatically. You may paste the product URL as a fallback.';
      product.monitoringStatus = monitoringStatusFor(product);
      product.productDiscoveryError = isGroqRateLimitError(error)
        ? 'Product identity comparison is temporarily rate limited. The agent will retry automatically.'
        : sanitizeErrorText(error.message);
      product.lastError = product.productDiscoveryError;
    } finally {
      activeDiscoveries.delete(product.id);
    }
    await record.persist();
    if (product.originalUrlVerified) {
      try {
        await runMonitoringWhenIdle();
      } catch (error) {
        console.error('Immediate price monitoring after discovery failed:', error.message);
      }
    }
    return res.json({
      ok: true,
      message: product.originalUrlVerified
        ? 'Original retailer product URL verified and saved.'
        : product.discoveryMessage || 'No matching product page could be verified yet. The receipt and product remain saved.',
      product,
      monitoringStatus: monitoringStatusFor(product)
    });
  } catch (error) {
    console.error('Product URL discovery failed:', error.message);
    res.status(500).json({ ok: false, error: 'Could not load the saved product for discovery.' });
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

    const navigationReason = navigationUrlRejectionReason(requestedUrl);
    if (navigationReason) return res.status(400).json({ error: navigationReason });



    let parsedUrl;
    try {
      ({ url: parsedUrl } = await validateProductUrl(requestedUrl));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    let domain = record.product.officialRetailerDomain || '';
    if (!domain && record.product.retailer) {
      try {
        domain = await resolveOfficialRetailerDomain(record.product.retailer);
      } catch {
        domain = '';
      }
    }
    if (!domain && retailerMatchesHost(record.product.retailer, parsedUrl.hostname)) {
      domain = registrableDomain(parsedUrl.hostname);
    }
    if (!retailerMatchesHost(record.product.retailer, parsedUrl.hostname)) {
      return res.status(400).json({
        error: `Enter a product URL from the original retailer's official website (${record.product.retailer || 'unknown'}).`
      });
    }
    if (domain && !isRetailerDomain(parsedUrl.hostname, domain)) {
      return res.status(400).json({
        error: `Enter a product URL from the original retailer's official website (${record.product.retailer}).`
      });
    }

    const previousUrl = record.product.url;
    record.product.url = parsedUrl.toString();
    if (previousUrl !== record.product.url || !record.product.urlSavedAt) {
      record.product.urlSavedAt = new Date().toISOString();
    }
    if (domain) record.product.officialRetailerDomain = domain;
    record.product.originalUrlVerified = false;
    let verified = false;
    try {
      verified = domain && await verifyOriginalProductUrl(record.product);
    } catch (error) {
      record.product.productDiscoveryError = sanitizeErrorText(error.message);
    }

    if (!verified) {
      record.product.discoveryStatus = 'found';
      record.product.lastError = record.product.productDiscoveryError || record.product.lastError || null;
      record.product.discoveryMessage =
        'Product link saved. Product identity is not verified; daily price checks can continue.';
      if (previousUrl !== record.product.url) {
        record.product.currentVerifiedPrice = null;
        record.product.currentPrice = null;
        record.product.currentPriceSource = null;
        record.product.priceStatus = 'MONITORING';
      }
      record.product.monitoringStatus = monitoringStatusFor(record.product);
      record.product.nextProductDiscoveryAt = new Date(
        Date.now() + PRODUCT_DISCOVERY_INTERVAL_MS
      ).toISOString();
      await record.persist();
      try {
        await runMonitoringWhenIdle();
      } catch (error) {
        console.error('Could not schedule monitoring after saving URL:', error.message);
      }
      return res.json({
        ok: true,
        message: record.product.discoveryMessage,
        product: record.product,
        monitoringStatus: monitoringStatusFor(record.product)
      });
    }



    record.product.discoveryCandidates = [];



    record.product.watch = statusFor(record.product.purchaseDate || record.product.date);
    record.product.monitoringStatus = monitoringStatusFor(record.product);



    await record.persist();
    try {
      await runMonitoringWhenIdle();
    } catch (error) {
      console.error('Immediate price monitoring after URL confirmation failed:', error.message);
    }



    res.json({

      ok: true,

      ok: true,
      message:
        record.product.monitoringStatus === 'ON WATCH'
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



function applyConfirmedPurchaseDate(receipt, products, purchaseDate) {
  const window = monitoringWindow(purchaseDate);
  if (receipt) {
    receipt.purchaseDate = purchaseDate;
    receipt.purchaseDateConfirmed = true;
    receipt.purchaseDateConfirmedByUser = true;
    receipt.purchaseDateNeedsConfirmation = false;
    const state = receiptDateState(purchaseDate);
    receipt.status = state.status;
    receipt.watch = state.watch;
  }
  for (const product of products) {
    product.date = purchaseDate;
    product.purchaseDate = purchaseDate;
    product.purchaseDateConfirmed = true;
    product.purchaseDateConfirmedByUser = true;
    product.purchaseDateNeedsConfirmation = false;
    product.monitoringStartDate = window.startDate;
    product.monitoringExpirationDate = window.expirationDate;
    product.monitoringStatus = monitoringStatusFor(product);
  }
}

function scheduleDiscoveryAfterDateConfirmation(products) {
  if (!products.some(product => monitoringStatusFor(product) === 'ON WATCH' &&
    !(product.originalUrlVerified === true && product.url))) return;
  runMonitoringWhenIdle().catch(error => {
    console.error('Product discovery after purchase date confirmation failed:', sanitizeErrorText(error.message));
  });
}

app.post('/api/receipts/:id/confirm-date', async (req, res) => {
  const purchaseDate = req.body?.purchaseDate;
  if (typeof purchaseDate !== 'string' || !isValidDateOnly(purchaseDate) ||
      isFutureDateOnly(purchaseDate)) {
    return res.status(400).json({ error: 'Choose a valid purchase date that is not in the future.' });
  }
  try {
    const receipt = await withTrackingStoreLock(async () => {
      const receipts = await readReceipts();
      const item = receipts.find(entry => entry.id === req.params.id);
      if (!item) return null;
      applyConfirmedPurchaseDate(item, item.products || [], purchaseDate);
      await writeReceipts(receipts);
      return item;
    });
    if (!receipt) return res.status(404).json({ error: 'Receipt not found.' });
    scheduleDiscoveryAfterDateConfirmation(receipt.products || []);
    return res.json({ ok: true, message: 'Purchase date saved.', status: receiptStatusFor(receipt) });
  } catch (error) {
    console.error('Could not save receipt purchase date:', error.message);
    return res.status(500).json({ error: 'Could not save the purchase date.' });
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

    const productsToUpdate = record.receipt
      ? record.receipt.products || []
      : [record.product];
    applyConfirmedPurchaseDate(record.receipt, productsToUpdate, purchaseDate);

    await record.persist();
    scheduleDiscoveryAfterDateConfirmation(productsToUpdate);

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

    const navigationReason = navigationUrlRejectionReason(urlValue);
    if (navigationReason) return res.status(400).json({ error: navigationReason });

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

    monitoringStatus: monitoringStatusFor({ purchaseDate: date }),

    purchaseDateConfirmed: !isFutureDateOnly(date),

    purchaseDateNeedsConfirmation: isFutureDateOnly(date),

    discoveryStatus: url ? 'found' : 'searching',

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

    await withTrackingStoreLock(async () => {
      const manualProducts = JSON.parse(
        await fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8')
      );
      manualProducts.unshift(product);
      await writeJsonFile(MANUAL_PRODUCTS_FILE, manualProducts);
    });

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

    await withTrackingStoreLock(async () => {
      const products = JSON.parse(
        await fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8')
      );
      const remaining = products.filter(
        product => product.id !== req.params.id
      );
      if (remaining.length === products.length) {
        res.status(404).json({ error: 'Manual product not found.' });
        return;
      }
      await writeJsonFile(MANUAL_PRODUCTS_FILE, remaining);
      res.json({ ok: true });
    });

  } catch (error) {

    console.error('Could not delete manual product:', error.message);

    res.status(500).json({ error: 'Could not delete product.' });

  }

});



async function retryPendingReceiptExtractions(receipts) {
  const now = new Date();
  for (const receipt of receipts) {
    if (receipt.extractionStatus !== 'retry_pending') continue;
    const retryAt = Date.parse(receipt.nextExtractionRetryAt || '');
    if (Number.isFinite(retryAt) && now.getTime() < retryAt) continue;

    try {
      const buffer = await fs.readFile(path.join(UPLOADS_DIR, path.basename(receipt.storedFile)));
      const parsed = await extractReceipt({
        buffer,
        originalname: receipt.fileName,
        mimetype: receipt.mimeType
      }, receipt.id);
      receipt.merchant = parsed.merchant;
      const userConfirmedDate = receipt.purchaseDateConfirmedByUser === true &&
        isValidDateOnly(receipt.purchaseDate);
      const purchaseDate = userConfirmedDate ? receipt.purchaseDate : parsed.purchaseDate;
      receipt.purchaseDate = purchaseDate;
      receipt.purchaseDateEvidence = parsed.purchaseDateEvidence || null;
      receipt.total = parsed.total;
      receipt.currency = parsed.currency;
      const confirmed = isValidDateOnly(purchaseDate) &&
        !isFutureDateOnly(purchaseDate);
      const needsConfirmation = receiptDateNeedsConfirmation(
        purchaseDate,
        receipt.uploadedAt,
        userConfirmedDate
      );
      const dateState = receiptDateState(purchaseDate, now);
      receipt.purchaseDateConfirmed = confirmed;
      receipt.purchaseDateNeedsConfirmation = needsConfirmation;
      receipt.purchaseDateConfirmedByUser = userConfirmedDate;
      receipt.watch = dateState.watch;
      receipt.status = dateState.status;
      receipt.products = createReceiptProducts(
        parsed,
        purchaseDate,
        confirmed,
        needsConfirmation,
        userConfirmedDate
      );
      receipt.extractionStatus = 'complete';
      receipt.extractionMethod = `Groq (${OLLAMA_MODEL})`;
      delete receipt.extractionReason;
      delete receipt.extractionMessage;
      delete receipt.nextExtractionRetryAt;
      console.info('[receipt]', JSON.stringify({
        event: 'receipt_updated',
        receiptId: receipt.id,
        extractionStatus: receipt.extractionStatus,
        merchant: receipt.merchant,
        purchaseDate: receipt.purchaseDate,
        currency: receipt.currency,
        products: receipt.products.length
      }));
    } catch (error) {
      const rateLimited = error instanceof GroqError &&
        error.status === 429 &&
        error.operation === 'receipt_extraction';
      const failureReason = rateLimited
        ? 'rate_limited'
        : error instanceof GroqError
          ? 'groq_error'
          : 'extraction_error';
      receipt.extractionStatus = 'failed';
      receipt.extractionReason = failureReason;
      receipt.extractionHttpStatus = error instanceof GroqError
        ? error.status || null
        : null;
      receipt.extractionMessage = error.message || EXTRACTION_RETRY_MESSAGE;
      receipt.status = 'EXTRACTION FAILED';
      delete receipt.nextExtractionRetryAt;
      if (error instanceof GroqError) {
        console.error('[receipt]', JSON.stringify({
          event: 'extraction_failed',
          receiptId: receipt.id,
          operation: error.operation,
          reason: receipt.extractionReason,
          status: error.status || null,
          message: error.message,
          responseBody: error.responseBody
        }));
      } else {
        console.error('[receipt]', JSON.stringify({
          event: 'extraction_failed',
          receiptId: receipt.id,
          reason: receipt.extractionReason,
          status: null,
          message: error.message,
          responseBody: null
        }));
      }
      console.info('[receipt]', JSON.stringify({
        event: 'receipt_updated',
        receiptId: receipt.id,
        extractionStatus: receipt.extractionStatus
      }));
    }
  }
}

let checking = false;
let checkFinished = Promise.resolve();

async function runMonitoringWhenIdle() {
  while (checking) {
    await checkFinished;
  }
  return monitorPrices();
}

const receiptExtractionRetryScheduler = createReceiptExtractionRetryScheduler({
  getReceipts: readReceipts,
  run: runMonitoringWhenIdle,
  onError: error => console.error('Scheduled receipt extraction retry failed:', error.message)
});



async function monitorPrices({ manual = false } = {}) {

  if (checking) {

    return {

      ok: false,

      message: 'A price check is already running.',

      results: []

    };

  }



  checking = true;
  let finishCheck;
  checkFinished = new Promise(resolve => { finishCheck = resolve; });



  const results = [];
  let productsSearched = 0;
  const searchedProductIds = new Set();
  const discoverySearchCache = new Map();
  let earliestNextDiscovery = null;



  try {

    const [receipts, manualProducts] = await Promise.all([
      readReceipts(),
      fs.readFile(MANUAL_PRODUCTS_FILE, 'utf8').then(JSON.parse)
    ]);
    await retryPendingReceiptExtractions(receipts);
    const persistStores = () => persistMonitoringState(receipts, manualProducts);
    await persistStores();
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
      if (deletedProductIds.has(product.id)) continue;
      try {
      if (source === 'receipt') {

        Object.assign(product, normalizeProduct(product, receipt));

        product.retailer = receipt.merchant || product.retailer;

      }



      ensureMonitoringMetadata(product, product.date || receipt.purchaseDate);

      const now = new Date();

      const activeWindow = monitoringStatusFor(product, now) === 'ON WATCH';
      product.monitoringStatus = monitoringStatusFor(product, now);
      if (product.originalUrlVerified !== true && hasMonitorableUrl(product) && !product.urlSavedAt) {
        product.urlSavedAt = product.lastProductDiscoveryAt || now.toISOString();
      }
      const lastDiscovery = Date.parse(product.lastProductDiscoveryAt || '');
      const existingNextDiscovery = Date.parse(product.nextProductDiscoveryAt || '');
      if (product.originalUrlVerified !== true && Number.isFinite(lastDiscovery) &&
        (!Number.isFinite(existingNextDiscovery) ||
          existingNextDiscovery < lastDiscovery + PRODUCT_DISCOVERY_INTERVAL_MS)) {
        product.nextProductDiscoveryAt = new Date(
          lastDiscovery + PRODUCT_DISCOVERY_INTERVAL_MS
        ).toISOString();
      }
      const discoveryProduct = manual
        ? { ...product, nextProductDiscoveryAt: null }
        : product;
      if (!activeDiscoveries.has(product.id) && !searchedProductIds.has(product.id) &&
        shouldAutomaticallyDiscoverProduct(
        discoveryProduct,
        product.date || receipt.purchaseDate,
        now
      )) {

        const nextDiscovery = Date.parse(product.nextProductDiscoveryAt || '');
        if (manual || !Number.isFinite(nextDiscovery) || now.getTime() >= nextDiscovery) {
          searchedProductIds.add(product.id);
          productsSearched++;
          product.lastProductDiscoveryAttemptAt = now.toISOString();
          product.lastProductDiscoveryAt = now.toISOString();
          product.productDiscoveryError = null;
          product.discoveryStatus = 'searching';
          product.nextProductDiscoveryAt = new Date(
            now.getTime() + PRODUCT_DISCOVERY_INTERVAL_MS
          ).toISOString();

          activeDiscoveries.add(product.id);
          try {
            await persistStores();
            if (product.url) {
              await verifyOriginalProductUrl(product);
            } else {
              await discoverOriginalListing(product, persistStores, discoverySearchCache);
            }
          } catch (error) {
            product.discoveryStatus = product.url ? 'found' : 'awaiting_url';
            product.productDiscoveryError = sanitizeErrorText(error.message);
            product.lastError = product.productDiscoveryError;

            product.discoveryMessage = product.url
              ? 'The product page was found. Product identity and price verification will retry automatically.'
              : 'The agent could not verify the product page yet. It will continue searching automatically. You may paste the product URL as a fallback.';

            product.monitoringStatus = monitoringStatusFor(product, now);

          } finally {
            activeDiscoveries.delete(product.id);
          }

          await persistStores();

        }

      }

      const nextDiscoveryAt = Date.parse(product.nextProductDiscoveryAt || '');
      if (Number.isFinite(nextDiscoveryAt) &&
        shouldAutomaticallyDiscoverProduct(
          { ...product, nextProductDiscoveryAt: null },
          product.date || receipt.purchaseDate,
          now
        ) &&
        (earliestNextDiscovery === null || nextDiscoveryAt < earliestNextDiscovery)) {
        earliestNextDiscovery = nextDiscoveryAt;
      }

      if (activeWindow && product.originalUrlVerified === true) {
        await refreshAlternativeOffers(product, now, persistStores);
      }

      const discoveryError = product.discoveryStatus === 'blocked' ? product.lastError : null;
      const monitoringResult = await checkMonitoredProduct({

        product,

        purchaseDate: receiptPurchaseDate(receipt, product),

        now,

        intervalMs: MONITOR_INTERVAL_MS,

        fetchVerifiedPrice: url => fetchPrice(
          url,
          product.officialRetailerDomain || knownRetailerDomain(product.retailer) || new URL(url).hostname
        ),

        sendNotification: (trackedProduct, details) => {
          if (deletedProductIds.has(trackedProduct.id)) {
            throw new Error('This product was deleted; no alert was sent.');
          }
          return sendAlert(receipt, trackedProduct, details);
        },

        persist: persistStores

      });
      if (discoveryError) product.lastError = discoveryError;

      if (
        monitoringResult.status === 'SEARCHING FOR PRODUCT URL' ||
        monitoringResult.status === 'URL FOUND' && !hasMonitorableUrl(product) ||
        monitoringResult.status === 'URL VERIFIED' ||
        monitoringResult.status === 'AWAITING PRODUCT URL'
      ) {
        product.nextCheckAt = null;
      } else if (
        ['OFF WATCH', 'PURCHASE DATE NEEDS CONFIRMATION'].includes(
          monitoringResult.status
        )

      ) {

        product.nextCheckAt = null;

      }

      product.watch = monitoringResult.status === 'OFF WATCH'
        ? 'WATCH EXPIRED'
        : statusFor(product.date || receipt.purchaseDate);

      await persistStores();

      results.push({

        product: product.name,

        status: monitoringResult.notification === 'sent'

          ? 'price_drop_alert_sent'

          : monitoringResult.notification === 'failed'

            ? 'price_drop_email_failed'

            : monitoringResult.status,

        monitoringStatus: product.monitoringStatus,
        priceStatus: priceStatusFor(product, now),

        currentPrice: product.currentVerifiedPrice,

        reason: monitoringResult.reason || null
      });
      } catch (error) {
        console.error(`Price monitoring failed for ${product.name || product.id}:`, error.message);
        product.lastError = 'This product could not be checked. The agent will continue and retry automatically.';
        product.priceStatus = product.url && product.originalUrlVerified === true
          ? 'PRICE UNAVAILABLE'
          : product.discoveryStatus === 'found' && product.url
            ? 'URL FOUND'
            : 'AWAITING PRODUCT URL';
        results.push({
          product: product.name || product.id,
          status: product.priceStatus,
          monitoringStatus: monitoringStatusFor(product),
          priceStatus: product.priceStatus,
          currentPrice: product.currentVerifiedPrice ?? null,
          reason: product.lastError
        });
        try {
          await persistStores();
        } catch (persistError) {
          console.error('Could not persist monitoring status:', persistError.message);
        }
      }
    }



    console.info('[product-discovery]', JSON.stringify({
      event: 'discovery_cycle_finished',
      productsSearched,
      nextProductDiscoveryAt: earliestNextDiscovery === null
        ? null : new Date(earliestNextDiscovery).toISOString()
    }));
    return {

      ok: true,

      message: 'Price check completed.',

      results

    };

  } finally {

    checking = false;
    finishCheck();
    receiptExtractionRetryScheduler.schedule().catch(error => {
      console.error('Could not schedule receipt extraction retry:', error.message);
    });

  }

}



app.post('/api/monitor/run', async (_, res) => {

  try {

    const result = await monitorPrices({ manual: true });

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

          retailer: receipt.merchant || item.retailer,

          url: item.url || ''

        }))

      ).find(item => item.id === requestedId);

      product = receiptProduct ||

        manualProducts.find(item => item.id === requestedId);



      if (!product || statusFor(product.date) !== 'WATCH') {

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

            watch: statusFor(product.date),

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

  console.log({
    groqKeyLoaded: Boolean(process.env.GROQ_API_KEY),
    groqModel: OLLAMA_MODEL
  });

  console.log(

    `PriceDrop Agent API running on http\://127.0.0.1:${PORT}`

  );



  console.log(

    `Groq: ${

      `Groq (${OLLAMA_MODEL})`

    } | Gmail: ${

      isGoogleOAuthConfigured()

        ? 'configured'

        : 'not configured'

    } | Price monitoring interval: ${PRICE_CHECK_INTERVAL_HOURS} hours | Public product discovery interval: ${PRODUCT_DISCOVERY_INTERVAL_MS / (60 * 60 * 1000)} hours`

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
