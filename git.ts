// Git smart HTTP: pkt-lines, packfiles (read with delta resolution, write plain),
// protocol v2 (ls-refs, fetch) and v0 (upload-pack, receive-pack) over HTTP.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  Forge,
  ZERO_OID,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
} from './store.ts';
import type { GitObject, GitObjectType, Repo } from './store.ts';

export const AGENT = 'core-clone-forge/1.0';

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data' | 'flush' | 'delim'; payload: Buffer };

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(hex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) throw new Error('bad pkt-line length');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, no deltas) from plain objects. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; typeCode: number } {
  let offset = start;
  let byte = buf[offset];
  const typeCode = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  offset += 1;
  while (byte & 0x80) {
    byte = buf[offset];
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { size, next: offset, typeCode };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let offset = start;
  let byte = buf[offset];
  let baseOffset = byte & 0x7f;
  offset += 1;
  while (byte & 0x80) {
    byte = buf[offset];
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    offset += 1;
  }
  return { baseOffset, next: offset };
}

/** Inflate a zlib stream starting at `offset`, returning the data and the offset just past it. */
export function inflateWithLength(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function readDeltaVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buf[at];
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const src = readDeltaVarint(delta, at);
  at = src.next;
  if (src.value !== base.length) throw new Error('delta source size mismatch');
  const dst = readDeltaVarint(delta, at);
  at = dst.next;
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[at] << (8 * i);
          at += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[at] << (8 * i);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      produced += op;
      at += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dst.value || produced !== dst.value) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number | null;
  baseOid: string | null;
}

/** Read a packfile into objects, resolving ofs-delta and ref-delta entries. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (header.typeCode === 6) {
      const ofs = readOfsDeltaBase(pack, offset);
      baseOffset = entryOffset - ofs.baseOffset;
      offset = ofs.next;
    } else if (header.typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateWithLength(pack, offset);
    entries.push({ offset: entryOffset, typeCode: header.typeCode, data: inflated.data, baseOffset, baseOid });
    offset = inflated.next;
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolveEntry = (entry: PackEntry, guard: Set<number>): GitObject => {
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
        if (guard.has(baseEntry.offset)) throw new Error('delta cycle');
        guard.add(baseEntry.offset);
        base = resolveEntry(baseEntry, guard);
      } else {
        base = resolveBase?.(entry.baseOid!);
        if (base === undefined) {
          // The base may be an earlier entry in this same pack, keyed by its id.
          for (const candidate of objects.values()) {
            if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
              base = candidate;
              break;
            }
          }
        }
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    const type = CODE_TYPE[entry.typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
    return { type, data: entry.data };
  };
  for (const entry of entries) {
    const object = resolveEntry(entry, new Set([entry.offset]));
    objects.set(hashObject(object.type, object.data), object);
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

interface FetchPlan {
  /** Objects to send (commits, trees, blobs, tags), in a stable order. */
  objects: GitObject[];
  /** Commits that are shallow boundaries in the result (parents cut off). */
  shallow: string[];
  /** Previously shallow commits that are now fully known. */
  unshallow: string[];
}

/**
 * Plan a fetch: objects reachable from the wants, minus objects reachable from the
 * haves, with an optional depth limit (deepen N: commits within N generations of a
 * want; their trees and blobs included).
 */
/** Add a tree and everything under it (subtrees and blobs) to `out`. */
function addTreeObjects(repo: Repo, out: Set<string>, treeOid: string): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/**
 * Objects the client already holds, from its `have` commits. A commit the client
 * named as a shallow boundary is held itself (with its tree), but its parents are
 * not: a shallow client holds the boundary commit, never the history behind it.
 */
function heldObjects(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const held = new Set<string>();
  const boundaries = new Set(shallowBoundaries);
  const queue: string[] = [...haves];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      held.add(oid);
      addTreeObjects(repo, held, parseCommit(object.data).tree);
      if (!boundaries.has(oid)) {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      held.add(oid);
      queue.push(parseTag(object.data).object);
    } else {
      held.add(oid);
    }
  }
  return held;
}

export function planFetch(forge: Forge, repo: Repo, request: FetchRequest): FetchPlan {
  const haveReachable = heldObjects(repo, request.haves, request.shallowBoundaries);
  // Commit traversal from the wants with depth tracking.
  const includedCommits = new Map<string, number>(); // oid -> distance from a want
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, depth: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (visited.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    visited.add(oid);
    includedCommits.set(oid, depth);
    if (request.depth !== null && depth + 1 >= request.depth) continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!visited.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  // Objects to send: each included commit with its own tree (never its parents:
  // the depth limit cuts the history, so a commit's ancestors must not leak in
  // through a full closure), plus any wanted tag objects, minus what the client
  // already holds.
  const send = new Set<string>();
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') send.add(want);
  }
  for (const commitOid of includedCommits.keys()) {
    send.add(commitOid);
    const object = repo.objects.get(commitOid);
    if (object !== undefined && object.type === 'commit') {
      addTreeObjects(repo, send, parseCommit(object.data).tree);
    }
  }
  for (const oid of haveReachable) send.delete(oid);
  // A shallow boundary is an included commit with a parent that is not included.
  const shallow: string[] = [];
  for (const [oid] of includedCommits) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
  }
  // Unshallow: a boundary the client named that is now an included commit whose
  // parents are all included (or that has no parents).
  const unshallow: string[] = [];
  for (const boundary of request.shallowBoundaries) {
    if (!includedCommits.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => includedCommits.has(parent))) unshallow.push(boundary);
  }
  const objects: GitObject[] = [];
  const ordered = [...send].sort();
  for (const oid of ordered) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

