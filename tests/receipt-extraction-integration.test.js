import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import test from 'node:test';
import '../server/env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = 'qwen/qwen3.8-27b';

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error =>
    error ? reject(error) : resolve()
  ));
  return port;
}

async function startBackend({ failProvider = false, rateLimited = false, liveProvider = false, shellKeyOnly = false, receiptDates = [] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pricedrop-extraction-test-'));
  let child;
  let output = '';
  const providerRequests = [];
  const provider = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    providerRequests.push({ ...payload, requestPath: request.url });

    response.setHeader('content-type', 'application/json');
    if (failProvider || rateLimited) {
      response.writeHead(rateLimited ? 429 : 503);
      response.end(JSON.stringify({
        error: { message: rateLimited ? 'mock Groq quota exceeded' : 'mock Groq provider outage' }
      }));
      return;
    }

    const isHealthCheck = payload.max_tokens === 1;
    const date = receiptDates[providerRequests.filter(request => request.max_tokens !== 1).length - 1];
    const content = isHealthCheck
      ? 'OK'
      : JSON.stringify({
          merchant: 'Costco',
          merchantEvidence: 'Costco Wholesale',
          purchaseDateEvidence: date === undefined ? '11/10/2026' : date,
          purchaseDate: date === undefined ? '2026-11-10' : date,
          total: 12.5,
          currency: 'USD',
          products: [{
            name: 'Sample coffee',
            quantity: 2,
            paidPrice: 12.5
          }]
        });
    response.writeHead(200);
    response.end(JSON.stringify({
      choices: [{ message: { content } }]
    }));
  });

  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;

  try {
    await cp(path.join(root, 'server'), path.join(directory, 'server'), { recursive: true });
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    if (!shellKeyOnly && !liveProvider) {
      await writeFile(
        path.join(directory, '.env'),
        [
          'GROQ_API_KEY=gsk_test_key',
          'GROQ_URL=https://api.groq.com/openai/v1',
          'GROQ_BASE_URL=https://api.groq.com/openai/v1',
          `GROQ_MODEL=${model}`
        ].join('\n')
      );
    }
    await writeFile(path.join(directory, 'mock-fetch.js'), `
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(input);
        if (url.origin === 'https://api.groq.com' && ${!liveProvider}) {
          url.protocol = 'http:';
          url.host = '127.0.0.1:${providerPort}';
        }
        if (url.pathname.includes('/chat/completions')) {
          console.log('[test-provider-path]', url.pathname);
        }
        return originalFetch(url, init);
      };
    `);
    await cp(
      path.join(directory, 'server', 'product-discovery.js'),
      path.join(directory, 'server', 'product-discovery-real.js')
    );
    await writeFile(path.join(directory, 'server', 'product-discovery.js'), `
      export {
        cheapestVerifiedAlternative, compareProductIdentity, isRetailerDomain, matchProductCandidate,
        registrableDomain, resolveOfficialRetailerDomain, retailerMatchesHost,
        saveFoundUrlBeforeVerification, saveFoundProductUrl, saveVerifiedProductMatch,
        selectBestProductMatch
      } from './product-discovery-real.js';
      export async function searchRetailerProductPages() {
        return { domain: null, results: [] };
      }
      export async function searchPublicProductPages() {
        return [];
      }
    `);
    await mkdir(path.join(directory, 'data'));

    const port = await unusedPort();
    child = spawn(process.execPath, ['--import', './mock-fetch.js', 'server/index.js'], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PORT: String(port),
        ...(liveProvider ? { GROQ_API_KEY: process.env.GROQ_API_KEY } : {}),
        ...(shellKeyOnly ? { GROQ_API_KEY: 'gsk_test_key' } : {}),
        ...(rateLimited ? { GROQ_MAX_RETRIES: '1' } : {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });

    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`Test server exited early: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/ready`);
        if (response.status === 204) {
          ready = true;
          break;
        }
      } catch {
        // The isolated backend may still be starting.
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Backend did not become ready: ${output}`);

    return {
      directory,
      output: () => output,
      port,
      provider,
      providerRequests,
      stop: async () => {
        if (child && child.exitCode == null) {
          const exit = new Promise(resolve => child.once('exit', resolve));
          child.kill('SIGTERM');
          await exit;
        }
        await new Promise((resolve, reject) => provider.close(error =>
          error ? reject(error) : resolve()
        ));
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    if (child && child.exitCode == null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exit;
    }
    await new Promise(resolve => provider.close(resolve));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function sampleImage(format) {
  const image = sharp({
    create: {
      width: 80,
      height: 180,
      channels: 3,
      background: '#ffffff'
    }
  });
  if (format === 'png') return image.png().toBuffer();
  if (format === 'webp') return image.webp().toBuffer();
  return image.jpeg().toBuffer();
}

async function syntheticReceiptImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800">
    <rect width="100%" height="100%" fill="white"/>
    <g fill="black" font-family="monospace" font-size="40">
      <text x="60" y="90">COSTCO WHOLESALE</text>
      <text x="60" y="160">DATE: 11/09/2026</text>
      <text x="60" y="250">COFFEE   QTY 2   $12.50</text>
      <text x="60" y="320">TEA      QTY 1    $5.00</text>
      <text x="60" y="420">TOTAL USD        $17.50</text>
      <text x="60" y="510">THANK YOU</text>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function syntheticPdf(pageCount = 1) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) =>
      `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`
  ];
  for (let index = 0; index < pageCount; index++) {
    const stream = '1 0 0 rg\n20 20 100 100 re f\n0 0 0 rg\nBT /F1 14 Tf 20 200 Td (COFFEE 12.50) Tj ET\n';
    const font = 3 + pageCount * 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function uploadReceipt(port, name, mimeType, image, purchaseDate) {
  const formData = new FormData();
  formData.append('receipt', new Blob([image], { type: mimeType }), name);
  if (purchaseDate !== undefined) formData.append('purchaseDate', purchaseDate);
  return fetch(`http://127.0.0.1:${port}/api/receipts/upload`, {
    method: 'POST',
    body: formData
  });
}

