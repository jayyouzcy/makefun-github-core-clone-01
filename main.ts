// Core Clone Forge entrypoint.
// Boots the forge on an ephemeral port, registers it with the make.fun trial
// environment, answers the health probe, then waits for the trial to end.

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;
if (ENV_URL === undefined || ENV_URL === '') {
  console.error('[forge] MAKEFUN_ENV_URL is not set; nothing to register with.');
  process.exit(1);
}

const base = ENV_URL.replace(/\/+$/, '');

async function register(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return true;
      console.error(`[forge] register attempt ${attempt + 1} answered HTTP ${res.status}`);
    } catch (err) {
      console.error(`[forge] register attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForDone(): Promise<void> {
  // /done is a poll, not a long-hold: the env answers HTTP 200 at once with
  // {"done":false} while the suite is still running, and {"done":true} only
  // once the export is written. Returning on any 2xx would exit the entry
  // before the suite even starts, so only a true done flag ends the wait.
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${base}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body: unknown = await res.json().catch(() => null);
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) return;
      }
    } catch {
      // The environment may restart between trials; keep waiting.
    }
    const delay = Math.min(2000, Math.round(250 * 2 ** attempt));
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

const server = createApp();
server.listen(0, async () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('[forge] could not determine the listening port.');
    process.exit(1);
  }
  const port = address.port;
  console.log(`[forge] listening on port ${port}`);
  const ok = await register(port);
  if (!ok) {
    console.error('[forge] could not register with the trial environment.');
    process.exit(1);
  }
  console.log('[forge] registered; waiting for the trial to finish.');
  await waitForDone();
  console.log('[forge] trial finished; shutting down.');
  server.close(() => process.exit(0));
});
