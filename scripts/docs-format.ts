/**
 * Format guard for the ADR and business-rule docs (#78).
 *
 * Checks `docs/adr/` and `docs/business-rules/` against the "Format rules"
 * section of each directory's README: filenames and numbers, the README index,
 * required headings, ADR status lines, business-rule changelogs, Mechanical
 * enforcement lines and relative links. `src/docs-format.test.ts` runs it in the
 * unit tests (and so in CI) and feeds it synthetic fixtures through `memoryFs`.
 *
 * Reads files only. It never calls the GitHub API: a `none-yet` line is checked
 * for the form of its issue link, not for whether the issue exists.
 *
 * Usage: npx tsx scripts/docs-format.ts [repoRoot]
 * Prints one line per violation and exits 1 if there are any.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { posix, resolve as resolvePath } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// File access. Paths are POSIX and relative to the repo root.

export interface DirEntry {
  name: string;
  isFile: boolean;
}

export interface DocsFs {
  /** Entries directly in `dir`, or null when it does not exist. */
  readDir(dir: string): DirEntry[] | null;
  /** File content, or null when it is not a file. */
  readFile(path: string): string | null;
  /** True when `path` is a file or a directory. Matching is case-sensitive. */
  exists(path: string): boolean;
  /** True when `path` is a file. Matching is case-sensitive. */
  isFile(path: string): boolean;
}

/**
 * The real file system under `root`. Every path segment is matched against
 * directory entries, so the check is case-sensitive on macOS too and a path
 * that only differs in case fails locally the way it would on Linux CI.
 */
export function nodeFs(root: string): DocsFs {
  const lookup = (path: string): 'file' | 'dir' | null => {
    const segments = path.split('/').filter(s => s !== '' && s !== '.');
    let current = root;
    for (const segment of segments) {
      let names: string[];
      try {
        names = readdirSync(current);
      } catch {
        return null;
      }
      if (!names.includes(segment)) return null;
      current = `${current}/${segment}`;
    }
    try {
      return statSync(current).isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  };
  return {
    readDir(dir) {
      if (lookup(dir) !== 'dir') return null;
      return readdirSync(`${root}/${dir}`, { withFileTypes: true }).map(e => ({ name: e.name, isFile: e.isFile() }));
    },
    readFile(path) {
      return lookup(path) === 'file' ? readFileSync(`${root}/${path}`, 'utf-8') : null;
    },
    exists: path => lookup(path) !== null,
    isFile: path => lookup(path) === 'file',
  };
}

/** An in-memory tree for fixtures: keys are file paths, directories are implied. */
export function memoryFs(files: Record<string, string>): DocsFs {
  const norm = (p: string) => posix.normalize(p).replace(/\/$/, '');
  const paths = Object.keys(files).map(norm);
  const isDir = (dir: string) => dir === '.' || dir === '' || paths.some(p => p.startsWith(`${norm(dir)}/`));
  return {
    readDir(dir) {
      if (!isDir(dir)) return null;
      const prefix = norm(dir) === '.' ? '' : `${norm(dir)}/`;
      const entries = new Map<string, boolean>();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const name = rest.split('/')[0];
        entries.set(name, (entries.get(name) ?? false) || !rest.includes('/'));
      }
      return [...entries].map(([name, isFile]) => ({ name, isFile }));
    },
    readFile(path) {
      const key = Object.keys(files).find(k => norm(k) === norm(path));
      return key === undefined ? null : files[key];
    },
    exists: path => paths.includes(norm(path)) || isDir(path),
    isFile: path => paths.includes(norm(path)),
  };
}

// ---------------------------------------------------------------------------
// Results

export type RuleCode =
  | 'readme'
  | 'filename'
  | 'duplicate-number'
  | 'index'
  | 'title'
  | 'heading'
  | 'status'
  | 'changelog'
  | 'enforcement'
  | 'link';

