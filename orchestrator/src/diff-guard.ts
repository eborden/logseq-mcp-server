// The diff guard (#629 review): pure functions over what a session's branch changed, run by `guardBranch` before the
// orchestrator pushes. It does not trust the session's permission rules to keep it out of the files that steer the
// repo's own automation. The deny rules for the file tools name the same paths (`protectedDenyRules`), but their path
// syntax was not verified against a real session, so this guard is the one that does not depend on a CLI semantic.
//
// THE PRINCIPLE. A session may change the feature: the source, the tests and the docs it was asked to change. It may
// not change anything that decides how code is built, run, tested, released or permitted, because the next command
// (an allowed `npm run`, `cargo build`, the worker's own git, a same-repo PR's CI) executes it with more reach than the
// session has. So a path is protected when it is
//   1. executed by an allowed command as an entry point, or by the worker or CI: package manifests and lockfiles
//      (their scripts run), `build.rs`, `scripts/`, hooks (`.husky/`, `.githooks/`), test and build tool configs
//      (`vitest.config.*` and the like are JavaScript that runs);
//   2. a configuration that changes how git, npm, cargo, node or claude behave: `.npmrc`, `.cargo/`,
//      `rust-toolchain*`, `.gitattributes`, `.gitmodules`, `.gitignore` (it decides what `git add` skips), `.mcp.json`, `.claude/`,
//      `CLAUDE.md` at any depth, anything under a `.git` directory, `.env*`, keys and database files;
//   3. a CI or release file, or a rule CI enforces: `.github/`, `CODEOWNERS`, `.claude-plugin/` (its
//      entry runs the launcher for users), `pypi/` (release packaging), `about.toml`, `Dockerfile*`, `docs/adr/`,
//      `docs/business-rules/`, `tests/guards/`, `tests/rust-guards/`;
//   4. the orchestrator itself (`orchestrator/src/`), which decides what the next session may do, and the
//      dependencies it installs.
// Changing dependencies (`package.json`, `Cargo.toml` and their lockfiles) is on the list on purpose: foundations 7
// asks for a verified, maintained dependency, and a person does that. So an issue that must change one of these files
// cannot be implemented by the orchestrator yet, and needs a human. That is by design for now.
//
// A branch is also refused when it changes a symlink, a submodule or a file mode (any entry whose mode is not a plain
// `100644` file, before or after), since a link can point a later write into a protected place.
//
// The guard reads names and modes, never contents, and returns counts: the failure that comes out of it carries no
// path. It compares in lower case (the checkout may be on a case-insensitive disk) and after normalising the path.
// This file imports nothing from Node.

/** More files than this is unexpected for one issue and is refused, not reviewed. */
export const MAX_CHANGED_FILES = 300;

/** Directories nobody but a person changes. Lower case, with the trailing slash. */
export const PROTECTED_PREFIXES: readonly string[] = [
  '.github/',
  '.claude/',
  '.claude-plugin/',
  'pypi/',
  '.cargo/',
  '.husky/',
  '.githooks/',
  '.devcontainer/',
  '.vscode/',
  'docs/adr/',
  'docs/business-rules/',
  'scripts/',
  'tests/guards/',
  'tests/rust-guards/',
  'orchestrator/src/',
  // The orchestrator's own database and logs.
  'orchestrator/.temporal/',
];

/** File names protected at any depth, as they are spelled (compared in lower case). */
export const PROTECTED_BASENAMES: readonly string[] = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  '.npmrc',
  'Cargo.toml',
  'Cargo.lock',
  'build.rs',
  'rust-toolchain',
  'rust-toolchain.toml',
  '.gitattributes',
  '.gitmodules',
  '.mcp.json',
  'about.toml',
  'about.hbs',
  'Makefile',
  'Dockerfile',
  '.pre-commit-config.yaml',
  'CODEOWNERS',
  '.gitignore',
];

/** File name prefixes protected at any depth: `.env`, `.env.local`, `Dockerfile.dev`, `docker-compose.yml`. */
export const PROTECTED_NAME_PREFIXES: readonly string[] = ['.env', 'Dockerfile', 'docker-compose', '.eslintrc', '.babelrc', '.mocharc'];

/** Extensions protected at any depth: keys and databases. */
export const PROTECTED_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.sqlite', '.sqlite-journal'];

/** Tool configs that are code: `vitest.config.ts`, `vite.config.mjs`, `jest.config.js`, `webpack.config.cjs`. */
const TOOL_CONFIG = /^(vitest|vite|jest|webpack|rollup|esbuild)\.config\.[a-z]+$/;

/**
 * One path as the guard compares it: lower case, with `\\` read as `/`, empty and `.` segments dropped and `..`
 * resolved. `undefined` when the path leaves the work tree (a `..` above the root, or an absolute path).
 */
