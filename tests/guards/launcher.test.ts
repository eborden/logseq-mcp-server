import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { fileURLToPath } from 'url';

// The launcher (ADR-0035, #419): scripts/logseq-mcp-server.sh finds the release binary for this platform and this
// checkout's version, downloads it, checks it against SHA256SUMS, caches it and `exec`s it. These tests run the real
// script against a fake release directory over file:// (and a local HTTP server), with a fake `uname` and, where a
// tool must be missing, a PATH of symlinks. Nothing here contacts GitHub or a LogSeq (BR-0001).

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_LAUNCHER = join(ROOT, 'scripts', 'logseq-mcp-server.sh');
const NAME = 'logseq-mcp-server';
const VERSION = '9.8.7';
const TARGET = 'x86_64-unknown-linux-musl';
const STUB_OUTPUT = 'stub-server-ran';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** A stand-in server: says one fixed line, then echoes its arguments and the first line of stdin. */
const STUB_BINARY = `#!/bin/sh
echo "${STUB_OUTPUT}"
echo "args=$*"
read -r line
echo "stdin=$line"
`;

interface Release {
  /** The directory of release files (what the base URL names). */
  dir: string;
  files: Record<string, string>;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let scratch: string;
let pluginRoot: string;
let launcher: string;
let cacheRoot: string;
let fakeBin: string;

const cacheDir = () => join(cacheRoot, NAME, VERSION);

/** Everything under the cache root, relative, so a test can say "nothing was left behind". */
function cacheContents(): string[] {
  if (!existsSync(cacheRoot)) return [];
  return readdirSync(cacheRoot, { recursive: true, encoding: 'utf-8' }).filter(p => statSync(join(cacheRoot, p)).isFile());
}

function writeExecutable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** A `uname` that answers `-s` and `-m` with the given values. */
function fakeUname(os: string, arch: string) {
  writeExecutable(join(fakeBin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo '${os}';; -m) echo '${arch}';; *) echo '${os}';; esac\n`);
}

/** A release directory for `target` with the four files and a matching SHA256SUMS. `tamper` changes a file after it was summed. */
function makeRelease(name: string, options: { target?: string; omit?: string[]; tamper?: Record<string, string>; sums?: (files: Record<string, string>) => string } = {}): Release {
  const target = options.target ?? TARGET;
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const asset = `${NAME}-${VERSION}-${target}`;
  const files: Record<string, string> = {
    [asset]: STUB_BINARY,
    LICENSE: 'MIT License\n',
    'THIRD-PARTY-NOTICES.txt': 'notices\n',
  };
  const sums = options.sums ? options.sums(files) : Object.entries(files).map(([file, body]) => `${sha256(body)}  ${file}`).join('\n') + '\n';
  const written: Record<string, string> = { ...files, ...options.tamper, SHA256SUMS: sums };
  const present = Object.fromEntries(Object.entries(written).filter(([file]) => !options.omit?.includes(file)));
  for (const [file, body] of Object.entries(present)) writeFileSync(join(dir, file), body);
  return { dir, files: present };
}

const fileUrl = (dir: string) => `file://${dir}`;

/** The launcher, as the plugin starts it: `sh <script> args`, stdin fed `input`. */
function run(env: Record<string, string>, options: { input?: string; args?: string[]; script?: string; path?: string } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [options.script ?? launcher, ...(options.args ?? [])], {
      env: { PATH: options.path ?? `${fakeBin}${delimiter}${process.env.PATH}`, HOME: join(scratch, 'home'), XDG_CACHE_HOME: cacheRoot, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    // a launcher that refuses to start exits without reading stdin, so the write can hit a closed pipe
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

/** A PATH holding only symlinks to the named tools, found on the real PATH. */
function pathWith(tools: string[]): string {
  const dir = join(scratch, 'toolbin');
  mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    const found = (process.env.PATH ?? '').split(delimiter).map(p => join(p, tool)).find(p => existsSync(p));
    if (!found) throw new Error(`the test needs ${tool} on PATH`);
    symlinkSync(found, join(dir, tool));
  }
  return `${fakeBin}${delimiter}${dir}`;
}

// Everything the launcher runs besides shell builtins. A test that removes one starts from this list.
const BASIC_TOOLS = ['awk', 'sed', 'tr', 'mkdir', 'mv', 'rm', 'chmod'];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'launcher-test-'));
  pluginRoot = join(scratch, 'plugin');
  mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
  launcher = join(pluginRoot, 'scripts', 'logseq-mcp-server.sh');
  copyFileSync(REAL_LAUNCHER, launcher);
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'x', version: VERSION, devDependencies: { zod: '3.25.76' } }, null, 2));
  cacheRoot = join(scratch, 'cache');
  fakeBin = join(scratch, 'fakebin');
  mkdirSync(fakeBin);
  mkdirSync(join(scratch, 'home'));
  fakeUname('Linux', 'x86_64');
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('a download that checks out', () => {
  it('installs the files, caches them and runs the binary with its own stdout, stdin and arguments', async () => {
    const release = makeRelease('release');
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) }, { args: ['--flag', 'x y'], input: 'hello\n' });

    // The launcher wrote nothing to stdout: it is exactly what the stub binary said.
    expect(result.stdout).toBe(`${STUB_OUTPUT}\nargs=--flag x y\nstdin=hello\n`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(cacheContents().sort()).toEqual(
      ['LICENSE', 'SHA256SUMS', 'THIRD-PARTY-NOTICES.txt', `${NAME}-${VERSION}-${TARGET}`].map(f => join(NAME, VERSION, f)).sort(),
    );
    expect(statSync(join(cacheDir(), `${NAME}-${VERSION}-${TARGET}`)).mode & 0o111).not.toBe(0);
  });

  it('downloads from a local HTTP server too', async () => {
    const release = makeRelease('release');
    const server = await serve(release.files);
    try {
      const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: `http://127.0.0.1:${port(server)}/` }, { input: 'hi\n' });
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(STUB_OUTPUT);
      expect(result.status).toBe(0);
    } finally {
      server.close();
    }
  });

  it('answers a 404 from the server with the missing file named, and installs nothing', async () => {
    const release = makeRelease('release', { omit: [`${NAME}-${VERSION}-${TARGET}`] });
    const server = await serve(release.files);
    try {
      const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: `http://127.0.0.1:${port(server)}` });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(`the release has no file named ${NAME}-${VERSION}-${TARGET}`);
      expect(cacheContents()).toEqual([]);
    } finally {
      server.close();
    }
  });

  it.each([
    ['Darwin', 'arm64', 'aarch64-apple-darwin'],
    ['Darwin', 'x86_64', 'x86_64-apple-darwin'],
    ['Linux', 'x86_64', 'x86_64-unknown-linux-musl'],
  ])('maps %s %s to %s', async (os, arch, target) => {
    fakeUname(os, arch);
    const release = makeRelease(`release-${target}`, { target });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(STUB_OUTPUT);
    expect(existsSync(join(cacheDir(), `${NAME}-${VERSION}-${target}`))).toBe(true);
  });

  it('puts the cache under ~/Library/Caches on macOS and ~/.cache elsewhere when XDG_CACHE_HOME is not set', async () => {
    const home = join(scratch, 'home');
    fakeUname('Darwin', 'arm64');
    const mac = makeRelease('mac', { target: 'aarch64-apple-darwin' });
    await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(mac.dir), XDG_CACHE_HOME: '' });
    expect(existsSync(join(home, 'Library', 'Caches', NAME, VERSION, `${NAME}-${VERSION}-aarch64-apple-darwin`))).toBe(true);

    fakeUname('Linux', 'x86_64');
    const linux = makeRelease('linux');
    await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(linux.dir), XDG_CACHE_HOME: '' });
    expect(existsSync(join(home, '.cache', NAME, VERSION, `${NAME}-${VERSION}-${TARGET}`))).toBe(true);
  });
});

