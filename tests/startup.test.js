import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readinessScript = path.join(projectRoot, 'scripts', 'wait-for-backend.js');

test('dev client waits for the backend readiness endpoint before starting', async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/api/ready' ? 204 : 404);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error =>
    error ? reject(error) : resolve()
  ));
  const child = spawn(process.execPath, [readinessScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      BACKEND_READY_URL: `http://127.0.0.1:${port}/api/ready`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const startServer = setTimeout(() => {
    server.listen(port, '127.0.0.1');
  }, 150);

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Readiness waiter did not exit after backend became ready.'));
    }, 5000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  clearTimeout(startServer);
  await new Promise((resolve, reject) => server.close(error =>
    error ? reject(error) : resolve()
  ));

  assert.equal(exitCode, 0, output);
  assert.match(output, /Backend is ready\. Starting Vite\./);
});