test('optional upload purchase date overrides extracted date and survives storage', async () => {
  const backend = await startBackend({ receiptDates: ['2026-11-10'] });
  try {
    const response = await uploadReceipt(
      backend.port, 'old.png', 'image/png', await sampleImage('png'), '2000-01-02'
    );
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.purchaseDate, '2000-01-02');
    assert.equal(receipt.purchaseDateEvidence, '2026-11-10');
    assert.equal(receipt.purchaseDateConfirmedByUser, true);
    assert.equal(receipt.status, 'WATCH EXPIRED');
    assert.equal(receipt.products[0].date, '2000-01-02');
    assert.equal(receipt.products[0].purchaseDateConfirmedByUser, true);
    const saved = await (await fetch(`http://127.0.0.1:${backend.port}/api/receipts`)).json();
    assert.equal(saved[0].purchaseDate, '2000-01-02');
    assert.equal(saved[0].products[0].monitoringStatus, 'OFF WATCH');
    const monitor = await (await fetch(`http://127.0.0.1:${backend.port}/api/monitor/products`)).json();
    assert.equal(monitor.stats.monitored, 0);
  } finally {
    await backend.stop();
  }
});

test('unclear date is requested and saving it updates receipt and product watch states', async () => {
  const backend = await startBackend({ receiptDates: [null] });
  try {
    const response = await uploadReceipt(
      backend.port, 'unclear.png', 'image/png', await sampleImage('png')
    );
    const receipt = await response.json();
    assert.equal(receipt.purchaseDate, null);
    assert.equal(receipt.status, 'PURCHASE DATE NEEDS CONFIRMATION');
    const update = date => fetch(`http://127.0.0.1:${backend.port}/api/receipts/${receipt.id}/confirm-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseDate: date })
    });
    assert.equal((await update('2999-01-01')).status, 400);
    const old = await update('2000-01-02');
    assert.equal(old.status, 200);
    assert.equal((await old.json()).status, 'WATCH EXPIRED');
    const saved = await (await fetch(`http://127.0.0.1:${backend.port}/api/receipts`)).json();
    assert.equal(saved[0].purchaseDate, '2000-01-02');
    assert.equal(saved[0].products[0].monitoringStatus, 'OFF WATCH');
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    assert.equal((await (await update(today)).json()).status, 'WATCH');
    const monitor = await (await fetch(`http://127.0.0.1:${backend.port}/api/monitor/products`)).json();
    assert.equal(monitor.stats.monitored, 1);
    assert.equal(monitor.products[0].monitoringStatus, 'ON WATCH');
  } finally {
    await backend.stop();
  }
});

test('invalid or future optional dates are rejected before extraction', async () => {
  const backend = await startBackend();
  try {
    const image = await sampleImage('png');
    for (const date of ['2026-02-30', '2999-01-01', 'not-a-date']) {
      const response = await uploadReceipt(backend.port, 'sample.png', 'image/png', image, date);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /valid purchase date/i);
    }
    assert.equal(backend.providerRequests.length, 0);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${backend.port}/api/receipts`)).json(), []);
  } finally {
    await backend.stop();
  }
});

test('old and recent uploads remain saved and update watch counts before price checks', async () => {
  const today = new Date();
  const old = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 31, 12);
  const recent = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
  const dateOnly = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const backend = await startBackend({ receiptDates: [dateOnly(old), dateOnly(recent)] });
  try {
    const image = await sampleImage('png');
    const first = await (await uploadReceipt(backend.port, 'old.png', 'image/png', image)).json();
    assert.equal(first.status, 'WATCH EXPIRED');
    const second = await (await uploadReceipt(backend.port, 'recent.png', 'image/png', image)).json();
    assert.equal(second.status, 'WATCH');
    const receipts = await (await fetch(`http://127.0.0.1:${backend.port}/api/receipts`)).json();
    assert.equal(receipts.length, 2);
    assert.equal(receipts.find(item => item.id === first.id).status, 'WATCH EXPIRED');
    assert.equal(receipts.find(item => item.id === second.id).status, 'WATCH');
    assert.equal(receipts.find(item => item.id === first.id).products[0].monitoringStatus, 'OFF WATCH');
    assert.equal(receipts.find(item => item.id === second.id).products[0].monitoringStatus, 'ON WATCH');
    const monitor = await (await fetch(`http://127.0.0.1:${backend.port}/api/monitor/products`)).json();
    assert.equal(monitor.stats.monitored, 1);
    assert.equal(monitor.products.find(item => item.receiptId === second.id).lastCheckedAt, null);
  } finally {
    await backend.stop();
  }
});

