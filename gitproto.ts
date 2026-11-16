// Git smart HTTP: info/refs advertisements and the upload-pack (v2 and v0) and
// receive-pack (v0) POST endpoints, as the suite's client speaks them
// (kit program/env/src/git-client.ts).
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//
// A missing repository is 404 on both services' GET /info/refs. Every update must
// fast-forward; a non-fast-forward push is refused per ref with
// "ng <ref> non-fast-forward" and the ref does not move.

import { decodePktLines, encodePktLine, encodePktLines, hashObject, isObjectId, parseCommit, parseTag, pktDelim, pktFlush, readPack, verifyPackChecksum, writePack, ZERO_OID } from './gitobj.ts';
import { type Repo, type Store } from './store.ts';

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'forge/1.0';

function notFound(): GitResponse {
  return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Refs sorted by name, with peeled tag targets resolved. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      try {
        entry.peeled = parseTag(object.data).object;
      } catch {
        // A tag that does not parse has no peel.
      }
    }
    out.push(entry);
  }
  return out;
}

function uploadCaps(): string {
  return 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0';
}

function receiveCaps(): string {
  return 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';
}

/** The v0 ref advertisement body (with the # service= preamble). */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps() : receiveCaps();
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get('refs/heads/main');
    // HEAD first, carrying the capabilities.
    if (mainTip !== undefined) parts.push(encodePktLine(`${mainTip} HEAD\0${caps}\n`));
    let first = mainTip === undefined;
    for (const ref of refs) {
      if (first) {
        parts.push(encodePktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
        first = false;
      } else {
        parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      }
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body. */
function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow ofs-delta\n', 'object-format=sha1\n', 'flush']);
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, gitProtocolV2: boolean): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocolV2) {
      return { status: 200, headers: { 'content-type': UPLOAD_AD }, body: v2Advertisement() };
    }
    return { status: 200, headers: { 'content-type': UPLOAD_AD }, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, headers: { 'content-type': RECEIVE_AD }, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return notFound();
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
}

/** Split a sideband pack into band-1 pkt-lines (each at most 65520 bytes framed). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const maxData = 65520 - 4 - 1;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return parts;
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) lines.push('unborn HEAD symref-target:refs/heads/main\n');
  } else {
    if (mainTip !== undefined && keep('HEAD')) {
      lines.push(args.symrefs ? `${mainTip} HEAD symref-target:refs/heads/main\n` : `${mainTip} HEAD\n`);
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      const peeled = args.peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
      lines.push(`${ref.oid} ${ref.name}${peeled}\n`);
    }
  }
  return encodePktLines([...lines, 'flush']);
}

function fetchResponse(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow } = store.objectsForFetch(repo, args.wants, args.haves, args.depth);
  // unshallow: an old shallow boundary is unshallowed when the fetch delivered it
  // and every parent of it too (its history is no longer cut off there).
  const computedUnshallow: string[] = [];
  if (args.depth !== undefined && args.shallow.length > 0) {
    const packCommits = new Set<string>();
    for (const object of objects) {
      if (object.type === 'commit') packCommits.add(hashObject('commit', object.data));
    }
    for (const boundaryOid of args.shallow) {
      if (!packCommits.has(boundaryOid)) continue;
      const object = repo.objects.get(boundaryOid);
      if (!object || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.every((p) => packCommits.has(p))) computedUnshallow.push(boundaryOid);
    }
  }
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktDelim());
  if (shallow.length > 0 || computedUnshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of computedUnshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow } = store.objectsForFetch(repo, args.wants, args.haves, args.depth);
  const pack = writePack(objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(store: Store, owner: string, repoName: string, gitProtocolV2: boolean, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let packets;
  try {
    packets = decodePktLines(body).packets;
  } catch (err) {
    return badRequest((err as Error).message);
  }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));

  if (gitProtocolV2) {
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text === 'peel') args.peel = true;
        else if (text === 'symrefs') args.symrefs = true;
        else if (text === 'unborn') args.unborn = true;
        else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
      }
      return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: lsRefsResponse(repo, args) };
    }
    if (command === 'command=fetch') {
      const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
      for (const line of lines.slice(1)) {
        const text = line.trim();
        if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
        else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
        else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) {
          const n = Number.parseInt(text.slice(7).trim(), 10);
          if (Number.isFinite(n)) args.depth = n;
        } else if (text === 'done') args.done = true;
      }
      if (args.wants.length === 0) {
        return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchResponse(store, repo, args) };
      }
      for (const want of args.wants) {
        if (!isObjectId(want) || !repo.objects.has(want)) return badRequest(`want ${want} is not in the repository`);
      }
      return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchResponse(store, repo, args) };
    }
    return badRequest(`unknown command ${JSON.stringify(command)}`);
  }

  // Protocol v0: want lines (first may carry capabilities), shallow/deepen, flush,
  // have lines, done, flush.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      args.wants.push(rest.split(' ')[0]);
    } else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (text === 'done') args.done = true;
  }
  for (const want of args.wants) {
    if (!isObjectId(want) || !repo.objects.has(want)) return badRequest(`want ${want} is not in the repository`);
  }
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT }, body: fetchV0Response(store, repo, args) };
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound();

  let decoded;
  try {
    decoded = decodePktLines(body, { allowTrailing: true });
  } catch (err) {
    return badRequest((err as Error).message);
  }
  const commands: PushCommand[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) return badRequest(`bad command line ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) return badRequest('no commands in the push');

  const packBytes = decoded.trailing;
  const report: string[] = [];
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates) {
    if (packBytes.length === 0) {
      report.push('unpack index-pack failed');
      return receiveResult(report, []);
    }
    if (!verifyPackChecksum(packBytes)) {
      report.push('unpack pack checksum failed');
      return receiveResult(report, []);
    }
    let read;
    try {
      read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
    } catch (err) {
      report.push(`unpack ${(err as Error).message}`);
      return receiveResult(report, []);
    }
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    report.push('unpack ok');
  } else {
    report.push('unpack ok');
  }

  const results: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push(`ng ${command.ref} no such ref`);
      } else if (current !== command.oldOid) {
        results.push(`ng ${command.ref} old value mismatch`);
      } else {
        repo.refs.delete(command.ref);
        results.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push(`ng ${command.ref} already exists`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      results.push(`ng ${command.ref} no such ref`);
    } else if (current !== command.oldOid) {
      results.push(`ng ${command.ref} old value mismatch`);
    } else if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
      results.push(`ng ${command.ref} non-fast-forward`);
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push(`ok ${command.ref}`);
    }
  }
  return receiveResult(report, results);
}

function receiveResult(unpackLines: string[], refLines: string[]): GitResponse {
  const lines = [...unpackLines, ...refLines].map((line) => `${line}\n`);
  const reportBody = encodePktLines(lines);
  const parts: Buffer[] = [];
  const maxData = 65520 - 4 - 1;
  for (let offset = 0; offset < reportBody.length; offset += maxData) {
    const chunk = reportBody.subarray(offset, Math.min(reportBody.length, offset + maxData));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return { status: 200, headers: { 'content-type': RECEIVE_RESULT }, body: Buffer.concat(parts) };
}
