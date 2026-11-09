const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_SUPPORTED_YEAR = 1900;
const MAX_SUPPORTED_YEAR = 2100;

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
}

export function isValidDateOnly(value) {
  const date = dateOnly(value);
  if (!date) return false;
  const year = Number(date.slice(0, 4));
  if (year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) return false;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === date;
}

function dateFromParts(year, month, day) {
  if (Number(year) < MIN_SUPPORTED_YEAR || Number(year) > MAX_SUPPORTED_YEAR) {
    return null;
  }
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidDateOnly(date) ? date : null;
}

const MONTH_NAMES = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3], ['apr', 4], ['april', 4],
  ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10], ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12]
]);

function expandYear(rawYear) {
  const year = Number(rawYear);
  if (String(rawYear).length !== 2) return year;
  return year <= 49 ? 2000 + year : 1900 + year;
}

function parseDateText(dateText, { dateOrder } = {}) {
  if (isValidDateOnly(dateText)) return dateText;

  const yearFirst = dateText.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (yearFirst) return dateFromParts(yearFirst[1], yearFirst[2], yearFirst[3]);

  const namedMonth =
    dateText.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/) ||
    dateText.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (namedMonth) {
    const monthFirst = /^[A-Za-z]/.test(namedMonth[1]);
    const month = MONTH_NAMES.get(
      (monthFirst ? namedMonth[1] : namedMonth[2]).toLowerCase()
    );
    if (!month) return null;
    return dateFromParts(
      namedMonth[3],
      month,
      monthFirst ? namedMonth[2] : namedMonth[1]
    );
  }

  const abbreviatedMonth =
    dateText.match(/^([A-Za-z]{3})[ -](\d{1,2}),?[ -](\d{2,4})$/) ||
    dateText.match(/^(\d{1,2})[ -]([A-Za-z]{3}),?[ -](\d{2,4})$/);
  if (abbreviatedMonth) {
    const monthFirst = /^[A-Za-z]/.test(abbreviatedMonth[1]);
    const month = MONTH_NAMES.get(
      (monthFirst ? abbreviatedMonth[1] : abbreviatedMonth[2]).toLowerCase()
    );
    if (!month) return null;
    return dateFromParts(
      expandYear(abbreviatedMonth[3]),
      month,
      monthFirst ? abbreviatedMonth[2] : abbreviatedMonth[1]
    );
  }

  const numeric = dateText.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (!numeric || numeric[3].length === 3) return null;
  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const year = expandYear(numeric[3]);
  if (first === second) return dateFromParts(year, first, second);
  if (first > 12 && second <= 12) return dateFromParts(year, second, first);
  if (second > 12 && first <= 12) return dateFromParts(year, first, second);
  if (dateOrder === 'MDY') return dateFromParts(year, first, second);
  return null;
}

const EMBEDDED_DATE_PATTERNS = [
  /\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/,
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/,
  /\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}\b/
];

export function normalizeReceiptDate(value, options) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  const direct = parseDateText(
    cleaned
      .replace(/^[A-Za-z]+,\s*/, '')
      .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i, '')
      .trim(),
    options
  );
  if (direct) return direct;
  for (const pattern of EMBEDDED_DATE_PATTERNS) {
    const match = cleaned.match(pattern);
    if (match) {
      const parsed = parseDateText(match[0].trim(), options);
      if (parsed) return parsed;
    }
  }
  return null;
}

// The printed text is authoritative: the model's own normalized date is never
// trusted over it, which prevents errors such as November 6 becoming July 11.
export function receiptDateFromEvidence(evidence, options) {
  if (typeof evidence !== 'string' || !evidence.trim()) return null;
  return normalizeReceiptDate(evidence, options);
}

