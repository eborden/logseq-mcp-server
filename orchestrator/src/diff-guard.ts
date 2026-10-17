// The diff guard (#629 review): a pure function over the paths a session's branch changed, run by `guardBranch` before
// the orchestrator pushes. It does not trust the session's permission rules to keep it out of the files that steer the
// repo's own automation: a same-repo PR runs its own edited workflow in CI, and a changed `CLAUDE.md` or a changed
// permission default reaches every later session. The deny rules for the file tools name the same paths
// (`DEFAULT_DISALLOWED_TOOLS`), but the syntax of those rules was not verified against a real session, so this guard
// is the one that does not depend on a CLI semantic.
//
// It reads names only, never contents, and it returns counts: the failure that comes out of it carries no path.
// This file imports nothing from Node.

/** More files than this is unexpected for one issue and is refused, not reviewed. */
export const MAX_CHANGED_FILES = 300;

/** Directories nobody but a person changes. Compared in lower case: the checkout may be on a case-insensitive disk. */
export const PROTECTED_PREFIXES: readonly string[] = [
  '.github/',
  '.claude/',
  'docs/adr/',
  'docs/business-rules/',
  // The orchestrator's own database and logs.
  'orchestrator/.temporal/',
];

/** Single files nobody but a person changes, at that exact path. */
export const PROTECTED_FILES: readonly string[] = [
  // The files that decide what a session may do, what it is asked and what is pushed: a session that edits them
  // widens the next session, so they change in a PR a person writes.
  'orchestrator/src/config.ts',
  'orchestrator/src/claude-session-policy.ts',
  'orchestrator/src/activities/claude-session.ts',
  'orchestrator/src/activities/branch.ts',
  'orchestrator/src/diff-guard.ts',
  'orchestrator/src/branch-types.ts',
];

/** File names protected at any depth. */
const PROTECTED_BASENAMES: readonly string[] = ['claude.md', 'claude.local.md'];
const PROTECTED_EXTENSIONS: readonly string[] = ['.pem', '.key', '.sqlite', '.sqlite-journal'];

export type DiffVerdict =
  | { readonly ok: true; readonly files: number }
  | {
      readonly ok: false;
      readonly reason: 'EmptyDiff' | 'DiffTooLarge' | 'ProtectedPath';
      readonly files: number;
      /** How many of the changed paths are protected. A count: no path is returned. */
      readonly protectedPaths: number;
    };

/** Whether one repo-relative path, as `git diff --name-only` prints it, is protected. */
export function isProtectedPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower.startsWith('/') || lower.split('/').some((part) => part === '..' || part === '.git')) {
    // Not a path inside the work tree: never expected from git, and never allowed through.
    return true;
  }
  const baseName = lower.slice(lower.lastIndexOf('/') + 1);
  return (
    PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    PROTECTED_FILES.includes(lower) ||
    PROTECTED_BASENAMES.includes(baseName) ||
    baseName.startsWith('.env') ||
    PROTECTED_EXTENSIONS.some((extension) => baseName.endsWith(extension))
  );
}

/** Decides whether a branch that changed exactly these paths may be pushed. */
export function checkChangedPaths(paths: readonly string[]): DiffVerdict {
  const protectedPaths = paths.filter(isProtectedPath).length;
  if (paths.length === 0) {
    return { ok: false, reason: 'EmptyDiff', files: 0, protectedPaths };
  }
  if (protectedPaths > 0) {
    return { ok: false, reason: 'ProtectedPath', files: paths.length, protectedPaths };
  }
  if (paths.length > MAX_CHANGED_FILES) {
    return { ok: false, reason: 'DiffTooLarge', files: paths.length, protectedPaths };
  }
  return { ok: true, files: paths.length };
}