describe('the cache', () => {
  it('runs a cached binary without touching the network or the release', async () => {
    const release = makeRelease('release');
    await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    rmSync(release.dir, { recursive: true });

    const second = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(second.stderr).toBe('');
    expect(second.stdout).toContain(STUB_OUTPUT);
    expect(second.status).toBe(0);

    // not even curl is needed
    const third = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) }, { path: pathWith(BASIC_TOOLS) });
    expect(third.stdout).toContain(STUB_OUTPUT);
  });

  it('keeps one version apart from another', async () => {
    const release = makeRelease('release');
    await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '9.8.8' }, null, 2));
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the release has no file named ${NAME}-9.8.8-${TARGET}`);
  });

  it('leaves no partial file behind, not even a staging directory, after a refusal', async () => {
    const release = makeRelease('release', { tamper: { [`${NAME}-${VERSION}-${TARGET}`]: 'not the binary\n' } });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.status).toBe(1);
    expect(cacheContents()).toEqual([]);
    // and not even an empty staging directory
    expect(existsSync(cacheDir()) ? readdirSync(cacheDir()) : []).toEqual([]);
  });
});

describe('refusals', () => {
  const asset = `${NAME}-${VERSION}-${TARGET}`;

  it('refuses a binary whose hash is not the listed one, and caches nothing', async () => {
    const release = makeRelease('release', { tamper: { [asset]: `${STUB_BINARY}# changed\n` } });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`checksum mismatch for ${asset}`);
    expect(result.stderr).toContain('LOGSEQ_MCP_BINARY');
    expect(cacheContents()).toEqual([]);
  });

  it.each(['LICENSE', 'THIRD-PARTY-NOTICES.txt'])('refuses a %s whose hash is not the listed one', async file => {
    const release = makeRelease('release', { tamper: { [file]: 'tampered\n' } });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`checksum mismatch for ${file}`);
    expect(cacheContents()).toEqual([]);
  });

  it('refuses a file that SHA256SUMS does not list', async () => {
    const release = makeRelease('release', { sums: files => `${sha256(files[asset])}  ${asset}\n` });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SHA256SUMS has no line for LICENSE');
    expect(cacheContents()).toEqual([]);
  });

  it('takes the binary-mode marker and upper-case digests of sha256sum output', async () => {
    const release = makeRelease('release', {
      sums: files => Object.entries(files).map(([file, body]) => `${sha256(body).toUpperCase()} *${file}`).join('\n') + '\n',
    });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([asset, 'SHA256SUMS', 'LICENSE', 'THIRD-PARTY-NOTICES.txt'])('says which file is missing from the release: %s', async file => {
    const release = makeRelease('release', { omit: [file] });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`the release has no file named ${file}`);
    expect(result.stderr).toContain('LOGSEQ_MCP_BINARY');
    expect(cacheContents()).toEqual([]);
  });

  it.each([
    ['MINGW64_NT-10.0', 'x86_64', 'Windows has no release binary yet'],
    ['Linux', 'aarch64', 'there is no release binary for this platform (Linux aarch64)'],
    ['FreeBSD', 'amd64', 'there is no release binary for this platform (FreeBSD amd64)'],
  ])('refuses %s %s before it downloads anything', async (os, arch, message) => {
    fakeUname(os, arch);
    const release = makeRelease('release');
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain('LOGSEQ_MCP_BINARY');
    expect(existsSync(cacheRoot)).toBe(false);
  });

  it('refuses a base URL that is not https, http or file', async () => {
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: 'ftp://example.invalid/x' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must start with https://, http:// or file://');
  });

  it('refuses a package.json it cannot take a version from', async () => {
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '1.0.0/../../x' }));
    const result = await run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read a valid version from package.json');
    rmSync(join(pluginRoot, 'package.json'));
    const missing = await run({});
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('cannot find package.json');
  });

  it('says so when the cache directory cannot be written', async () => {
    const blocker = join(scratch, 'blocker');
    writeFileSync(blocker, 'a file where a directory should be');
    const release = makeRelease('release');
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir), XDG_CACHE_HOME: blocker });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cannot create the cache directory');
    expect(result.stderr).toContain('XDG_CACHE_HOME');
  });

  it('says so when a cache directory exists but cannot be written into', async () => {
    const release = makeRelease('release');
    mkdirSync(cacheDir(), { recursive: true });
    chmodSync(cacheDir(), 0o555);
    try {
      const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) });
      // a root user can write into a 555 directory, so the refusal is only expected where the mode is enforced
      const enforced = process.getuid?.() !== 0;
      expect(result.status).toBe(enforced ? 1 : 0);
      expect(result.stderr).toEqual(enforced ? expect.stringContaining('cannot write to the cache directory') : '');
    } finally {
      chmodSync(cacheDir(), 0o755);
    }
  });
});

