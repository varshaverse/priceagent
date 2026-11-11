import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkMonitoredProduct,
  ensureMonitoringMetadata,
  isFutureDateOnly,
  isValidDateOnly,
  isWithinMonitoringWindow,
  localDateString,
  monitoringDashboardStats,
  monitoringStatusFor,
  priceStatusFor,
  monitoringWindow,
  normalizeReceiptDate,
  receiptDateFromEvidence,
  receiptDateState,
  receiptDateNeedsConfirmation,
  shouldAttemptProductDiscovery,
  watchStatusFor,
  startMonitoringScheduler
} from '../server/monitoring.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const intervalMs = 24 * 60 * 60 * 1000;

test('obsolete Costco path error is replaced without marking a URL verified', () => {
  const product = {
    url: 'https://www.costco.com/walnuts',
    originalUrlVerified: false,
    lastError: 'URL does not contain Costco product-page path evidence.',
    productDiscoveryError: 'URL does not contain Costco product-page path evidence.',
    discoveryMessage: 'URL does not contain Costco product-page path evidence.'
  };
  ensureMonitoringMetadata(product, null);
  assert.equal(product.lastError, null);
  assert.equal(product.productDiscoveryError, null);
  assert.equal(product.discoveryMessage, 'Product link saved. Product identity is not verified.');
  assert.equal(product.originalUrlVerified, false);
});

test('a saved link is not rediscovered even when product identity is unverified', () => {
  const product = {
    purchaseDate: '2026-11-01',
    url: 'https://www.costco.com/walnuts',
    originalUrlVerified: false,
    lastError: 'Page has no product schema, SKU, add-to-cart control, verified price, or product details.'
  };
  ensureMonitoringMetadata(product, product.purchaseDate);
  assert.equal(product.lastError, null);
  assert.equal(shouldAttemptProductDiscovery(product, now, true), false);
});

function makeProduct(overrides = {}) {
  return {
    id: 'test-product',
    name: 'Test item',
    retailer: 'Example Retailer',
    purchasePrice: 100,
    purchaseDate: '2026-11-01',
    date: '2026-11-01',
    url: 'https://store.example/products/item',
    originalUrlVerified: true,
    ...overrides
  };
}

async function check(product, { price, fetchError, now: checkTime = now, send = async () => {} } = {}) {
  return checkMonitoredProduct({
    product,
    now: checkTime,
    intervalMs,
    fetchVerifiedPrice: async () => {
      if (fetchError) throw fetchError;
      return { price, currency: 'USD', verified: true };
    },
    sendNotification: send
  });
}

test('a product without a verified original URL cannot be a price drop', async () => {
    const product = makeProduct({
      url: '',
      originalUrlVerified: false,
      monitoringStatus: 'PRICE DROP DETECTED',
      currentPrice: 1,
      currentVerifiedPrice: 1
    });
    let fetchCount = 0;
    let sendCount = 0;
    const result = await checkMonitoredProduct({
      product,
      now,
      intervalMs,
      fetchVerifiedPrice: async () => { fetchCount++; return { price: 1, currency: 'USD', verified: true }; },
      sendNotification: async () => { sendCount++; }
    });
    assert.equal(result.status, 'AWAITING PRODUCT URL');
    assert.equal(product.monitoringStatus, 'ON WATCH');
    assert.equal(fetchCount, 0);
    assert.equal(sendCount, 0);
    assert.equal(priceStatusFor(product, now), 'AWAITING PRODUCT URL');
});

test('a found retailer URL remains visible while identity or price verification retries', async () => {
  const product = makeProduct({
    url: 'https://store.example/products/item',
    originalUrlVerified: false,
    discoveryStatus: 'found',
    monitoringStatus: 'URL FOUND'
  });
  let fetchCount = 0;
  const result = await checkMonitoredProduct({
    product,
    now,
    intervalMs,
    fetchVerifiedPrice: async () => {
      fetchCount++;
      return { price: 20, currency: 'USD', verified: true };
    },
    sendNotification: async () => {}
  });
  assert.equal(result.status, 'URL FOUND');
  assert.equal(priceStatusFor(product, now), 'URL FOUND');
  assert.equal(monitoringStatusFor(product, now), 'ON WATCH');
  assert.equal(fetchCount, 0);
});

