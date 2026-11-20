// Core Clone Forge: GitHub-compatible git forge in one Node process.
// REST v3 (/api/v3), GraphQL v4 (/api/graphql), MCP (/mcp) and git smart HTTP
// (see git.ts), all on one in-memory store (store.ts). No dependencies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Forge,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  ZERO_OID,
  diffTrees,
  globalId,
  parseCommit,
  parseGlobalId,
  parseTree,
  threeWayMerge,
} from './store.ts';
import type { Issue, Label, PullRequest, Repo } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VERSION = '1.0.0';

/** A request-scoped id for the X-GitHub-Request-Id header (non-empty, unique per request). */
let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  /** A Buffer body, a JSON value (stringified), or null for no body. */
  body: Buffer | unknown | null;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers, body };
}

function errorResponse(status: number, message: string): ApiResponse {
  return jsonResponse(status, { message });
}

function notFoundResponse(message = 'Not Found'): ApiResponse {
  return errorResponse(404, message);
}

/** The bearer token the suite presents; empty when unset (local runs). */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authed(req: IncomingMessage): boolean {
  const expected = expectedToken();
  if (expected === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
}

function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const parsed = new URL(url, 'http://entry');
  return { path: parsed.pathname, query: parsed.searchParams };
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', String(VIEWER_ID)), avatar_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open' && issue.pull === undefined).length,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: globalId('Label', label.name), node_id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function mergeableOf(forge: Forge, repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = forge.refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseTip = forge.refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  if (headTip === baseTip) return 'MERGEABLE';
  const merged = threeWayMerge(forge, repo, baseTip, headTip);
  return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const mergeable = mergeableOf(forge, repo, pull);
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeable === 'MERGEABLE',
    mergeable_state: mergeable === 'MERGEABLE' ? 'clean' : mergeable === 'CONFLICTING' ? 'dirty' : 'unknown',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: userJson(), repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: userJson(), repo: repoJson(repo) },
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Domain operations shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------------------------

