import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_BYTES = 8 * 1024 * 1024;

export type ProvenanceReachability = 'reachable' | 'unreachable' | 'unknown';

export interface ProvenanceTarget {
  readonly selection: 'current' | 'revision';
  readonly requested_ref: string | null;
  readonly commit_sha: string | null;
  readonly tree_sha: string | null;
  readonly committed_blob_sha: string | null;
  readonly content_hash: string | null;
  readonly file: string;
  readonly line: number | null;
  readonly content: string | null;
  readonly line_content: string | null;
  readonly state: 'available' | 'deleted' | 'unavailable';
  readonly dirty: boolean | null;
  readonly blame: Readonly<{
    status: 'committed' | 'uncommitted' | 'unavailable' | 'not_requested';
    sha: string | null;
  }>;
  readonly issues: readonly string[];
}

export interface ProvenanceTargetInput {
  file: string;
  line?: number;
  at?: string;
}

function validateSelection(input: ProvenanceTargetInput): void {
  if (
    !input.file ||
    path.posix.isAbsolute(input.file) ||
    input.file.includes('\\') ||
    [...input.file].some((character) => character.charCodeAt(0) < 32) ||
    input.file.split('/').some((part) => !part || ['.', '..', '.git'].includes(part))
  )
    throw new Error('Provenance requires a normalized repository-relative file path');
  if (input.line !== undefined && (!Number.isSafeInteger(input.line) || input.line < 1))
    throw new Error('Provenance requires a positive integer line');
  if (
    input.at !== undefined &&
    (!input.at ||
      input.at.startsWith('-') ||
      [...input.at].some((character) => character.charCodeAt(0) <= 32))
  )
    throw new Error('Provenance requires a non-option Git revision');
}