test('a saved official URL waits until the next day, then checks and alerts without claiming identity verification', async () => {
  const product = makeProduct({
    name: 'KS WALNUTS',
    retailer: 'Costco',
    officialRetailerDomain: 'costco.com',
    url: 'https://www.costco.com/walnuts',
    urlSavedAt: now.toISOString(),
    originalUrlVerified: false,
    discoveryStatus: 'found'
  });
  let fetchCount = 0;
  let notifications = 0;
  const run = checkTime => checkMonitoredProduct({
    product, now: checkTime, intervalMs,
    fetchVerifiedPrice: async () => {
      fetchCount++;
      return { price: 80, currency: 'USD', verified: true };
    },
    sendNotification: async () => { notifications++; }
  });
  const first = await run(now);
  assert.equal(first.checked, false);
  assert.equal(fetchCount, 0);
  assert.equal(product.nextCheckAt, new Date(now.getTime() + intervalMs).toISOString());
  const tomorrow = new Date(now.getTime() + intervalMs);
  const checked = await run(tomorrow);
  assert.equal(checked.notification, 'sent');
  assert.equal(fetchCount, 1);
  assert.equal(notifications, 1);
  assert.equal(product.originalUrlVerified, false);
  assert.equal(product.discoveryStatus, 'found');
  assert.equal(product.notificationHistory[0].productIdentityVerified, false);
  assert.equal(priceStatusFor(product, tomorrow), 'PRICE DROP DETECTED');
  assert.equal(monitoringDashboardStats([{
    ...product,
    purchaseDate: localDateString(new Date()),
    date: localDateString(new Date())
  }]).priceDropsDetected, 1);
  assert.equal((await run(tomorrow)).checked, false);
  assert.equal(fetchCount, 1);
});

test('saved links from other retailers and navigation pages are never monitored', async () => {
  for (const url of ['https://other.example/product/1', 'https://www.costco.com/cart.html']) {
    const product = makeProduct({
      retailer: 'Costco', officialRetailerDomain: 'costco.com', url,
      urlSavedAt: new Date(now.getTime() - intervalMs).toISOString(),
      originalUrlVerified: false, discoveryStatus: 'found'
    });
    let fetched = false;
    await checkMonitoredProduct({
      product, now, intervalMs,
      fetchVerifiedPrice: async () => { fetched = true; },
      sendNotification: async () => {}
    });
    assert.equal(fetched, false, url);
  }
});

test('saved unverified links do not bypass purchase-date or watch-window restrictions', async () => {
  for (const date of [null, '2026-09-01']) {
    const product = makeProduct({
      retailer: 'Costco', officialRetailerDomain: 'costco.com',
      url: 'https://www.costco.com/walnuts', urlSavedAt: '2026-11-02T12:00:00Z',
      originalUrlVerified: false, discoveryStatus: 'found', purchaseDate: date, date
    });
    let fetched = false;
    await checkMonitoredProduct({
      product, now, intervalMs,
      fetchVerifiedPrice: async () => { fetched = true; },
      sendNotification: async () => {}
    });
    assert.equal(fetched, false);
  }
});

test('a verified retailer URL is exposed as URL VERIFIED until price monitoring runs', () => {
  const product = makeProduct({
    discoveryStatus: 'matched',
    monitoringStatus: 'URL VERIFIED'
  });
  assert.equal(priceStatusFor(product, now), 'URL VERIFIED');
  assert.equal(monitoringStatusFor(product, now), 'ON WATCH');
});

test('a stale drop status without a verified current price is unavailable and not counted', () => {
    const product = makeProduct({
      monitoringStatus: 'PRICE DROP DETECTED',
      currentVerifiedPrice: null,
      currentPrice: 1,
      lastCheckedAt: now.toISOString()
    });
    assert.equal(priceStatusFor(product, now), 'PRICE UNAVAILABLE');
    assert.equal(monitoringDashboardStats([product]).priceDropsDetected, 0);
});