export interface Violation {
  /** Repo-relative path of the file at fault. */
  file: string;
  /** 1-based line number, when the violation is on one line. */
  line?: number;
  rule: RuleCode;
  message: string;
}

export function formatViolation(v: Violation): string {
  return `${v.file}${v.line === undefined ? '' : `:${v.line}`}: [${v.rule}] ${v.message}`;
}

// ---------------------------------------------------------------------------
// Directory specs

export type DocKind = 'adr' | 'business-rule';

interface DocSpec {
  kind: DocKind;
  dir: string;
  headings: string[];
}

export const DOC_SPECS: Record<DocKind, DocSpec> = {
  adr: {
    kind: 'adr',
    dir: 'docs/adr',
    headings: ['Context', 'Decision', 'Consequences', 'Status', 'Mechanical enforcement'],
  },
  'business-rule': {
    kind: 'business-rule',
    dir: 'docs/business-rules',
    headings: ['Statement', 'Rationale', 'Mechanical enforcement', 'Changelog'],
  },
};

export const STEM_PATTERN = /^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$/;
export const TIERS = ['type', 'test', 'ci', 'reviewer', 'none-yet'] as const;
export type Tier = (typeof TIERS)[number];

// ---------------------------------------------------------------------------
// Markdown helpers. Deliberately small: the format rules are line-based.

export interface Line {
  /** 1-based line number. */
  n: number;
  text: string;
}

/**
 * The lines outside fenced code blocks. A fence opens with three or more
 * backticks or tildes (up to three spaces of indent) and closes with a line of
 * at least as many of the same character and nothing else. The fence lines
 * themselves are dropped. An unclosed fence runs to the end of the file, as in
 * CommonMark.
 */
export function linesOutsideFences(content: string): Line[] {
  const out: Line[] = [];
  let fence: { char: string; length: number } | null = null;
  content.split(/\r?\n/).forEach((text, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence === null) {
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = { char: m[1][0], length: m[1].length };
        return;
      }
      out.push({ n: i + 1, text });
    } else if (m && m[1][0] === fence.char && m[1].length >= fence.length && m[2].trim() === '') {
      fence = null;
    }
  });
  return out;
}

/** The lines of each `## Name` section (exact match), up to the next `#` or `##` heading. */
export function sections(lines: Line[]): Map<string, { heading: Line; body: Line[] }[]> {
  const result = new Map<string, { heading: Line; body: Line[] }[]>();
  let current: Line[] | null = null;
  for (const line of lines) {
    if (/^##? /.test(line.text)) {
      current = null;
      const m = /^## (.*)$/.exec(line.text);
      if (m) {
        const body: Line[] = [];
        const list = result.get(m[1]) ?? [];
        list.push({ heading: line, body });
        result.set(m[1], list);
        current = body;
      }
      continue;
    }
    current?.push(line);
  }
  return result;
}

export interface Table {
  header: string[];
  rows: { line: Line; cells: string[] }[];
  headerLine: Line;
}

const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split a `| a | b |` row into trimmed cells. `\|` stays inside a cell. */
export function splitRow(text: string): string[] {
  let row = text.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}

/** The first table in `lines`: a `|` header row, a delimiter row, then `|` rows. */
export function firstTable(lines: Line[]): Table | null {
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i];
    if (!header.text.trimStart().startsWith('|') || !DELIMITER_ROW.test(lines[i + 1].text)) continue;
    if (lines[i + 1].n !== header.n + 1) continue;
    // A delimiter row is not valid without a pipe, so a bare `---` rule is not a table.
    if (!lines[i + 1].text.includes('|')) continue;
    const rows: Table['rows'] = [];
    for (let j = i + 2; j < lines.length && lines[j].text.trimStart().startsWith('|'); j++) {
      // Rows must be consecutive lines; a gap in line numbers means a fence or blank line ended it.
      if (lines[j].n !== lines[j - 1].n + 1) break;
      rows.push({ line: lines[j], cells: splitRow(lines[j].text) });
    }
    return { header: splitRow(header.text), rows, headerLine: header };
  }
  return null;
}

