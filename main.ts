// Entry point: the handshake between this forge and the trial environment.
//
// The conversation is short and strictly ordered. The forge binds a port the
// operating system chooses, tells the environment which port that is, and
// then waits, polling, until the environment reports that the trial has
// finished. Only then does the process shut the server down and leave.
//
//   1. The environment's origin comes from MAKEFUN_ENV_URL. With no origin
//      there is nobody to talk to, so the process gives up right away.
//   2. The server starts on port 0, letting the kernel hand out a free one.
//      Port 8080 is never used here: that port belongs to the environment.
//   3. The chosen port is POSTed to $MAKEFUN_ENV_URL/register. A 200 means
//      the environment took it; a 409 means some other entry registered
//      first, which is fine — this process simply waits like any other.
//      A 400 or 405 means the registration itself is wrong, so the
//      process stops instead of retrying forever. Any other answer, or a
//      connection that fails outright, is retried: the environment may
//      still be coming up.
//   4. GET $MAKEFUN_ENV_URL/done is polled until it answers {"done": true}.
//      The environment answers immediately either way, so each poll is a
//      short request; a failed or slow poll is retried with a growing
//      pause between attempts, and the process never leaves early.
//   5. Once done is true, the server is closed and the process exits 0.
//      Anything that goes wrong along the way exits 1.
//
// Nothing here calls a model or reads any other file: the only import is
// the server this entrypoint exists to run.

import { createApp } from './app.ts';

// One request to the environment may take this long before it is dropped
// and tried again.
const REQUEST_LIMIT_MS = 30_000;
// The pause after a failed attempt starts here and doubles, up to this cap.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

/** The environment's origin, with any trailing slashes trimmed away. */
function readEnvOrigin(): string {
  return (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
}

const envOrigin = readEnvOrigin();
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const pause = (ms: number): Promise<void> => new Promise((wake) => setTimeout(wake, ms));

/** How long to wait after `failures` consecutive failures: doubling, capped. */
function pauseAfter(failures: number): number {
  return Math.min(LONGEST_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(failures, 8));
}

/**
 * Run `attempt` again and again until it hands back a value. Returning
 * `undefined` means "not yet — wait a little and try again"; throwing means
 * the failure is final and the error travels straight to the caller.
 */
async function keepAttempting<T>(attempt: () => Promise<T | undefined>): Promise<T> {
  let failures = 0;
  for (;;) {
    const outcome = await attempt();
    if (outcome !== undefined) return outcome;
    await pause(pauseAfter(failures));
    failures += 1;
  }
}

/**
 * Tell the environment which port the forge bound. A 200 registers us; a
 * 409 means another entry got there first and we wait anyway. A 400 or 405
 * is a contract error and ends the program; anything else is retried.
 */
async function announce(port: number): Promise<void> {
  await keepAttempting(async () => {
    let answer: Response;
    try {
      answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
    } catch {
      // The environment is not reachable yet: wait, then try again.
      return undefined;
    }
    if (answer.status === 200 || answer.status === 409) return true;
    if (answer.status === 400 || answer.status === 405) {
      throw new Error(`register answered HTTP ${answer.status}: ${await answer.text()}`);
    }
    return undefined;
  });
}

/** Poll GET /done until the environment answers {"done": true}. */
async function awaitDone(): Promise<void> {
  await keepAttempting(async () => {
    try {
      const answer = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (!answer.ok) return undefined;
      const payload = (await answer.json()) as { done?: unknown };
      return payload.done === true ? true : undefined;
    } catch {
      // No answer, or a slow one: the trial is not done, so poll again.
      return undefined;
    }
  });
}

/** Bind, register, wait for done, shut down: the whole life of the process. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((ready, failed) => {
    server.once('error', failed);
    server.listen(0, () => ready());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[entry] ${detail}\n`);
  process.exit(1);
}