test('an unverified or non-USD observation cannot trigger a notification', async () => {
    for (const observation of [
      { price: 50, currency: 'USD', verified: false },
      { price: 50, currency: 'CAD', verified: true },
      { price: 0, currency: 'USD', verified: true }
    ]) {
      const product = makeProduct();
      let sendCount = 0;
      const result = await checkMonitoredProduct({
        product,
        now,
        intervalMs,
        fetchVerifiedPrice: async () => observation,
        sendNotification: async () => { sendCount++; }
      });
      assert.equal(result.status, 'PRICE UNAVAILABLE');
      assert.equal(product.currentVerifiedPrice, null);
      assert.equal(sendCount, 0);
    }
});

test('future purchase dates are not monitored until confirmed and use local calendar dates', async () => {
    const localLateNight = new Date(2026, 10, 4, 23, 19);
    assert.equal(localDateString(localLateNight), '2026-11-04');
    assert.equal(isValidDateOnly('2026-11-05'), true);
    assert.equal(isValidDateOnly('2026-02-30'), false);
    assert.equal(isFutureDateOnly('2026-11-05', localLateNight), true);
    assert.equal(monitoringWindow('2026-11-05').expirationDate, '2026-12-05');

    const product = makeProduct({
      purchaseDate: '2026-11-05',
      date: '2026-11-05',
      monitoringStartDate: '2026-11-05',
      originalUrlVerified: true
    });
    let fetchCount = 0;
    const result = await checkMonitoredProduct({
      product,
      now: localLateNight,
      intervalMs,
      fetchVerifiedPrice: async () => { fetchCount++; return { price: 80, currency: 'USD', verified: true }; },
      sendNotification: async () => {}
    });
    assert.equal(result.status, 'PURCHASE DATE NEEDS CONFIRMATION');
    assert.equal(fetchCount, 0);

    product.purchaseDateConfirmed = true;
    product.purchaseDateConfirmedByUser = true;
    const waiting = await checkMonitoredProduct({
      product,
      now: localLateNight,
      intervalMs,
      fetchVerifiedPrice: async () => { fetchCount++; return { price: 80, currency: 'USD', verified: true }; },
      sendNotification: async () => {}
    });
    assert.equal(waiting.status, 'PURCHASE DATE NEEDS CONFIRMATION');
    assert.equal(waiting.checked, false);
    assert.equal(fetchCount, 0);
  assert.equal(product.monitoringStartDate, '2026-11-05');
});

test('valid non-future receipts under 30 days old remain in the monitoring window', () => {
    const localNow = new Date(2026, 10, 4, 12);
    assert.equal(isWithinMonitoringWindow('2026-10-06', localNow), true);
    assert.equal(isWithinMonitoringWindow('2026-10-05', localNow), false);
    assert.equal(isWithinMonitoringWindow('2026-10-04', localNow), false);
    assert.equal(isWithinMonitoringWindow('2026-11-05', localNow), false);
    assert.equal(isWithinMonitoringWindow('not-a-date', localNow), false);
});

test('receipt dates require a complete, unambiguous date with a year', () => {
  assert.equal(normalizeReceiptDate('2026-11-06'), '2026-11-06');
  assert.equal(normalizeReceiptDate('Nov 6, 2026'), '2026-11-06');
  assert.equal(normalizeReceiptDate('October 30th, 2026'), '2026-10-30');
  assert.equal(normalizeReceiptDate('30 October 2026'), '2026-10-30');
  assert.equal(normalizeReceiptDate('10/30/26'), '2026-10-30');
  assert.equal(normalizeReceiptDate('30-Oct-26'), '2026-10-30');
  assert.equal(normalizeReceiptDate('2026/11/06'), '2026-11-06');
  assert.equal(normalizeReceiptDate('07-07'), null);
  assert.equal(normalizeReceiptDate('11/06/2026'), null);
  assert.equal(normalizeReceiptDate('2026-02-30'), null);
  assert.equal(normalizeReceiptDate(null), null);
});

test('receipt dates are accepted only when supported by clear matching printed evidence', () => {
  assert.equal(receiptDateFromEvidence('Nov 6, 2026'), '2026-11-06');
  assert.equal(receiptDateFromEvidence('03/04/2026'), null);
  assert.equal(receiptDateFromEvidence('11/06/2026 14:32'), null);
  assert.equal(receiptDateFromEvidence('11/22/2026'), '2026-11-22');
  assert.equal(receiptDateFromEvidence(''), null);
  // A model-supplied normalization can never override the printed text.
  assert.equal(receiptDateFromEvidence('Nov 6, 2026', '2026-07-11'), '2026-11-06');
});