function objectHash(type: string, bytes: Buffer, oid: string): string {
  return createHash(oid.length === 64 ? 'sha256' : 'sha1')
    .update(`${type} ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

export class ProvenanceRepository {
  private readonly env: NodeJS.ProcessEnv;
  private readonly commits = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly cwd: string,
    source: NodeJS.ProcessEnv = process.env
  ) {
    this.env = Object.fromEntries(
      Object.entries(source).filter(([key]) => !key.startsWith('GIT_'))
    );
    Object.assign(this.env, {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
  }

  private run(args: string[], input?: Buffer): Promise<{ code: number | null; bytes: Buffer }> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['--no-replace-objects', '--literal-pathspecs', ...args], {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 15_000,
      });
      const output: Buffer[] = [];
      let size = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) child.kill();
        else output.push(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (size > MAX_BYTES) reject(new Error('Git evidence exceeds the bounded read limit'));
        else resolve({ code, bytes: Buffer.concat(output) });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }

  private async object(type: string, oid: string): Promise<Buffer> {
    if (!OBJECT_ID.test(oid)) throw new Error('Git evidence requires a resolved object ID');
    const result = await this.run(['cat-file', type, oid]);
    if (result.code !== 0 || objectHash(type, result.bytes, oid) !== oid)
      throw new Error('Git object is missing, unreadable or differs from its identity');
    return result.bytes;
  }

  private commit(oid: string): Promise<Buffer> {
    let existing = this.commits.get(oid);
    if (!existing) {
      existing = this.object('commit', oid);
      this.commits.set(oid, existing);
    }
    return existing;
  }

  private async resolve(ref: string): Promise<string> {
    const result = await this.run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    const oid = result.bytes.toString('utf8').trim();
    if (result.code !== 0 || !OBJECT_ID.test(oid))
      throw new Error('The code revision is unavailable');
    await this.commit(oid);
    return oid;
  }

  private async hasOriginalGraph(): Promise<boolean> {
    const grafts = await this.run(['rev-parse', '--git-path', 'info/grafts']);
    if (grafts.code !== 0) return false;
    try {
      const graftPath = path.resolve(this.cwd, grafts.bytes.toString('utf8').trim());
      await lstat(graftPath);
      return false;
    } catch (cause) {
      return (cause as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  async reachability(ancestor: string, descendant: string): Promise<ProvenanceReachability> {
    try {
      await Promise.all([this.commit(ancestor), this.commit(descendant)]);
      if (!(await this.hasOriginalGraph())) return 'unknown';
      const result = await this.run(['merge-base', '--is-ancestor', ancestor, descendant]);
      if (result.code === 0) return 'reachable';
      if (result.code !== 1) return 'unknown';
      const shallow = await this.run(['rev-parse', '--is-shallow-repository']);
      return shallow.code === 0 && shallow.bytes.toString('utf8').trim() === 'false'
        ? 'unreachable'
        : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async blame(
    file: string,
    line: number,
    revision: string,
    contents?: Buffer
  ): Promise<ProvenanceTarget['blame']> {
    try {
      validateSelection({ file, line });
      await this.commit(revision);
      const shallow = await this.run(['rev-parse', '--is-shallow-repository']);
      if (
        !(await this.hasOriginalGraph()) ||
        shallow.code !== 0 ||
        shallow.bytes.toString('utf8').trim() !== 'false'
      )
        return { status: 'unavailable', sha: null };
      if (contents && (await this.resolve('HEAD')) !== revision)
        throw new Error('Blame checkout differs from the selected revision');
      const result = await this.run(
        [
          'blame',
          '--no-textconv',
          '--line-porcelain',
          '--root',
          '-L',
          `${line},${line}`,
          ...(contents ? ['--contents', '-'] : [revision]),
          '--',
          file,
        ],
        contents
      );
      if (result.code !== 0) return { status: 'unavailable', sha: null };
      const sha = result.bytes.toString('utf8').split(' ', 1)[0];
      if (!OBJECT_ID.test(sha)) return { status: 'unavailable', sha: null };
      if (/^0+$/.test(sha)) return { status: 'uncommitted', sha: null };
      await this.commit(sha);
      return { status: 'committed', sha };
    } catch {
      return { status: 'unavailable', sha: null };
    }
  }

  private async currentFile(file: string): Promise<Buffer | null> {
    const root = await realpath(this.cwd);
    const target = path.join(root, file);
    try {
      let parent = root;
      for (const part of file.split('/')) {
        await access(parent, constants.R_OK | constants.X_OK);
        parent = path.join(parent, part);
        if ((await lstat(parent)).isSymbolicLink())
          throw new Error('Code target contains a symlink');
      }
      const before = await lstat(target);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES)
        throw new Error('Code target is not a bounded regular file');
      if ((await realpath(target)) !== target) throw new Error('Code target path changed');
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino)
          throw new Error('Code target changed while opening');
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        const after = await lstat(target);
        if (
          after.ino !== before.ino ||
          after.dev !== before.dev ||
          after.mtimeMs !== before.mtimeMs ||
          after.size !== before.size ||
          bytes.length !== before.size ||
          (await realpath(target)) !== target
        )
          throw new Error('Code target changed while reading');
        return bytes;
      } finally {
        await handle.close();
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    }
  }

  async resolveTarget(input: ProvenanceTargetInput): Promise<ProvenanceTarget> {
    validateSelection(input);
    const target: { -readonly [K in keyof ProvenanceTarget]: ProvenanceTarget[K] } = {
      selection: input.at === undefined ? 'current' : 'revision',
      requested_ref: input.at ?? null,
      commit_sha: null,
      tree_sha: null,
      committed_blob_sha: null,
      content_hash: null,
      file: input.file,
      line: input.line ?? null,
      content: null,
      line_content: null,
      state: 'unavailable',
      dirty: null,
      blame: { status: 'not_requested', sha: null },
      issues: [],
    };
    const issues: string[] = [];
    try {
      const root = await this.run(['rev-parse', '--show-toplevel']);
      if (
        root.code !== 0 ||
        (await realpath(root.bytes.toString('utf8').trim())) !== (await realpath(this.cwd))
      )
        throw new Error('Provenance requires the selected checkout root');
      const revision = await this.resolve(input.at ?? 'HEAD');
      target.commit_sha = revision;
      const commit = await this.commit(revision);
      const tree = /^tree ([a-f0-9]+)\n/.exec(commit.toString('utf8'))?.[1];
      if (!tree || !OBJECT_ID.test(tree)) throw new Error('Code revision has no valid tree');
      await this.object('tree', tree);
      target.tree_sha = tree;
      const entry = await this.run(['ls-tree', '-z', '--full-tree', tree, '--', input.file]);
      if (entry.code !== 0) throw new Error('Cannot inspect the selected code tree');
      let committed: Buffer | null = null;
      if (entry.bytes.length > 0) {
        const parsed = /^(100[0-7]{3}) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(
          entry.bytes.toString('utf8')
        );
        if (!parsed || parsed[3] !== input.file)
          throw new Error('Code target is not a regular blob');
        target.committed_blob_sha = parsed[2];
        committed = await this.object('blob', parsed[2]);
      }
      const bytes = input.at === undefined ? await this.currentFile(input.file) : committed;
      target.dirty =
        input.at === undefined
          ? committed === null
            ? bytes !== null
            : bytes === null || !bytes.equals(committed)
          : false;
      if (bytes === null) {
        target.state = 'deleted';
        issues.push('CODE_PATH_ABSENT');
      } else if (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) {
        issues.push('CODE_CONTENT_UNSUPPORTED');
      } else {
        target.content = bytes.toString('utf8');
        target.content_hash = createHash('sha256').update(bytes).digest('hex');
        target.state = 'available';
        if (input.line !== undefined) {
          const lines = target.content.split('\n');
          if (lines.at(-1) === '') lines.pop();
          target.line_content = lines[input.line - 1] ?? null;
          if (target.line_content === null) issues.push('CODE_LINE_ABSENT');
          else {
            target.blame = await this.blame(
              input.file,
              input.line,
              revision,
              input.at === undefined ? bytes : undefined
            );
            if (target.blame.status === 'unavailable') issues.push('CODE_BLAME_UNAVAILABLE');
          }
        }
      }
      // --contents uses HEAD; a concurrent checkout cannot be accepted as the selected revision.
      if (input.at === undefined && (await this.resolve('HEAD')) !== revision)
        throw new Error('The selected checkout revision changed while reading');
    } catch {
      target.state = 'unavailable';
      target.blame = {
        status: input.line === undefined ? 'not_requested' : 'unavailable',
        sha: null,
      };
      issues.push('CODE_EVIDENCE_UNAVAILABLE');
    }
    target.issues = Object.freeze(issues);
    target.blame = Object.freeze(target.blame);
    return Object.freeze(target);
  }
}