export function createIssueDomain(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string; labels?: readonly string[] },
): { issue: Issue } | { status: number; message: string } {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') return { status: 422, message: 'title is required' };
  const labels: string[] = [];
  for (const name of input.labels ?? []) {
    if (!repo.labels.has(name)) return { status: 422, message: `Label '${name}' does not exist` };
    labels.push(name);
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = forge.clock.iso();
  const issue: Issue = {
    number,
    title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    createdSeq: forge.sequence(),
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(number, issue);
  return { issue };
}

function branchTip(forge: Forge, repo: Repo, branch: string): string | null {
  const ref = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  return forge.refCommit(repo, ref);
}

function shortBranch(branch: string): string {
  const colon = branch.indexOf(':');
  const name = colon >= 0 ? branch.slice(colon + 1) : branch;
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : name;
}

export function createPullDomain(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: PullRequest } | { status: number; message: string } {
  const headRef = shortBranch(input.head);
  const baseRef = shortBranch(input.base);
  const headTip = branchTip(forge, repo, headRef);
  const baseTip = branchTip(forge, repo, baseRef);
  if (headTip === null) return { status: 422, message: `head branch '${headRef}' does not exist` };
  if (baseTip === null) return { status: 422, message: `base branch '${baseRef}' does not exist` };
  for (const existing of repo.issues.values()) {
    if (existing.pull !== undefined && existing.pull.state === 'open' && existing.pull.headRef === headRef && existing.pull.baseRef === baseRef) {
      return { status: 422, message: 'a pull request already exists for this head and base' };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const now = forge.clock.iso();
  const pull: PullRequest = {
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergeable: 'UNKNOWN',
    headRef,
    baseRef,
    headSha: headTip,
    baseSha: baseTip,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: forge.sequence(),
    createdAt: now,
    updatedAt: now,
  };
  const issue: Issue = {
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [],
    comments: [],
    createdSeq: pull.createdSeq,
    createdAt: now,
    updatedAt: now,
    pull,
  };
  repo.issues.set(number, issue);
  return { pull };
}

export function mergePullDomain(
  forge: Forge,
  repo: Repo,
  pull: PullRequest,
): { sha: string; message: string } | { status: number; message: string } {
  if (pull.state !== 'open') return { status: 405, message: 'pull request is not open' };
  const headTip = forge.refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseTip = forge.refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headTip === null || baseTip === null) return { status: 405, message: 'head or base branch is missing' };
  const merged = threeWayMerge(forge, repo, baseTip, headTip);
  if (merged.conflict) return { status: 405, message: 'merge conflict' };
  const message = `${pull.title} (#${pull.number})`;
  const timestamp = forge.clock.epochSec();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const commit = forge.putObject(
    repo,
    'commit',
    Buffer.from(
      `tree ${merged.treeOid}\nparent ${baseTip}\nauthor ${ident} ${timestamp} +0000\ncommitter ${ident} ${timestamp} +0000\n\n${message}\n`,
      'utf8',
    ),
  );
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.clock.iso();
  pull.mergeCommitSha = commit;
  pull.updatedAt = pull.mergedAt;
  const issue = repo.issues.get(pull.number);
  if (issue !== undefined) {
    issue.state = 'closed';
    issue.updatedAt = pull.mergedAt;
  }
  return { sha: commit, message };
}

export function findRepoById(forge: Forge, id: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

export function findIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':');
  const repo = findRepoById(forge, Number(repoId));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(number));
  if (issue === undefined) return null;
  return { repo, issue };
}

export function findPullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':');
  const repo = findRepoById(forge, Number(repoId));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(number));
  if (issue?.pull === undefined) return null;
  return { repo, pull: issue.pull };
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoFromSegments(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(name) ?? null;
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function pageLink(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, rel: string): string {
  const host = req.headers.host ?? 'localhost';
  const params = new URLSearchParams(query);
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  return `<http://${host}${path}?${params.toString()}>; rel="${rel}"`;
}

function resolveRef(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return forge.refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(ref)) return forge.refCommit(repo, ref);
  if (repo.refs.has(`refs/heads/${ref}`)) return forge.refCommit(repo, `refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return forge.refCommit(repo, `refs/tags/${ref}`);
  if (repo.objects.has(ref)) return forge.peelToCommit(repo, ref);
  return null;
}

/** Handle one REST request. Segments are the path parts after /api/v3. */
function handleRest(
  forge: Forge,
  req: IncomingMessage,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
): ApiResponse {
  const seg = (index: number): string => decodePathSegment(segments[index] ?? '');

  // GET /api/v3/ (root) and /api/v3/meta
  if (segments.length === 0) {
    if (method !== 'GET') return notFoundResponse();
    return jsonResponse(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return notFoundResponse();
    return jsonResponse(200, { installed_version: VERSION, verifiable_password_authentication: false });
  }
  if (segments.length === 1 && seg(0) === 'user') {
    if (method !== 'GET') return notFoundResponse();
    return jsonResponse(200, userJson());
  }
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = parsePagination(query);
      const repos = forge.listRepos();
      const start = (page - 1) * perPage;
      const items = repos.slice(start, start + perPage).map((repo) => repoJson(repo));
      const headers: Record<string, string> = {};
      const links: string[] = [];
      if (start + perPage < repos.length) {
        links.push(pageLink(req, '/api/v3/user/repos', query, page + 1, perPage, 'next'));
      }
      const lastPage = Math.max(1, Math.ceil(repos.length / perPage));
      if (lastPage > 1) links.push(pageLink(req, '/api/v3/user/repos', query, lastPage, perPage, 'last'));
      if (links.length > 0) headers.link = links.join(', ');
      return jsonResponse(200, items, headers);
    }
    if (method === 'POST') {
      if (!isObject(body)) return errorResponse(400, 'Invalid request body');
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return errorResponse(422, 'name is invalid');
      }
      if (forge.getRepo(name) !== undefined) return errorResponse(422, 'Repository already exists');
      const repo = forge.createRepo(
        name,
        body.private === true,
        typeof body.description === 'string' ? body.description : '',
      );
      if (typeof body.default_branch === 'string' && body.default_branch !== '') {
        repo.defaultBranch = body.default_branch;
      }
      return jsonResponse(201, repoJson(repo));
    }
    return notFoundResponse();
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg(0) === 'repos' && segments.length >= 3) {
    const owner = seg(1);
    const repoName = seg(2);
    const repo = repoFromSegments(forge, owner, repoName);
    if (repo === null) return notFoundResponse();
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return jsonResponse(200, repoJson(repo));
      if (method === 'PATCH') {
        if (!isObject(body)) return errorResponse(400, 'Invalid request body');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return jsonResponse(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repoName);
        return { status: 204, body: null };
      }
      return notFoundResponse();
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false }));
        return jsonResponse(200, list);
      }
      if (rest.length === 2 && method === 'GET') {
        const ref = `refs/heads/${decodePathSegment(rest[1])}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFoundResponse();
        return jsonResponse(200, { name: decodePathSegment(rest[1]), commit: { sha: oid }, protected: false });
      }
      return notFoundResponse();
    }

    if (rest[0] === 'commits') {
      if (method !== 'GET') return notFoundResponse();
      const ref = query.get('sha');
      const tip = resolveRef(forge, repo, ref);
      if (tip === null) return jsonResponse(200, []);
      const list = forge.commitList(repo, tip).map((sha) => {
        const object = repo.objects.get(sha)!;
        const view = parseCommit(object.data);
        const message = view.message.replace(/\n+$/, '');
        return {
          sha,
          commit: {
            message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
            tree: { sha: view.tree },
          },
          author: userJson(),
          parents: view.parents.map((parent) => ({ sha: parent })),
        };
      });
      return jsonResponse(200, list);
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (!isObject(body)) return errorResponse(400, 'Invalid request body');
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) return errorResponse(422, 'ref or sha is invalid');
        const object = repo.objects.get(sha);
        if (object === undefined || (object.type !== 'commit' && object.type !== 'tag')) {
          return errorResponse(422, 'sha does not name a commit');
        }
        if (repo.refs.has(ref)) return errorResponse(422, 'ref already exists');
        repo.refs.set(ref, sha);
        return jsonResponse(201, { ref, node_id: globalId('Ref', `${repo.id}:${ref}`), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}`, object: { sha, type: object.type, url: '' } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = decodePathSegment(rest.slice(2).join('/'));
        const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const oid = repo.refs.get(full);
        if (oid === undefined) return notFoundResponse();
        const object = repo.objects.get(oid)!;
        return jsonResponse(200, { ref: full, node_id: globalId('Ref', `${repo.id}:${full}`), url: '', object: { sha: oid, type: object.type, url: '' } });
      }
      return notFoundResponse();
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodePathSegment(part)).join('/');
      if (method === 'PUT') {
        if (!isObject(body)) return errorResponse(400, 'Invalid request body');
        const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return errorResponse(400, 'content is not valid base64');
        }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        if (!repo.refs.has(ref) && repo.refs.size > 0) return notFoundResponse('Branch not found');
        if (!repo.refs.has(ref) && repo.refs.size === 0 && branch !== repo.defaultBranch) {
          return notFoundResponse('Branch not found');
        }
        const tip = forge.refCommit(repo, ref);
        const current = tip === null ? undefined : forge.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree).get(path);
        const isUpdate = current !== undefined;
        if (isUpdate) {
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (sha === '' || sha.toLowerCase() !== current.oid.toLowerCase()) {
            return errorResponse(409, 'sha does not match the current blob');
          }
        }
        const commitSha = forge.commitFiles(repo, ref, message, [{ path, content }]);
        const blobOid = forge.flattenTree(repo, parseCommit(repo.objects.get(commitSha)!.data).tree).get(path)!.oid;
        return jsonResponse(isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'GET') {
        const ref = query.get('ref');
        const tip = resolveRef(forge, repo, ref);
        if (tip === null) return notFoundResponse();
        const tree = parseCommit(repo.objects.get(tip)!.data).tree;
        const files = forge.flattenTree(repo, tree);
        if (path === '') {
          const entries = directoryListing(forge, repo, tree, '');
          return jsonResponse(200, entries);
        }
        const file = files.get(path);
        if (file !== undefined) {
          const data = repo.objects.get(file.oid)!.data;
          return jsonResponse(200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: data.toString('base64'),
            sha: file.oid,
          });
        }
        // A directory: any file under path + '/'.
        const prefix = `${path}/`;
        const childNames = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(prefix)) childNames.add(key.slice(prefix.length).split('/')[0]);
        }
        if (childNames.size === 0) return notFoundResponse();
        const entries: Record<string, unknown>[] = [];
        for (const name of [...childNames].sort()) {
          const full = `${path}/${name}`;
          const direct = files.get(full);
          if (direct !== undefined) {
            entries.push({ type: 'file', name, path: full, sha: direct.oid, size: repo.objects.get(direct.oid)?.data.length ?? 0 });
          } else {
            const subTree = findSubtree(forge, repo, tree, path);
            void subTree;
            entries.push({ type: 'dir', name, path: full, sha: subtreeOid(forge, repo, tree, full) ?? ZERO_OID, size: 0 });
          }
        }
        return jsonResponse(200, entries);
      }
      if (method === 'DELETE') {
        if (!isObject(body)) return errorResponse(400, 'Invalid request body');
        const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const tip = forge.refCommit(repo, ref);
        if (tip === null) return notFoundResponse();
        const current = forge.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree).get(path);
        if (current === undefined) return notFoundResponse();
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (sha !== '' && sha.toLowerCase() !== current.oid.toLowerCase()) {
          return errorResponse(409, 'sha does not match the current blob');
        }
        const commitSha = forge.commitFiles(repo, ref, message, [{ path, content: null }]);
        return jsonResponse(200, { commit: { sha: commitSha, message } });
      }
      return notFoundResponse();
    }

    if (rest[0] === 'labels') {
      if (method === 'GET') return jsonResponse(200, [...repo.labels.values()].map((label) => labelJson(label)));
      if (method === 'POST') {
        if (!isObject(body)) return errorResponse(400, 'Invalid request body');
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return errorResponse(422, 'name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return jsonResponse(201, labelJson(existing));
        const label: Label = {
          name,
          color: typeof body.color === 'string' ? body.color : 'ededed',
          description: typeof body.description === 'string' ? body.description : '',
        };
        repo.labels.set(name, label);
        return jsonResponse(201, labelJson(label));
      }
      return notFoundResponse();
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()].filter((issue) => issue.pull === undefined);
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          const compare = (a: Issue, b: Issue): number => {
            if (sort === 'comments') return a.comments.length - b.comments.length;
            return a.createdSeq - b.createdSeq;
          };
          list.sort(compare);
          if (direction === 'desc') list.reverse();
          return jsonResponse(200, list.map((issue) => issueJson(repo, issue)));
        }
        if (method === 'POST') {
          if (!isObject(body)) return errorResponse(400, 'Invalid request body');
          const result = createIssueDomain(forge, repo, {
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            labels: Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [],
          });
          if ('status' in result) return errorResponse(result.status, result.message);
          return jsonResponse(201, issueJson(repo, result.issue));
        }
        return notFoundResponse();
      }
      const number = Number.parseInt(rest[1], 10);
      const issue = repo.issues.get(number);
      if (issue === undefined || issue.pull !== undefined) return notFoundResponse();
      if (rest.length === 2) {
        if (method === 'GET') return jsonResponse(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          if (!isObject(body)) return errorResponse(400, 'Invalid request body');
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          issue.updatedAt = forge.clock.iso();
          return jsonResponse(200, issueJson(repo, issue));
        }
        return notFoundResponse();
      }
      if (rest[2] === 'comments') {
        if (method === 'GET') {
          return jsonResponse(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        }
        if (method === 'POST') {
          if (!isObject(body)) return errorResponse(400, 'Invalid request body');
          const text = typeof body.body === 'string' ? body.body : '';
          if (text === '') return errorResponse(422, 'body is required');
          const now = forge.clock.iso();
          const comment = { id: repo.nextCommentId, body: text, author: VIEWER_LOGIN, createdAt: now, updatedAt: now };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          return jsonResponse(201, commentJson(repo, issue, comment));
        }
        return notFoundResponse();
      }
      return notFoundResponse();
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const list = [...repo.issues.values()]
            .filter((issue) => issue.pull !== undefined)
            .map((issue) => issue.pull!)
            .filter((pull) => state === 'all' || pull.state === state)
            .sort((a, b) => b.createdSeq - a.createdSeq);
          return jsonResponse(200, list.map((pull) => pullJson(forge, repo, pull)));
        }
        if (method === 'POST') {
          if (!isObject(body)) return errorResponse(400, 'Invalid request body');
          const result = createPullDomain(forge, repo, {
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            head: typeof body.head === 'string' ? body.head : '',
            base: typeof body.base === 'string' ? body.base : repo.defaultBranch,
          });
          if ('status' in result) return errorResponse(result.status, result.message);
          return jsonResponse(201, pullJson(forge, repo, result.pull));
        }
        return notFoundResponse();
      }
      const number = Number.parseInt(rest[1], 10);
      const issue = repo.issues.get(number);
      const pull = issue?.pull;
      if (pull === undefined) return notFoundResponse();
      if (rest.length === 2) {
        if (method === 'GET') return jsonResponse(200, pullJson(forge, repo, pull));
        return notFoundResponse();
      }
      if (rest[2] === 'files' && method === 'GET') {
        const headTip = forge.refCommit(repo, `refs/heads/${pull.headRef}`);
        const baseTip = forge.refCommit(repo, `refs/heads/${pull.baseRef}`);
        if (headTip === null || baseTip === null) return jsonResponse(200, []);
        const base = forge.mergeBase(repo, headTip, baseTip);
        const baseTree = base === null ? '' : parseCommit(repo.objects.get(base)!.data).tree;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const emptyTree = baseTree === '' ? forge.putObject(repo, 'tree', Buffer.from('', 'utf8')) : baseTree;
        void emptyTree;
        const changes = baseTree === '' ? diffTrees(forge, repo, forge.buildTreeFromMap(repo, new Map()), headTree) : diffTrees(forge, repo, baseTree, headTree);
        return jsonResponse(
          200,
          changes.map((change) => ({
            sha: change.newOid ?? change.oldOid ?? ZERO_OID,
            filename: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
          })),
        );
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        const result = mergePullDomain(forge, repo, pull);
        if ('status' in result) return errorResponse(result.status, result.message);
        return jsonResponse(200, { sha: result.sha, merged: true, message: result.message });
      }
      return notFoundResponse();
    }
  }

  return notFoundResponse();
}

function directoryListing(forge: Forge, repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (object === undefined) return [];
  const entries: Record<string, unknown>[] = [];
  for (const entry of parseTree(object.data)) {
    const full = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      entries.push({ type: 'dir', name: entry.name, path: full, sha: entry.oid, size: 0 });
    } else {
      entries.push({ type: 'file', name: entry.name, path: full, sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
    }
  }
  return entries;
}

function findSubtree(forge: Forge, repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function subtreeOid(forge: Forge, repo: Repo, treeOid: string, path: string): string | null {
  return findSubtree(forge, repo, treeOid, path);
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4 (a small parser and executor for the documents gh and github-mcp-server send)
// ---------------------------------------------------------------------------------------------

interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: GqlSelection[];
  fragmentType: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: GqlSelection[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'var'; value: string };

function tokenizeGql(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'var', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      tokens.push({ kind: 'int', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: Token[];
  private pos = 0;
  private variables: Record<string, unknown>;

  constructor(source: string, variables: Record<string, unknown>) {
    this.tokens = tokenizeGql(source);
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token?.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipVariableDefinitions(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const token = this.next()!;
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = this.next()!.value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') {
        name = this.next()!.value;
      }
      this.skipVariableDefinitions();
    }
    const selection = this.parseSelectionSet();
    return { kind, name, selection };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      if (token?.kind === 'punct' && token.value === '...') {
        this.next();
        const onToken = this.peek();
        let fragmentType: string | null = null;
        if (onToken?.kind === 'name' && onToken.value === 'on') {
          this.next();
          const typeToken = this.next();
          if (typeToken?.kind === 'name') fragmentType = typeToken.value;
        }
        const children = this.parseSelectionSet();
        selections.push({ alias: null, name: '__fragment', args: {}, children, fragmentType });
        continue;
      }
      if (token?.kind !== 'name') throw new Error('expected a field name');
      const firstName = this.next()!.value;
      let alias: string | null = null;
      let name = firstName;
      const colon = this.peek();
      if (colon?.kind === 'punct' && colon.value === ':') {
        this.next();
        alias = firstName;
        const nameToken = this.next();
        if (nameToken?.kind !== 'name') throw new Error('expected a field name after an alias');
        name = nameToken.value;
      }
      const args: Record<string, unknown> = {};
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (this.pos < this.tokens.length) {
          const argToken = this.peek();
          if (argToken?.kind === 'punct' && argToken.value === ')') {
            this.next();
            break;
          }
          if (argToken?.kind !== 'name') throw new Error('expected an argument name');
          const argName = this.next()!.value;
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
      }
      let children: GqlSelection[] = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
        children = this.parseSelectionSet();
      }
      selections.push({ alias, name, args, children, fragmentType: null });
    }
    return selections;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token === undefined) throw new Error('unexpected end of document');
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return token.value;
    if (token.kind === 'var') return this.variables[token.value] ?? null;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (this.pos < this.tokens.length) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        list.push(this.parseValue());
      }
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (this.pos < this.tokens.length) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        if (next?.kind !== 'name') throw new Error('expected an object key');
        const key = this.next()!.value;
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      return object;
    }
    throw new Error(`unexpected token ${JSON.stringify(token)}`);
  }
}

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  AddCommentEdge: ['node'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['name', 'target'],
};

const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface GqlContext {
  forge: Forge;
  errors: Array<{ message: string }>;
}

type GqlValue = Record<string, unknown> | null;

function gqlFieldError(ctx: GqlContext, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

function resolveSelections(
  ctx: GqlContext,
  typeName: string,
  value: GqlValue,
  selections: GqlSelection[],
  resolver: (field: string, args: Record<string, unknown>, children: GqlSelection[]) => unknown,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  const known = GQL_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.name === '__fragment') {
      if (selection.fragmentType !== null && selection.fragmentType !== typeName) continue;
      const nested = resolveSelections(ctx, typeName, value, selection.children, resolver);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    if (!known.includes(selection.name)) {
      gqlFieldError(ctx, typeName, selection.name);
      out[selection.alias ?? selection.name] = null;
      continue;
    }
    out[selection.alias ?? selection.name] = resolver(selection.name, selection.args, selection.children);
  }
  return out;
}

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function resolveIssue(ctx: GqlContext, repo: Repo, issue: Issue, selections: GqlSelection[]): Record<string, unknown> {
  return resolveSelections(ctx, 'Issue', issue as unknown as GqlValue, selections, (field, _args, children) => {
    switch (field) {
      case 'id':
        return globalId('Issue', `${repo.id}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueStateGql(issue.state);
      case 'body':
        return issue.body;
      case 'author':
        return resolveSelections(ctx, 'User', userJson() as GqlValue, children, (userField) => (userField === 'login' ? VIEWER_LOGIN : userField === 'id' ? VIEWER_ID : null));
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'comments':
        return { nodes: issue.comments.map((comment) => ({ id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`), body: comment.body })) };
      case 'labels':
        return { nodes: issue.labels.map((name) => ({ name })) };
      default:
        return null;
    }
  })!;
}

function resolvePull(ctx: GqlContext, forge: Forge, repo: Repo, pull: PullRequest, selections: GqlSelection[]): Record<string, unknown> {
  return resolveSelections(ctx, 'PullRequest', pull as unknown as GqlValue, selections, (field, args, children) => {
    switch (field) {
      case 'id':
        return globalId('PullRequest', `${repo.id}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'state':
        return pullStateGql(pull);
      case 'body':
        return pull.body;
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return mergeableOf(forge, repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'author':
        return resolveSelections(ctx, 'User', userJson() as GqlValue, children, (userField) => (userField === 'login' ? VIEWER_LOGIN : userField === 'id' ? VIEWER_ID : null));
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'url':
        return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const headTip = forge.refCommit(repo, `refs/heads/${pull.headRef}`);
        const baseTip = forge.refCommit(repo, `refs/heads/${pull.baseRef}`);
        if (headTip === null || baseTip === null) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 };
        const base = forge.mergeBase(repo, headTip, baseTip);
        const baseTree = base === null ? forge.buildTreeFromMap(repo, new Map()) : parseCommit(repo.objects.get(base)!.data).tree;
        const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
        const changes = diffTrees(forge, repo, baseTree, headTree).slice(0, first);
        return {
          nodes: changes.map((change) => ({ path: change.path, additions: change.additions, deletions: change.deletions, changes: change.changes })),
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: changes.length,
        };
      }
      default:
        return null;
    }
  })!;
}