test('a valid printed date controls status regardless of when the image was uploaded', async () => {
  const now = new Date('2026-11-08T16:00:00-08:00');
  const uploadedAt = '2026-11-06T10:00:00-08:00';
  assert.equal(
    receiptDateNeedsConfirmation('2026-07-07', uploadedAt, false, now),
    false
  );
  assert.equal(
    receiptDateNeedsConfirmation('2026-11-06', uploadedAt, false, now),
    false
  );
  assert.equal(
    receiptDateNeedsConfirmation('2026-10-30', uploadedAt, false, now),
    false
  );
  assert.equal(watchStatusFor('2026-10-30', now), 'WATCH');
  assert.equal(
    receiptDateNeedsConfirmation('2026-07-07', uploadedAt, true, now),
    false
  );
  assert.equal(watchStatusFor('2026-07-07', now), 'WATCH EXPIRED');

  const product = makeProduct({
    purchaseDate: '2026-07-07',
    date: '2026-07-07',
    purchaseDateNeedsConfirmation: false,
    monitoringStatus: 'WATCH EXPIRED'
  });

  test('a November 6 receipt is automatically confirmed and WATCH on November 8', () => {
    const now = new Date('2026-11-08T12:00:00-08:00');
    assert.deepEqual(receiptDateState('2026-11-06', now), {
      purchaseDateConfirmed: true,
      purchaseDateNeedsConfirmation: false,
      status: 'WATCH',
      watch: 'yes'
    });
    assert.equal(normalizeReceiptDate('Nov 6, 2026'), '2026-11-06');
  });

  test('missing, future, invalid, and out-of-range dates require confirmation', () => {
    const now = new Date('2026-11-08T12:00:00-08:00');
    for (const date of [null, '2026-02-30', '2026-11-09', '1800-01-01', '2200-01-01']) {
      assert.deepEqual(receiptDateState(date, now), {
        purchaseDateConfirmed: false,
        purchaseDateNeedsConfirmation: true,
        status: 'PURCHASE DATE NEEDS CONFIRMATION',
        watch: 'no'
      });
    }
  });

  test('product URL discovery requires a clear date within the watch window', () => {
    const now = new Date('2026-11-08T12:00:00-08:00');
    for (const purchaseDate of [null, '2026-11-06', '2026-11-09']) {
      assert.equal(shouldAttemptProductDiscovery({
        purchaseDate,
        purchaseDateNeedsConfirmation: !purchaseDate || purchaseDate === '2026-11-09',
        url: '',
        originalUrlVerified: false
      }, now, true), purchaseDate === '2026-11-06');
    }
    assert.equal(shouldAttemptProductDiscovery({
      url: 'https://store.example/item',
      originalUrlVerified: true
    }, now, true), false);
    assert.equal(shouldAttemptProductDiscovery({
      url: '',
      originalUrlVerified: false
    }, now), false);
    assert.equal(shouldAttemptProductDiscovery({
      url: '',
      originalUrlVerified: false,
      purchaseDate: '2026-11-06',
      nextProductDiscoveryAt: '2026-11-09T12:00:00.000Z'
    }, now, true), false);
  });
  let fetchCount = 0;
  const result = await checkMonitoredProduct({
    product,
    now,
    intervalMs,
    fetchVerifiedPrice: async () => {
      fetchCount++;
      return { price: 80, currency: 'USD', verified: true };
    },
    sendNotification: async () => {}
  });
  assert.equal(result.status, 'OFF WATCH');
  assert.equal(product.nextCheckAt, null);
  assert.equal(fetchCount, 0);

  assert.equal(monitoringStatusFor(product, now), 'OFF WATCH');
});

test('a November 6 purchase remains WATCH on November 8 using date-only arithmetic', async () => {
  const purchaseDate = '2026-11-06';
  const checkDate = new Date('2026-11-08T23:59:00-08:00');
  assert.equal(isWithinMonitoringWindow(purchaseDate, checkDate), true);
  assert.equal(monitoringWindow(purchaseDate).startDate, '2026-11-06');
  assert.equal(watchStatusFor(purchaseDate, checkDate), 'WATCH');

  const product = makeProduct({
    purchaseDate,
    date: purchaseDate,
    monitoringStartDate: purchaseDate
  });
  const result = await checkMonitoredProduct({
    product,
    now: checkDate,
    intervalMs,
    fetchVerifiedPrice: async () => ({ price: 100, currency: 'USD', verified: true }),
    sendNotification: async () => {}
  });
  assert.equal(result.status, 'MONITORING');
  assert.equal(product.monitoringStartDate, '2026-11-06');
});