/** Remove inline code spans, keeping the rest of the line. */
export function stripCodeSpans(text: string): string {
  return text.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '');
}

// ---------------------------------------------------------------------------
// Checks

interface DocFile {
  name: string;
  stem: string;
  path: string;
  content: string;
  lines: Line[];
}

export interface CheckResult {
  violations: Violation[];
  /** Stems of the `*.md` files checked (README excluded). */
  stems: string[];
}

/** Check one directory against its README's format rules. */
export function checkDocsDir(fs: DocsFs, kind: DocKind): CheckResult {
  const spec = DOC_SPECS[kind];
  const violations: Violation[] = [];
  const add = (file: string, rule: RuleCode, message: string, line?: number) =>
    violations.push({ file, rule, message, ...(line === undefined ? {} : { line }) });

  const entries = fs.readDir(spec.dir);
  if (entries === null) {
    add(spec.dir, 'readme', 'directory is missing');
    return { violations, stems: [] };
  }

  // Rule 1: the file set, its names and numbers.
  const files: DocFile[] = entries
    .filter(e => e.isFile && e.name.endsWith('.md') && e.name !== 'README.md')
    .map(e => {
      const path = `${spec.dir}/${e.name}`;
      const content = fs.readFile(path) ?? '';
      return { name: e.name, stem: e.name.slice(0, -'.md'.length), path, content, lines: linesOutsideFences(content) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const stems = files.map(f => f.stem);
  const stemSet = new Set(stems);

  const byNumber = new Map<string, string[]>();
  for (const f of files) {
    if (!STEM_PATTERN.test(f.stem)) {
      add(f.path, 'filename', `"${f.stem}" must match ${STEM_PATTERN.source} (NNNN-kebab-case-slug, lowercase)`);
      continue;
    }
    const number = f.stem.slice(0, 4);
    byNumber.set(number, [...(byNumber.get(number) ?? []), f.stem]);
  }
  for (const [number, sharing] of byNumber) {
    if (sharing.length > 1) {
      for (const stem of sharing) {
        add(`${spec.dir}/${stem}.md`, 'duplicate-number', `number ${number} is shared by ${sharing.join(', ')}`);
      }
    }
  }

  // Rule 3 (headings and title), rule 4 (status or changelog), rule 5 (enforcement).
  const titles = new Map<string, string>();
  const statuses = new Map<string, string>();
  for (const f of files) {
    const title = checkTitle(f, add);
    if (title !== null) titles.set(f.stem, title);
    const secs = sections(f.lines);
    checkHeadings(f, spec.headings, secs, add);
    if (kind === 'adr') {
      const status = checkStatus(f, secs, stemSet, add);
      if (status !== null) statuses.set(f.stem, status);
    } else {
      checkChangelog(f, secs, add);
    }
    checkEnforcement(fs, f, secs, add);
    checkLinks(fs, f.path, f.lines, add);
  }

  // Rule 2: the README index.
  const readmePath = `${spec.dir}/README.md`;
  const readme = fs.readFile(readmePath);
  if (readme === null) {
    add(readmePath, 'readme', 'README.md is missing, so there is no index');
  } else {
    const readmeLines = linesOutsideFences(readme);
    checkIndex(kind, readmePath, readmeLines, stems, titles, statuses, add);
    checkLinks(fs, readmePath, readmeLines, add);
  }

  return { violations, stems };
}

/** Check both directories. */
export function checkAllDocs(fs: DocsFs): CheckResult {
  const adr = checkDocsDir(fs, 'adr');
  const br = checkDocsDir(fs, 'business-rule');
  return { violations: [...adr.violations, ...br.violations], stems: [...adr.stems, ...br.stems] };
}

type Add = (file: string, rule: RuleCode, message: string, line?: number) => void;

function checkTitle(f: DocFile, add: Add): string | null {
  const headings = f.lines.filter(l => l.text.startsWith('# '));
  if (headings.length !== 1) {
    add(f.path, 'title', `must have exactly one "# Title" heading, found ${headings.length}`);
    return headings.length > 0 ? headings[0].text.slice(2).trim() : null;
  }
  return headings[0].text.slice(2).trim();
}

function checkHeadings(f: DocFile, required: string[], secs: ReturnType<typeof sections>, add: Add): void {
  for (const name of required) {
    const found = secs.get(name) ?? [];
    if (found.length === 1) continue;
    if (found.length > 1) {
      add(f.path, 'heading', `"## ${name}" appears ${found.length} times; it must appear exactly once`, found[1].heading.n);
      continue;
    }
    // A near miss (case, trailing whitespace, ### level) gets a pointer to the line.
    const near = f.lines.find(l => /^#{2,6}\s/.test(l.text) && l.text.replace(/^#+\s+/, '').trim().toLowerCase() === name.toLowerCase());
    add(
      f.path,
      'heading',
      `missing "## ${name}"${near ? ` (line ${near.n} has "${near.text}"; the heading is exact and case-sensitive, with no trailing whitespace)` : ''}`,
      near?.n,
    );
  }
}

/** First non-empty body lines of the first matching section. */
function nonEmpty(body: Line[]): Line[] {
  return body.filter(l => l.text.trim() !== '');
}

const STATUS_LINE = /^(proposed|accepted|deprecated|superseded by (\S+))$/;

function checkStatus(f: DocFile, secs: ReturnType<typeof sections>, stems: Set<string>, add: Add): string | null {
  const section = secs.get('Status')?.[0];
  if (!section) return null; // reported as a missing heading
  const [status, next] = nonEmpty(section.body);
  if (!status) {
    add(f.path, 'status', '"## Status" has no status line', section.heading.n);
    return null;
  }
  const m = STATUS_LINE.exec(status.text);
  if (!m) {
    add(
      f.path,
      'status',
      `status line "${status.text}" must be exactly one of proposed, accepted, deprecated, superseded by <NNNN-slug>`,
      status.n,
    );
    return null;
  }
  const target = m[2];
  if (target !== undefined) {
    if (target === f.stem) add(f.path, 'status', 'an ADR cannot supersede itself', status.n);
    else if (!stems.has(target)) {
      add(f.path, 'status', `superseded by "${target}", which is not an ADR in this directory (use the full NNNN-slug stem)`, status.n);
    }
  }
  if (next && /^date\b/i.test(next.text.trim())) {
    const d = /^Date: (\d{4})-(\d{2})-(\d{2})$/.exec(next.text);
    if (!d || !isCalendarDate(+d[1], +d[2], +d[3])) {
      add(f.path, 'status', `date line "${next.text}" must be exactly "Date: YYYY-MM-DD" with a real date`, next.n);
    }
  }
  return status.text;
}

function isCalendarDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const CHANGELOG_COLUMNS = ['Date', 'Change', 'Issue/PR'];

function checkChangelog(f: DocFile, secs: ReturnType<typeof sections>, add: Add): void {
  const section = secs.get('Changelog')?.[0];
  if (!section) return; // reported as a missing heading
  const table = firstTable(section.body);
  if (!table) {
    add(f.path, 'changelog', '"## Changelog" has no table', section.heading.n);
    return;
  }
  if (table.header.join('|') !== CHANGELOG_COLUMNS.join('|')) {
    add(
      f.path,
      'changelog',
      `Changelog columns must be ${CHANGELOG_COLUMNS.join(', ')}; found ${table.header.join(', ')}`,
      table.headerLine.n,
    );
  }
  if (!table.rows.some(r => r.cells.some(c => c !== ''))) {
    add(f.path, 'changelog', 'Changelog table needs at least one row besides the header and delimiter', table.headerLine.n);
  }
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TIER_LINE = /^(type|test|ci|reviewer|none-yet): (.*)$/;
/** A line that starts like a tier line but with a word that is not quite a tier: `Test:`, `tests:`, `none yet:`. */
const NEAR_TIER_LINE = /^([A-Za-z][A-Za-z _-]{0,15}):/;
const ISSUE_REF =
  /^(?:#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|\[[^\]]+\]\(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+\))(?=$|[\s.,;:)])/;

export interface EnforcementLine {
  line: Line;
  tier: Tier;
  reference: string;
}

/** The `<tier>: <reference>` lines of a Mechanical enforcement body, list markers allowed. */
export function enforcementLines(body: Line[]): { valid: EnforcementLine[]; nearMisses: Line[] } {
  const valid: EnforcementLine[] = [];
  const nearMisses: Line[] = [];
  for (const line of body) {
    const text = line.text.replace(LIST_MARKER, '').trimEnd();
    const m = TIER_LINE.exec(text);
    if (m) {
      valid.push({ line, tier: m[1] as Tier, reference: m[2].trim() });
      continue;
    }
    const near = NEAR_TIER_LINE.exec(text);
    if (near) {
      const key = near[1].trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/s$/, '');
      if ((TIERS as readonly string[]).includes(key)) nearMisses.push(line);
    }
  }
  return { valid, nearMisses };
}

function checkEnforcement(fs: DocsFs, f: DocFile, secs: ReturnType<typeof sections>, add: Add): void {
  const section = secs.get('Mechanical enforcement')?.[0];
  if (!section) return; // reported as a missing heading
  const { valid, nearMisses } = enforcementLines(section.body);
  for (const line of nearMisses) {
    add(
      f.path,
      'enforcement',
      `"${line.text.trim()}" looks like a tier line but its tier is not one of ${TIERS.join(', ')} (lowercase, singular, then ": ")`,
      line.n,
    );
  }
  if (valid.length === 0) {
    add(
      f.path,
      'enforcement',
      `"## Mechanical enforcement" needs at least one "<tier>: <reference>" line, tier one of ${TIERS.join(', ')}`,
      section.heading.n,
    );
  }
  for (const { line, tier, reference } of valid) {
    if (reference === '') {
      add(f.path, 'enforcement', `${tier}: needs a reference`, line.n);
      continue;
    }
    if (tier === 'type' || tier === 'test' || tier === 'ci') {
      if (!/^`[^`]+`/.test(reference)) {
        add(f.path, 'enforcement', `${tier}: reference must start with a backticked repo-relative path, e.g. \`src/index.test.ts\``, line.n);
        continue;
      }
      // The first span is the path. A later span that looks like a path (a `/`, no
      // whitespace) is checked too, so a second path on the line can't rot unnoticed;
      // other spans, such as (pins `ResultMeta`), are prose.
      const spans = [...reference.matchAll(/`([^`]+)`/g)].map(s => s[1].trim());
      const paths = [spans[0], ...spans.slice(1).filter(s => s.includes('/') && !/\s/.test(s))];
      for (const path of paths) {
        const normalized = posix.normalize(path);
        if (path.startsWith('/') || normalized.startsWith('..')) {
          add(f.path, 'enforcement', `${tier}: \`${path}\` must be relative to the repo root`, line.n);
        } else if (!fs.isFile(normalized)) {
          add(f.path, 'enforcement', `${tier}: \`${path}\` does not exist in the repo (paths are case-sensitive)`, line.n);
        }
      }
    } else if (tier === 'none-yet') {
      if (!ISSUE_REF.test(reference)) {
        add(f.path, 'enforcement', `none-yet: must link an issue as #N or https://github.com/<owner>/<repo>/issues/N`, line.n);
      }
    }
    // reviewer: any non-empty text.
  }
}

