import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptExtractionRetryScheduler } from '../server/receipt-retry.js';

function fakeTimers() {
  let scheduled;
  return {
    setTimeout(callback, delay) {
      const handle = {
        delay,
        unref() {},
        callback: async () => {
          if (scheduled === handle) scheduled = null;
          await callback();
        }
      };
      scheduled = handle;
      return scheduled;
    },
    clearTimeout(timer) {
      if (scheduled === timer) scheduled = null;
    },
    get scheduled() {
      return scheduled;
    }
  };
}

test('pending receipt extraction retries at its due time, independent of price-check intervals', async () => {
  const timers = fakeTimers();
  let receipts = [
    {
      extractionStatus: 'retry_pending',
      nextExtractionRetryAt: new Date(5000).toISOString()
    },
    {
      extractionStatus: 'retry_pending',
      nextExtractionRetryAt: new Date(3000).toISOString()
    }
  ];
  let runs = 0;
  const scheduler = createReceiptExtractionRetryScheduler({
    getReceipts: async () => receipts,
    run: async () => {
      runs++;
      receipts = [];
    },
    timers,
    now: () => 1000
  });

  await scheduler.schedule();
  assert.equal(timers.scheduled.delay, 2000);
  await timers.scheduled.callback();
  assert.equal(runs, 1);
  assert.equal(timers.scheduled, null);
});

test('retry scheduler keeps retrying after extraction remains rate limited', async () => {
  const timers = fakeTimers();
  let retryAt = 2000;
  let runs = 0;
  const scheduler = createReceiptExtractionRetryScheduler({
    getReceipts: async () => [{
      extractionStatus: 'retry_pending',
      nextExtractionRetryAt: new Date(retryAt).toISOString()
    }],
    run: async () => {
      runs++;
      retryAt += 15 * 60 * 1000;
    },
    timers,
    now: () => 1000
  });

  await scheduler.schedule();
  await timers.scheduled.callback();
  assert.equal(runs, 1);
  assert.equal(timers.scheduled.delay, 15 * 60 * 1000 + 1000);
  scheduler.stop();
  assert.equal(timers.scheduled, null);
});

test('retry scheduler does not create timers when no receipt needs extraction', async () => {
  const timers = fakeTimers();
  const scheduler = createReceiptExtractionRetryScheduler({
    getReceipts: async () => [{ extractionStatus: 'complete' }],
    run: async () => {},
    timers
  });

  await scheduler.schedule();
  assert.equal(timers.scheduled, undefined);
  scheduler.stop();
});