test('missing purchase dates require confirmation and purchases past the window expire', () => {
  assert.equal(watchStatusFor(null, now), 'PURCHASE DATE NEEDS CONFIRMATION');
  assert.equal(watchStatusFor('2026-10-04', now), 'WATCH EXPIRED');
});

test('watch status is independent of discovery and price status', async () => {
  for (const [date, expected] of [
    [null, 'PURCHASE DATE NEEDS CONFIRMATION'],
    ['2026-11-01', 'ON WATCH'],
    ['2026-10-01', 'OFF WATCH']
  ]) {
    const product = makeProduct({
      purchaseDate: date, date,
      discoveryStatus: 'matched',
      priceStatus: 'PRICE DROP DETECTED'
    });
    assert.equal(monitoringStatusFor(product, now), expected);
  }
  const ambiguous = makeProduct({ purchaseDateNeedsConfirmation: true });
  let fetched = false;
  const result = await checkMonitoredProduct({
    product: ambiguous, now, intervalMs,
    fetchVerifiedPrice: async () => { fetched = true; },
    sendNotification: async () => {}
  });
  assert.equal(result.status, 'PURCHASE DATE NEEDS CONFIRMATION');
  assert.equal(fetched, false);
});

test('dashboard statistics count valid records, verified URLs, unavailable prices, and only verified drops', () => {
    const products = [
      makeProduct({
        id: 'ninja',
        name: 'NINJA CRISPI',
        originalUrlVerified: false,
        url: '',
        monitoringStatus: 'URL DISCOVERY',
        currentPrice: 1
      }),
      makeProduct({
        id: 'pants-one',
        name: 'RAACTIVEPANT',
        purchasePrice: 14.99,
        originalUrlVerified: true,
        monitoringStatus: 'PRICE DROP DETECTED',
        currentVerifiedPrice: 10,
        lastCheckedAt: now.toISOString()
      }),
      makeProduct({
        id: 'pants-two',
        name: 'RAACTIVEPANT',
        purchasePrice: 14.99,
        originalUrlVerified: true,
        monitoringStatus: 'PRICE UNAVAILABLE',
        currentVerifiedPrice: null
      }),
      makeProduct({
        id: 'expired',
        name: 'Expired item',
        purchaseDate: '2026-09-01',
        date: '2026-09-01',
        originalUrlVerified: true,
        monitoringStatus: 'WATCH EXPIRED'
      })
    ];
    assert.deepEqual(monitoringDashboardStats(products), {
      monitored: 3,
      withVerifiedUrls: 2,
      awaitingUrlDiscovery: 1,
      pricesUnavailable: 1,
      priceDropsDetected: 1
    });
});

test('dashboard counts awaiting and blocked discovery even without a confirmed purchase date', () => {
  const products = [
    { id: 'a', name: 'KS WALNUTS', discoveryStatus: 'awaiting_url', date: null },
    { id: 'b', name: 'Other', discoveryStatus: 'blocked', date: null },
    { id: 'c', name: 'Verified', discoveryStatus: 'awaiting_url', originalUrlVerified: true, url: 'https://costco.com/product/1' }
  ];
  assert.equal(monitoringDashboardStats(products).awaitingUrlDiscovery, 2);
});

test('dashboard does not count unconfirmed purchases as monitored', () => {
  const product = makeProduct({ purchaseDateNeedsConfirmation: true });
  assert.equal(monitoringDashboardStats([product]).monitored, 0);
});

test('verified price above purchase price records no drop and sends no email', async () => {
  const product = makeProduct();
  let sendCount = 0;
  const result = await check(product, { price: 105, send: async () => sendCount++ });
  assert.equal(result.status, 'MONITORING');
  assert.equal(product.currentVerifiedPrice, 105);
  assert.equal(product.previousVerifiedPrice, null);
  assert.equal(product.potentialSavings, 0);
  assert.equal(sendCount, 0);
});

