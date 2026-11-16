// GraphQL v4 at /api/graphql: a small parser and executor for the documents `gh`
// and `github-mcp-server` send (see kit program/env/src/checks-graphql.ts for the
// exact documents). Supports query/mutation, variables, aliases, inline fragments,
// input objects, enums, lists, nulls, operation batching (a JSON array body) and
// __type introspection. An unknown field is HTTP 200 with an errors array naming it.

import { globalId, parseGlobalId, VIEWER_LOGIN, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos])) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }

  eof(): boolean {
    this.skipIgnored();
    return this.pos >= this.src.length;
  }

  expect(ch: string): void {
    this.skipIgnored();
    if (this.src[this.pos] !== ch) throw new ParseError(`expected ${JSON.stringify(ch)} at ${this.pos}`);
    this.pos += 1;
  }

  match(ch: string): boolean {
    this.skipIgnored();
    if (this.src[this.pos] === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  matchSpread(): boolean {
    this.skipIgnored();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      return true;
    }
    return false;
  }

  readName(): string {
    this.skipIgnored();
    const start = this.pos;
    if (!/[A-Za-z_]/.test(this.src[this.pos] ?? '')) throw new ParseError(`expected a name at ${this.pos}`);
    while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  peekName(): string | null {
    this.skipIgnored();
    if (!/[A-Za-z_]/.test(this.src[this.pos] ?? '')) return null;
    let end = this.pos;
    while (end < this.src.length && /[A-Za-z0-9_]/.test(this.src[end])) end += 1;
    return this.src.slice(this.pos, end);
  }

  readString(): string {
    this.skipIgnored();
    if (this.src[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      if (this.pos >= this.src.length) throw new ParseError('unterminated string');
      const ch = this.src[this.pos];
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.src[this.pos];
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.src.slice(this.pos + 1, this.pos + 5), 16));
          this.pos += 4;
        } else out += esc;
        this.pos += 1;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  readNumber(): { kind: 'int' | 'float'; value: number } {
    this.skipIgnored();
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos += 1;
    while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    let isFloat = false;
    if (this.src[this.pos] === '.') {
      isFloat = true;
      this.pos += 1;
      while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      isFloat = true;
      this.pos += 1;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos += 1;
      while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    }
    const text = this.src.slice(start, this.pos);
    return isFloat ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) };
  }
}

