export const PRICE_DROP_THRESHOLD_PERCENT = 5;
export const PRICE_DROP_THRESHOLD_DOLLARS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
}

export function isValidDateOnly(value) {
  const date = dateOnly(value);
  if (!date) return false;
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === date;
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
  if (!product.monitoringStartDate && window.valid) {
    product.monitoringStartDate = window.startDate;
  }
  if (!product.monitoringExpirationDate && window.valid) {
    product.monitoringExpirationDate = window.expirationDate;
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
  if (isFutureDateOnly(purchaseDate, now) && !product.purchaseDateConfirmed) {
    return 'PURCHASE DATE NEEDS CONFIRMATION';
  }
  const expirationDate = product.monitoringExpirationDate ||
    monitoringWindow(purchaseDate).expirationDate;
  const nowDate = localDateString(now);
  if (!expirationDate || nowDate >= expirationDate) return 'WATCH EXPIRED';
  if (product.discoveryStatus === 'needs_confirmation') return 'NEEDS CONFIRMATION';
  let validVerifiedUrl = false;
  try {
    const url = new URL(product.url);
    validVerifiedUrl = product.originalUrlVerified === true &&
      ['http:', 'https:'].includes(url.protocol);
  } catch {
    validVerifiedUrl = false;
  }
  if (!validVerifiedUrl) return 'URL DISCOVERY';
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
      : 'NO PRICE DROP';
  }
  return product.monitoringStatus || 'MONITORING';
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
  const expirationDate = product.monitoringExpirationDate;
  const today = localDateString(now);
  product.monitoringStartDate ||= purchaseDate;

  if (!isValidDateOnly(purchaseDate)) {
    product.purchaseDateNeedsConfirmation = true;
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
    product.monitoringStatus = product.discoveryStatus === 'needs_confirmation'
      ? 'NEEDS CONFIRMATION'
      : 'URL DISCOVERY';
    product.lastError ||= 'A verified original-retailer product URL is required.';
    product.nextCheckAt = null;
    return { status: product.monitoringStatus, checked: true, reason: product.lastError };
  }

  if (product.originalUrlVerified !== true) {
    product.monitoringStatus = 'URL DISCOVERY';
    product.lastError ||= 'The product URL has not been verified as this exact retailer listing.';
    product.nextCheckAt = null;
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
  const previous = product.currentVerifiedPrice == null
    ? Number.NaN
    : Number(product.currentVerifiedPrice);
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
    product.monitoringStatus = 'NO PRICE DROP';
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
  const lastSentPrice = sentPrices.at(-1) ||
    (Number.isFinite(legacyLastSentPrice) && legacyLastSentPrice > 0
      ? legacyLastSentPrice
      : null);
  const deliveryInProgress = product.notificationHistory.some(
    item => ['pending', 'sending'].includes(item.status) &&
      Number(item.price) === price
  );
  const qualifies = lastSentPrice == null ||
    price <= lastSentPrice - Math.max(
      PRICE_DROP_THRESHOLD_DOLLARS,
      lastSentPrice * PRICE_DROP_THRESHOLD_PERCENT / 100
    );
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
