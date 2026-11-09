import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function verifyBrowserLaunch() {
  const browser = await chromium.launch({ headless: true });
  await browser.close();
}

try {
  await verifyBrowserLaunch();
} catch {
  console.log('Installing Playwright Chromium for automatic retailer discovery...');
  const result = spawnSync(
    process.execPath,
    [path.join(projectRoot, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
    { cwd: projectRoot, stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('Playwright Chromium installation failed. Retry with: npx playwright install chromium');
  }
  await verifyBrowserLaunch();
}
