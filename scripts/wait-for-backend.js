const backendPort = process.env.PORT || '4100';
const readyUrl = process.env.BACKEND_READY_URL ||
  `http://127.0.0.1:${backendPort}/api/ready`;
const timeoutMs = 60_000;
const retryIntervalMs = 500;
const deadline = Date.now() + timeoutMs;

console.log(`Waiting for backend readiness at ${readyUrl}...`);

while (Date.now() < deadline) {
  try {
    const response = await fetch(readyUrl, {
      signal: AbortSignal.timeout(2_000)
    });
    if (response.ok) {
      console.log('Backend is ready. Starting Vite.');
      process.exit(0);
    }
  } catch {
    // The API is expected to refuse connections until Express finishes startup.
  }
  await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
}

console.error(`Backend did not become ready within ${timeoutMs / 1000} seconds.`);
process.exit(1);
