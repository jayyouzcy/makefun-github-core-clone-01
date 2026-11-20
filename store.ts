// The forge's in-memory store: repositories, git objects, issues, pull requests.
// Everything is deterministic: timestamps come from MAKEFUN_TRIAL_NOW plus a
// monotonic counter, never from the wall clock, so a replayed trial leaves the
// same state as the live pass.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0'.repeat(40);

/** A deterministic clock: the trial's opening time plus one millisecond per tick. */
export class Clock {
  private next: number;
  constructor() {
    const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = raw === '' ? Number.NaN : Date.parse(raw);
    this.next = Number.isFinite(parsed) ? parsed : Date.now();
  }
  /** The next timestamp, in milliseconds since the epoch. */
  tick(): number {
    const t = this.next;
    this.next += 1;
    return t;
  }
  iso(): string {
    return new Date(this.tick()).toISOString();
  }
  /** Epoch seconds for a git ident line. */
  epochSec(): number {
    return Math.floor(this.tick() / 1000);
  }
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function encodeLooseObject(type: GitObjectType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return zlibDeflate(Buffer.concat([header, data]));
}

export function decodeLooseObject(raw: Buffer): GitObject {
  const inflated = zlibInflate(raw);
  const nul = inflated.indexOf(0);
  const header = inflated.subarray(0, nul).toString('utf8');
  const [type, size] = header.split(' ');
  const data = Buffer.from(inflated.subarray(nul + 1));
  if (data.length !== Number(size)) throw new Error('loose object size mismatch');
  return { type: type as GitObjectType, data };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space);
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${message}`,
    'utf8',
  );
}

/** Global (Relay) ids: opaque base64 of a typed key, stable across reads. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Issues, pull requests, labels
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Set for pull requests; undefined for plain issues. */
  pull?: PullRequest;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextNumber: number;
  nextCommentId: number;
}

export class Forge {
  readonly clock = new Clock();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;

  sequence(): number {
    this.seq += 1;
    return this.seq;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.sequence(),
      createdAt: this.clock.iso(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ---- git objects ---------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** All objects reachable from `roots` (commits, tags, trees, blobs), in discovery order. */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
    return seen;
  }

  /** Peel a tag (possibly nested) to its commit, or the oid itself when it is one. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    const guard = new Set<string>();
    for (;;) {
      if (guard.has(current)) return null;
      guard.add(current);
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
  }

  /** The tip commit of a ref, peeling tags; null when the ref is missing or unborn. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return null;
    return this.peelToCommit(repo, oid);
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The merge-base of two commits: the first common ancestor found walking both sides. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackA.push(parent);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stackB.push(parent);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (tip, then parents depth-first). */
  commitList(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
    }
    return out;
  }

  /** Flatten a tree into path -> {oid, mode}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const full = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, full);
        else out.set(full, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree object from a flat path map, storing every intermediate tree. */
  buildTreeFromMap(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `ref` with `files` applied over the ref's current tree. */
  commitFiles(
    repo: Repo,
    ref: string,
    message: string,
    changes: Array<{ path: string; content: Buffer | null }>,
  ): string {
    const tip = this.refCommit(repo, ref);
    let files = new Map<string, { oid: string; mode: string }>();
    if (tip !== null) {
      const tree = parseCommit(repo.objects.get(tip)!.data).tree;
      files = this.flattenTree(repo, tree);
    }
    for (const change of changes) {
      if (change.content === null) files.delete(change.path);
      else {
        const blob = this.putObject(repo, 'blob', change.content);
        files.set(change.path, { oid: blob, mode: '100644' });
      }
    }
    const treeOid = this.buildTreeFromMap(repo, files);
    const timestamp = this.clock.epochSec();
    const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const commit = buildCommit({
      tree: treeOid,
      parents: tip === null ? [] : [tip],
      message,
      author: ident,
      committer: ident,
      timestamp,
    });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, oid);
    return oid;
  }
}

// ---------------------------------------------------------------------------------------------
// Diffs and merges
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  oldOid: string | null;
  newOid: string | null;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    const oldSet = new Map<string, number>();
    for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const count = oldSet.get(line) ?? 0;
      if (count > 0) {
        oldSet.set(line, count - 1);
        common += 1;
      }
    }
    return { additions: m - common, deletions: n - common };
  }
  // LCS dynamic programming on lines.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: m - common, deletions: n - common };
}

/** The file-level diff between two trees (by path), with line counts. */
export function diffTrees(forge: Forge, repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = forge.flattenTree(repo, baseTree);
  const head = forge.flattenTree(repo, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineDiff(oldText, '');
      out.push({ path, status: 'removed', additions: 0, deletions, changes: deletions, oldOid: b.oid, newOid: null });
    } else if (b === undefined && h !== undefined) {
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineDiff('', newText);
      out.push({ path, status: 'added', additions, deletions: 0, changes: additions, oldOid: null, newOid: h.oid });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ path, status: 'modified', additions, deletions, changes: additions + deletions, oldOid: b.oid, newOid: h.oid });
    }
  }
  return out;
}

/** Three-way merge of head into base, over their merge-base. Returns the merged tree or a conflict. */
export function threeWayMerge(
  forge: Forge,
  repo: Repo,
  baseTip: string,
  headTip: string,
): { treeOid: string; conflict: false } | { conflict: true; paths: string[] } {
  const mergeBase = forge.mergeBase(repo, baseTip, headTip);
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const ancestorTree = mergeBase === null ? '' : parseCommit(repo.objects.get(mergeBase)!.data).tree;
  const baseFiles = forge.flattenTree(repo, baseTree);
  const headFiles = forge.flattenTree(repo, headTree);
  const ancestorFiles = ancestorTree === '' ? new Map() : forge.flattenTree(repo, ancestorTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const a = ancestorFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const aOid = a?.oid ?? null;
    const bOid = b?.oid ?? null;
    const hOid = h?.oid ?? null;
    if (bOid === hOid) {
      if (b !== undefined) merged.set(path, b);
      continue;
    }
    if (aOid === bOid) {
      // Base unchanged since the ancestor: take the head's version.
      if (h !== undefined) merged.set(path, h);
      continue;
    }
    if (aOid === hOid) {
      // Head unchanged since the ancestor: keep the base's version.
      if (b !== undefined) merged.set(path, b);
      continue;
    }
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { conflict: true, paths: conflicts };
  return { treeOid: forge.buildTreeFromMap(repo, merged), conflict: false };
}