class Parser {
  private readonly lex: Lexer;
  constructor(src: string) {
    this.lex = new Lexer(src);
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (!this.lex.eof()) defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const name = this.lex.peekName();
    if (name === 'fragment') {
      this.lex.readName();
      const fragName = this.lex.readName();
      const on = this.lex.readName();
      if (on !== 'on') throw new ParseError('expected "on" in a fragment definition');
      const typeCondition = this.lex.readName();
      this.skipDirectives();
      return { kind: 'fragment', name: fragName, typeCondition, selection: this.parseSelectionSet() };
    }
    let operation: 'query' | 'mutation' = 'query';
    let opName: string | null = null;
    if (name === 'query' || name === 'mutation') {
      operation = this.lex.readName() as 'query' | 'mutation';
      const next = this.lex.peekName();
      if (next !== null && next !== '') opName = this.lex.readName();
    }
    const variables = this.parseVariableDefinitions();
    this.skipDirectives();
    return { kind: 'operation', operation, name: opName, variables, selection: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): Array<{ name: string; type: string; defaultValue: ValueNode | null }> {
    const vars: Array<{ name: string; type: string; defaultValue: ValueNode | null }> = [];
    if (!this.lex.match('(')) return vars;
    while (!this.lex.match(')')) {
      this.lex.expect('$');
      const name = this.lex.readName();
      this.lex.expect(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.lex.match('=')) defaultValue = this.parseValue(true);
      vars.push({ name, type, defaultValue });
    }
    return vars;
  }

  private parseType(): string {
    let type: string;
    if (this.lex.match('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.lex.readName();
    }
    if (this.lex.match('!')) type += '!';
    return type;
  }

  private skipDirectives(): void {
    while (this.lex.peek() === '@') {
      this.lex.expect('@');
      this.lex.readName();
      if (this.lex.peek() === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.lex.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.lex.match('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.lex.matchSpread()) {
      const name = this.lex.peekName();
      if (name === 'on') {
        this.lex.readName();
        const typeCondition = this.lex.readName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (name !== null) {
        const fragName = this.lex.readName();
        this.skipDirectives();
        return { kind: 'spread', name: fragName };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
    }
    const first = this.lex.readName();
    let alias: string | null = null;
    let name = first;
    if (this.lex.match(':')) {
      alias = first;
      name = this.lex.readName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selection = this.lex.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selection };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.lex.match('(')) return args;
    while (!this.lex.match(')')) {
      const name = this.lex.readName();
      this.lex.expect(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const ch = this.lex.peek();
    if (ch === '$') {
      if (isConst) throw new ParseError('a variable is not allowed in a constant value');
      this.lex.expect('$');
      return { kind: 'variable', name: this.lex.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.lex.readString() };
    if (ch === '[') {
      this.lex.expect('[');
      const values: ValueNode[] = [];
      while (!this.lex.match(']')) values.push(this.parseValue(isConst));
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.lex.expect('{');
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.lex.match('}')) {
        const name = this.lex.readName();
        this.lex.expect(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const num = this.lex.readNumber();
      return num.kind === 'int' ? { kind: 'int', value: num.value } : { kind: 'float', value: num.value };
    }
    const name = this.lex.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
}

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

interface ExecContext {
  store: Store;
  fragments: Map<string, FragmentNode>;
  variables: Variables;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Variables): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, variables);
}

// The schema's field tables, for validation and introspection.
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'mergeCommit'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  Node: ['id'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'PACKAGE', 'MILESTONE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

interface TypedValue {
  type: string;
  value: unknown;
}

function executeSelection(ctx: ExecContext, typeName: string, source: unknown, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelection(ctx, typeName, source, fragment.selection));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelection(ctx, typeName, source, selection.selection));
      }
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const known = TYPE_FIELDS[typeName] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const resolved = resolveField(ctx, typeName, source, field);
    out[responseKey] = resolved;
  }
  return out;
}

/** Resolve one field; returns the JSON value (a nested object is itself executed against its selection). */
function resolveField(ctx: ExecContext, typeName: string, source: unknown, field: FieldNode): unknown {
  const store = ctx.store;
  const sel = field.selection;

  // Scalars and nested objects are dispatched by (type, field).
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        return sel.length === 0 ? { login: VIEWER_LOGIN } : executeSelection(ctx, 'User', { login: VIEWER_LOGIN }, sel);
      }
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', ctx.variables) as string | undefined;
        const name = argValue(field, 'name', ctx.variables) as string | undefined;
        const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        return sel.length === 0 ? { name: repo.name } : executeSelection(ctx, 'Repository', repo, sel);
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', ctx.variables) as string | undefined;
        if (typeof id !== 'string') return null;
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        const repo = [...store.repos.values()].find((r) => r.id === parsed.repoDbId);
        if (repo === undefined) return null;
        if (parsed.kind === 'Repository') return executeSelection(ctx, 'Repository', repo, sel);
        if (parsed.kind === 'Issue' && parsed.number !== undefined) {
          const issue = repo.issues.find((i) => i.number === parsed.number);
          if (issue === undefined) return null;
          return executeSelection(ctx, 'Issue', { repo, issue }, sel);
        }
        if (parsed.kind === 'PullRequest' && parsed.number !== undefined) {
          const pull = repo.pulls.find((p) => p.number === parsed.number);
          if (pull === undefined) return null;
          return executeSelection(ctx, 'PullRequest', { repo, pull }, sel);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', ctx.variables) as string | undefined;
        return executeSelection(ctx, '__Type', { typeName: name ?? '' }, sel);
      }
      return null;
    }
    case 'User': {
      const user = source as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return globalId('Repository', 0);
      if (field.name === 'name') return user.login;
      if (field.name === 'email') return `${user.login}@example.invalid`;
      return null;
    }
    case 'Repository': {
      const repo = source as Repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return sel.length === 0 ? { login: repo.owner } : executeSelection(ctx, 'User', { login: repo.owner }, sel);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return sel.length === 0 ? { name: repo.defaultBranch } : executeSelection(ctx, 'Ref', { name: repo.defaultBranch }, sel);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argValue(field, 'number', ctx.variables) as number | undefined;
          const issue = repo.issues.find((i) => i.number === number);
          if (issue === undefined) return null;
          return executeSelection(ctx, 'Issue', { repo, issue }, sel);
        }
        case 'issues':
          return issueConnection(ctx, repo, field, sel);
        case 'pullRequests':
          return pullConnection(ctx, repo, field, sel);
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx.variables) as number | undefined;
          const pull = repo.pulls.find((p) => p.number === number);
          if (pull === undefined) return null;
          return executeSelection(ctx, 'PullRequest', { repo, pull }, sel);
        }
        default:
          return null;
      }
    }
    case 'Ref':
      return (source as { name: string }).name;
    case 'Issue': {
      const { repo, issue } = source as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
        case 'createdAt':
        case 'updatedAt':
          return store.stamp(issue.createdSeq);
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'author':
          return sel.length === 0 ? { login: issue.user } : executeSelection(ctx, 'User', { login: issue.user }, sel);
        case 'labels':
          return { nodes: issue.labels.map((l) => ({ name: l.name })) };
        case 'comments':
          return { nodes: issue.comments.map((c) => ({ id: globalId('IssueComment', repo.id, issue.number, c.id), body: c.body })) };
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      const conn = source as { nodes: Array<{ repo: Repo; issue: Issue }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') {
        return conn.nodes.map((n) => executeSelection(ctx, 'Issue', n, sel));
      }
      if (field.name === 'edges') {
        return conn.nodes.map((n) => executeSelection(ctx, 'IssueEdge', n, sel));
      }
      if (field.name === 'totalCount') return conn.nodes.length;
      if (field.name === 'pageInfo') return executeSelection(ctx, 'PageInfo', conn.pageInfo, sel);
      return null;
    }
    case 'IssueEdge': {
      const n = source as { repo: Repo; issue: Issue };
      if (field.name === 'node') return executeSelection(ctx, 'Issue', n, sel);
      if (field.name === 'cursor') return cursorFor(n.issue.number);
      return null;
    }
    case 'PageInfo': {
      const info = source as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: Repo; pull: PullRequest };
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable': {
          const headTip = store.refTip(repo, `refs/heads/${pull.headRef}`) ?? pull.headSha;
          const baseTip = store.refTip(repo, `refs/heads/${pull.baseRef}`) ?? pull.baseSha;
          return store.mergeable(repo, headTip, baseTip);
        }
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'createdAt':
        case 'updatedAt':
          return store.stamp(pull.createdSeq);
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'author':
          return sel.length === 0 ? { login: repo.owner } : executeSelection(ctx, 'User', { login: repo.owner }, sel);
        case 'mergeCommit': {
          if (pull.mergeCommitSha === null) return null;
          return { oid: pull.mergeCommitSha };
        }
        case 'files': {
          const first = argValue(field, 'first', ctx.variables) as number | undefined;
          const headTip = store.refTip(repo, `refs/heads/${pull.headRef}`);
          const baseTip = store.refTip(repo, `refs/heads/${pull.baseRef}`);
          if (headTip === undefined || baseTip === undefined) return { nodes: [] };
          const mergeBase = store.mergeBase(repo, headTip, baseTip) ?? baseTip;
          const baseTree = store.commitTree(repo, mergeBase);
          const headTree = store.commitTree(repo, headTip);
          if (baseTree === null || headTree === null) return { nodes: [] };
          const diff = store.diffTrees(repo, baseTree, headTree);
          const limited = first !== undefined ? diff.slice(0, first) : diff;
          const nodes = limited.map((d) => ({ path: d.filename, filename: d.filename, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() }));
          return executeSelection(ctx, 'PullRequestChangedFileConnection', { nodes, pageInfo: { hasNextPage: false, endCursor: null } }, sel);
        }
        default:
          return null;
      }
    }
    case 'PullRequestConnection': {
      const conn = source as { nodes: Array<{ repo: Repo; pull: PullRequest }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return conn.nodes.map((n) => executeSelection(ctx, 'PullRequest', n, sel));
      if (field.name === 'edges') return conn.nodes.map((n) => executeSelection(ctx, 'PullRequestEdge', n, sel));
      if (field.name === 'totalCount') return conn.nodes.length;
      if (field.name === 'pageInfo') return executeSelection(ctx, 'PageInfo', conn.pageInfo, sel);
      return null;
    }
    case 'PullRequestEdge': {
      const n = source as { repo: Repo; pull: PullRequest };
      if (field.name === 'node') return executeSelection(ctx, 'PullRequest', n, sel);
      if (field.name === 'cursor') return cursorFor(n.pull.number);
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = source as { nodes: Array<{ path: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      if (field.name === 'nodes') return conn.nodes.map((n) => executeSelection(ctx, 'PullRequestChangedFile', n, sel));
      if (field.name === 'edges') return conn.nodes.map((n) => executeSelection(ctx, 'PullRequestChangedFileEdge', n, sel));
      if (field.name === 'totalCount') return conn.nodes.length;
      if (field.name === 'pageInfo') return executeSelection(ctx, 'PageInfo', conn.pageInfo, sel);
      return null;
    }
    case 'PullRequestChangedFileEdge': {
      const n = source as { path: string };
      if (field.name === 'node') return executeSelection(ctx, 'PullRequestChangedFile', n, sel);
      if (field.name === 'cursor') return cursorFor(0);
      return null;
    }
    case 'PullRequestChangedFile': {
      const n = source as { path: string; filename?: string; additions?: number; deletions?: number; changeType?: string };
      if (field.name === 'path' || field.name === 'filename') return n.path;
      if (field.name === 'additions') return n.additions ?? 0;
      if (field.name === 'deletions') return n.deletions ?? 0;
      if (field.name === 'changeType') return n.changeType ?? 'MODIFIED';
      return null;
    }
    case 'IssueComment': {
      const c = source as { id: string; body: string };
      if (field.name === 'id') return c.id;
      if (field.name === 'body') return c.body;
      return null;
    }
    case 'IssueCommentEdge': {
      const c = source as { id: string; body: string };
      if (field.name === 'node') return executeSelection(ctx, 'IssueComment', c, sel);
      if (field.name === 'cursor') return c.id;
      return null;
    }
    case '__Type': {
      const name = (source as { typeName: string }).typeName;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return TYPE_ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        return (TYPE_FIELDS[name] ?? []).map((f) => executeSelection(ctx, '__Field', { name: f }, sel));
      }
      if (field.name === 'enumValues') {
        return (TYPE_ENUM_VALUES[name] ?? []).map((v) => executeSelection(ctx, '__EnumValue', { name: v }, sel));
      }
      if (field.name === 'description') return null;
      return null;
    }
    case '__Field': {
      const f = source as { name: string };
      if (field.name === 'name') return f.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return { name: 'String' };
      return null;
    }
    case '__EnumValue': {
      const v = source as { name: string };
      if (field.name === 'name') return v.name;
      if (field.name === 'description') return null;
      return null;
    }
    case 'Mutation': {
      return executeMutation(ctx, field, sel);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = source as { issue: { repo: Repo; issue: Issue } };
      if (field.name === 'issue') return executeSelection(ctx, 'Issue', payload.issue, sel);
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = source as { pull: { repo: Repo; pull: PullRequest } };
      if (field.name === 'pullRequest') return executeSelection(ctx, 'PullRequest', payload.pull, sel);
      return null;
    }
    case 'AddCommentPayload': {
      const payload = source as { commentEdge: { node: { id: string; body: string } } };
      if (field.name === 'commentEdge') return executeSelection(ctx, 'IssueCommentEdge', payload.commentEdge.node, sel);
      return null;
    }
    default:
      return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const plain = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(plain);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueConnection(ctx: ExecContext, repo: Repo, field: FieldNode, sel: SelectionNode[]): unknown {
  const first = argValue(field, 'first', ctx.variables) as number | undefined;
  const after = argValue(field, 'after', ctx.variables) as string | null | undefined;
  const states = argValue(field, 'states', ctx.variables) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx.variables) as { field?: string; direction?: string } | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => {
    const bySeq = (a.createdSeq - b.createdSeq) * direction;
    if (bySeq !== 0) return bySeq;
    return (b.number - a.number) * (direction === 1 ? -1 : 1);
  });
  // Default (no orderBy): creation order, ascending.
  if (orderBy === undefined) list.sort((a, b) => a.createdSeq - b.createdSeq);
  const afterNumber = cursorNumber(after ?? null);
  if (afterNumber !== null) {
    const idx = list.findIndex((i) => i.number === afterNumber);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const limit = first !== undefined ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > limit;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  const conn = {
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: { hasNextPage, endCursor },
  };
  return executeSelection(ctx, 'IssueConnection', conn, sel);
}

function pullConnection(ctx: ExecContext, repo: Repo, field: FieldNode, sel: SelectionNode[]): unknown {
  const first = argValue(field, 'first', ctx.variables) as number | undefined;
  const list = [...repo.pulls].filter((p) => p.state === 'open').sort((a, b) => b.createdSeq - a.createdSeq);
  const limited = first !== undefined ? list.slice(0, first) : list;
  const conn = {
    nodes: limited.map((pull) => ({ repo, pull })),
    pageInfo: { hasNextPage: list.length > limited.length, endCursor: limited.length > 0 ? cursorFor(limited[limited.length - 1].number) : null },
  };
  return executeSelection(ctx, 'PullRequestConnection', conn, sel);
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

function findRepoByGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return [...store.repos.values()].find((r) => r.id === parsed.repoDbId) ?? null;
}

function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue' || parsed.number === undefined) return null;
  const repo = [...store.repos.values()].find((r) => r.id === parsed.repoDbId);
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === parsed.number);
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(store: Store, id: unknown): { repo: Repo; pull: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest' || parsed.number === undefined) return null;
  const repo = [...store.repos.values()].find((r) => r.id === parsed.repoDbId);
  if (repo === undefined) return null;
  const pull = repo.pulls.find((p) => p.number === parsed.number);
  return pull === undefined ? null : { repo, pull };
}

