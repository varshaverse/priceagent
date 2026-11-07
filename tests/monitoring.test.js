import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkMonitoredProduct,
  isFutureDateOnly,
  isValidDateOnly,
  isWithinMonitoringWindow,
  localDateString,
  monitoringDashboardStats,
  monitoringStatusFor,
  monitoringWindow,
  startMonitoringScheduler
} from '../server/monitoring.js';

const now = new Date('2026-11-04T12:00:00.000Z');
const intervalMs = 60 * 60 * 1000;

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
    assert.equal(result.status, 'URL DISCOVERY');
    assert.equal(product.monitoringStatus, 'URL DISCOVERY');
    assert.equal(fetchCount, 0);
    assert.equal(sendCount, 0);
    assert.equal(monitoringStatusFor(product, now), 'URL DISCOVERY');
});

test('a stale drop status without a verified current price is unavailable and not counted', () => {
    const product = makeProduct({
      monitoringStatus: 'PRICE DROP DETECTED',
      currentVerifiedPrice: null,
      currentPrice: 1,
      lastCheckedAt: now.toISOString()
    });
    assert.equal(monitoringStatusFor(product, now), 'PRICE UNAVAILABLE');
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
    const waiting = await checkMonitoredProduct({
      product,
      now: localLateNight,
      intervalMs,
      fetchVerifiedPrice: async () => { fetchCount++; return { price: 80, currency: 'USD', verified: true }; },
      sendNotification: async () => {}
    });
    assert.equal(waiting.status, 'MONITORING');
    assert.equal(waiting.checked, false);
    assert.equal(fetchCount, 0);
  assert.equal(product.monitoringStartDate, '2026-11-05');
});

test('only valid non-future receipts fewer than 30 days old remain in the monitoring window', () => {
    const localNow = new Date(2026, 10, 4, 12);
    assert.equal(isWithinMonitoringWindow('2026-10-06', localNow), true);
    assert.equal(isWithinMonitoringWindow('2026-10-05', localNow), false);
    assert.equal(isWithinMonitoringWindow('2026-10-04', localNow), false);
    assert.equal(isWithinMonitoringWindow('2026-11-05', localNow), false);
    assert.equal(isWithinMonitoringWindow('not-a-date', localNow), false);
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

test('verified price above purchase price records no drop and sends no email', async () => {
  const product = makeProduct();
  let sendCount = 0;
  const result = await check(product, { price: 105, send: async () => sendCount++ });
  assert.equal(result.status, 'NO PRICE DROP');
  assert.equal(product.currentVerifiedPrice, 105);
  assert.equal(product.previousVerifiedPrice, null);
  assert.equal(product.potentialSavings, 0);
  assert.equal(sendCount, 0);
});

test('verified price equal to purchase price records no drop', async () => {
  const product = makeProduct();
  const result = await check(product, { price: 100 });
  assert.equal(result.status, 'NO PRICE DROP');
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
  assert.equal(result.status, 'WATCH EXPIRED');
  assert.equal(product.monitoringExpirationDate, '2026-10-31');
  assert.equal(product.nextCheckAt, null);
  assert.equal(fetchCount, 0);
  assert.equal(sendCount, 0);
});

test('day 30 is the first day off-watch and never triggers a retailer fetch', async () => {
  const product = makeProduct({ purchaseDate: '2026-10-05', date: '2026-10-05' });
  let fetchCount = 0;
  let sendCount = 0;
  const result = await checkMonitoredProduct({
    product,
    now,
    intervalMs,
    fetchVerifiedPrice: async () => { fetchCount++; return { price: 20, currency: 'USD', verified: true }; },
    sendNotification: async () => { sendCount++; }
  });
  assert.equal(result.status, 'WATCH EXPIRED');
  assert.equal(product.nextCheckAt, null);
  assert.equal(fetchCount, 0);
  assert.equal(sendCount, 0);
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
  assert.equal(retryResult.status, 'NO PRICE DROP');
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
    },
    persist: async () => persisted.push(product.notificationStatus)
  });
  assert.equal(result.notification, 'sent');
  assert.deepEqual(persisted, ['pending', 'sending', 'sent']);
  assert.equal(product.notificationHistory[0].status, 'sent');
  assert.ok(product.notificationHistory[0].sentAt);
});

test('a failed notification remains retryable on the next scheduled check', async () => {
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
  const retried = await check(product, {
    price: 75,
    now: new Date(now.getTime() + intervalMs),
    send: async () => { sendCount++; }
  });
  assert.equal(retried.notification, 'sent');
  assert.equal(sendCount, 2);
  assert.deepEqual(product.notificationHistory.map(item => item.status), ['failed', 'sent']);
});

test('duplicate drops are suppressed; a further drop of at least five percent and one dollar can notify', async () => {
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
    price: 85,
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
