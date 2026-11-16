// The forge's HTTP surface: one server, one store, four surfaces.
//
//   GET  /healthz                       the env's boot probe (no auth)
//   GET|POST|... /api/v3/*              REST v3 (Bearer auth)
//   POST /api/graphql                   GraphQL v4 (Bearer auth)
//   POST|DELETE /mcp                    MCP over streamable HTTP (Bearer auth)
//   /{owner}/{repo}.git/info/refs       git smart HTTP advertisement
//   /{owner}/{repo}.git/git-upload-pack  git fetch/clone (protocol v0 and v2)
//   /{owner}/{repo}.git/git-receive-pack git push (protocol v0)
//
// Every response carries a deterministic X-GitHub-Request-Id and JSON bodies are
// always JSON (never HTML). A handler that throws becomes a 500 JSON reply; the
// server itself never crashes on a bad request.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { createStore } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** The path and query of a request URL, or '/' when it does not parse. */
function parseUrl(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

/** Read the request body (binary for git, text/JSON elsewhere); rejects past the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The Bearer token the suite sends must equal $MAKEFUN_SHOP_TOKEN when the env
 * sets one. When it is unset (a local smoke test), any Bearer token is accepted
 * — the token is opaque and encodes nothing, so the forge answers for whichever
 * token it is given.
 */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice(7).trim() === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return header.slice(7).trim() === expected;
}

/** Parse a body buffer as JSON; `undefined` means no body, `null` means malformed. */
function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = createStore();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
      const url = parseUrl(req);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}. No auth here.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, baseHeaders);
        return;
      }

      // MCP session close: 204, no body. Auth still applies.
      if (path === '/mcp' && method === 'DELETE') {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
          return;
        }
        res.writeHead(204, { ...baseHeaders });
        res.end();
        return;
      }

      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      const isApi = path === '/api/v3' || path.startsWith('/api/v3/');
      const isGraphql = path === '/api/graphql';
      const isMcp = path === '/mcp';

      if (!isApi && !isGraphql && !isMcp && gitMatch === null) {
        sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
        return;
      }

      // Auth on every API surface, including git.
      if (!authorized(req)) {
        sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'Request body too large' }, baseHeaders);
        return;
      }

      try {
        if (isApi) {
          const segments = path.split('/').filter((s) => s !== '');
          const apiSegments = segments.slice(2);
          const parsed = method === 'GET' ? undefined : parseJsonBody(body);
          if (parsed === null) {
            sendJson(res, 400, { message: 'Malformed JSON body' }, baseHeaders);
            return;
          }
          const result = handleRest(store, method, apiSegments, url.searchParams, parsed ?? null, req.headers.host ?? '');
          sendJson(res, result.status, result.body, { ...baseHeaders, ...result.headers });
          return;
        }

        if (isGraphql) {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          const parsed = parseJsonBody(body);
          if (parsed === null) {
            sendJson(res, 400, { message: 'Malformed JSON body' }, baseHeaders);
            return;
          }
          const result = handleGraphQL(store, parsed);
          sendJson(res, result.status, result.body, baseHeaders);
          return;
        }

        if (isMcp) {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
            return;
          }
          const result = handleMcp(store, body.toString('utf8'));
          sendRaw(res, result.status, Buffer.from(result.body, 'utf8'), { ...baseHeaders, ...result.headers });
          return;
        }

        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const service = gitMatch[3];
          const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (service === 'info/refs') {
            const result = handleInfoRefs(store, owner, repoName, url.searchParams.get('service') ?? '', v2);
            sendRaw(res, result.status, result.body, { ...baseHeaders, ...result.headers });
            return;
          }
          if (service === 'git-upload-pack') {
            const result = handleUploadPack(store, owner, repoName, v2, body);
            sendRaw(res, result.status, result.body, { ...baseHeaders, ...result.headers });
            return;
          }
          const result = handleReceivePack(store, owner, repoName, body);
          sendRaw(res, result.status, result.body, { ...baseHeaders, ...result.headers });
          return;
        }
      } catch (err) {
        process.stderr.write(`[app] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
        sendJson(res, 500, { message: 'Internal Server Error' }, baseHeaders);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
    })().catch((err: unknown) => {
      process.stderr.write(`[app] request error: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': JSON_TYPE });
        }
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } catch {
        // The socket is gone; nothing left to do.
      }
    });
  });
}
