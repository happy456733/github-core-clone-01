// The forge's in-memory store: repositories, refs, git objects, issues, pull
// requests, labels and comments, plus the git operations the REST and git surfaces
// need (tree building, commit creation, merge-base, three-way merge, diff).
//
// Determinism: nothing here reads the wall clock or Math.random. Timestamps and
// ids come from monotonic counters, so two runs fed the same requests behave the
// same way.

import { collectReachableStopAtShallow, buildCommit, buildTree, collectReachable, hashObject, isObjectId, parseCommit, parseTag, parseTree, ZERO_OID, type GitObject, type TreeEntry } from './gitobj.ts';

/** The login the trial's bearer token names (the scenario's viewer, derived from the kit's fixed scenario seed). */
export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** Fixed epoch for every timestamp this store mints, plus a monotonic counter. */
const EPOCH_SEC = 1_700_000_000;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export type PullState = 'open' | 'closed';
export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** ref name -> tip oid */
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  /** shared issue + pull-request numbering, as GitHub numbers them */
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private seq = 0;

  /** A strictly increasing sequence used for created/updated ordering and timestamps. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ISO timestamp for sequence `seq` (fixed epoch + seconds). */
  stamp(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, options: { private?: boolean; description?: string }): Repo {
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: seq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.nextGlobalId += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  nextObjectId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** The tree oid of a commit, or null. */
  commitTree(repo: Repo, oid: string): string | null {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Read a file's blob oid out of a tree, following path segments; null when absent. */
  treeBlob(repo: Repo, treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** List a tree's immediate children as {name, mode, oid}. */
  treeEntries(repo: Repo, treeOid: string): TreeEntry[] {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** The full path -> blob oid map of a tree, recursively. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, base: string): void => {
      for (const entry of this.treeEntries(repo, oid)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /**
   * A new tree equal to `baseTree` with `path` set to `blobOid` (or removed when
   * `blobOid` is null), creating intermediate directories as needed.
   */
  setPathInTree(repo: Repo, baseTree: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        for (const entry of this.treeEntries(repo, treeOid)) entries.set(entry.name, entry);
      }
      const name = segments[depth];
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const next = build(childTree, depth + 1);
        const childEntries = this.treeEntries(repo, next);
        if (childEntries.length === 0) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      const built = buildTree([...entries.values()]);
      return this.putObject(repo, 'tree', built);
    };
    return build(baseTree, 0);
  }

  /** Create a commit on `branch` (creating the branch at `parent` when absent). */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined) {
      // A new branch starts at the default branch tip (or unborn).
      tip = this.defaultTip(repo);
    }
    const baseTree = tip === undefined ? null : this.commitTree(repo, tip);
    const blobOid = this.putObject(repo, 'blob', content);
    const treeOid = this.setPathInTree(repo, baseTree, path, blobOid);
    const seq = this.nextSeq();
    const commit = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      message,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: EPOCH_SEC + seq,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /** Delete a file from `branch`'s tree and commit the result. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return null;
    const baseTree = this.commitTree(repo, tip);
    if (baseTree === null) return null;
    if (this.treeBlob(repo, baseTree, path) === null) return null;
    const treeOid = this.setPathInTree(repo, baseTree, path, null);
    const seq = this.nextSeq();
    const commit = buildCommit({
      tree: treeOid,
      parents: [tip],
      message,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: EPOCH_SEC + seq,
    });
    const commitSha = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitSha);
    return commitSha;
  }

  /** Commits reachable from `tip`, newest first (parents after children, first-parent order). */
  commitList(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The nearest common ancestor of two commits (merge base), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /**
   * Three-way merge of `headTree` into `baseTree` over `mergeBaseTree`. Returns the merged
   * tree oid and whether any path conflicted (both sides changed the same path differently).
   */
  mergeTrees(repo: Repo, baseTree: string, headTree: string, targetTree: string): { tree: string; conflict: boolean } {
    const base = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const target = this.flattenTree(repo, targetTree);
    const paths = new Set([...base.keys(), ...head.keys(), ...target.keys()]);
    let conflict = false;
    const merged = new Map<string, string>();
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = target.get(path);
      if (h === t) {
        if (h !== undefined) merged.set(path, h);
      } else if (b === h) {
        if (t !== undefined) merged.set(path, t);
      } else if (b === t) {
        if (h !== undefined) merged.set(path, h);
      } else {
        conflict = true;
      }
    }
    // Rebuild the tree from the flat map.
    let root: string | null = null;
    const buildDir = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, oid] of merged) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: '100644', name: rest, oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) entries.push({ mode: '40000', name: dir, oid: buildDir(`${prefix}${dir}/`) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    root = buildDir('');
    return { tree: root, conflict };
  }

  /** Line counts for a blob diff (added = lines in new not in old, removed = lines in old not in new). */
  static diffLines(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
    const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    let additions = 0;
    for (const line of newLines) if (!oldSet.has(line)) additions += 1;
    let deletions = 0;
    for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
    return { additions, deletions };
  }

  /** The file diff between two trees: {filename, status, additions, deletions, changes}. */
  diffTrees(repo: Repo, oldTree: string, newTree: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const oldMap = this.flattenTree(repo, oldTree);
    const newMap = this.flattenTree(repo, newTree);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
    for (const path of [...paths].sort()) {
      const o = oldMap.get(path);
      const n = newMap.get(path);
      if (o === n) continue;
      const oldData = o === undefined ? null : repo.objects.get(o)?.data ?? null;
      const newData = n === undefined ? null : repo.objects.get(n)?.data ?? null;
      const { additions, deletions } = Store.diffLines(oldData, newData);
      const status = o === undefined ? 'added' : n === undefined ? 'removed' : 'modified';
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Whether `headTip` can merge into `baseTip` (a fast-forward or a clean three-way merge). */
  mergeable(repo: Repo, headTip: string, baseTip: string): Mergeable {
    if (!isObjectId(headTip) || !isObjectId(baseTip)) return 'UNKNOWN';
    if (this.isAncestor(repo, baseTip, headTip)) return 'MERGEABLE';
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === null) return 'CONFLICTING';
    const headTree = this.commitTree(repo, headTip);
    const targetTree = this.commitTree(repo, baseTip);
    const baseTree = this.commitTree(repo, base);
    if (headTree === null || targetTree === null || baseTree === null) return 'UNKNOWN';
    return this.mergeTrees(repo, baseTree, headTree, targetTree).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null on conflict. */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    const headTip = this.refTip(repo, `refs/heads/${pr.headRef}`);
    const baseTip = this.refTip(repo, `refs/heads/${pr.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return null;
    if (this.isAncestor(repo, baseTip, headTip)) {
      // Fast-forward: the base just advances (still a squash-shaped single commit? No:
      // a fast-forward has no new commit. GitHub squash-merging a fast-forwardable PR
      // still creates a new commit. Fall through to the merge below with base as merge base.
    }
    const base = this.mergeBase(repo, headTip, baseTip) ?? baseTip;
    const headTree = this.commitTree(repo, headTip);
    const targetTree = this.commitTree(repo, baseTip);
    const baseTree = this.commitTree(repo, base);
    if (headTree === null || targetTree === null || baseTree === null) return null;
    const { tree, conflict } = this.mergeTrees(repo, baseTree, headTree, targetTree);
    if (conflict) return null;
    const seq = this.nextSeq();
    const commit = buildCommit({
      tree,
      parents: [baseTip],
      message: `${pr.title} (#${pr.number})\n`,
      author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
      timestamp: EPOCH_SEC + seq,
    });
    const sha = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pr.baseRef}`, sha);
    return sha;
  }

  /** All objects reachable from `roots` that are not reachable from `exclude`. */
  objectsForFetch(
    repo: Repo,
    wants: readonly string[],
    exclude: readonly string[],
    depth?: number,
    shallow: readonly string[] = [],
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const lookup = this.lookup(repo);
    // Depth-limited commit set: BFS from wants, at most `depth` generations.
    let includedCommits: Set<string> | null = null;
    let boundary = new Set<string>();
    if (depth !== undefined) {
      includedCommits = new Set<string>();
      const queue: Array<{ oid: string; dist: number }> = wants.map((w) => ({ oid: w, dist: 0 }));
      const seen = new Set<string>();
      while (queue.length) {
        const { oid, dist } = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        includedCommits.add(oid);
        if (dist + 1 >= depth) {
          boundary.add(oid);
          continue;
        }
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
      }
    }
    const reachable = (roots: readonly string[]): Set<string> => {
      if (includedCommits !== null) {
        // Reachable from the depth-limited commits only: follow trees and tags, but
        // never a parent link out of the included set.
        const out = new Set<string>();
        const queue: string[] = [...includedCommits];
        while (queue.length) {
          const oid = queue.pop()!;
          if (out.has(oid)) continue;
          const object = repo.objects.get(oid);
          if (!object) continue;
          out.add(oid);
          if (object.type === 'commit') {
            const commit = parseCommit(object.data);
            queue.push(commit.tree);
            for (const parent of commit.parents) if (includedCommits.has(parent)) queue.push(parent);
          } else if (object.type === 'tag') {
            queue.push(parseTag(object.data).object);
          } else if (object.type === 'tree') {
            for (const entry of parseTree(object.data)) {
              if (entry.mode === '160000') continue;
              queue.push(entry.oid);
            }
          }
        }
        return out;
      }
      return collectReachable(roots, lookup);
    };
    const wanted = reachable(wants);
    // A have that is also a shallow boundary is held only up to itself: the
    // client has that commit and its tree, but none of the history behind it,
    // so a deepen fetch must still deliver its parent. A plain have is held
    // with its whole history.
    const held = new Set<string>();
    const shallowSet = new Set(shallow);
    for (const oid of exclude) {
      try {
        for (const reachableOid of collectReachableStopAtShallow([oid], lookup, shallowSet)) held.add(reachableOid);
      } catch {
        // An unknown have is not held.
      }
    }
    const objects: GitObject[] = [];
    for (const oid of wanted) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.push(object);
    }
    // Deterministic order: commits, then trees, then blobs, each by oid.
    const order = { commit: 0, tree: 1, blob: 2, tag: 3 } as const;
    objects.sort((a, b) => order[a.type] - order[b.type] || hashObject(a.type, a.data).localeCompare(hashObject(b.type, b.data)));
    return { objects, shallow: [...boundary].sort(), unshallow: [] };
  }
}

/** The global id for a repository / issue / pull request / comment (opaque, stable). */
export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', repoDbId: number, number?: number, extra?: number): string {
  const plain = extra !== undefined ? `${kind}:${repoDbId}:${number}:${extra}` : number !== undefined ? `${kind}:${repoDbId}:${number}` : `${kind}:${repoDbId}`;
  return Buffer.from(plain, 'utf8').toString('base64');
}

/** Parse a global id back into {kind, repoDbId, number, extra}. */
export function parseGlobalId(id: string): { kind: string; repoDbId: number; number?: number; extra?: number } | null {
  try {
    const plain = Buffer.from(id, 'base64').toString('utf8');
    const parts = plain.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0];
    const repoDbId = Number(parts[1]);
    if (!Number.isInteger(repoDbId)) return null;
    const number = parts.length > 2 ? Number(parts[2]) : undefined;
    const extra = parts.length > 3 ? Number(parts[3]) : undefined;
    return { kind, repoDbId, number, extra };
  } catch {
    return null;
  }
}

/** Create a fresh, empty store. */
export function createStore(): Store {
  return new Store();
}