const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;

/** Relative link targets on the lines, with their line. Code spans and fenced blocks are skipped. */
export function relativeLinks(lines: Line[]): { line: Line; target: string }[] {
  const out: { line: Line; target: string }[] = [];
  for (const line of lines) {
    const text = stripCodeSpans(line.text);
    const targets = [...text.matchAll(INLINE_LINK)].map(m => m[1]);
    const def = LINK_DEFINITION.exec(text);
    if (def) targets.push(def[1]);
    for (let target of targets) {
      if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
      if (target === '' || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      out.push({ line, target });
    }
  }
  return out;
}

function checkLinks(fs: DocsFs, file: string, lines: Line[], add: Add): void {
  for (const { line, target } of relativeLinks(lines)) {
    let path = target.replace(/[#?].*$/, '');
    try {
      path = decodeURI(path);
    } catch {
      // keep it encoded; the lookup below reports it
    }
    const resolved = path.startsWith('/') ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(posix.dirname(file), path));
    if (resolved.startsWith('..')) {
      add(file, 'link', `link "${target}" points outside the repo`, line.n);
    } else if (!fs.exists(resolved)) {
      add(file, 'link', `link "${target}" does not resolve (${resolved} is missing; paths are case-sensitive)`, line.n);
    }
  }
}

const INDEX_KEY = /^\[([^\]]*)\]\(([^)]*)\)$/;

