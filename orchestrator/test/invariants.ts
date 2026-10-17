// A tripwire, not a proof, for what the orchestrator must never do (#630, CLAUDE.md "Code review" and "Merge policy"):
// resolve a review thread, merge, approve or request changes, apply a label (`golden-change` above all), move a board
// item into Ready, or write to the board outside the GitHub activities. It reads source text, so it catches the forms a
// person would write to do those things: GraphQL mutation names, REST routes, `gh` argv, method names, event names. It
// looks through comments, string concatenation, `${'literal'}` and `[...].join('')` of literals.
//
// A perfect static check is impossible: a name built at run time from data (a config value, `String.fromCharCode`,
// base64, a table indexed by a variable) or loaded from another file is invisible to a text scan, and so is code that
// is not in `src/`. `eval` and `new Function` are refused so the easy way round is shut; the rest is the permission
// model, the token's scopes and review. Treat a pass as "no known form is present", never as "it cannot happen".

export interface SourceFile {
  readonly name: string;
  readonly text: string;
}

interface Rule {
  readonly label: string;
  readonly pattern: RegExp;
  /** Files (relative to `src/`) where the form is the activity's own job, and so allowed. */
  readonly allowedIn?: readonly string[];
}

const QUOTE = `['"\`]`;

const RULES: readonly Rule[] = [
  { label: 'resolve a thread', pattern: /resolveReviewThread|unresolveReviewThread|resolveThread|\/resolve['"`\s]/i },
  { label: 'merge', pattern: new RegExp(`mergePullRequest|enablePullRequestAutoMerge|\\/merge\\b|${QUOTE}merge${QUOTE}|--merge\\b|--squash|--rebase\\b|--auto\\b|\\bmerge(?:Pr|PullRequest|Pull)?\\s*\\(`, 'i') },
  { label: 'approve or request changes', pattern: new RegExp(`event:\\s*${QUOTE}(?:APPROVE|REQUEST_CHANGES)|${QUOTE}(?:APPROVE|REQUEST_CHANGES)${QUOTE}|--approve|--request-changes|addPullRequestReview|submitPullRequestReview|\\bapprove\\w*\\s*[(:=]`, 'i') },
  { label: 'label', pattern: new RegExp(`addLabelsToLabelable|removeLabelsFromLabelable|createLabel|--add-label|--remove-label|--label\\b|\\/labels\\b|${QUOTE}label${QUOTE}|\\b(?:add|set|apply|remove)Labels?\\b`, 'i') },
  { label: 'a board write by mutation', pattern: /updateProjectV2Item|addProjectV2Item|archiveProjectV2Item|deleteProjectV2Item/ },
  // The board activities are the one place that edits the board, and they have no move into Ready (the board tests pin it).
  { label: 'a board write by gh project', pattern: new RegExp(`${QUOTE}item-(?:edit|add|archive|delete)${QUOTE}`), allowedIn: ['activities/github.ts'] },
  { label: 'gh pr or gh issue that writes', pattern: new RegExp(`${QUOTE}(?:pr|issue)${QUOTE}\\s*,\\s*${QUOTE}(?:merge|review|edit|ready|close|reopen|lock)${QUOTE}`) },
  { label: 'dynamic code', pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/ },
];

/**
 * The code of a file with comments removed and obvious string building put back together. A block comment ends at its
 * `*` + `/`, and code after it on the same line is kept; a `//` comment is dropped only when it is the whole line.
 * A `/*` counts as a comment start only after a line start, a space or one of `;{}()`, so a glob like `src/**` in a
 * string does not swallow the code that follows it.
 */
export function normalise(text: string): string {
  const code = text
    .replace(/(^|[\s;{}()])\/\*[\s\S]*?\*\//g, '$1')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return code
    .replace(/\[\s*((?:['"`][^'"`\n]*['"`]\s*,?\s*)+)\]\s*\.join\(\s*(['"`])([^'"`\n]*)\2\s*\)/g, (_all, items: string, _quote: string, separator: string) =>
      `'${[...items.matchAll(/['"`]([^'"`\n]*)['"`]/g)].map((match) => match[1]).join(separator)}'`,
    )
    .replace(/\$\{\s*(['"`])([^'"`$\n]*)\1\s*\}/g, '$2')
    .replace(/['"`]\s*\+\s*['"`]/g, '');
}

/** The rules a set of files breaks, as `file: rule`. Empty when none does. */
export function forbiddenCalls(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const { name, text } of files) {
    const code = normalise(text);
    for (const rule of RULES) {
      if (rule.allowedIn?.includes(name) !== true && rule.pattern.test(code)) {
        found.push(`${name}: ${rule.label}`);
      }
    }
  }
  return found;
}
