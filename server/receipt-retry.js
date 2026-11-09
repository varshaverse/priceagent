export function createReceiptExtractionRetryScheduler({
  getReceipts,
  run,
  onError = console.error,
  timers = globalThis,
  now = () => Date.now()
}) {
  let timer = null;
  let stopped = false;

  async function schedule() {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (stopped) return;

    const receipts = await getReceipts();
    const nextRetryAt = receipts
      .filter(receipt => receipt.extractionStatus === 'retry_pending')
      .map(receipt => Date.parse(receipt.nextExtractionRetryAt || ''))
      .filter(Number.isFinite)
      .sort((left, right) => left - right)[0];
    if (nextRetryAt == null) return;

    timer = timers.setTimeout(async () => {
      timer = null;
      try {
        await run();
      } catch (error) {
        onError(error);
      }
      if (!stopped) {
        try {
          await schedule();
        } catch (error) {
          onError(error);
        }
      }
    }, Math.max(0, nextRetryAt - now()));
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  return { schedule, stop };
}
