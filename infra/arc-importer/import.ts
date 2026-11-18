import { mkdtemp, mkdir, chmod, rm, statfs, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ARC_IMPORT_BLOB_MAX,
  ARC_IMPORT_DISK_MAX,
  ARC_IMPORT_PUSH_MAX,
  ARC_IMPORT_WARN_BYTES,
  ARC_IMPORT_REF_MAX,
  ARC_IMPORT_TIMEOUT_MS,
} from '../../packages/shared/src/constants/arc';

export class RunnerFailure extends Error {}
export interface RunnerBoundary {
  source: string;
  confirmLarge: boolean;
  sourceCredential?: () => Promise<string | undefined>;
  checkpoint: (
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  localTransport?: boolean;
  lfs?: (
    objects: LfsObject[],
    directory: string,
  ) => Promise<{
    missing: LfsObject[];
    upload: (destination: string, token: string) => Promise<void>;
  }>;
}
export interface LfsObject {
  oid: string;
  size: number;
  paths: string[];
}
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_OBJECTS = 2_000_000;
const ENVELOPE = 1024 * 1024;

export async function runImport(boundary: RunnerBoundary) {
  if (
    !boundary.localTransport &&
    !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      boundary.source,
    )
  )
    throw new RunnerFailure('invalid_source');
  const root = await mkdtemp(join(tmpdir(), 'init-arc-'));
  await chmod(root, 0o700);
  const home = join(root, 'home');
  const templates = join(root, 'templates');
  await mkdir(home, { mode: 0o700 });
  await mkdir(templates, { mode: 0o700 });
  const directory = join(root, 'source.git');
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  const started = Date.now();
  let cancelled = false;
  const kill = (child: ReturnType<typeof Bun.spawn>) => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const stop = () => {
    cancelled = true;
    for (const child of children) kill(child);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const timer = setTimeout(stop, ARC_IMPORT_TIMEOUT_MS);
  const initialSpace = await statfs(root);
  const initialFree = initialSpace.bavail * initialSpace.bsize;
  const disk = setInterval(
    () =>
      void statfs(root).then((s) => {
        if (
          s.bavail * s.bsize < 2 * 1024 ** 3 ||
          initialFree - s.bavail * s.bsize > ARC_IMPORT_DISK_MAX
        )
          stop();
      }),
    1000,
  );
  const baseConfig = [
    ['core.hooksPath', '/dev/null'],
    ['credential.helper', ''],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['http.followRedirects', 'false'],
    ['fetch.fsckObjects', 'true'],
    ['transfer.fsckObjects', 'true'],
    ['submodule.recurse', 'false'],
    ['pack.threads', '1'],
    ['pack.windowMemory', '64m'],
    ['core.deltaBaseCacheLimit', '64m'],
    ['http.maxRequests', '4'],
    ['maintenance.auto', 'false'],
    ['gc.auto', '0'],
    ['core.attributesFile', '/dev/null'],
    ['core.pager', 'cat'],
    ...(boundary.localTransport ? [['protocol.file.allow', 'always']] : []),
  ];
  function env(token?: string) {
    const configs = [
      ...baseConfig,
      ...(token
        ? [
            [
              'http.https://github.com/.extraHeader',
              `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
            ],
          ]
        : []),
    ];
    const result: Record<string, string> = {
      PATH: process.env.PATH!,
      HOME: home,
      LANG: 'C.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_CONFIG_COUNT: String(configs.length),
    };
    configs.forEach(([key, value], i) => {
      result[`GIT_CONFIG_KEY_${i}`] = key!;
      result[`GIT_CONFIG_VALUE_${i}`] = value!;
    });
    return result;
  }
  async function command(
    args: string[],
    options: { input?: string; token?: string; count?: boolean } = {},
  ) {
    if (cancelled || Date.now() - started > ARC_IMPORT_TIMEOUT_MS)
      throw new RunnerFailure('cancelled');
    const argv =
      process.platform === 'linux'
        ? ['prlimit', '--as=2147483648', '--nproc=256', '--', 'git', ...args]
        : ['git', ...args];
    const child = Bun.spawn(argv, {
      detached: true,
      env: env(options.token),
      stdin: options.input === undefined ? 'ignore' : new Blob([options.input]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.add(child);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    const read = async (
      stream: ReadableStream<Uint8Array>,
      capture: boolean,
    ) => {
      let total = 0;
      for await (const chunk of stream) {
        total += chunk.length;
        if (capture) {
          bytes += chunk.length;
          if (!options.count) chunks.push(chunk);
          if (bytes >= (options.count ? ARC_IMPORT_PUSH_MAX : MAX_OUTPUT)) {
            kill(child);
            throw new RunnerFailure(
              options.count ? 'push_too_large' : 'output_limit',
            );
          }
        } else if (total > MAX_OUTPUT) {
          kill(child);
          throw new RunnerFailure('output_limit');
        }
      }
    };
    try {
      await Promise.all([read(child.stdout, true), read(child.stderr, false)]);
      if (await child.exited) throw new RunnerFailure('git_failed');
      return options.count
        ? String(bytes)
        : Buffer.concat(chunks).toString('utf8');
    } finally {
      await child.exited;
      children.delete(child);
    }
  }
  const git = (args: string[], options?: Parameters<typeof command>[1]) =>
    command(['-C', directory, ...args], options);
  try {
    const space = await statfs(root);
    if (space.bavail * space.bsize < ARC_IMPORT_DISK_MAX + 2 * 1024 ** 3)
      throw new RunnerFailure('disk_insufficient');
    const sourceToken = await boundary.sourceCredential?.();
    const head = await command(
      ['ls-remote', '--symref', boundary.source, 'HEAD'],
      { token: sourceToken },
    );
    const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head)?.[1];
    await command(
      [
        'clone',
        '--bare',
        '--no-local',
        '--no-hardlinks',
        `--template=${templates}`,
        '--',
        boundary.source,
        directory,
      ],
      { token: sourceToken },
    );
    const all = (
      await git(['for-each-ref', '--format=%(refname) %(objectname)'])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    if (all.length > ARC_IMPORT_REF_MAX) throw new RunnerFailure('ref_limit');
    const refs: Record<string, string> = {};
    for (const line of all) {
      const [ref, oid] = line.split(' ');
      await git(['check-ref-format', ref!]);
      if (/^refs\/(heads|tags)\//.test(ref!)) refs[ref!] = oid!;
      else await git(['update-ref', '-d', ref!, oid!]);
    }
    if (
      Object.keys(refs).length &&
      (!defaultBranch || !refs[`refs/heads/${defaultBranch}`])
    )
      throw new RunnerFailure('default_branch_missing');
    if (defaultBranch)
      await git(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
    await git(['fsck', '--full', '--no-reflogs']);
    if (defaultBranch) {
      const rootEntries = (
        await git(['ls-tree', '-z', `refs/heads/${defaultBranch}`])
      )
        .split('\0')
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf('\t');
          const [mode, type, oid] = line.slice(0, tab).split(' ');
          return { mode, type, oid, path: line.slice(tab + 1) };
        });
      const recognized = /^(?:license(?:\.md|\.txt)?|licence.*|copying.*)$/i;
      for (const entry of rootEntries) {
        if (
          /licen[cs]e|copying/i.test(entry.path) &&
          !recognized.test(entry.path) &&
          !/^LICENSE-ORIGINAL/i.test(entry.path)
        )
          throw new RunnerFailure('licence_review_required');
        if (
          recognized.test(entry.path) &&
          (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode!))
        )
          throw new RunnerFailure('licence_review_required');
      }
      const readmes = rootEntries.filter((e) =>
        /^readme(?:\.md|\.txt)?$/i.test(e.path),
      );
      if (readmes.length > 1) throw new RunnerFailure('readme_review_required');
      if (readmes[0]) {
        const readme = readmes[0];
        if (
          readme.type !== 'blob' ||
          !['100644', '100755'].includes(readme.mode!) ||
          Number(await git(['cat-file', '-s', readme.oid!])) > 1_000_000
        )
          throw new RunnerFailure('readme_review_required');
        const content = await git(['cat-file', 'blob', readme.oid!]);
        if (content.includes('\0') || content.includes('\ufffd'))
          throw new RunnerFailure('readme_review_required');
      }
    }

    const reachable = (
      await git(['rev-list', '--objects', '--all', '--no-object-names'])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    if (reachable.length > MAX_OBJECTS) throw new RunnerFailure('object_limit');
    const objects = reachable.length
      ? (
          await git(
            [
              'cat-file',
              '--batch-check=%(objectname) %(objecttype) %(objectsize)',
            ],
            { input: reachable.join('\n') + '\n' },
          )
        )
          .trim()
          .split('\n')
      : [];
    const pointers = new Map<string, LfsObject>();
    for (const entry of objects) {
      const [oid, type, sizeText] = entry.split(' ');
      const size = Number(sizeText);
      if (type !== 'blob') continue;
      if (size > ARC_IMPORT_BLOB_MAX) {
        const commits = (await git(['rev-list', '--all'])).trim().split('\n');
        let path = '';
        for (const commit of commits) {
          const entries = (await git(['ls-tree', '-r', '-z', commit])).split(
            '\0',
          );
          const found = entries.find((e) =>
            e.split('\t')[0]?.endsWith(` ${oid}`),
          );
          if (found) {
            path = found.slice(found.indexOf('\t') + 1);
            break;
          }
        }
        await boundary.checkpoint({
          phase: 'failed',
          error: 'blob_too_large',
          diagnostic: JSON.stringify({ oid, path }).slice(0, 8192),
        });
        throw new RunnerFailure('blob_too_large');
      }
      if (size > 1024 || size < 100) continue;
      const blob = await git(['cat-file', 'blob', oid!]);
      const pointer =
        /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n?$/.exec(
          blob,
        );
      if (pointer) {
        const n = Number(pointer[2]);
        if (!Number.isSafeInteger(n))
          throw new RunnerFailure('invalid_lfs_pointer');
        const previous = pointers.get(pointer[1]!);
        if (previous && previous.size !== n)
          throw new RunnerFailure('invalid_lfs_pointer');
        pointers.set(pointer[1]!, { oid: pointer[1]!, size: n, paths: [] });
      }
    }
    if (pointers.size) {
      const commits = (await git(['rev-list', '--all']))
        .trim()
        .split('\n')
        .filter(Boolean);
      const byBlob = new Map<string, LfsObject>();
      for (const entry of objects) {
        const [oid, type, size] = entry.split(' ');
        if (type !== 'blob' || Number(size) > 1024) continue;
        const pointer = /oid sha256:([a-f0-9]{64})/.exec(
          await git(['cat-file', 'blob', oid!]),
        );
        if (pointer && pointers.has(pointer[1]!))
          byBlob.set(oid!, pointers.get(pointer[1]!)!);
      }
      for (const commit of commits) {
        for (const entry of (await git(['ls-tree', '-r', '-z', commit])).split(
          '\0',
        )) {
          const tab = entry.indexOf('\t');
          const oid = entry.slice(0, tab).split(' ')[2];
          const pointer = byBlob.get(oid ?? '');
          const path = entry.slice(tab + 1);
          if (
            pointer &&
            pointer.paths.length < 20 &&
            !pointer.paths.includes(path)
          )
            pointer.paths.push(path);
        }
      }
    }
    const gitBytes = Object.keys(refs).length
      ? Number(
          await git(
            [
              'pack-objects',
              '--stdout',
              '--revs',
              '--window=0',
              '--depth=0',
              '--no-reuse-delta',
              '--no-reuse-object',
              '--compression=0',
            ],
            { input: Object.values(refs).join('\n') + '\n', count: true },
          ),
        )
      : 0;
    const pushBoundBytes =
      gitBytes +
      ENVELOPE +
      Object.keys(refs).reduce((n, ref) => n + Buffer.byteLength(ref) + 128, 0);
    const lfsBytes = [...pointers.values()].reduce(
      (total, p) => total + p.size,
      0,
    );
    if (pushBoundBytes >= ARC_IMPORT_PUSH_MAX)
      throw new RunnerFailure('push_too_large');
    if (gitBytes + lfsBytes > ARC_IMPORT_WARN_BYTES && !boundary.confirmLarge) {
      await boundary.checkpoint({
        phase: 'checked',
        refs,
        defaultBranch,
        gitBytes,
        lfsBytes,
        pushBoundBytes,
        missingLfs: [],
      });
      throw new RunnerFailure('size_confirmation_required');
    }
    if (gitBytes * 3 + lfsBytes > ARC_IMPORT_DISK_MAX)
      throw new RunnerFailure('disk_limit');
    const lfs = await (
      boundary.lfs ?? publicLfs(boundary.source, boundary.sourceCredential)
    )([...pointers.values()], root);
    const target = await boundary.checkpoint({
      phase: 'checked',
      refs,
      defaultBranch,
      gitBytes,
      lfsBytes,
      pushBoundBytes,
      missingLfs: lfs.missing,
    });
    const authorization = await boundary.checkpoint({ phase: 'push' });
    const destination = String(authorization.destination ?? target.destination);
    const token = String(authorization.token ?? target.token ?? '');
    if (
      !boundary.localTransport &&
      !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\.git$/.test(
        destination,
      )
    )
      throw new RunnerFailure('invalid_destination');
    await lfs.upload(destination, token);
    await git(['remote', 'add', 'arc', destination]);
    const expected = (authorization.expectedRefs ?? {}) as Record<
      string,
      string
    >;
    const advertised = await git(['ls-remote', '--refs', 'arc'], { token });
    const actual = Object.fromEntries(
      advertised
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [oid, ref] = l.split('\t');
          return [ref, oid];
        }),
    );
    if (
      JSON.stringify(Object.entries(actual).sort()) !==
      JSON.stringify(Object.entries(expected).sort())
    )
      throw new RunnerFailure('destination_changed');
    if (
      Object.keys(expected).length &&
      !Object.keys(refs).length &&
      authorization.keepEmptySeed
    ) {
      await boundary.checkpoint({ phase: 'pushed' });
      await boundary.checkpoint({ phase: 'notice' });
      await boundary.checkpoint({ phase: 'finish' });
      return;
    }
    if (Object.keys(expected).length) {
      if (!Object.keys(refs).length)
        throw new RunnerFailure('empty_replacement');
      const leases = Object.keys(refs).map(
        (ref) => `--force-with-lease=${ref}:${expected[ref] ?? ''}`,
      );
      await git(
        [
          '-c',
          'pack.window=0',
          '-c',
          'pack.depth=0',
          'push',
          '--atomic',
          ...leases,
          'arc',
          ...Object.keys(refs).map((ref) => `${ref}:${ref}`),
        ],
        { token },
      );
      const staged = await boundary.checkpoint({ phase: 'staged' });
      const intermediate = staged.expectedRefs as Record<string, string>;
      const deletes = Object.keys(intermediate).filter((ref) => !refs[ref]);
      if (deletes.length)
        await git(
          [
            'push',
            '--atomic',
            ...deletes.map(
              (ref) => `--force-with-lease=${ref}:${intermediate[ref]}`,
            ),
            'arc',
            ...deletes.map((ref) => `:${ref}`),
          ],
          { token: String(staged.token ?? token) },
        );
    } else if (Object.keys(refs).length)
      await git(
        [
          '-c',
          'pack.window=0',
          '-c',
          'pack.depth=0',
          'push',
          '--mirror',
          '--atomic',
          'arc',
        ],
        { token },
      );
    await boundary.checkpoint({ phase: 'pushed' });
    await boundary.checkpoint({ phase: 'notice' });
    await boundary.checkpoint({ phase: 'finish' });
  } finally {
    clearTimeout(timer);
    clearInterval(disk);
    stop();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await rm(root, { recursive: true, force: true });
  }
}

function safeStorage(href: string) {
  const url = new URL(href);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === 'github.com' ||
      url.hostname === 'github-cloud.s3.amazonaws.com' ||
      url.hostname.endsWith('.githubusercontent.com')
    )
  )
    throw new RunnerFailure('lfs_host_refused');
  return url;
}
function storageHeaders(url: URL, headers: Record<string, string> = {}) {
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      /[\r\n]/.test(value) ||
      !(
        key === 'content-type' ||
        key === 'content-length' ||
        key.startsWith('x-amz-') ||
        (key === 'authorization' && url.hostname === 'github.com')
      )
    )
      throw new RunnerFailure('lfs_headers_require_review');
  }
  return headers;
}
export function publicLfs(
  source: string,
  credential?: () => Promise<string | undefined>,
): NonNullable<RunnerBoundary['lfs']> {
  return async (objects, directory) => {
    const missing: LfsObject[] = [];
    async function batch(url: string, operation: string, token?: string) {
      const response = await fetch(`${url}/info/lfs/objects/batch`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/vnd.git-lfs+json',
          ...(token
            ? {
                Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
              }
            : {}),
        },
        body: JSON.stringify({
          operation,
          transfers: ['basic'],
          objects: objects.map(({ oid, size }) => ({ oid, size })),
        }),
      });
      if (!response.ok) throw new RunnerFailure('lfs_service_failed');
      const text = await response.text();
      if (text.length > MAX_OUTPUT) throw new RunnerFailure('lfs_output_limit');
      return JSON.parse(text) as {
        transfer?: string;
        objects: {
          oid: string;
          size: number;
          error?: { code: number };
          actions?: Record<
            string,
            { href: string; header?: Record<string, string> }
          >;
        }[];
      };
    }
    if (objects.length) {
      const answer = await batch(source, 'download', await credential?.());
      if (answer.transfer && answer.transfer !== 'basic')
        throw new RunnerFailure('lfs_transfer_refused');
      if (answer.objects.length !== objects.length)
        throw new RunnerFailure('lfs_incomplete_response');
      for (const object of objects) {
        const entry = answer.objects.find(
          (e) => e.oid === object.oid && e.size === object.size,
        );
        if (!entry) throw new RunnerFailure('lfs_incomplete_response');
        if (entry.error?.code === 404 || entry.error?.code === 410) {
          missing.push(object);
          continue;
        }
        if (entry.error || !entry.actions?.download)
          throw new RunnerFailure('lfs_download_failed');
        const action = entry.actions.download;
        const url = safeStorage(action.href);

        const response = await fetch(url, {
          headers: storageHeaders(url, action.header),
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok || !response.body)
          throw new RunnerFailure('lfs_download_failed');
        const file = Bun.file(join(directory, object.oid));
        const writer = file.writer();
        const hash = createHash('sha256');
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > object.size) throw new RunnerFailure('lfs_corrupt');
            hash.update(chunk);
            writer.write(chunk);
          }
        } finally {
          await writer.end();
        }
        if (size !== object.size || hash.digest('hex') !== object.oid)
          throw new RunnerFailure('lfs_corrupt');
        if ((await stat(file.name!)).size !== object.size)
          throw new RunnerFailure('lfs_corrupt');
      }
    }
    return {
      missing,
      upload: async (destination, token) => {
        if (!objects.length) return;
        const response = await batch(destination, 'upload', token);
        if (response.transfer && response.transfer !== 'basic')
          throw new RunnerFailure('lfs_transfer_refused');
        for (const object of objects.filter((o) => !missing.includes(o))) {
          const entry = response.objects.find(
            (e) => e.oid === object.oid && e.size === object.size,
          );
          if (!entry || entry.error)
            throw new RunnerFailure('lfs_upload_failed');
          const action = entry.actions?.upload;
          if (action) {
            const url = safeStorage(action.href);
            const sent = await fetch(url, {
              method: 'PUT',
              headers: storageHeaders(url, action.header),
              body: Bun.file(join(directory, object.oid)),
              redirect: 'error',
              signal: AbortSignal.timeout(120_000),
            });
            if (!sent.ok) throw new RunnerFailure('lfs_upload_failed');
          }
          if (entry.actions?.verify) {
            const action = entry.actions.verify;
            const url = safeStorage(action.href);
            const verified = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/vnd.git-lfs+json',
                ...storageHeaders(url, action.header),
              },
              body: JSON.stringify({ oid: object.oid, size: object.size }),
              redirect: 'error',
              signal: AbortSignal.timeout(30_000),
            });
            if (!verified.ok) throw new RunnerFailure('lfs_verify_failed');
          }
        }
        const confirmed = await batch(destination, 'download', token);
        for (const object of objects.filter((o) => !missing.includes(o)))
          if (
            !confirmed.objects.some(
              (e) => e.oid === object.oid && e.size === object.size && !e.error,
            )
          )
            throw new RunnerFailure('lfs_destination_missing');
      },
    };
  };
}

async function main() {
  const id = process.env.IMPORT_ID!;
  const api = process.env.IMPORT_API_URL!;
  if (
    !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(api) ||
    !/^[a-f0-9-]{36}$/.test(id)
  )
    throw new RunnerFailure('configuration_invalid');
  function mask(value: unknown) {
    if (typeof value !== 'string' || !value) return;
    console.log(
      `::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`,
    );
  }
  async function post(path: string, body: unknown, credential?: string) {
    const response = await fetch(`${api}/arc-import/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new RunnerFailure(
        failure?.error && /^[a-z_]{1,64}$/.test(failure.error)
          ? failure.error
          : 'api_refused',
      );
    }
    const result = (await response.json()) as Record<string, unknown>;
    for (const key of [
      'ticket',
      'credential',
      'token',
      'source',
      'sourceToken',
      'destination',
    ])
      mask(result[key]);
    for (const token of [result.token, result.sourceToken])
      if (typeof token === 'string')
        mask(Buffer.from(`x-access-token:${token}`).toString('base64'));
    return result;
  }
  const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL!);
  oidcUrl.searchParams.set('audience', `${api}/arc-import`);
  const response = await fetch(oidcUrl, {
    headers: {
      Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    },
    redirect: 'error',
  });
  if (!response.ok) throw new RunnerFailure('oidc_unavailable');
  const oidc = (await response.json()) as { value: string };
  mask(oidc.value);
  const bootstrap = await post('bootstrap', { id, oidc: oidc.value });
  const redeemed = await post('redeem', { ticket: bootstrap.ticket });
  let sequence = 0;
  const credential = String(redeemed.credential);
  const heartbeat = setInterval(
    () =>
      void post(`${id}/heartbeat`, {}, credential).catch(() =>
        process.kill(process.pid, 'SIGTERM'),
      ),
    30_000,
  );
  try {
    await runImport({
      source: String(redeemed.source),
      sourceCredential: async () => {
        const result = await post(`${id}/source-credential`, {}, credential);
        return typeof result.sourceToken === 'string'
          ? result.sourceToken
          : undefined;
      },
      confirmLarge: !!redeemed.confirmLarge,
      checkpoint: async (data) => {
        const response = await post(
          `${id}/checkpoint`,
          { ...data, sequence: sequence + 1 },
          credential,
        );
        sequence++;
        return response;
      },
    });
  } catch (error) {
    await post(
      `${id}/checkpoint`,
      {
        phase: 'failed',
        sequence: sequence + 1,
        error: error instanceof RunnerFailure ? error.message : 'runner_failed',
      },
      credential,
    ).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
if (import.meta.main)
  main().catch(() => {
    console.error(
      'Repository import stopped. See the authorized project panel for status.',
    );
    process.exitCode = 1;
  });