function resolveRepository(ctx: GqlContext, forge: Forge, repo: Repo, selections: GqlSelection[]): Record<string, unknown> {
  return resolveSelections(ctx, 'Repository', repo as unknown as GqlValue, selections, (field, args, children) => {
    switch (field) {
      case 'id':
        return globalId('Repository', String(repo.id));
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return resolveSelections(ctx, 'User', userJson() as GqlValue, children, (userField) => (userField === 'login' ? VIEWER_LOGIN : userField === 'id' ? VIEWER_ID : null));
      case 'defaultBranchRef': {
        const ref = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (ref === undefined) return null;
        return resolveSelections(ctx, 'Ref', { name: repo.defaultBranch } as unknown as GqlValue, children, (refField) => (refField === 'name' ? repo.defaultBranch : null));
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'url':
        return `/${repo.owner}/${repo.name}`;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.createdAt;
      case 'issue': {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        if (issue === undefined || issue.pull !== undefined) return null;
        return resolveIssue(ctx, repo, issue, children);
      }
      case 'issues': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
        const after = decodeCursor(args.after);
        let list = [...repo.issues.values()].filter((issue) => issue.pull === undefined);
        if (states !== null) {
          const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        const direction = orderBy.direction === 'ASC' ? 1 : -1;
        const field = orderBy.field ?? 'CREATED_AT';
        list.sort((a, b) => {
          let primary = 0;
          if (field === 'COMMENTS') primary = a.comments.length - b.comments.length;
          else primary = a.createdSeq - b.createdSeq;
          if (primary !== 0) return primary * direction;
          return (a.number - b.number) * direction;
        });
        if (after !== null) {
          const index = list.findIndex((issue) => issue.number === after);
          if (index >= 0) list = list.slice(index + 1);
        }
        const page = list.slice(0, first);
        const hasNextPage = list.length > first;
        const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
        const nodeChildren = children.find((child) => child.name === 'nodes')?.children ?? [];
        return {
          nodes: page.map((issue) => resolveIssue(ctx, repo, issue, nodeChildren)),
          edges: page.map((issue) => ({ node: resolveIssue(ctx, repo, issue, nodeChildren), cursor: encodeCursor(issue.number) })),
          pageInfo: { hasNextPage, hasPreviousPage: after !== null, startCursor: page.length > 0 ? encodeCursor(page[0].number) : null, endCursor },
          totalCount: list.length,
        };
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const list = [...repo.issues.values()]
          .filter((issue) => issue.pull !== undefined)
          .map((issue) => issue.pull!)
          .sort((a, b) => b.createdSeq - a.createdSeq)
          .slice(0, first);
        const pullNodeChildren = children.find((child) => child.name === 'nodes')?.children ?? [];
        return {
          nodes: list.map((pull) => resolvePull(ctx, forge, repo, pull, pullNodeChildren)),
          edges: list.map((pull) => ({ node: resolvePull(ctx, forge, repo, pull, pullNodeChildren), cursor: encodeCursor(pull.number) })),
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: list.length,
        };
      }
      case 'pullRequest': {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        if (issue?.pull === undefined) return null;
        return resolvePull(ctx, forge, repo, issue.pull, children);
      }
      default:
        return null;
    }
  })!;
}

function resolveTypeIntrospection(ctx: GqlContext, name: string, selections: GqlSelection[]): Record<string, unknown> | null {
  const fields = GQL_FIELDS[name];
  const enums = GQL_ENUMS[name];
  if (fields === undefined && enums === undefined) return null;
  const value: Record<string, unknown> = { name };
  return resolveSelections(ctx, '__Type', value as GqlValue, selections, (field) => {
    if (field === 'name') return name;
    if (field === 'kind') return enums !== undefined ? 'ENUM' : 'OBJECT';
    if (field === 'fields') return (fields ?? []).map((fieldName) => ({ name: fieldName }));
    if (field === 'enumValues') return (enums ?? []).map((enumName) => ({ name: enumName }));
    if (field === 'description') return null;
    return null;
  });
}

function executeOperation(forge: Forge, operation: GqlOperation): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: GqlContext = { forge, errors: [] };
  const data: Record<string, unknown> = {};
  if (operation.kind === 'query') {
    for (const selection of operation.selection) {
      const key = selection.alias ?? selection.name;
      if (selection.name === 'viewer') {
        data[key] = resolveSelections(ctx, 'User', userJson() as GqlValue, selection.children, (field) => {
          if (field === 'login') return VIEWER_LOGIN;
          if (field === 'id') return VIEWER_ID;
          if (field === 'name') return VIEWER_NAME;
          if (field === 'email') return VIEWER_EMAIL;
          return null;
        });
      } else if (selection.name === 'repository') {
        const owner = selection.args.owner as string | undefined;
        const name = selection.args.name as string | undefined;
        const repo = owner === VIEWER_LOGIN && typeof name === 'string' ? forge.getRepo(name) : undefined;
        data[key] = repo === undefined ? null : resolveRepository(ctx, forge, repo, selection.children);
      } else if (selection.name === 'node') {
        const id = selection.args.id as string | undefined;
        if (typeof id !== 'string') {
          data[key] = null;
          continue;
        }
        const parsed = parseGlobalId(id);
        if (parsed?.kind === 'Repository') {
          const repo = findRepoById(forge, Number(parsed.key));
          data[key] = repo === undefined ? null : resolveRepository(ctx, forge, repo, selection.children);
        } else if (parsed?.kind === 'Issue') {
          const found = findIssueByGlobalId(forge, id);
          data[key] = found === null ? null : resolveIssue(ctx, found.repo, found.issue, selection.children);
        } else if (parsed?.kind === 'PullRequest') {
          const found = findPullByGlobalId(forge, id);
          data[key] = found === null ? null : resolvePull(ctx, forge, found.repo, found.pull, selection.children);
        } else {
          data[key] = null;
        }
      } else if (selection.name === '__type') {
        const name = selection.args.name as string | undefined;
        data[key] = typeof name === 'string' ? resolveTypeIntrospection(ctx, name, selection.children) : null;
      } else {
        gqlFieldError(ctx, 'Query', selection.name);
        data[key] = null;
      }
    }
    return { data, errors: ctx.errors };
  }
  // Mutations.
  for (const selection of operation.selection) {
    const key = selection.alias ?? selection.name;
    const input = (selection.args.input ?? {}) as Record<string, unknown>;
    if (selection.name === 'createIssue') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? findRepoById(forge, Number(parsed.key)) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createIssue: unknown repository' });
        data[key] = null;
        continue;
      }
      const result = createIssueDomain(forge, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
      if ('status' in result) {
        ctx.errors.push({ message: result.message });
        data[key] = null;
        continue;
      }
      data[key] = resolveSelections(ctx, 'CreateIssuePayload', {} as GqlValue, selection.children, (field) => {
        if (field === 'issue') {
          return resolveSelections(ctx, 'Issue', result.issue as unknown as GqlValue, selection.children[0]?.children ?? [], (issueField) => {
            if (issueField === 'id') return globalId('Issue', `${repo.id}:${result.issue.number}`);
            if (issueField === 'number') return result.issue.number;
            return null;
          });
        }
        return null;
      });
      // The payload resolver above needs the issue's own selection set, not the
      // payload's children; rebuild it directly for correctness.
      const issueSel = selection.children.find((child) => child.name === 'issue');
      data[key] = { issue: issueSel === undefined ? { number: result.issue.number, id: globalId('Issue', `${repo.id}:${result.issue.number}`) } : resolveIssue(ctx, repo, result.issue, issueSel.children) };
    } else if (selection.name === 'closeIssue') {
      const found = findIssueByGlobalId(forge, String(input.issueId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'closeIssue: unknown issue' });
        data[key] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = forge.clock.iso();
      const issueSel = selection.children.find((child) => child.name === 'issue');
      data[key] = { issue: issueSel === undefined ? { number: found.issue.number, id: globalId('Issue', `${found.repo.id}:${found.issue.number}`), state: 'CLOSED' } : resolveIssue(ctx, found.repo, found.issue, issueSel.children) };
    } else if (selection.name === 'createPullRequest') {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? findRepoById(forge, Number(parsed.key)) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'createPullRequest: unknown repository' });
        data[key] = null;
        continue;
      }
      const result = createPullDomain(forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('status' in result) {
        ctx.errors.push({ message: result.message });
        data[key] = null;
        continue;
      }
      const pullSel = selection.children.find((child) => child.name === 'pullRequest');
      data[key] = { pullRequest: pullSel === undefined ? { number: result.pull.number, id: globalId('PullRequest', `${repo.id}:${result.pull.number}`), state: 'OPEN', headRefName: result.pull.headRef, baseRefName: result.pull.baseRef } : resolvePull(ctx, forge, repo, result.pull, pullSel.children) };
    } else if (selection.name === 'mergePullRequest') {
      const found = findPullByGlobalId(forge, String(input.pullRequestId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'mergePullRequest: unknown pull request' });
        data[key] = null;
        continue;
      }
      const result = mergePullDomain(forge, found.repo, found.pull);
      if ('status' in result) {
        ctx.errors.push({ message: result.message });
        data[key] = null;
        continue;
      }
      const pullSel = selection.children.find((child) => child.name === 'pullRequest');
      data[key] = { pullRequest: pullSel === undefined ? { number: found.pull.number, merged: true, state: 'CLOSED' } : resolvePull(ctx, forge, found.repo, found.pull, pullSel.children) };
    } else if (selection.name === 'addComment') {
      const found = findIssueByGlobalId(forge, String(input.subjectId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'addComment: unknown subject' });
        data[key] = null;
        continue;
      }
      const now = forge.clock.iso();
      const comment = { id: found.repo.nextCommentId, body: String(input.body ?? ''), author: VIEWER_LOGIN, createdAt: now, updatedAt: now };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      data[key] = { commentEdge: { node: { id: globalId('IssueComment', `${found.repo.id}:${found.issue.number}:${comment.id}`), body: comment.body } } };
    } else {
      gqlFieldError(ctx, 'Mutation', selection.name);
      data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}