test('verified price equal to purchase price records no drop', async () => {
  const product = makeProduct();
  const result = await check(product, { price: 100 });
  assert.equal(result.status, 'MONITORING');
  assert.equal(product.priceDropDetectedAt, undefined);
  assert.equal(product.notificationHistory.length, 0);
});

test('verified price below purchase price records savings and notifies automatically', async () => {
  const product = makeProduct();
  let notification;
  const result = await check(product, {
    price: 80,
    send: async (item, details) => { notification = { item, details }; }
  });
  assert.equal(result.status, 'PRICE DROP DETECTED');
  assert.equal(result.notification, 'sent');
  assert.equal(product.priceDropSavings, 20);
  assert.equal(product.priceDropSavingsPercent, 20);
  assert.equal(product.notificationCount, 1);
  assert.equal(notification.details.price, 80);
  assert.equal(product.notificationHistory[0].status, 'sent');
  assert.deepEqual(
    Object.fromEntries(['productName', 'retailer', 'purchasePrice', 'price', 'savings', 'savingsPercent', 'url', 'detectedAt']
      .map(key => [key, product.notificationHistory[0][key]])),
    { productName: 'Test item', retailer: 'Example Retailer', purchasePrice: 100,
      price: 80, savings: 20, savingsPercent: 20, url: product.url, detectedAt: now.toISOString() }
  );
});

test('a Costco warehouse price below the purchase price creates a labeled notification', async () => {
  const product = makeProduct({ name: 'ZIPLK VTY PK', retailer: 'Costco', purchasePrice: 9.09 });
  const result = await checkMonitoredProduct({
    product, now, intervalMs,
    fetchVerifiedPrice: async () => ({
      price: 1.49, currency: 'USD', verified: true, priceSource: 'Costco warehouse price'
    }),
    sendNotification: async () => {}
  });
  assert.equal(result.notification, 'sent');
  assert.equal(product.currentVerifiedPrice, 1.49);
  assert.equal(product.notificationHistory[0].priceSource, 'Costco warehouse price');
  assert.equal(product.priceHistory[0].source, 'Costco warehouse price');
});

test('only one price attempt per day survives manual runs, failures, and reloads', async () => {
  const product = makeProduct();
  let fetchCount = 0;
  const run = (item, checkTime, fail = false) => checkMonitoredProduct({
    product: item,
    now: checkTime,
    intervalMs: 60 * 60 * 1000,
    fetchVerifiedPrice: async () => {
      fetchCount++;
      if (fail) throw new Error('HTTP 503');
      return { price: 100, currency: 'USD', verified: true };
    },
    sendNotification: async () => {},
    persist: async () => {}
  });
  assert.equal((await run(product, now, true)).checked, true);
  const reloaded = JSON.parse(JSON.stringify(product));
  assert.equal((await run(reloaded, new Date(now.getTime() + 60 * 60 * 1000))).checked, false);
  assert.equal(fetchCount, 1);
  assert.equal((await run(reloaded, new Date(now.getTime() + intervalMs))).checked, true);
  assert.equal(fetchCount, 2);
});

test('overlapping checks reserve the daily attempt before fetching', async () => {
  const product = makeProduct();
  let releaseFetch;
  let fetchCount = 0;
  const options = {
    product, now, intervalMs,
    fetchVerifiedPrice: async () => {
      fetchCount++;
      await new Promise(resolve => { releaseFetch = resolve; });
      return { price: 100, currency: 'USD', verified: true };
    },
    sendNotification: async () => {},
    persist: async () => {}
  };
  const first = checkMonitoredProduct(options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await checkMonitoredProduct(options)).checked, false);
  releaseFetch();
  assert.equal((await first).checked, true);
  assert.equal(fetchCount, 1);
});

test('a later calendar day allows a check even if less than 24 hours elapsed', async () => {
  const late = new Date(2026, 10, 4, 23, 30);
  const product = makeProduct({ lastPriceCheckAttemptAt: new Date(2026, 10, 3, 22, 30).toISOString() });
  const result = await check(product, { price: 100, now: late });
  assert.equal(result.checked, true);
  const duplicate = await check(product, { price: 90, now: new Date(2026, 10, 4, 23, 45) });
  assert.equal(duplicate.checked, false);
  const followingDay = await check(product, { price: 100, now: new Date(2026, 10, 5, 0, 5) });
  assert.equal(followingDay.checked, true);
  assert.equal(product.priceHistory.length, 2);
});