test('receipt uploads call Groq and extract receipt fields from JPG, JPEG, PNG, and WebP', async () => {
  const backend = await startBackend();
  try {
    const formats = [
      ['sample.jpg', 'image/jpeg', 'jpeg'],
      ['sample.jpeg', 'image/jpeg', 'jpeg'],
      ['sample.png', 'image/png', 'png'],
      ['sample.webp', 'image/webp', 'webp']
    ];

    for (const [name, mimeType, format] of formats) {
      const response = await uploadReceipt(
        backend.port,
        name,
        mimeType,
        await sampleImage(format)
      );
      assert.equal(response.status, 201);
      const receipt = await response.json();
      assert.equal(receipt.extractionStatus, 'complete');
      assert.equal(receipt.merchant, 'Costco');
      assert.equal(receipt.purchaseDate, '2026-11-10');
      assert.equal(receipt.total, 12.5);
      assert.equal(receipt.currency, 'USD');
      assert.equal(receipt.products[0].name, 'Sample coffee');
      assert.equal(receipt.products[0].quantity, 2);
      assert.equal(receipt.products[0].purchasePrice, 12.5);
    }

    const healthChecks = backend.providerRequests.filter(request => request.max_tokens === 1);
    const extractionRequests = backend.providerRequests.filter(request => request.max_tokens !== 1);
    assert.equal(healthChecks.length, 0);
    assert.equal(extractionRequests.length, formats.length);
    assert.ok(backend.providerRequests.every(request => request.model === model));
    assert.ok(backend.providerRequests.every(request =>
      request.requestPath === '/openai/v1/chat/completions'
    ));
    for (const request of extractionRequests) {
      assert.equal(request.max_tokens, 2000);
      const imagePart = request.messages[1].content.find(part => part.type === 'image_url');
      const match = imagePart.image_url.url.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);
      assert.ok(match, 'normalized image must be sent as a JPEG data URL');
      assert.deepEqual(
        [...Buffer.from(match[1], 'base64').subarray(0, 3)],
        [0xff, 0xd8, 0xff]
      );
    }

    for (const event of [
      'receipt_received',
      'image_loaded',
      'provider_request_started',
      'provider_request_succeeded',
      'extraction_parsed',
      'receipt_updated'
    ]) {
      assert.match(backend.output(), new RegExp(`"event":"${event}"`));
    }
  } finally {
    await backend.stop();
  }
});