// ---------------------------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export function listRefs(forge: Forge, repo: Repo): RefLine[] {
  const refs: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid !== undefined) {
    refs.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  } else {
    refs.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headTarget, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const peeled = forge.peelToCommit(repo, oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', forge: Forge, repo: Repo): Buffer {
  const refs = listRefs(forge, repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${headTarget} side-band-64k thin-pack ofs-delta multi_ack_detailed shallow no-progress agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0 || (refs.length === 1 && refs[0].name === 'HEAD' && refs[0].unborn)) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      if (ref.name === 'HEAD' && ref.unborn) continue;
      const line = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      first = false;
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

// ---------------------------------------------------------------------------------------------
// Handlers: each returns {status, contentType, body} for the app router to send.
// ---------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8') };
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  forge: Forge,
  repo: Repo | undefined,
  service: 'git-upload-pack' | 'git-receive-pack',
  wantsV2: boolean,
): GitResponse {
  if (repo === undefined) return notFound();
  if (service === 'git-upload-pack' && wantsV2) {
    return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
  }
  return ok(`application/x-${service}-advertisement`, v0Advertisement(service, forge, repo));
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

/** Parse a v2 command request body into the command line and its arguments. */
function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').trim());
  }
  if (!sawDelim && lines.length === 0) return null;
  const commandLine = lines[0] ?? '';
  if (!commandLine.startsWith('command=')) return null;
  return { command: commandLine.slice('command='.length).trim(), args: lines.slice(1) };
}

function lsRefsResponse(forge: Forge, repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const refs = listRefs(forge, repo);
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn === true) {
      const target = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      parts.push(pktLine(`unborn ${ref.name}${target}\n`));
      continue;
    }
    const peeled = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
    const symref = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${peeled}${symref}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchResponse(forge: Forge, repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const arg of args) {
    const line = arg.trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') done = true;
  }
  const plan = planFetch(forge, repo, { wants, haves, shallowBoundaries, depth: Number.isNaN(depth) ? null : depth });
  const parts: Buffer[] = [];
  // Protocol v2: when the client sends "done" it requires a packfile, so the
  // acknowledgments section MUST be omitted from the response.
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
  }
  if (depth !== null || shallowBoundaries.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(forge: Forge, repo: Repo | undefined, body: Buffer, wantsV2: boolean): GitResponse {
  if (repo === undefined) return notFound();
  if (wantsV2) {
    const parsed = parseV2Request(body);
    if (parsed === null) return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n', 'utf8') };
    if (parsed.command === 'ls-refs') {
      return ok('application/x-git-upload-pack-result', lsRefsResponse(forge, repo, parsed.args));
    }
    if (parsed.command === 'fetch') {
      return ok('application/x-git-upload-pack-result', fetchResponse(forge, repo, parsed.args));
    }
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n', 'utf8') };
  }
  // v0: want lines, flush, have lines, done, flush.
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n', 'utf8') };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      wants.push(rest.split(' ')[0]);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  void section;
  const plan = planFetch(forge, repo, { wants, haves, shallowBoundaries, depth: Number.isNaN(depth) ? null : depth });
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(forge: Forge, repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return notFound();
  // Walk the raw buffer pkt-line by pkt-line: commands run up to the first flush,
  // and the pack (if any) starts immediately after that flush packet.
  const commands: PushCommand[] = [];
  let offset = 0;
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    const len = Number.parseInt(hex, 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) break;
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    if (len === 1) {
      offset += 4;
      continue;
    }
    if (offset + len > body.length) break;
    const text = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    offset += len;
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n', 'utf8') };
  }
  // Unpack the pack that follows the command flush, if any.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packStart >= 0 && packStart < body.length) {
    const packBytes = body.subarray(packStart);
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} remote ref does not exist`);
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (newObject === undefined) {
        reportLines.push(`ng ${command.ref} object not found`);
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      const newCommit = forge.peelToCommit(repo, command.newOid);
      if (newCommit === null || !forge.isAncestor(repo, current, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }
  const reportText = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
  const banded = pktLine(Buffer.concat([Buffer.from([1]), reportText]));
  return ok('application/x-git-receive-pack-result', Buffer.concat([banded, pktFlush()]));
}