function checkIndex(
  kind: DocKind,
  readmePath: string,
  lines: Line[],
  stems: string[],
  titles: Map<string, string>,
  statuses: Map<string, string>,
  add: Add,
): void {
  const table = firstTable(lines);
  if (!table) {
    add(readmePath, 'index', 'no markdown table found; the first table is the index');
    return;
  }
  const titleCol = table.header.indexOf('Title');
  const statusCol = table.header.indexOf('Status');
  if (kind === 'adr' && (titleCol < 1 || statusCol < 1)) {
    add(readmePath, 'index', `the ADR index needs Title and Status columns; found ${table.header.join(', ')}`, table.headerLine.n);
  }

  const indexed = new Map<string, number>();
  for (const { line, cells } of table.rows) {
    const key = cells[0] ?? '';
    const m = INDEX_KEY.exec(key);
    if (!m || m[2] !== `${m[1]}.md`) {
      add(readmePath, 'index', `first cell "${key}" must be [<stem>](<stem>.md): plain link text, no backticks`, line.n);
      continue;
    }
    const stem = m[1];
    if (indexed.has(stem)) {
      add(readmePath, 'index', `"${stem}" is indexed twice (first on line ${indexed.get(stem)})`, line.n);
      continue;
    }
    indexed.set(stem, line.n);
    if (!stems.includes(stem)) {
      add(readmePath, 'index', `"${stem}" is indexed but ${stem}.md does not exist`, line.n);
      continue;
    }
    if (kind === 'adr') {
      const title = titles.get(stem);
      if (titleCol >= 1 && title !== undefined && (cells[titleCol] ?? '') !== title) {
        add(readmePath, 'index', `Title cell for "${stem}" is "${cells[titleCol] ?? ''}" but the file's # heading is "${title}"`, line.n);
      }
      const status = statuses.get(stem);
      if (statusCol >= 1 && status !== undefined && (cells[statusCol] ?? '') !== status) {
        add(readmePath, 'index', `Status cell for "${stem}" is "${cells[statusCol] ?? ''}" but the file's status line is "${status}"`, line.n);
      }
    }
  }
  for (const stem of stems) {
    if (!indexed.has(stem)) add(readmePath, 'index', `${stem}.md has no row in the index`);
  }
}

// ---------------------------------------------------------------------------
// CLI

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href;
if (isMain) {
  const root = resolvePath(process.argv[2] ?? posix.join(fileURLToPath(new URL('.', import.meta.url)), '..'));
  const { violations, stems } = checkAllDocs(nodeFs(root));
  for (const v of violations) console.log(formatViolation(v));
  console.log(`${stems.length} files checked, ${violations.length} violation(s)`);
  process.exit(violations.length === 0 ? 0 : 1);
}
