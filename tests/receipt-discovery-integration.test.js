import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('discovery only searches active purchases and resumes when a missing date is confirmed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pricedrop-discovery-test-'));
  let child;
  try {
    await cp(path.join(root, 'server'), path.join(directory, 'server'), { recursive: true });
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await cp(
      path.join(directory, 'server', 'product-discovery.js'),
      path.join(directory, 'server', 'product-discovery-real.js')
    );
    await writeFile(path.join(directory, 'server', 'product-discovery.js'), `
      export {
        cheapestVerifiedAlternative, compareProductIdentity, isRetailerDomain, matchProductCandidate,
        registrableDomain, resolveOfficialRetailerDomain, retailerMatchesHost,
        saveFoundUrlBeforeVerification, saveFoundProductUrl, saveVerifiedProductMatch,
        selectBestProductMatch, searchPublicProductPages
      } from './product-discovery-real.js';
      export async function searchRetailerProductPages(retailer, product) {
        console.log('TEST_SEARCH ' + JSON.stringify({ retailer, name: product.name }));
        return { domain: 'costco.com', results: product.sku === '36285'
          ? [{ url: 'https://www.costco.com/kirkland-signature-walnuts-36285', title: 'Walnuts' },
             { url: 'https://www.costco.com/second-walnuts-36285', title: 'Walnuts other listing' }]
          : [] };
      }
    `);
    const indexPath = path.join(directory, 'server', 'index.js');
    const indexSource = await readFile(indexPath, 'utf8');
    await writeFile(indexPath, indexSource.replace(
      'const { url: parsedUrl } = await validateProductUrl(url);',
      `const stored = JSON.parse(await fs.readFile(RECEIPTS_FILE, 'utf8'));
       const candidate = stored.flatMap(receipt => receipt.products || [])
         .find(product => product.sku === '36285')?.discoveryCandidates?.[0];
       if (!url.includes('replacement-walnuts-36285') && (!candidate || candidate.url !== url))
         throw new Error('Candidate was not persisted before verification');
       if (url.includes('replacement-walnuts-36285') && url.includes('blocked=1'))
         throw new Error('TEST replacement unavailable');
       console.log('TEST_PRODUCT_PAGE ' + url);
       globalThis.__testPageCalls = (globalThis.__testPageCalls || 0) + 1;
       if (globalThis.__testPageCalls === 1) throw new Error('TEST product page blocked');
       return { url, title: 'Kirkland Signature Walnuts', sku: '36285',
         productTitle: true, productSku: true, productSchema: true };`
    ).replace(
      '({ url: parsedUrl } = await validateProductUrl(requestedUrl));',
      'parsedUrl = new URL(requestedUrl);'
    ).replace(
      'await refreshAlternativeOffers(product, now, persistStores);',
      '/* Alternative searches are outside this discovery test. */'
    ));
    await mkdir(path.join(directory, 'data'));

    const now = new Date();
    const printedDate = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}/${now.getFullYear()}`;
    const expectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const receipts = [
      { id: 'dated', merchant: 'Costco', purchaseDate: null, purchaseDateEvidence: printedDate,
        products: [{ id: 'first', name: 'Example item', price: 5, purchasePrice: 5, discoveryStatus: 'searching' }] },
      { id: 'undated', merchant: 'Costco', purchaseDate: null, purchaseDateEvidence: '',
        products: [{ id: 'second', name: 'Other item', price: 5, purchasePrice: 5, discoveryStatus: 'searching' }] },
      { id: 'walnuts', merchant: 'Costco', purchaseDate: expectedDate, purchaseDateEvidence: printedDate,
        products: [{ id: 'third', name: 'KS WALNUTS', sku: '36285', ocrText: '/KS WALNUTS', price: 10, purchasePrice: 10, discoveryStatus: 'searching' }] },
      { id: 'walnuts-copy', merchant: 'Costco', purchaseDate: expectedDate, purchaseDateEvidence: printedDate,
        products: [{ id: 'fourth', name: 'KS WALNUTS', sku: '36285', ocrText: '/KS WALNUTS', price: 10, purchasePrice: 10, discoveryStatus: 'searching' }] },
      { id: 'expired', merchant: 'Costco', purchaseDate: '2000-01-01',
        products: [{ id: 'fifth', name: 'Expired item', price: 5, purchasePrice: 5, discoveryStatus: 'queued' }] }
    ];
    await writeFile(path.join(directory, 'data', 'receipts.json'), JSON.stringify(receipts));
    await writeFile(path.join(directory, 'data', 'manual-products.json'), '[]');
    await writeFile(path.join(directory, 'data', 'email-settings.json'), '{}');

    const port = await unusedPort();
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, PORT: String(port), GROQ_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exit = new Promise(resolve => child.once('exit', resolve));
    const deadline = Date.now() + 10000;
    let response;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`Test server exited early: ${output}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/receipts`);
        const data = await response.json();
        if (output.includes('"event":"discovery_cycle_finished"') &&
          [0, 2, 3].every(index => data[index].products[0].lastProductDiscoveryAt &&
            data[index].products[0].discoveryStatus !== 'searching')) break;
      } catch {
        // The isolated server may still be starting.
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    assert.ok(response?.ok, `Server did not become ready: ${output}`);
    const results = await (await fetch(`http://127.0.0.1:${port}/api/receipts`)).json();
    assert.equal(results[0].purchaseDate, expectedDate);
    assert.equal(results[0].status, 'WATCH');
    assert.equal(results[1].status, 'PURCHASE DATE NEEDS CONFIRMATION');
    assert.ok([0, 2, 3].every(index => results[index].products[0].lastProductDiscoveryAt), output);
    assert.equal(results[1].products[0].lastProductDiscoveryAt, undefined);
    assert.equal(results[4].products[0].lastProductDiscoveryAt, undefined);
    assert.equal(results[2].products[0].discoveryStatus, 'found');
    assert.equal(results[2].products[0].originalUrlVerified, false);
    assert.equal(results[2].products[0].discoveryCandidates[0].url, 'https://www.costco.com/kirkland-signature-walnuts-36285');
    assert.equal(results[2].products[0].discoveryCandidates.length, 2);
    assert.equal(results[2].products[0].url, results[2].products[0].discoveryCandidates[0].url);
    assert.equal(results[2].products[0].lastError, null);
    assert.match(results[2].products[0].productDiscoveryError, /TEST product page blocked/);
    assert.equal(results[2].products[0].ocrText, '/KS WALNUTS');
    assert.equal(results[3].products[0].discoveryStatus, 'verified');
    assert.equal(results[3].products[0].originalUrlVerified, true);
    assert.equal(results[3].products[0].purchaseDateNeedsConfirmation, false);
    assert.equal(results[3].products[0].monitoringStatus, 'ON WATCH');
    assert.equal(results[3].products[0].url, 'https://www.costco.com/kirkland-signature-walnuts-36285');
    assert.equal(results[3].products[0].discoveryCandidates[0].url, results[3].products[0].url);
    assert.equal((output.match(/TEST_SEARCH {"retailer":"Costco","name":"KS WALNUTS"}/g) || []).length, 1);
    assert.ok((output.match(/TEST_PRODUCT_PAGE/g) || []).length >= 2);
    assert.equal(results[0].products[0].monitoringStatus, 'ON WATCH');
    assert.equal(results[4].products[0].monitoringStatus, 'OFF WATCH');
    assert.doesNotMatch(output, /TEST_SEARCH {"retailer":"Costco","name":"Expired item"}/);
    for (const receipt of [results[0], results[2], results[3]]) {
      const product = receipt.products[0];
      const interval = Date.parse(product.nextProductDiscoveryAt) - Date.parse(product.lastProductDiscoveryAt);
      assert.ok(interval > 23.9 * 60 * 60 * 1000 && interval <= 24 * 60 * 60 * 1000);
    }
    assert.match(output, /TEST_SEARCH {"retailer":"Costco","name":"Example item"}/);
    assert.doesNotMatch(output, /TEST_SEARCH {"retailer":"Costco","name":"Other item"}/);
    const persisted = JSON.parse(await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8'));
    assert.equal(persisted[0].purchaseDate, expectedDate);
    assert.equal(persisted[1].products[0].lastProductDiscoveryAt, undefined);
    const dashboard = await (await fetch(`http://127.0.0.1:${port}/api/monitor/products`)).json();
    assert.equal(dashboard.products.find(product => product.id === 'second').monitoringStatus, 'PURCHASE DATE NEEDS CONFIRMATION');
    const verifiedUndated = dashboard.products.find(product => product.id === 'fourth');
    assert.equal(verifiedUndated.monitoringStatus, 'ON WATCH');
    assert.equal(verifiedUndated.purchaseDateNeedsConfirmation, false);
    assert.equal(verifiedUndated.originalUrlVerified, true);
    assert.equal(dashboard.products.find(product => product.id === 'first').monitoringStatus, 'ON WATCH');
    assert.equal(dashboard.products.find(product => product.id === 'fifth').monitoringStatus, 'OFF WATCH');
    assert.ok(dashboard.stats.awaitingUrlDiscovery >= 1);
    assert.match(output, /"event":"discovery_cycle_finished","productsSearched":3/);
    for (const id of ['second', 'fifth']) {
      const paused = await fetch(`http://127.0.0.1:${port}/api/monitor/products/${id}/discover`, { method: 'POST' });
      assert.equal(paused.status, 400);
    }
    const replacementUrl = 'https://www.costco.com/replacement-walnuts-36285';
    const edit = await fetch(`http://127.0.0.1:${port}/api/monitor/products/fourth/confirm-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: replacementUrl })
    });
    assert.equal(edit.status, 200, await edit.text());
    const edited = JSON.parse(await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8'))
      .flatMap(receipt => receipt.products).find(product => product.id === 'fourth');
    assert.equal(edited.url, replacementUrl);
    assert.equal(edited.originalUrlVerified, true);
    assert.equal(edited.discoveryStatus, 'verified');
    for (const [url, options] of [
      ['/api/monitor/products', {
        name: 'Example item',
        retailer: 'Costco',
        purchasePrice: 5,
        url: 'https://www.costco.com/cart.html'
      }],
      ['/api/monitor/products/first/confirm-url', {
        url: 'https://www.costco.com/photo-center.html'
      }]
    ]) {
      const rejected = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
      });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /navigation page/);
    }
    child.kill('SIGTERM');
    await exit;
    child = null;
    const beforeRestart = await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8');
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, PORT: String(port), GROQ_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let restartOutput = '';
    child.stdout.on('data', chunk => { restartOutput += chunk; });
    child.stderr.on('data', chunk => { restartOutput += chunk; });
    const restartDeadline = Date.now() + 10000;
    while (!restartOutput.includes('"event":"discovery_cycle_finished"') && Date.now() < restartDeadline) {
      if (child.exitCode != null) throw new Error(`Restart failed: ${restartOutput}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(restartOutput, /"event":"discovery_cycle_finished","productsSearched":0/);
    assert.match(restartOutput, /"nextProductDiscoveryAt":"\d{4}-\d{2}-\d{2}T/);
    assert.doesNotMatch(restartOutput, /TEST_SEARCH/);
    const beforeProducts = JSON.parse(beforeRestart).flatMap(receipt => receipt.products);
    const afterProducts = JSON.parse(await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8'))
      .flatMap(receipt => receipt.products);
    for (const [index, product] of afterProducts.entries()) {
      assert.equal(product.lastProductDiscoveryAt, beforeProducts[index].lastProductDiscoveryAt);
      assert.equal(product.nextProductDiscoveryAt, beforeProducts[index].nextProductDiscoveryAt);
    }
    const restartedExit = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await restartedExit;
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, PORT: String(port), GROQ_API_KEY: '',
        PUBLIC_PRODUCT_DISCOVERY_INTERVAL_HOURS: '48' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let configuredOutput = '';
    child.stdout.on('data', chunk => { configuredOutput += chunk; });
    child.stderr.on('data', chunk => { configuredOutput += chunk; });
    const configuredDeadline = Date.now() + 10000;
    while (!configuredOutput.includes('"event":"discovery_cycle_finished"') && Date.now() < configuredDeadline) {
      if (child.exitCode != null) throw new Error(`Configured restart failed: ${configuredOutput}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(configuredOutput, /"productsSearched":0/);
    const configuredProducts = JSON.parse(await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8'))
      .flatMap(receipt => receipt.products);
    for (const product of configuredProducts.filter(item => item.lastProductDiscoveryAt && !item.url)) {
      assert.equal(Date.parse(product.nextProductDiscoveryAt) - Date.parse(product.lastProductDiscoveryAt),
        48 * 60 * 60 * 1000);
    }
    const manual = await fetch(`http://127.0.0.1:${port}/api/monitor/run`, { method: 'POST' });
    assert.equal(manual.status, 200);
    const manualProducts = JSON.parse(await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8'))
      .flatMap(receipt => receipt.products);
    for (const product of manualProducts.filter(item => item.lastProductDiscoveryAt && !item.url)) {
      assert.equal(Date.parse(product.nextProductDiscoveryAt) - Date.parse(product.lastProductDiscoveryAt),
        48 * 60 * 60 * 1000);
      assert.ok(Date.parse(product.lastProductDiscoveryAt) >= Date.parse(beforeProducts.find(item => item.id === product.id).lastProductDiscoveryAt));
    }
    assert.match(configuredOutput, /"event":"discovery_cycle_finished","productsSearched":1/);
    const confirmed = await fetch(`http://127.0.0.1:${port}/api/receipts/undated/confirm-date`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchaseDate: expectedDate })
    });
    assert.equal(confirmed.status, 200);
    const searchDeadline = Date.now() + 10000;
    while (!configuredOutput.includes('TEST_SEARCH {"retailer":"Costco","name":"Other item"}') && Date.now() < searchDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(configuredOutput, /TEST_SEARCH {"retailer":"Costco","name":"Other item"}/);
    assert.doesNotMatch(configuredOutput, /TEST_SEARCH {"retailer":"Costco","name":"Expired item"}/);
    const failedEdit = await fetch(`http://127.0.0.1:${port}/api/monitor/products/fourth/confirm-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${replacementUrl}?blocked=1` })
    });
    assert.equal(failedEdit.status, 200);
    assert.match((await failedEdit.json()).message, /link saved/i);
    const afterFailedEdit = JSON.parse(await readFile(path.join(directory, 'data', 'receipts.json'), 'utf8'))
      .flatMap(receipt => receipt.products).find(product => product.id === 'fourth');
    assert.equal(afterFailedEdit.url, `${replacementUrl}?blocked=1`);
    assert.equal(afterFailedEdit.originalUrlVerified, false);
    assert.equal(afterFailedEdit.discoveryStatus, 'found');
    assert.ok(afterFailedEdit.urlSavedAt);
    assert.match(afterFailedEdit.lastError, /TEST replacement unavailable/);
  } finally {
    if (child && child.exitCode == null) {
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exit;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
