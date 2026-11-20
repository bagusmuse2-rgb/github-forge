// main.ts — the entrypoint: everything that ties this forge to the contest env.
//
// The forge itself lives behind createApp() in app.ts and knows nothing about
// the contest around it. This file owns the whole conversation with the env:
//
//   1. build the HTTP server and bind it to port 0, so the kernel picks a
//      free ephemeral port (8080 belongs to the suite and is never ours);
//   2. tell the env where we landed: POST {"port": <port>} to
//      $MAKEFUN_ENV_URL/register — the env notes the address the request
//      came from and dials us at that address and port;
//   3. while the suite drives the forge, keep asking GET
//      $MAKEFUN_ENV_URL/done; it answers {"done": false} until the suite
//      has finished and written its export, then {"done": true};
//   4. on that answer, close the server and exit 0.
//
// Started without MAKEFUN_ENV_URL (a plain local run) the file skips steps
// 2–4: no registration, no polling, the server just stays up until killed.
// Nothing time-based or random ever leaves this process — the only body it
// sends is the port — so two runs of a trial behave identically.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** Pause between two polls of the env's /done endpoint. */
const DONE_POLL_DELAY_MS = 250;
/** One request to the env may hang at most this long before it is retried. */
const ENV_REQUEST_TIMEOUT_MS = 10_000;
/** Registration attempts before giving up; the env is normally already up. */
const REGISTER_ATTEMPTS = 120;
/** Pause between two registration attempts. */
const REGISTER_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The env's origin with any trailing slash removed, or '' outside a trial. */
function envOrigin(): string {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  return raw.replace(/\/+$/, '');
}

/** Bind the server to an ephemeral port and report the port the kernel chose. */
function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server bound without a TCP port'));
        return;
      }
      resolve((address as AddressInfo).port);
    });
  });
}

/** POST {"port": port} to the env, retrying until the env accepts it. */
async function registerWithEnv(origin: string, port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ENV_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return;
      lastError = new Error(`register answered HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(REGISTER_DELAY_MS);
  }
  throw lastError instanceof Error ? lastError : new Error('registration with the env failed');
}

/** True once the env answers {"done": true}; any failure just means ask again. */
async function envIsDone(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/done`, {
      signal: AbortSignal.timeout(ENV_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { done?: unknown };
    return body.done === true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const server = createApp();
  const port = await listenEphemeral(server);
  const origin = envOrigin();

  if (origin === '') {
    console.error(`forge listening on port ${port} (no MAKEFUN_ENV_URL: serving until killed)`);
    return;
  }

  await registerWithEnv(origin, port);
  console.error(`forge listening on port ${port}; registered with the env, waiting for done`);

  while (!(await envIsDone(origin))) {
    await sleep(DONE_POLL_DELAY_MS);
  }

  // The suite has finished and written its export: shut down and exit 0.
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