test('HEIC and HEIF uploads are converted and stored as JPEG with the original filename', async () => {
  const backend = await startBackend();
  try {
    const heic = await readFile(path.join(root, 'tests', 'fixtures', 'synthetic-receipt.heic'));
    const heif = Buffer.from(heic);
    heif.write('mif1', 8, 'ascii');
    const formats = [
      ['receipt.HEIC', 'image/heic', heic],
      ['receipt.heif', 'image/heif', heif],
      ['extension.heic', 'application/octet-stream', heic],
      ['mime-upload', 'image/heif', heif]
    ];

    for (const [name, mimeType, image] of formats) {
      const response = await uploadReceipt(backend.port, name, mimeType, image);
      assert.equal(response.status, 201, `${await response.clone().text()}\n${backend.output()}`);
      const receipt = await response.json();
      assert.equal(receipt.extractionStatus, 'complete');
      assert.equal(receipt.fileName, name);
      assert.equal(receipt.mimeType, 'image/jpeg');
      assert.match(receipt.storedFile, /\.jpg$/);
      const stored = await readFile(path.join(backend.directory, 'data', 'uploads', receipt.storedFile));
      assert.equal((await sharp(stored).metadata()).format, 'jpeg');

      const request = backend.providerRequests.at(-1);
      const imagePart = request.messages[1].content.find(part => part.type === 'image_url');
      const encoded = imagePart.image_url.url.match(/^data:image\/jpeg;base64,(.+)$/);
      assert.ok(encoded);
      assert.equal((await sharp(Buffer.from(encoded[1], 'base64')).metadata()).format, 'jpeg');
    }
    assert.equal(backend.providerRequests.length, formats.length);
  } finally {
    await backend.stop();
  }
});

test('corrupt HEIC and HEIF uploads return a clear error without saving or calling Groq', async () => {
  const backend = await startBackend();
  try {
    for (const [name, mimeType] of [['bad.heic', 'image/heic'], ['bad.heif', 'image/heif']]) {
      const response = await uploadReceipt(backend.port, name, mimeType, Buffer.from('not an image'));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error,
        'This HEIC receipt could not be converted. Please upload a JPG or PNG version.');
    }
    assert.equal(backend.providerRequests.length, 0);
    assert.deepEqual(await readdir(path.join(backend.directory, 'data', 'uploads')), []);
    assert.match(backend.output(), /"event":"heif_conversion_failed"/);
  } finally {
    await backend.stop();
  }
});

test('the 10 MB upload limit still applies before HEIC conversion', async () => {
  const backend = await startBackend();
  try {
    const belowLimit = await uploadReceipt(
      backend.port, 'invalid.heic', 'image/heic', Buffer.alloc(10 * 1024 * 1024 - 1)
    );
    assert.equal(belowLimit.status, 400);
    assert.equal((await belowLimit.json()).error,
      'This HEIC receipt could not be converted. Please upload a JPG or PNG version.');

    const aboveLimit = await uploadReceipt(
      backend.port, 'large.heic', 'image/heic', Buffer.alloc(10 * 1024 * 1024 + 1)
    );
    assert.ok(aboveLimit.status >= 400);
    assert.equal(backend.providerRequests.length, 0);
    assert.deepEqual(await readdir(path.join(backend.directory, 'data', 'uploads')), []);
  } finally {
    await backend.stop();
  }
});

