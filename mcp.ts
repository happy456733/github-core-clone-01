// Model Context Protocol at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision
// 2026-07-28 (the modern era: `server/discover`, no handshake, no session). The
// legacy `initialize` handshake is answered too, so a pre-discover client can
// still connect. Tools act on the same store as REST, so a repository or issue
// created over MCP reads back over /api/v3 as the same object.

import { globalId, VIEWER_LOGIN, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
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
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.stamp(repo.createdSeq),
    updated_at: store.stamp(repo.createdSeq),
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name })),
    user: { login: issue.user },
    created_at: store.stamp(issue.createdSeq),
    updated_at: store.stamp(issue.updatedSeq),
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: store.refTip(repo, `refs/heads/${pr.headRef}`) ?? pr.headSha },
    base: { ref: pr.baseRef, sha: store.refTip(repo, `refs/heads/${pr.baseRef}`) ?? pr.baseSha },
    merged: pr.merged,
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    created_at: store.stamp(pr.createdSeq),
  };
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const owner = typeof args.owner === 'string' ? args.owner : typeof args.full_name === 'string' ? String(args.full_name).split('/')[0] : '';
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.full_name === 'string' ? String(args.full_name).split('/')[1] ?? '' : '';

  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name.trim() : '';
    if (repoNameArg === '') return errorResult('create_repo requires a name.');
    if (store.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) return errorResult(`Repository ${repoNameArg} already exists.`);
    const repo = store.createRepo(repoNameArg, {
      private: args.private === true,
      description: typeof args.description === 'string' ? args.description : '',
    });
    return textResult(repoJson(store, repo));
  }

  if (name === 'list_repos') {
    return textResult({ repositories: store.listViewerRepos().map((r) => repoJson(store, r)) });
  }

  if (name === 'get_repo') {
    if (owner === '' || repoName === '') return errorResult('get_repo requires owner and repo.');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found.`);
    return textResult(repoJson(store, repo));
  }

  if (name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    if (owner === '' || repoName === '' || title === '') return errorResult('create_issue requires owner, repo and title.');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const seq = store.nextSeq();
    const issue: Issue = {
      id: store.nextObjectId(),
      number: repo.nextNumber,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return textResult(issueJson(store, repo, issue));
  }

  if (name === 'list_issues') {
    if (owner === '' || repoName === '') return errorResult('list_issues requires owner and repo.');
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    let list = [...repo.issues];
    if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.createdSeq - b.createdSeq);
    return textResult({ issues: list.map((i) => issueJson(store, repo, i)) });
  }

  if (name === 'create_pull_request') {
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
      return errorResult('create_pull_request requires owner, repo, title, head and base.');
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined || baseTip === undefined) return errorResult('Head or base branch does not exist.');
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (existing) return errorResult('A pull request already exists for this head and base.');
    const seq = store.nextSeq();
    const pr: PullRequest = {
      id: store.nextObjectId(),
      number: repo.nextNumber,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.nextNumber += 1;
    repo.pulls.push(pr);
    return textResult(pullJson(store, repo, pr));
  }

  if (name === 'merge_pull_request') {
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
    if (owner === '' || repoName === '' || !Number.isInteger(pullNumber)) {
      return errorResult('merge_pull_request requires owner, repo and pull_number.');
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) return errorResult(`Repository ${owner}/${repoName} not found.`);
    const pr = repo.pulls.find((p) => p.number === pullNumber);
    if (pr === undefined) return errorResult(`Pull request #${pullNumber} not found.`);
    if (pr.merged) return textResult({ ...pullJson(store, repo, pr), merged: true });
    const sha = store.squashMerge(repo, pr);
    if (sha === null) return errorResult('Merge conflict.');
    const seq = store.nextSeq();
    pr.merged = true;
    pr.state = 'closed';
    pr.mergeCommitSha = sha;
    pr.mergedAt = store.stamp(seq);
    pr.updatedSeq = seq;
    return textResult({ ...pullJson(store, repo, pr), merged: true, sha });
  }

  return errorResult(`Unknown tool: ${name}`);
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

/** Handle one POST /mcp body (the raw text; a non-JSON body is a -32700 parse error). */
export function handleMcp(store: Store, bodyText: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // A notification (no id) is answered with 202 and no body.
  if (request.id === undefined) {
    return { status: 202, headers: {}, body: '' };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (name === '' || !TOOLS.some((t) => t.name === name)) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const result = callTool(store, name, args);
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
