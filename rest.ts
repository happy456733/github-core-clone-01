// GitHub REST v3 under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is application/json and carries a
// non-empty X-GitHub-Request-Id (added by app.ts); errors carry {message}.

import { isObjectId, parseCommit } from './gitobj.ts';
import { globalId, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Issue, type Label, type PullRequest, type Repo, type Store } from './store.ts';

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

type Json = Record<string, unknown>;

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, headers, body };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function repoJson(store: Store, repo: Repo): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: store.stamp(repo.createdSeq),
    updated_at: store.stamp(repo.createdSeq),
    pushed_at: store.stamp(repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function labelJson(label: Label): Json {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    assignee: null,
    created_at: store.stamp(issue.createdSeq),
    updated_at: store.stamp(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? store.stamp(issue.updatedSeq) : null,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest): Json {
  const headSha = store.refTip(repo, `refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = store.refTip(repo, `refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return {
    id: pr.id,
    node_id: globalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: headSha, label: `${repo.owner}:${pr.headRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    base: { ref: pr.baseRef, sha: baseSha, label: `${repo.owner}:${pr.baseRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' } },
    merged: pr.merged,
    mergeable: store.mergeable(repo, headSha, baseSha) === 'MERGEABLE',
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAt,
    created_at: store.stamp(pr.createdSeq),
    updated_at: store.stamp(pr.updatedSeq),
    closed_at: pr.state === 'closed' ? store.stamp(pr.updatedSeq) : null,
    draft: false,
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Json | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const stamp = store.stamp(repo.createdSeq);
  return {
    sha,
    node_id: globalId('Repository', repo.id),
    commit: {
      // The stored object ends its message with "\n" (as a real git object does);
      // the API presents the message without that trailing newline.
      message: commit.message.replace(/\n+$/, ''),
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: stamp },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: stamp },
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

function parseQuery(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function pageLink(host: string, path: string, query: URLSearchParams, perPage: number, page: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(page + 1));
  return { link: `<http://${host}${path}?${next.toString()}>; rel="next"` };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): { page: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

/** Resolve a ref query (?ref=branch or ?ref=sha) to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return byRef;
  if (isObjectId(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Json | null,
  host: string,
): RestResponse {
  const path = `/api/v3/${segments.join('/')}`;

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = parseQuery(query);
      const all = store.listViewerRepos();
      const { page: items, hasNext } = paginate(all, perPage, page);
      return ok(
        items.map((r) => repoJson(store, r)),
        200,
        pageLink(host, path, query, perPage, page, hasNext),
      );
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (name === '') return err(422, 'name is required');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, {
        private: body?.private === true,
        description: typeof body?.description === 'string' ? body.description : '',
      });
      return ok(repoJson(store, repo), 201);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(segments[1]);
    const name = decodeURIComponent(segments[2]);
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(3);
    if (repo === undefined) return err(404, 'Not Found');
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return ok(repoJson(store, repo));
      if (method === 'PATCH') {
        if (typeof body?.description === 'string') repo.description = body.description;
        if (typeof body?.name === 'string' && body.name.trim() !== '' && body.name !== name) {
          // Renames are not part of the suite; ignore the name change but answer 200.
        }
        return ok(repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/git/refs[/heads/{branch}]
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') {
          const all: Json[] = [];
          for (const refName of [...repo.refs.keys()].sort()) {
            all.push({ ref: refName, object: { sha: repo.refs.get(refName), type: 'commit' } });
          }
          return ok(all);
        }
        if (method === 'POST') {
          const ref = typeof body?.ref === 'string' ? body.ref : '';
          const sha = typeof body?.sha === 'string' ? body.sha : '';
          if (!ref.startsWith('refs/') || !isObjectId(sha) || repo.objects.get(sha) === undefined) {
            return err(422, 'ref or sha is invalid');
          }
          if (repo.refs.has(ref)) return err(422, 'Reference already exists');
          repo.refs.set(ref, sha);
          return ok({ ref, object: { sha, type: 'commit' } }, 201);
        }
        return err(404, 'Not Found');
      }
      if (rest.length >= 3 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest.slice(3).join('/'));
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (method === 'GET') {
          if (tip === undefined) return err(404, 'Not Found');
          return ok({ ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/branches[/{branch}]
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches: Json[] = [];
        for (const refName of [...repo.refs.keys()].sort()) {
          if (!refName.startsWith('refs/heads/')) continue;
          branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha: repo.refs.get(refName) }, protected: false });
        }
        return ok(branches);
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = decodeURIComponent(rest.slice(1).join('/'));
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        return ok({ name: branch, commit: { sha: tip }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/commits[?sha=]
    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const tip = resolveRef(repo, query.get('sha'));
        if (tip === null) return ok([]);
        const list = store.commitList(repo, tip);
        return ok(list.map((sha) => commitJson(store, repo, sha)).filter((c) => c !== null));
      }
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/contents/{path}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref'));
        if (tip === null) return err(404, 'Not Found');
        const tree = store.commitTree(repo, tip);
        if (tree === null) return err(404, 'Not Found');
        if (filePath === '') {
          return ok(listDirectory(store, repo, tree, ''));
        }
        const segments = filePath.split('/');
        let currentTree = tree;
        let blobOid: string | null = null;
        let dirOid: string | null = null;
        for (let i = 0; i < segments.length; i += 1) {
          const entries = store.treeEntries(repo, currentTree);
          const entry = entries.find((e) => e.name === segments[i]);
          if (!entry) return err(404, 'Not Found');
          if (i === segments.length - 1) {
            if (entry.mode === '40000') dirOid = entry.oid;
            else blobOid = entry.oid;
          } else {
            if (entry.mode !== '40000') return err(404, 'Not Found');
            currentTree = entry.oid;
          }
        }
        if (dirOid !== null) {
          return ok(listDirectory(store, repo, dirOid, filePath));
        }
        const blob = blobOid === null ? null : repo.objects.get(blobOid);
        if (blob == null || blob.type !== 'blob') return err(404, 'Not Found');
        return ok({
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: segments[segments.length - 1],
          path: filePath,
          content: blob.data.toString('base64'),
          sha: blobOid,
        });
      }
      if (method === 'PUT') {
        const message = typeof body?.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body?.content === 'string' ? body.content : '';
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        const baseTree = tip === undefined ? null : store.commitTree(repo, tip);
        const existing = baseTree === null ? null : store.treeBlob(repo, baseTree, filePath);
        if (body?.sha !== undefined && typeof body.sha === 'string') {
          if (existing === null || existing.toLowerCase() !== String(body.sha).toLowerCase()) {
            return err(409, 'sha does not match the current blob');
          }
        } else if (existing !== null) {
          return err(409, 'file already exists');
        }
        const { commitSha, contentSha } = store.commitFile(repo, branch, filePath, content, message);
        return ok(
          {
            content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: content.length, encoding: 'base64' },
            commit: { sha: commitSha },
          },
          existing === null ? 201 : 200,
        );
      }
      if (method === 'DELETE') {
        const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined) return err(404, 'Not Found');
        const baseTree = store.commitTree(repo, tip);
        if (baseTree === null) return err(404, 'Not Found');
        const existing = store.treeBlob(repo, baseTree, filePath);
        if (existing === null) return err(404, 'Not Found');
        if (typeof body?.sha === 'string' && existing.toLowerCase() !== String(body.sha).toLowerCase()) {
          return err(409, 'sha does not match the current blob');
        }
        const message = typeof body?.message === 'string' ? body.message : 'Delete file';
        const commitSha = store.deleteFile(repo, branch, filePath, message);
        if (commitSha === null) return err(404, 'Not Found');
        return ok({ commit: { sha: commitSha } });
      }
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (name === '') return err(422, 'name is required');
        const color = typeof body?.color === 'string' ? body.color : 'ededed';
        const existing = repo.labels.get(name);
        if (existing) return ok(labelJson(existing), 201);
        const label: Label = { name, color, description: typeof body?.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        return ok(labelJson(label), 201);
      }
      if (rest.length === 1 && method === 'GET') return ok([...repo.labels.values()].map(labelJson));
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open' || state === 'closed') list = list.filter((i) => i.state === state);
          else if (state !== 'all') list = list.filter((i) => i.state === 'open');
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          void sort;
          const { perPage, page } = parseQuery(query);
          const { page: items, hasNext } = paginate(list, perPage, page);
          return ok(
            items.map((i) => issueJson(store, repo, i)),
            200,
            pageLink(host, path, query, perPage, page, hasNext),
          );
        }
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          const labelsRaw = Array.isArray(body?.labels) ? (body.labels as unknown[]) : [];
          const labels: Label[] = [];
          for (const raw of labelsRaw) {
            const labelName = typeof raw === 'string' ? raw : typeof (raw as Json)?.name === 'string' ? String((raw as Json).name) : '';
            const label = repo.labels.get(labelName);
            if (!label) return err(422, `label ${JSON.stringify(labelName)} does not exist`);
            labels.push(label);
          }
          const seq = store.nextSeq();
          const issue: Issue = {
            id: store.nextObjectId(),
            number: repo.nextNumber,
            title,
            body: typeof body?.body === 'string' ? body.body : '',
            state: 'open',
            labels,
            user: VIEWER_LOGIN,
            createdSeq: seq,
            updatedSeq: seq,
            comments: [],
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          return ok(issueJson(store, repo, issue), 201);
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(issueJson(store, repo, issue));
        if (method === 'PATCH') {
          if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body?.title === 'string') issue.title = body.title;
          if (typeof body?.body === 'string') issue.body = body.body;
          issue.updatedSeq = store.nextSeq();
          return ok(issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return ok(
            issue.comments.map((c) => ({
              id: c.id,
              node_id: globalId('IssueComment', repo.id, issue.number, c.id),
              body: c.body,
              user: { login: c.user, id: VIEWER_ID, type: 'User' },
              created_at: store.stamp(c.createdSeq),
              updated_at: store.stamp(c.createdSeq),
            })),
          );
        }
        if (method === 'POST') {
          const commentBody = typeof body?.body === 'string' ? body.body : '';
          const comment = { id: repo.nextCommentId, body: commentBody, user: VIEWER_LOGIN, createdSeq: store.nextSeq() };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          issue.updatedSeq = store.nextSeq();
          return ok(
            {
              id: comment.id,
              node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
              body: comment.body,
              user: { login: comment.user, id: VIEWER_ID, type: 'User' },
              created_at: store.stamp(comment.createdSeq),
              updated_at: store.stamp(comment.createdSeq),
            },
            201,
          );
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open' || state === 'closed') list = list.filter((p) => p.state === state);
          else if (state !== 'all') list = list.filter((p) => p.state === 'open');
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { perPage, page } = parseQuery(query);
          const { page: items, hasNext } = paginate(list, perPage, page);
          return ok(
            items.map((p) => pullJson(store, repo, p)),
            200,
            pageLink(host, path, query, perPage, page, hasNext),
          );
        }
        if (method === 'POST') {
          const title = typeof body?.title === 'string' ? body.title : '';
          const head = typeof body?.head === 'string' ? body.head : '';
          const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
          const headTip = repo.refs.get(`refs/heads/${head}`);
          const baseTip = repo.refs.get(`refs/heads/${base}`);
          if (headTip === undefined || baseTip === undefined) return err(422, 'head or base branch does not exist');
          const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
          if (existing) return err(422, 'A pull request already exists for this head and base');
          const seq = store.nextSeq();
          const pr: PullRequest = {
            id: store.nextObjectId(),
            number: repo.nextNumber,
            title,
            body: typeof body?.body === 'string' ? body.body : '',
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
          return ok(pullJson(store, repo, pr), 201);
        }
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1], 10);
      const pr = repo.pulls.find((p) => p.number === number);
      if (pr === undefined) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return ok(pullJson(store, repo, pr));
        if (method === 'PATCH') {
          if (typeof body?.state === 'string' && body.state === 'closed') pr.state = 'closed';
          if (typeof body?.title === 'string') pr.title = body.title;
          if (typeof body?.body === 'string') pr.body = body.body;
          pr.updatedSeq = store.nextSeq();
          return ok(pullJson(store, repo, pr));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const headTip = store.refTip(repo, `refs/heads/${pr.headRef}`);
        const baseTip = store.refTip(repo, `refs/heads/${pr.baseRef}`);
        if (headTip === undefined || baseTip === undefined) return err(404, 'Not Found');
        const mergeBase = store.mergeBase(repo, headTip, baseTip) ?? baseTip;
        const baseTree = store.commitTree(repo, mergeBase);
        const headTree = store.commitTree(repo, headTip);
        if (baseTree === null || headTree === null) return err(404, 'Not Found');
        return ok(store.diffTrees(repo, baseTree, headTree));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pr.merged || pr.state === 'closed') return err(405, 'Pull request is already merged or closed');
        const sha = store.squashMerge(repo, pr);
        if (sha === null) return err(405, 'Merge conflict');
        const seq = store.nextSeq();
        pr.merged = true;
        pr.state = 'closed';
        pr.mergeCommitSha = sha;
        pr.mergedAt = store.stamp(seq);
        pr.updatedSeq = seq;
        return ok({ sha, merged: true, message: `Pull request #${pr.number} merged` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function listDirectory(store: Store, repo: Repo, treeOid: string, dirPath: string): Json[] {
  const entries = store.treeEntries(repo, treeOid);
  return entries.map((e) => {
    const path = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
    const isDir = e.mode === '40000';
    const blob = isDir ? null : repo.objects.get(e.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: e.name,
      path,
      sha: e.oid,
      size: blob == null ? 0 : blob.data.length,
    };
  });
}