describe('what is missing from the machine', () => {
  it('names curl when it is not installed', async () => {
    const release = makeRelease('release');
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) }, { path: pathWith(BASIC_TOOLS) });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('curl is not installed');
    expect(result.stderr).toContain('LOGSEQ_MCP_BINARY');
    expect(existsSync(cacheRoot)).toBe(false);
  });

  it('names the hash tool when neither shasum nor sha256sum is installed', async () => {
    const release = makeRelease('release');
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) }, { path: pathWith([...BASIC_TOOLS, 'curl']) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('neither shasum nor sha256sum is installed');
    expect(existsSync(cacheRoot)).toBe(false);
  });

  it('works with either hash tool', async () => {
    for (const [name, hasher] of [['shasum', 'shasum'], ['sha256sum', 'sha256sum']] as const) {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(join(scratch, 'toolbin'), { recursive: true, force: true });
      const release = makeRelease(`release-${name}`);
      // a stand-in that computes the hash with Node, so the test needs neither tool installed
      const path = pathWith([...BASIC_TOOLS, 'curl']);
      const body =
        hasher === 'shasum'
          ? `#!/bin/sh\n[ "$1 $2" = "-a 256" ] || exit 2\nshift 2\nexec ${process.execPath} -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex")+"  "+process.argv[1])' "$1"\n`
          : `#!/bin/sh\nexec ${process.execPath} -e 'const c=require("crypto"),f=require("fs");console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex")+"  "+process.argv[1])' "$1"\n`;
      writeExecutable(join(scratch, 'toolbin', hasher), body);
      const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: fileUrl(release.dir) }, { path });
      expect(result.stderr, name).toBe('');
      expect(result.stdout, name).toContain(STUB_OUTPUT);
    }
  });

  it('names the network and the proxy variables when the download fails, and installs nothing', async () => {
    writeExecutable(join(fakeBin, 'curl'), '#!/bin/sh\nexit 7\n');
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: 'https://downloads.example.invalid/v1' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('could not download SHA256SUMS from https://downloads.example.invalid/v1 (curl exit 7)');
    expect(result.stderr).toContain('HTTPS_PROXY');
    expect(cacheContents()).toEqual([]);
  });

  it('never prints a credential from the base URL', async () => {
    writeExecutable(join(fakeBin, 'curl'), '#!/bin/sh\nexit 7\n');
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: 'https://user:s3cret-token@downloads.example.invalid/v1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('https://downloads.example.invalid/v1');
    expect(result.stderr).not.toContain('s3cret-token');
  });
});