test('a provider failure preserves the converted HEIC upload and its JPEG metadata', async () => {
  const backend = await startBackend({ failProvider: true });
  try {
    const image = await readFile(path.join(root, 'tests', 'fixtures', 'synthetic-receipt.heic'));
    const response = await uploadReceipt(backend.port, 'receipt.HEIC', 'image/heic', image);
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.equal(receipt.extractionStatus, 'failed');
    assert.equal(receipt.fileName, 'receipt.HEIC');
    assert.equal(receipt.mimeType, 'image/jpeg');
    assert.match(receipt.storedFile, /\.jpg$/);
    const stored = await readFile(path.join(backend.directory, 'data', 'uploads', receipt.storedFile));
    assert.equal((await sharp(stored).metadata()).format, 'jpeg');
  } finally {
    await backend.stop();
  }
});

test('UTF-8 text receipts continue to reach Groq', async () => {
  const backend = await startBackend();
  try {
    const response = await uploadReceipt(
      backend.port, 'receipt.txt', 'text/plain', Buffer.from('Costco\nCoffee $12.50\n')
    );
    assert.equal(response.status, 201, `${await response.clone().text()}\n${backend.output()}`);
    assert.equal((await response.json()).extractionStatus, 'complete');
    assert.equal(backend.providerRequests.length, 1);
    assert.match(JSON.stringify(backend.providerRequests[0].messages), /Coffee/);
  } finally {
    await backend.stop();
  }
});

test('PDF receipts are rendered as images and all supported pages reach Groq', async () => {
  const backend = await startBackend();
  try {
    for (const pageCount of [1, 2, 3]) {
      const response = await uploadReceipt(
        backend.port, 'receipt.pdf', 'application/pdf', syntheticPdf(pageCount)
      );
      assert.equal(response.status, 201, `${await response.clone().text()}\n${backend.output()}`);
      assert.equal((await response.json()).extractionStatus, 'complete');
      const request = backend.providerRequests.at(-1);
      const images = request.messages[1].content.filter(part => part.type === 'image_url');
      assert.equal(images.length, pageCount === 1 ? 3 : pageCount);
      for (const image of images) {
        const encoded = image.image_url.url.match(/^data:image\/jpeg;base64,(.+)$/);
        assert.ok(encoded);
        assert.deepEqual([...Buffer.from(encoded[1], 'base64').subarray(0, 3)], [0xff, 0xd8, 0xff]);
      }
    }
    for (const pdf of [syntheticPdf(4), Buffer.from('%PDF-1.4\nbroken')]) {
      const before = backend.providerRequests.length;
      const response = await uploadReceipt(backend.port, 'bad.pdf', 'application/pdf', pdf);
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /PDF|receipt reading/i);
      assert.equal(backend.providerRequests.length, before);
    }
  } finally {
    await backend.stop();
  }
});

test('provider failures are returned and persisted without leaving a receipt extracting', async () => {
  const backend = await startBackend({ failProvider: true });
  try {
    const response = await uploadReceipt(
      backend.port,
      'sample.png',
      'image/png',
      await sampleImage('png'),
      '2000-01-02'
    );
    assert.equal(response.status, 201);
    const failed = await response.json();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.reason, 'groq_error');
    assert.equal(failed.extractionStatus, 'failed');
    assert.match(failed.message, /HTTP 503.*mock Groq provider outage/);
    assert.equal(backend.providerRequests.length, 1);

    const receipts = await (await fetch(`http://127.0.0.1:${backend.port}/api/receipts`)).json();
    const saved = receipts.find(receipt => receipt.id === failed.id);
    assert.equal(saved.extractionStatus, 'failed');
    assert.equal(saved.purchaseDate, '2000-01-02');
    assert.equal(saved.purchaseDateConfirmedByUser, true);
    assert.equal(saved.status, 'EXTRACTION FAILED');
    assert.match(backend.output(), /"event":"provider_request_failed"/);
    assert.match(backend.output(), /"operation":"receipt_extraction"/);
    assert.match(backend.output(), /"responseBody":\{"error":\{"message":"mock Groq provider outage"\}\}/);
    assert.match(backend.output(), new RegExp(failed.id));
  } finally {
    await backend.stop();
  }
});