function handleGraphQL(forge: Forge, body: unknown): ApiResponse {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isObject(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'a query document is required' }] };
    }
    const variables = isObject(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    let operation: GqlOperation;
    try {
      operation = new GqlParser(entry.query, variables).parseOperation();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'could not parse the query' }] };
    }
    const result = executeOperation(forge, operation);
    const out: Record<string, unknown> = { data: result.data };
    if (result.errors.length > 0) out.errors = result.errors;
    return out;
  };
  if (Array.isArray(body)) {
    return jsonResponse(200, body.map((entry) => runOne(entry)));
  }
  return jsonResponse(200, runOne(body));
}

// ---------------------------------------------------------------------------------------------
// MCP (Model Context Protocol, streamable HTTP, revision 2026-07-28)
// ---------------------------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: 'core-clone-forge', version: VERSION };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpToolResult(result: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError,
  };
}

function executeMcpTool(forge: Forge, name: string, args: Record<string, unknown>): { result: unknown; isError: boolean } {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repoOf = (): Repo | null => {
    if (owner !== '' && owner !== VIEWER_LOGIN) return null;
    return repoName === '' ? null : (forge.getRepo(repoName) ?? null);
  };
  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') return { result: { error: 'name is required' }, isError: true };
      const existing = forge.getRepo(repoNameArg);
      if (existing !== undefined) return { result: repoJson(existing), isError: false };
      const repo = forge.createRepo(repoNameArg, args.private === true, typeof args.description === 'string' ? args.description : '');
      return { result: repoJson(repo), isError: false };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return { result: { error: 'repository not found' }, isError: true };
      return { result: repoJson(repo), isError: false };
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return { result: { error: 'repository not found' }, isError: true };
      const result = createIssueDomain(forge, repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('status' in result) return { result: { error: result.message }, isError: true };
      return { result: issueJson(repo, result.issue), isError: false };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return { result: { error: 'repository not found' }, isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => issue.pull === undefined)
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return { result: { issues: list }, isError: false };
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return { result: { error: 'repository not found' }, isError: true };
      const result = createPullDomain(forge, repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head: typeof args.head === 'string' ? args.head : '',
        base: typeof args.base === 'string' ? args.base : repo.defaultBranch,
      });
      if ('status' in result) return { result: { error: result.message }, isError: true };
      return { result: pullJson(forge, repo, result.pull), isError: false };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return { result: { error: 'repository not found' }, isError: true };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = repo.issues.get(number)?.pull;
      if (pull === undefined) return { result: { error: 'pull request not found' }, isError: true };
      const result = mergePullDomain(forge, repo, pull);
      if ('status' in result) return { result: { error: result.message }, isError: true };
      return { result: pullJson(forge, repo, pull), isError: false };
    }
    default:
      return { result: { error: `unknown tool ${name}` }, isError: true };
  }
}