test('a verified $20 price against a $50 purchase triggers a $30 price drop', async () => {
  const product = makeProduct({ purchasePrice: 50 });
  let notificationCount = 0;
  const result = await check(product, {
    price: 20,
    send: async () => { notificationCount++; }
  });
  assert.equal(result.status, 'PRICE DROP DETECTED');
  assert.equal(product.priceDropSavings, 30);
  assert.equal(product.currentVerifiedPrice, 20);
  assert.equal(notificationCount, 1);
});

test('a below-purchase price is not emailed until the purchase date is valid and active', async () => {
  const product = makeProduct({
    purchasePrice: 50,
    purchaseDate: null,
    date: null,
    purchaseDateNeedsConfirmation: true,
    purchaseDateConfirmed: false
  });
  let notificationCount = 0;
  const paused = await check(product, {
    price: 20,
    send: async () => { notificationCount++; }
  });
  assert.equal(paused.status, 'PURCHASE DATE NEEDS CONFIRMATION');
  assert.equal(notificationCount, 0);

  Object.assign(product, {
    purchaseDate: '2026-11-06',
    date: '2026-11-06',
    purchaseDateNeedsConfirmation: false,
    purchaseDateConfirmed: true
  });
  const active = await check(product, {
    price: 20,
    now: new Date('2026-11-08T12:00:00-08:00'),
    send: async () => { notificationCount++; }
  });
  assert.equal(active.status, 'PRICE DROP DETECTED');
  assert.equal(notificationCount, 1);
});

test('expired monitoring period does not fetch or notify', async () => {
  const product = makeProduct({ purchaseDate: '2026-10-01', date: '2026-10-01' });
  let fetchCount = 0;
  let sendCount = 0;
  const result = await checkMonitoredProduct({
    product,
    now,
    intervalMs,
    fetchVerifiedPrice: async () => { fetchCount++; return { price: 50, currency: 'USD', verified: true }; },
    sendNotification: async () => { sendCount++; }
  });
  assert.equal(result.status, 'OFF WATCH');
  assert.equal(product.monitoringExpirationDate, '2026-10-31');
  assert.equal(product.nextCheckAt, null);
  assert.equal(fetchCount, 0);
  assert.equal(sendCount, 0);
});

test('day 29 is still on watch and day 30 is expired and never fetched', async () => {
  const today = new Date('2026-11-04T12:00:00');
  let fetchCount = 0;
  const run = purchaseDate => checkMonitoredProduct({
    product: makeProduct({ purchaseDate, date: purchaseDate }),
    now: today,
    intervalMs,
    fetchVerifiedPrice: async () => { fetchCount++; return { price: 100, currency: 'USD', verified: true }; },
    sendNotification: async () => {}
  });
  assert.equal((await run('2026-10-06')).status, 'MONITORING');
  assert.equal(fetchCount, 1);
  assert.equal((await run('2026-10-05')).status, 'OFF WATCH');
  assert.equal(fetchCount, 1);
  assert.equal(watchStatusFor('2026-10-06', today), 'WATCH');
  assert.equal(watchStatusFor('2026-10-05', today), 'WATCH EXPIRED');
});

test('unverifiable retailer price records unavailable and schedules retry', async () => {
  const product = makeProduct();
  let sendCount = 0;
  const result = await check(product, {
    fetchError: new Error('HTTP 403'),
    send: async () => { sendCount++; }
  });
  assert.equal(result.status, 'PRICE UNAVAILABLE');
  assert.equal(product.currentVerifiedPrice, null);
  assert.equal(product.lastCheckedAt, now.toISOString());
  assert.equal(product.nextCheckAt, new Date(now.getTime() + intervalMs).toISOString());
  assert.match(product.lastError, /could not be verified/);
  assert.equal(product.notificationHistory.length, 0);
  assert.equal(sendCount, 0);
  const retryResult = await check(product, {
    price: 105,
    now: new Date(now.getTime() + intervalMs)
  });
  assert.equal(retryResult.status, 'MONITORING');
  assert.equal(product.currentVerifiedPrice, 105);
});

