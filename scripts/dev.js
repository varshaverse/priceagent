import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendPort = process.env.PORT || '4100';
const readyUrl = process.env.BACKEND_READY_URL ||
  `http://127.0.0.1:${backendPort}/api/ready`;
const backendScript = path.join(projectRoot, 'server', 'index.js');
const viteScript = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');

export async function isBackendReady(url = readyUrl) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function stopChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
}

async function waitForBackend(child) {
  const deadline = Date.now() + 60_000;
  let startupError;
  child?.once('error', error => { startupError = error; });
  while (Date.now() < deadline) {
    if (await isBackendReady()) return;
    if (startupError) {
      throw new Error(`Could not start the PriceDrop API: ${startupError.message}`);
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`PriceDrop API exited with code ${child.exitCode} before becoming ready.`);
    }
    if (child?.signalCode) {
      throw new Error(`PriceDrop API was stopped (${child.signalCode}) before becoming ready.`);
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('PriceDrop API did not become ready within 60 seconds.');
}

async function runDev() {
  let ownedBackend;
  let vite;
  let stopping = false;
  const stop = () => {
    stopping = true;
    stopChild(vite);
    stopChild(ownedBackend);
  };
  const onSignal = () => stop();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (await isBackendReady()) {
      console.log(`Using the existing PriceDrop API at ${readyUrl}.`);
    } else {
      console.log('Starting the PriceDrop API...');
      ownedBackend = spawn(process.execPath, [backendScript], {
        cwd: projectRoot,
        env: process.env,
        stdio: 'inherit'
      });
      ownedBackend.once('error', error => {
        console.error(`Could not start the PriceDrop API: ${error.message}`);
        stop();
      });
      await waitForBackend(ownedBackend);
    }

    if (stopping) return;
    console.log('Starting Vite...');
    vite = spawn(process.execPath, [viteScript, '--host', '127.0.0.1'], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit'
    });

    const viteExit = new Promise((resolve, reject) => {
      vite.once('error', reject);
      vite.once('exit', (code, signal) => resolve(
        signal ? 1 : code ?? 1
      ));
    });

    if (ownedBackend) {
      ownedBackend.once('exit', (code, signal) => {
        if (stopping) return;
        console.error(
          `PriceDrop API stopped${signal ? ` (${signal})` : ` with code ${code}`}.`
        );
        stop();
      });
    }

    process.exitCode = await viteExit;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    stopChild(vite);
    stopChild(ownedBackend);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runDev().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