test('exhausted rate-limit retries save a failed receipt with the provider error', async () => {
  const backend = await startBackend({ rateLimited: true });
  try {
    const response = await uploadReceipt(
      backend.port, 'sample.png', 'image/png', await sampleImage('png')
    );
    const receipt = await response.json();
    assert.equal(receipt.extractionStatus, 'failed');
    assert.equal(receipt.extractionHttpStatus, 429);
    assert.match(receipt.extractionMessage, /HTTP 429.*mock Groq quota exceeded/);
    assert.equal(backend.providerRequests.length, 2);
    const saved = await (await fetch(`http://127.0.0.1:${backend.port}/api/receipts`)).json();
    assert.equal(saved.find(item => item.id === receipt.id).extractionStatus, 'failed');
  } finally {
    await backend.stop();
  }
});

test('health endpoints share a cached real provider request', async () => {
  const backend = await startBackend();
  try {
    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${backend.port}/api/health`),
      fetch(`http://127.0.0.1:${backend.port}/api/health`)
    ]);
    for (const response of responses) {
      assert.equal((await response.json()).aiConnected, true);
    }
    await fetch(`http://127.0.0.1:${backend.port}/api/health`);
    assert.equal(backend.providerRequests.length, 1);
    assert.equal(backend.providerRequests[0].requestPath, '/openai/v1/chat/completions');
    assert.equal(backend.providerRequests[0].max_tokens, 1);
  } finally {
    await backend.stop();
  }
});

test('backend accepts a shell key without an .env file', async () => {
  const backend = await startBackend({ shellKeyOnly: true });
  try {
    const response = await uploadReceipt(
      backend.port, 'sample.png', 'image/png', await sampleImage('png')
    );
    assert.equal((await response.json()).extractionStatus, 'complete');
    assert.equal(backend.providerRequests.length, 1);
  } finally {
    await backend.stop();
  }
});

test('live Groq synthetic image upload reports a terminal result', {
  skip: process.env.GROQ_LIVE_TEST !== '1',
  timeout: 360000
}, async () => {
  assert.ok(process.env.GROQ_API_KEY, 'A Groq key is required for the live test');
  const backend = await startBackend({ liveProvider: true });
  try {
    const response = await uploadReceipt(
      backend.port, 'synthetic.png', 'image/png', await syntheticReceiptImage()
    );
    assert.equal(response.status, 201);
    const receipt = await response.json();
    assert.ok(['complete', 'failed'].includes(receipt.extractionStatus));
    assert.match(backend.output(), /\[test-provider-path\] \/openai\/v1\/chat\/completions/);
    const receipts = await (await fetch(`http://127.0.0.1:${backend.port}/api/receipts`)).json();
    assert.equal(receipts.find(item => item.id === receipt.id).extractionStatus, receipt.extractionStatus);
    console.log('Live synthetic upload result:', JSON.stringify({
      extractionStatus: receipt.extractionStatus,
      httpStatus: receipt.extractionHttpStatus ?? null,
      message: receipt.extractionStatus === 'complete' ? null : receipt.extractionMessage,
      ...(receipt.extractionStatus === 'complete' ? {
        merchant: receipt.merchant,
        purchaseDate: receipt.purchaseDate,
        total: receipt.total,
        currency: receipt.currency,
        products: receipt.products.map(({ name, quantity, purchasePrice }) =>
          ({ name, quantity, purchasePrice }))
      } : {})
    }));
    if (receipt.extractionStatus === 'complete') {
      assert.match(receipt.merchant, /costco/i);
      assert.equal(receipt.purchaseDate, '2026-11-09');
      assert.equal(receipt.total, 17.5);
      assert.equal(receipt.currency, 'USD');
      const coffee = receipt.products.find(product => /coffee/i.test(product.name));
      assert.ok(coffee, 'Coffee line item is present');
      assert.equal(coffee.quantity, 2);
      assert.equal(coffee.purchasePrice, 12.5);
    } else {
      assert.ok(receipt.extractionMessage, 'Provider error is visible');
    }
  } finally {
    await backend.stop();
  }
});