test('a successful automatic notification is persisted as sent through the injected sender', async () => {
  const product = makeProduct();
  const persisted = [];
  const result = await checkMonitoredProduct({
    product,
    now,
    intervalMs,
    fetchVerifiedPrice: async () => ({ price: 60, currency: 'USD', verified: true }),
    sendNotification: async (_, details) => {
      assert.equal(details.savings, 40);
      assert.equal(product.notificationHistory[0].status, 'sending');
      assert.equal(persisted.at(-1), 'sending');
    },
    persist: async () => persisted.push(product.notificationStatus)
  });
  assert.equal(result.notification, 'sent');
  assert.deepEqual(persisted, [undefined, 'pending', 'sending', 'sent']);
  assert.equal(product.notificationHistory[0].status, 'sent');
  assert.ok(product.notificationHistory[0].sentAt);
});

test('a failed email is recorded as a dashboard notification and is not retried at the same price', async () => {
  const product = makeProduct();
  let sendCount = 0;
  const failed = await check(product, {
    price: 75,
    send: async () => {
      sendCount++;
      throw new Error('mock Gmail failure');
    }
  });
  assert.equal(failed.notification, 'failed');
  assert.equal(product.notificationHistory[0].price, 75);
  assert.equal(product.notificationHistory[0].url, product.url);
  const retried = await check(product, {
    price: 75,
    now: new Date(now.getTime() + intervalMs),
    send: async () => { sendCount++; }
  });
  assert.equal(retried.notification, 'duplicate_suppressed');
  assert.equal(sendCount, 1);
  assert.deepEqual(product.notificationHistory.map(item => item.status), ['failed']);
  assert.match(product.notificationHistory[0].error, /mock Gmail failure/);
});

test('same-price notifications are suppressed but every changed lower price can notify', async () => {
  const product = makeProduct();
  let sendCount = 0;
  await check(product, { price: 90, send: async () => sendCount++ });
  const duplicate = await check(product, {
    price: 90,
    now: new Date(now.getTime() + intervalMs),
    send: async () => sendCount++
  });
  assert.equal(duplicate.notification, 'duplicate_suppressed');
  const furtherDrop = await check(product, {
    price: 89.99,
    now: new Date(now.getTime() + intervalMs * 2),
    send: async () => sendCount++
  });
  assert.equal(furtherDrop.notification, 'sent');
  assert.equal(sendCount, 2);
  assert.equal(product.notificationCount, 2);
});

test('monitoring period and notification history survive a backend restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pricedrop-monitoring-'));
  const store = path.join(directory, 'products.json');
  try {
    const product = makeProduct();
    await check(product, { price: 70 });
    const originalStart = product.monitoringStartDate;
    const originalExpiry = product.monitoringExpirationDate;
    await writeFile(store, JSON.stringify([product]));

    const [restartedProduct] = JSON.parse(await readFile(store, 'utf8'));
    let sendCount = 0;
    const result = await check(restartedProduct, {
      price: 70,
      now: new Date(now.getTime() + intervalMs),
      send: async () => sendCount++
    });
    assert.equal(result.notification, 'duplicate_suppressed');
    assert.equal(sendCount, 0);
    assert.equal(restartedProduct.monitoringStartDate, originalStart);
    assert.equal(restartedProduct.monitoringExpirationDate, originalExpiry);
    assert.equal(restartedProduct.notificationCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('scheduler checks on startup, repeats at the configured interval, and skips overlapping runs', async () => {
  let scheduledTick;
  let cleared = false;
  let runCount = 0;
  let finishFirstRun;
  const timer = { unref() {} };
  const stop = startMonitoringScheduler(
    () => {
      runCount++;
      if (runCount === 1) {
        return new Promise(resolve => { finishFirstRun = resolve; });
      }
    },
    {
      intervalMs,
      timers: {
        setInterval(callback, delay) {
          assert.equal(delay, intervalMs);
          scheduledTick = callback;
          return timer;
        },
        clearInterval(value) {
          assert.equal(value, timer);
          cleared = true;
        }
      }
    }
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runCount, 1);
  scheduledTick();
  assert.equal(runCount, 1);
  finishFirstRun();
  await new Promise(resolve => setImmediate(resolve));
  scheduledTick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runCount, 2);
  stop();
  assert.equal(cleared, true);
});