describe('the overrides', () => {
  it('LOGSEQ_MCP_BINARY runs that binary with no download, no curl and no cache', async () => {
    const binary = join(scratch, 'my-server');
    writeExecutable(binary, STUB_BINARY);
    const result = await run({ LOGSEQ_MCP_BINARY: binary, LOGSEQ_MCP_RELEASE_BASE_URL: 'https://unreachable.invalid' }, { args: ['a'], input: 'x\n', path: pathWith([]) });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${STUB_OUTPUT}\nargs=a\nstdin=x\n`);
    expect(existsSync(cacheRoot)).toBe(false);
  });

  it('LOGSEQ_MCP_BINARY must be an absolute path to an executable file', async () => {
    const plain = join(scratch, 'plain');
    writeFileSync(plain, 'x');
    for (const [value, message] of [
      ['relative/server', 'must be an absolute path'],
      [join(scratch, 'absent'), 'does not name an executable file'],
      [plain, 'does not name an executable file'],
      [scratch, 'does not name an executable file'],
    ]) {
      const result = await run({ LOGSEQ_MCP_BINARY: value });
      expect(result.status, value).toBe(1);
      expect(result.stdout, value).toBe('');
      expect(result.stderr, value).toContain(message);
    }
  });

  it('LOGSEQ_MCP_BINARY passes the binary exit code through', async () => {
    const binary = join(scratch, 'failing');
    writeExecutable(binary, '#!/bin/sh\nexit 42\n');
    expect((await run({ LOGSEQ_MCP_BINARY: binary })).status).toBe(42);
  });

  it('LOGSEQ_MCP_RELEASE_BASE_URL still gets the checks: a bad checksum from the override is refused', async () => {
    const release = makeRelease('release', { tamper: { [`${NAME}-${VERSION}-${TARGET}`]: 'x' } });
    const result = await run({ LOGSEQ_MCP_RELEASE_BASE_URL: `${fileUrl(release.dir)}/` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum mismatch');
  });
});

describe('the default download', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

  it('asks https://github.com/eborden/logseq-mcp-server/releases/download/v<version>/ for this checkout version, over https only', async () => {
    const log = join(scratch, 'curl.log');
    writeExecutable(join(fakeBin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 6\n`);
    // the real script in the real checkout, so its version is the repository's own
    const result = await run({}, { script: REAL_LAUNCHER });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const calls = readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls).toHaveLength(1);
    const base = `https://github.com/eborden/logseq-mcp-server/releases/download/v${pkg.version}`;
    expect(calls[0]).toMatch(new RegExp(`(^| )${base.replace(/[.]/g, '\\.')}/SHA256SUMS$`));
    expect(calls[0]).toContain('--proto =https');
    expect(calls[0]).toContain('--proto-redir =https');
    expect(result.stderr).toContain(`from ${base}`);
  });

  it('names the other files by the pattern logseq-mcp-server-<version>-<target triple>', async () => {
    const log = join(scratch, 'curl.log');
    const release = makeRelease('release');
    // answers the SHA256SUMS request from the fake release and fails the next one, so the second URL is logged
    writeExecutable(
      join(fakeBin, 'curl'),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
out=''; prev=''
for arg in "$@"; do
  if [ "$prev" = --output ]; then out=$arg; fi
  prev=$arg
done
case "$arg" in
  */SHA256SUMS) cp '${join(release.dir, 'SHA256SUMS')}' "$out"; exit 0 ;;
esac
exit 6
`,
    );
    await run({}, { script: REAL_LAUNCHER });
    const calls = readFileSync(log, 'utf-8').trim().split('\n');
    expect(calls).toHaveLength(2);
    const base = `https://github.com/eborden/logseq-mcp-server/releases/download/v${pkg.version}`;
    expect(calls[1].endsWith(` ${base}/logseq-mcp-server-${pkg.version}-x86_64-unknown-linux-musl`)).toBe(true);
  });
});