export function normalizePath(path: string): string | undefined {
  const slashed = path.toLowerCase().replace(/\\/g, '/');
  if (slashed.startsWith('/')) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of slashed.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.pop() === undefined) {
        return undefined;
      }
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Whether one repo-relative path, as git prints it, is protected. */
export function isProtectedPath(path: string): boolean {
  const normal = normalizePath(path);
  if (normal === undefined || normal === '') {
    // Not a path inside the work tree: never expected from git, and never allowed through.
    return true;
  }
  const parts = normal.split('/');
  const baseName = parts[parts.length - 1] ?? '';
  return (
    parts.includes('.git') ||
    PROTECTED_PREFIXES.some((prefix) => normal.startsWith(prefix)) ||
    PROTECTED_BASENAMES.some((name) => name.toLowerCase() === baseName) ||
    PROTECTED_NAME_PREFIXES.some((prefix) => baseName.startsWith(prefix.toLowerCase())) ||
    PROTECTED_EXTENSIONS.some((extension) => baseName.endsWith(extension)) ||
    TOOL_CONFIG.test(baseName)
  );
}

/**
 * The same set as deny rules for the file tools, so the session is stopped before it writes and not only caught after.
 * The syntax of these rules (gitignore-like globs, `**` for any depth) is the CLI's and was not verified against a real
 * session, which is why the guard above is the backstop and the README's drill tests them.
 */
export function protectedDenyRules(): string[] {
  const globs = [
    ...PROTECTED_PREFIXES.map((prefix) => `${prefix}**`),
    '**/.git/**',
    ...PROTECTED_BASENAMES.map((name) => `**/${name}`),
    ...PROTECTED_NAME_PREFIXES.map((prefix) => `**/${prefix}*`),
    ...PROTECTED_EXTENSIONS.map((extension) => `**/*${extension}`),
    '**/vitest.config.*',
    '**/vite.config.*',
    '**/jest.config.*',
    '**/webpack.config.*',
    '**/rollup.config.*',
    '**/esbuild.config.*',
  ];
  return globs.flatMap((glob) => [`Edit(${glob})`, `Write(${glob})`]);
}

/** One entry of `git diff --raw`: a path and its modes before and after. */
export interface ChangedFile {
  readonly path: string;
  readonly oldMode: string;
  readonly newMode: string;
}

export class RawDiffError extends Error {
  constructor() {
    super('git printed a change list that is not in the expected raw form');
    this.name = 'RawDiffError';
  }
}

const RAW_META = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])[0-9]*$/;

/**
 * Parses `git diff --raw -z --no-renames` or `git log --raw -z --no-renames --format=`: `:<old> <new> <sha> <sha>
 * <status>` then the path, each ended by a NUL. Empty tokens (the separator between commits) are skipped. Anything
 * else throws, without quoting the output.
 */
export function parseRawDiff(output: string): ChangedFile[] {
  const tokens = output.split('\0').filter((token) => token !== '');
  const files: ChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const meta = RAW_META.exec(tokens[index] ?? '');
    const path = tokens[index + 1];
    if (meta === null || path === undefined || path.startsWith(':')) {
      throw new RawDiffError();
    }
    files.push({ oldMode: meta[1] ?? '', newMode: meta[2] ?? '', path });
  }
  return files;
}

/** A plain file, or no file at all (an addition has no old mode, a deletion no new one). */
function isPlainMode(mode: string): boolean {
  return mode === '000000' || mode === '100644';
}

export type DiffVerdict =
  | { readonly ok: true; readonly files: number }
  | {
      readonly ok: false;
      readonly reason: 'EmptyDiff' | 'DiffTooLarge' | 'ProtectedPath' | 'SpecialFile';
      readonly files: number;
      /** How many distinct changed paths are protected. A count: no path is returned. */
      readonly protectedPaths: number;
      /** How many entries are a symlink, a submodule or a mode change. */
      readonly specialFiles: number;
    };

/**
 * Decides whether a branch may be pushed. `history` is every change of every commit the push would publish
 * (`origin/<base>..<head>`), and `net` is the branch's change as a whole (`origin/<base>...<head>`, the merge base to
 * the head). A protected path or a special file in ANY commit refuses the branch, even when a later commit undoes it:
 * the push publishes each commit, a secret or a workflow that was added and removed is still in the history. The net
 * change decides whether there is anything to push and whether it is too big to review.
 */
export function checkBranchChanges(net: readonly ChangedFile[], history: readonly ChangedFile[]): DiffVerdict {
  const all = [...history, ...net];
  const protectedPaths = new Set(all.filter((file) => isProtectedPath(file.path)).map((file) => normalizePath(file.path) ?? file.path)).size;
  const specialFiles = all.filter((file) => !isPlainMode(file.oldMode) || !isPlainMode(file.newMode)).length;
  const counts = { files: net.length, protectedPaths, specialFiles };
  if (protectedPaths > 0) {
    return { ok: false, reason: 'ProtectedPath', ...counts };
  }
  if (specialFiles > 0) {
    return { ok: false, reason: 'SpecialFile', ...counts };
  }
  if (net.length === 0) {
    return { ok: false, reason: 'EmptyDiff', ...counts };
  }
  if (net.length > MAX_CHANGED_FILES) {
    return { ok: false, reason: 'DiffTooLarge', ...counts };
  }
  return { ok: true, files: net.length };
}