function executeMutation(ctx: ExecContext, field: FieldNode, sel: SelectionNode[]): unknown {
  const store = ctx.store;
  const input = argValue(field, 'input', ctx.variables) as Record<string, unknown> | undefined;
  const inputObj = typeof input === 'object' && input !== null ? input : {};

  if (field.name === 'createIssue') {
    const repo = findRepoByGlobalId(store, inputObj.repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const seq = store.nextSeq();
    const issue: Issue = {
      id: store.nextObjectId(),
      number: repo.nextNumber,
      title: typeof inputObj.title === 'string' ? inputObj.title : '',
      body: typeof inputObj.body === 'string' ? inputObj.body : '',
      state: 'open',
      labels: [],
      user: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.push(issue);
    return executeSelection(ctx, 'CreateIssuePayload', { issue: { repo, issue } }, sel);
  }

  if (field.name === 'closeIssue') {
    const found = findIssueByGlobalId(store, inputObj.issueId);
    if (found === null) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.updatedSeq = store.nextSeq();
    return executeSelection(ctx, 'CloseIssuePayload', { issue: found }, sel);
  }

  if (field.name === 'createPullRequest') {
    const repo = findRepoByGlobalId(store, inputObj.repositoryId);
    if (repo === null) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const head = typeof inputObj.headRefName === 'string' ? inputObj.headRefName : '';
    const base = typeof inputObj.baseRefName === 'string' ? inputObj.baseRefName : repo.defaultBranch;
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined || baseTip === undefined) {
      ctx.errors.push({ message: 'Head or base branch does not exist.' });
      return null;
    }
    const existing = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
    if (existing) {
      ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
      return null;
    }
    const seq = store.nextSeq();
    const pull: PullRequest = {
      id: store.nextObjectId(),
      number: repo.nextNumber,
      title: typeof inputObj.title === 'string' ? inputObj.title : '',
      body: typeof inputObj.body === 'string' ? inputObj.body : '',
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
    repo.pulls.push(pull);
    return executeSelection(ctx, 'CreatePullRequestPayload', { pull: { repo, pull } }, sel);
  }

  if (field.name === 'mergePullRequest') {
    const found = findPullByGlobalId(store, inputObj.pullRequestId);
    if (found === null) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
      return null;
    }
    const { repo, pull } = found;
    if (pull.merged) {
      return executeSelection(ctx, 'MergePullRequestPayload', { pull: found }, sel);
    }
    const sha = store.squashMerge(repo, pull);
    if (sha === null) {
      ctx.errors.push({ message: 'Merge conflict.' });
      return null;
    }
    const seq = store.nextSeq();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = sha;
    pull.mergedAt = store.stamp(seq);
    pull.updatedSeq = seq;
    return executeSelection(ctx, 'MergePullRequestPayload', { pull: found }, sel);
  }

  if (field.name === 'addComment') {
    const found = findIssueByGlobalId(store, inputObj.subjectId);
    if (found === null) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    const body = typeof inputObj.body === 'string' ? inputObj.body : '';
    const comment = { id: found.repo.nextCommentId, body, user: VIEWER_LOGIN, createdSeq: store.nextSeq() };
    found.repo.nextCommentId += 1;
    found.issue.comments.push(comment);
    found.issue.updatedSeq = store.nextSeq();
    const node = { id: globalId('IssueComment', found.repo.id, found.issue.number, comment.id), body };
    return executeSelection(ctx, 'AddCommentPayload', { commentEdge: { node } }, sel);
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, query: string, variables: Variables): GraphQLResult {
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const fragments = new Map<string, FragmentNode>();
  for (const def of definitions) if (def.kind === 'fragment') fragments.set(def.name, def);
  const operation = definitions.find((d) => d.kind === 'operation') as OperationNode | undefined;
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation found in the document.' }] };
  const ctx: ExecContext = { store, fragments, variables, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, operation.selection);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one GraphQL HTTP body (single operation or a JSON array batch). */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results: GraphQLResult[] = [];
    for (const entry of body) {
      if (typeof entry !== 'object' || entry === null) {
        results.push({ data: null, errors: [{ message: 'Each batch entry must be an object.' }] });
        continue;
      }
      const query = typeof (entry as Record<string, unknown>).query === 'string' ? String((entry as Record<string, unknown>).query) : '';
      const variables = ((entry as Record<string, unknown>).variables ?? {}) as Variables;
      results.push(executeGraphQL(store, query, variables));
    }
    return { status: 200, body: results };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { errors: [{ message: 'The request body must be a JSON object.' }] } };
  }
  const query = typeof (body as Record<string, unknown>).query === 'string' ? String((body as Record<string, unknown>).query) : '';
  const variables = ((body as Record<string, unknown>).variables ?? {}) as Variables;
  return { status: 200, body: executeGraphQL(store, query, variables) };
}