describe('the script itself', () => {
  const text = readFileSync(REAL_LAUNCHER, 'utf-8');

  it('is POSIX sh, and executable in git', () => {
    expect(text.split('\n')[0]).toBe('#!/bin/sh');
    expect(statSync(REAL_LAUNCHER).mode & 0o111).not.toBe(0);
  });

  it('writes to stdout nowhere: every printf goes to stderr, or is a value for a substitution', () => {
    const lines = text.split('\n').filter(line => !line.trim().startsWith('#'));
    expect(lines.some(line => /\becho\b/.test(line))).toBe(false);
    const printfs = lines.filter(line => /\bprintf\b/.test(line));
    // say() writes to stderr, and shown() feeds a pipe into sed
    expect(printfs).toEqual([expect.stringContaining('>&2'), expect.stringContaining('| sed')]);
    expect(lines.some(line => /\bcat\b|\/dev\/stdout/.test(line))).toBe(false);
  });

  it('never falls back to a binary it has not checked: nothing runs the downloaded file before verify', () => {
    const verifyCalls = [...text.matchAll(/^verify "\$asset"$/gm)];
    expect(verifyCalls).toHaveLength(1);
    // the only exec of a downloaded file comes after the checks and the move into the cache
    const lastExec = text.lastIndexOf('exec "$cache/$asset"');
    expect(lastExec).toBeGreaterThan(text.indexOf('verify "$asset"'));
    expect(lastExec).toBeGreaterThan(text.indexOf('mv -f "$stage/$asset" "$cache/$asset"'));
  });
});

/** A local HTTP server that answers GET /<file> with the file's text, and 404 for anything else. */
function serve(files: Record<string, string>): Promise<Server> {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      const body = files[(request.url ?? '').replace(/^\//, '')];
      if (body === undefined) {
        response.writeHead(404).end('not found');
      } else {
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(body);
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  return address.port;
}