export function localDateString(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isFutureDateOnly(value, now = new Date()) {
  return isValidDateOnly(value) && value > localDateString(now);
}

export function isWithinMonitoringWindow(purchaseDate, now = new Date()) {
  if (!isValidDateOnly(purchaseDate) || isFutureDateOnly(purchaseDate, now)) {
    return false;
  }
  const expirationDate = monitoringWindow(purchaseDate).expirationDate;
  return Boolean(expirationDate) && localDateString(now) < expirationDate;
}

export function receiptDateNeedsConfirmation(
  purchaseDate,
  _uploadedAt,
  confirmedByUser = false,
  now = new Date()
) {
  if (confirmedByUser) return false;
  return !isValidDateOnly(purchaseDate) || isFutureDateOnly(purchaseDate, now);
}

export function watchStatusFor(purchaseDate, now = new Date()) {
  if (!isValidDateOnly(purchaseDate) || isFutureDateOnly(purchaseDate, now)) {
    return 'PURCHASE DATE NEEDS CONFIRMATION';
  }
  return isWithinMonitoringWindow(purchaseDate, now) ? 'WATCH' : 'WATCH EXPIRED';
}

export function receiptDateState(purchaseDate, now = new Date()) {
  const valid = isValidDateOnly(purchaseDate);
  const confirmed = valid && !isFutureDateOnly(purchaseDate, now);
  const needsConfirmation = !valid || !confirmed;
  const status = needsConfirmation
    ? 'PURCHASE DATE NEEDS CONFIRMATION'
    : watchStatusFor(purchaseDate, now);
  return {
    purchaseDateConfirmed: confirmed,
    purchaseDateNeedsConfirmation: needsConfirmation,
    status,
    watch: confirmed && isWithinMonitoringWindow(purchaseDate, now)
      ? 'yes'
      : 'no'
  };
}

export function shouldAttemptProductDiscovery(
  product,
  now = new Date(),
  requested = false
) {
  if (!requested) return false;
  if (product.originalUrlVerified === true && product.url) return false;
  const retryAt = Date.parse(product.nextProductDiscoveryAt || '');
  return !Number.isFinite(retryAt) || now.getTime() >= retryAt;
}

export function shouldAutomaticallyDiscoverProduct(product, purchaseDate, now = new Date()) {
  return watchStatusFor(purchaseDate, now) !== 'WATCH EXPIRED' &&
    shouldAttemptProductDiscovery(product, now, true);
}

export function monitoringWindow(purchaseDate) {
  const start = dateOnly(purchaseDate);
  const startTime = start ? Date.parse(`${start}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(startTime) || !isValidDateOnly(start)) {
    return { startDate: '', expirationDate: '', valid: false };
  }
  return {
    startDate: start,
    expirationDate: new Date(startTime + 30 * DAY_MS).toISOString().slice(0, 10),
    valid: true
  };
}

export function ensureMonitoringMetadata(product, purchaseDate) {
  const window = monitoringWindow(purchaseDate);
  if (window.valid) {
    product.monitoringStartDate = window.startDate;
    product.monitoringExpirationDate = window.expirationDate;
  } else {
    product.monitoringStartDate = '';
    product.monitoringExpirationDate = '';
  }
  if (!Array.isArray(product.priceHistory)) product.priceHistory = [];
  if (!Array.isArray(product.notificationHistory)) product.notificationHistory = [];
  if (
    product.currentVerifiedPrice == null ||
    !Number.isFinite(Number(product.currentVerifiedPrice)) ||
    Number(product.currentVerifiedPrice) <= 0
  ) product.currentVerifiedPrice = null;
  const verifiedHistory = product.priceHistory
    .filter(item => item.verified === true)
    .map(item => Number(item.price))
    .filter(price => Number.isFinite(price) && price > 0);
  if (
    product.lowestVerifiedPrice == null ||
    !Number.isFinite(Number(product.lowestVerifiedPrice)) ||
    Number(product.lowestVerifiedPrice) <= 0
  ) {
    product.lowestVerifiedPrice = verifiedHistory.length
      ? Math.min(...verifiedHistory)
      : null;
  }
  if (
    product.highestVerifiedPrice == null ||
    !Number.isFinite(Number(product.highestVerifiedPrice)) ||
    Number(product.highestVerifiedPrice) <= 0
  ) {
    product.highestVerifiedPrice = verifiedHistory.length
      ? Math.max(...verifiedHistory)
      : null;
  }
  if (!Number.isFinite(Number(product.previousVerifiedPrice))) {
    product.previousVerifiedPrice = null;
  }
  if (!Number.isFinite(Number(product.notificationCount))) {
    product.notificationCount = Math.max(product.notificationHistory.filter(
      item => item.status === 'sent'
    ).length, product.alertSent ? 1 : 0);
  }
  const legacyAlertedPrices = [
    ...(Array.isArray(product.alertedPrices) ? product.alertedPrices : []),
    ...(product.lastAlertedPrice == null ? [] : [product.lastAlertedPrice])
  ].map(Number).filter(price => Number.isFinite(price) && price > 0);
  for (const price of new Set(legacyAlertedPrices)) {
    if (!product.notificationHistory.some(
      item => item.status === 'sent' && Number(item.price) === price
    )) {
      product.notificationHistory.push({
        status: 'sent',
        price,
        detectedAt: product.lastAlertedAt || product.lastCheckedAt || null,
        sentAt: product.lastAlertedAt || product.lastCheckedAt || null,
        migrated: true
      });
    }
  }
  product.notificationCount = Math.max(
    Number(product.notificationCount || 0),
    product.notificationHistory.filter(item => item.status === 'sent').length
  );
  if (!product.firstPriceDropAt) {
    product.firstPriceDropAt = product.priceDropDetectedAt || null;
  }
  return product;
}

export function monitoringStatusFor(product, now = new Date()) {
  const purchaseDate = product.purchaseDate || product.date;
  if (!isValidDateOnly(purchaseDate)) return 'PURCHASE DATE NEEDS CONFIRMATION';
  if (
    product.purchaseDateNeedsConfirmation &&
    product.purchaseDateConfirmedByUser !== true
  ) return 'PURCHASE DATE NEEDS CONFIRMATION';
  if (isFutureDateOnly(purchaseDate, now) && !product.purchaseDateConfirmed) {
    return 'PURCHASE DATE NEEDS CONFIRMATION';
  }
  const expirationDate = monitoringWindow(purchaseDate).expirationDate;
  const nowDate = localDateString(now);
  if (!expirationDate || nowDate >= expirationDate) return 'WATCH EXPIRED';
  let validVerifiedUrl = false;
  try {
    const url = new URL(product.url);
    validVerifiedUrl = product.originalUrlVerified === true &&
      ['http:', 'https:'].includes(url.protocol);
  } catch {
    validVerifiedUrl = false;
  }
  if (!validVerifiedUrl) {
    if (product.discoveryStatus === 'searching') return 'SEARCHING FOR PRODUCT URL';
    if (product.discoveryStatus === 'found' && product.url) return 'URL FOUND';
    return 'AWAITING PRODUCT URL';
  }
  if (
    product.monitoringStatus === 'PRICE DROP DETECTED' &&
    (
      product.currentVerifiedPrice == null ||
      !Number.isFinite(Number(product.currentVerifiedPrice)) ||
      !Number.isFinite(Number(product.purchasePrice)) ||
      Number(product.purchasePrice) <= 0 ||
      Number(product.currentVerifiedPrice) >= Number(product.purchasePrice) ||
      !product.lastCheckedAt
    )
  ) {
    return product.currentVerifiedPrice == null ||
      !Number.isFinite(Number(product.purchasePrice)) ||
      Number(product.purchasePrice) <= 0
      ? 'PRICE UNAVAILABLE'
      : 'MONITORING';
  }
  return [
    'NO PRICE DROP',
    'URL DISCOVERY',
    'NEEDS CONFIRMATION',
    'PURCHASE DATE NEEDS CONFIRMATION',
    'WATCH EXPIRED',
    'SEARCHING FOR PRODUCT URL',
    'URL FOUND',
    'AWAITING PRODUCT URL'
  ].includes(product.monitoringStatus)
    ? 'MONITORING'
    : product.monitoringStatus || 'MONITORING';
}

export function monitoringDashboardStats(products) {
  const validProducts = products.filter(product =>
    isWithinMonitoringWindow(product.purchaseDate || product.date) &&
    Boolean(product.id) &&
    Boolean(String(product.name || product.product || '').trim()) &&
    Number.isFinite(Number(product.purchasePrice)) &&
    Number(product.purchasePrice) > 0 &&
    isValidDateOnly(product.purchaseDate || product.date)
  );
  const hasVerifiedUrl = product => {
    if (product.originalUrlVerified !== true) return false;
    try {
      const url = new URL(product.url);
      return ['http:', 'https:'].includes(url.protocol);
    } catch {
      return false;
    }
  };
  return {
    monitored: validProducts.length,
    withVerifiedUrls: validProducts.filter(hasVerifiedUrl).length,
    awaitingUrlDiscovery: validProducts.filter(product => !hasVerifiedUrl(product)).length,
    pricesUnavailable: validProducts.filter(product =>
      product.monitoringStatus === 'PRICE UNAVAILABLE'
    ).length,
    priceDropsDetected: validProducts.filter(product =>
      hasVerifiedUrl(product) &&
      product.monitoringStatus === 'PRICE DROP DETECTED' &&
      product.currentVerifiedPrice != null &&
      Number.isFinite(Number(product.currentVerifiedPrice)) &&
      Number(product.currentVerifiedPrice) < Number(product.purchasePrice) &&
      Boolean(product.lastCheckedAt)
    ).length
  };
}

export function nextCheckAt(lastCheckAt, intervalMs) {
  const time = lastCheckAt ? Date.parse(lastCheckAt) : Number.NaN;
  return Number.isFinite(time)
    ? new Date(time + intervalMs).toISOString()
    : null;
}

export function startMonitoringScheduler(
  run,
  { intervalMs, onError = console.error, timers = globalThis }
) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    Promise.resolve()
      .then(run)
      .catch(onError)
      .finally(() => { running = false; });
  };
  tick();
  const timer = timers.setInterval(tick, intervalMs);
  timer.unref?.();
  return () => timers.clearInterval(timer);
}

export async function checkMonitoredProduct({
  product,
  purchaseDate = product.purchaseDate || product.date,
  now = new Date(),
  intervalMs,
  fetchVerifiedPrice,
  sendNotification,
  persist
}) {
  ensureMonitoringMetadata(product, purchaseDate);
  const timestamp = now.toISOString();
  const expirationDate = monitoringWindow(purchaseDate).expirationDate;
  const today = localDateString(now);
  product.monitoringStartDate ||= purchaseDate;

  if (!isValidDateOnly(purchaseDate)) {
    product.purchaseDateNeedsConfirmation = true;
    product.monitoringStatus = 'PURCHASE DATE NEEDS CONFIRMATION';
    product.nextCheckAt = null;
    return { status: product.monitoringStatus, checked: false };
  }

  if (
    product.purchaseDateNeedsConfirmation &&
    product.purchaseDateConfirmedByUser !== true
  ) {
    product.monitoringStatus = 'PURCHASE DATE NEEDS CONFIRMATION';
    product.nextCheckAt = null;
    return { status: product.monitoringStatus, checked: false };
  }

  if (isFutureDateOnly(purchaseDate, now) && !product.purchaseDateConfirmed) {
    product.purchaseDateNeedsConfirmation = true;
    product.monitoringStatus = 'PURCHASE DATE NEEDS CONFIRMATION';
    product.nextCheckAt = null;
    return { status: product.monitoringStatus, checked: false };
  }

  product.purchaseDateNeedsConfirmation = false;
  if (today < purchaseDate) {
    product.monitoringStatus = 'MONITORING';
    product.nextCheckAt = new Date(
      `${purchaseDate}T00:00:00`
    ).toISOString();
    return { status: product.monitoringStatus, checked: false };
  }

  if (product.monitoringStartDate && today < product.monitoringStartDate) {
    product.monitoringStatus = 'MONITORING';
    product.nextCheckAt = nextCheckAt(timestamp, intervalMs);
    return { status: product.monitoringStatus, checked: false };
  }

  if (!expirationDate || today >= expirationDate) {
    product.monitoringStatus = 'WATCH EXPIRED';
    product.nextCheckAt = null;
    return { status: product.monitoringStatus, checked: false };
  }

  if (!Number.isFinite(Number(product.purchasePrice)) || Number(product.purchasePrice) <= 0) {
    product.lastCheckedAt = timestamp;
    product.monitoringStatus = 'PRICE UNAVAILABLE';
    product.lastError = 'A valid original purchase price is required for price-drop detection.';
    product.nextCheckAt = nextCheckAt(timestamp, intervalMs);
    return { status: product.monitoringStatus, checked: true, reason: product.lastError };
  }

  if (!product.url) {
    product.monitoringStatus = product.discoveryStatus === 'searching'
      ? 'SEARCHING FOR PRODUCT URL'
      : 'AWAITING PRODUCT URL';
    product.nextCheckAt = product.nextProductDiscoveryAt || null;
    return { status: product.monitoringStatus, checked: true, reason: product.lastError };
  }

  if (product.originalUrlVerified !== true) {
    product.monitoringStatus = product.discoveryStatus === 'found' && product.url
      ? 'URL FOUND'
      : 'AWAITING PRODUCT URL';
    product.nextCheckAt = product.nextProductDiscoveryAt || null;
    return { status: product.monitoringStatus, checked: false, reason: product.lastError };
  }

  const clearCurrentObservation = () => {
    product.currentVerifiedPrice = null;
    product.currentPrice = null;
    product.potentialSavings = null;
    product.savingsPercent = null;
  };

  let observation;
  try {
    observation = await fetchVerifiedPrice(product.url);
  } catch (error) {
    product.lastCheckedAt = timestamp;
    clearCurrentObservation();
    product.monitoringStatus = 'PRICE UNAVAILABLE';
    product.lastError = `The retailer price could not be verified: ${error.message}`;
    product.nextCheckAt = nextCheckAt(timestamp, intervalMs);
    return { status: product.monitoringStatus, checked: true, reason: product.lastError };
  }

  const price = Number(observation?.price);
  if (
    observation?.verified !== true ||
    String(observation?.currency || '').toUpperCase() !== 'USD' ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    product.lastCheckedAt = timestamp;
    clearCurrentObservation();
    product.monitoringStatus = 'PRICE UNAVAILABLE';
    product.lastError = 'The retailer did not provide a verified price.';
    product.nextCheckAt = nextCheckAt(timestamp, intervalMs);
    return { status: product.monitoringStatus, checked: true, reason: product.lastError };
  }

  const purchasePrice = Number(product.purchasePrice);
  const previousValue =
    product.currentVerifiedPrice ?? product.previousVerifiedPrice;
  const previous = previousValue == null ? Number.NaN : Number(previousValue);
  product.previousVerifiedPrice = Number.isFinite(previous) ? previous : null;
  product.currentVerifiedPrice = price;
  product.currentPrice = price;
  product.lastCheckedAt = timestamp;
  product.lastError = null;
  if (typeof observation === 'object' && observation.imageUrl) {
    product.imageUrl = observation.imageUrl;
  }
  product.originalUrlVerified = true;

  const lastSnapshot = product.priceHistory.at(-1);
  if (!lastSnapshot || Number(lastSnapshot.price) !== price) {
    product.priceHistory.push({ price, checkedAt: timestamp, verified: true });
    product.priceHistory = product.priceHistory.slice(-1000);
  }
  product.lowestVerifiedPrice = product.lowestVerifiedPrice == null
    ? price
    : Math.min(Number(product.lowestVerifiedPrice), price);
  product.highestVerifiedPrice = product.highestVerifiedPrice == null
    ? price
    : Math.max(Number(product.highestVerifiedPrice), price);
  product.potentialSavings = Math.max(0, purchasePrice - price);
  product.savingsPercent = purchasePrice > 0
    ? product.potentialSavings / purchasePrice * 100
    : 0;
  product.nextCheckAt = nextCheckAt(timestamp, intervalMs);

  if (price >= purchasePrice) {
    product.monitoringStatus = 'MONITORING';
    return { status: product.monitoringStatus, checked: true, price };
  }

  product.monitoringStatus = 'PRICE DROP DETECTED';
  product.priceDropDetectedAt ||= timestamp;
  product.firstPriceDropAt ||= timestamp;
  product.priceDropSavings = purchasePrice - price;
  product.priceDropSavingsPercent = (product.priceDropSavings / purchasePrice) * 100;

  const sentPrices = product.notificationHistory
    .filter(item => item.status === 'sent')
    .map(item => Number(item.price))
    .filter(value => Number.isFinite(value) && value > 0);
  const legacyLastSentPrice = Number(product.lastAlertedPrice);
  if (
    Number.isFinite(legacyLastSentPrice) &&
    legacyLastSentPrice > 0 &&
    !sentPrices.includes(legacyLastSentPrice)
  ) sentPrices.push(legacyLastSentPrice);
  const deliveryInProgress = product.notificationHistory.some(
    item => ['pending', 'sending'].includes(item.status) &&
      Number(item.price) === price
  );
  const qualifies = !sentPrices.includes(price);
  if (!qualifies || deliveryInProgress) {
    return { status: product.monitoringStatus, checked: true, price, notification: 'duplicate_suppressed' };
  }

  const notification = {
    status: 'pending',
    price,
    detectedAt: timestamp,
    savings: product.priceDropSavings,
    savingsPercent: product.priceDropSavingsPercent
  };
  product.notificationHistory.push(notification);
  product.notificationHistory = product.notificationHistory.slice(-200);
  product.notificationStatus = 'pending';
  await persist?.();
  notification.status = 'sending';
  product.notificationStatus = 'sending';
  await persist?.();
  try {
    await sendNotification(product, {
      price,
      savings: product.priceDropSavings,
      savingsPercent: product.priceDropSavingsPercent,
      detectedAt: timestamp
    });
    notification.status = 'sent';
    notification.sentAt = new Date().toISOString();
    product.notificationStatus = 'sent';
    product.notificationCount += 1;
    product.lastAlertedPrice = price;
    product.alertedPrices = [...new Set([...(product.alertedPrices || []), price])];
    product.alertSent = true;
    await persist?.();
    return { status: product.monitoringStatus, checked: true, price, notification: 'sent' };
  } catch (error) {
    notification.status = 'failed';
    notification.error = error.message;
    product.notificationStatus = 'failed';
    product.lastError = `Price drop detected, but the notification could not be sent: ${error.message}`;
    await persist?.();
    return { status: product.monitoringStatus, checked: true, price, notification: 'failed', reason: error.message };
  }
}