function handleMcp(forge: Forge, body: unknown, rawBody: Buffer): ApiResponse {
  // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
  if (body === undefined) {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  void rawBody;
  if (!isObject(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isObject(body.params) ? (body.params as Record<string, unknown>) : {};
  const rpcResult = (result: unknown): ApiResponse => jsonResponse(200, { jsonrpc: '2.0', id, result });
  const rpcError = (code: number, message: string): ApiResponse =>
    jsonResponse(200, { jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'server/discover') {
    return rpcResult({
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return rpcResult({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'tools/list') {
    return rpcResult({ tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isObject(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
    if (tool === undefined) return rpcError(-32601, `Method not found: ${toolName}`);
    const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
    if (missing.length > 0) {
      return rpcResult(mcpToolResult({ error: `missing required argument(s): ${missing.join(', ')}` }, true));
    }
    const { result, isError } = executeMcpTool(forge, toolName, args);
    return rpcResult(mcpToolResult(result, isError));
  }
  if (method === 'ping') {
    return rpcResult({});
  }
  return rpcError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------------------------

function sendResponse(res: ServerResponse, response: ApiResponse): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId(), ...(response.headers ?? {}) };
  if (response.body === null) {
    res.writeHead(response.status, headers);
    res.end();
    return;
  }
  if (Buffer.isBuffer(response.body)) {
    res.writeHead(response.status, { 'content-length': response.body.length, ...headers });
    res.end(response.body);
    return;
  }
  const text = `${JSON.stringify(response.body)}\n`;
  res.writeHead(response.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendGitResponse(res: ServerResponse, response: GitResponse): void {
  res.writeHead(response.status, {
    'content-type': response.contentType,
    'content-length': response.body.length,
    'x-github-request-id': requestId(),
  });
  res.end(response.body);
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const { path, query } = parseQuery(req.url ?? '/');
    const method = req.method ?? 'GET';
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        if (tooLarge) {
          sendResponse(res, errorResponse(413, 'Request body too large'));
          return;
        }
        const rawBody = Buffer.concat(chunks);

        // The boot probe takes no auth.
        if (method === 'GET' && path === '/healthz') {
          sendResponse(res, jsonResponse(200, { ok: true }));
          return;
        }

        const isGitRoute = /\.git\//.test(path) || path.endsWith('.git');
        const needsAuth =
          path === '/api/v3' ||
          path.startsWith('/api/v3/') ||
          path === '/api/graphql' ||
          path === '/mcp' ||
          isGitRoute;
        if (needsAuth && !authed(req)) {
          sendResponse(res, errorResponse(401, 'Requires authentication'));
          return;
        }

        // Git smart HTTP.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodePathSegment(gitMatch[1]);
          const repoName = decodePathSegment(gitMatch[2]);
          const suffix = gitMatch[3];
          const repo = owner === VIEWER_LOGIN ? forge.getRepo(repoName) : undefined;
          if (suffix === 'info/refs' && method === 'GET') {
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendResponse(res, errorResponse(400, 'service is required'));
              return;
            }
            const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
            sendGitResponse(res, handleInfoRefs(forge, repo, service, wantsV2));
            return;
          }
          if (suffix === 'git-upload-pack' && method === 'POST') {
            const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            if (repo === undefined) {
              sendGitResponse(res, handleUploadPack(forge, undefined, rawBody, wantsV2));
              return;
            }
            sendGitResponse(res, handleUploadPack(forge, repo, rawBody, wantsV2));
            return;
          }
          if (suffix === 'git-receive-pack' && method === 'POST') {
            sendGitResponse(res, handleReceivePack(forge, repo, rawBody));
            return;
          }
          sendResponse(res, notFoundResponse());
          return;
        }

        // JSON APIs: parse the body when one is present.
        let parsedBody: unknown = undefined;
        let bodyIsJson = false;
        if (rawBody.length > 0 && (path.startsWith('/api/v3') || path === '/api/graphql' || path === '/mcp')) {
          bodyIsJson = true;
          try {
            parsedBody = JSON.parse(rawBody.toString('utf8'));
          } catch {
            if (path === '/mcp') {
              sendResponse(res, handleMcp(forge, undefined, rawBody));
              return;
            }
            sendResponse(res, errorResponse(400, 'Problems parsing JSON'));
            return;
          }
        }
        void bodyIsJson;

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((part) => part !== '');
          sendResponse(res, handleRest(forge, req, method, segments, query, parsedBody));
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          sendResponse(res, handleGraphQL(forge, parsedBody));
          return;
        }
        if (path === '/mcp' && method === 'POST') {
          sendResponse(res, handleMcp(forge, parsedBody, rawBody));
          return;
        }
        sendResponse(res, notFoundResponse());
      } catch (err) {
        process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        try {
          sendResponse(res, errorResponse(500, 'Internal Server Error'));
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    });
  });
}
