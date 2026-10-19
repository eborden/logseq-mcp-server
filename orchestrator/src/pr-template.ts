// The structure of the repo's PR template, derived at run time (#706, parent plan #704). Nothing about the template's
// wording is written down in orchestrator/src: the activity reads the file from the PR's base ref, `parsePrTemplate`
// turns it into the level-2 headings it lists (in order), and `checkPrBody` compares a body with them. When the template
// changes, the check follows with no code change (foundations 4.2 parse at the boundary, 4.4 derive, don't duplicate).
//
// Shape only. Level-3 headings, checkbox lines, wording, order beyond the listing and links are not checked. HTML
// comments (the template's guidance) and fenced blocks never count as headings.

import { GhError } from './gh.ts';

/** Most bytes of the template one read takes. A larger file is a typed result, never a cut one. */
export const MAX_TEMPLATE_BYTES = 64 * 1024;

/** The path the template is read from, in the PR's base ref. */
export const PR_TEMPLATE_PATH = '.github/pull_request_template.md';

// ---- the read's answer ----------------------------------------------------------------------------------------

export type PrTemplateRead =
  | { readonly kind: 'found'; readonly text: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'too_large'; readonly bytes: number };

/**
 * Parses the answer of `GET /repos/{repo}/contents/{path}?ref=...` for a file. A directory or any other shape is
 * `malformed`; a file larger than `MAX_TEMPLATE_BYTES` is `too_large`.
 */
export function parseTemplateFile(raw: unknown): PrTemplateRead {
  const bad = (path: string): never => {
    throw new GhError(`pull request template: unexpected answer at ${path}`, 'malformed');
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return bad('$');
  }
  const file = new Map(Object.entries(raw));
  if (file.get('type') !== 'file') {
    return bad('$.type');
  }
  const size = file.get('size');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    return bad('$.size');
  }
  if (size > MAX_TEMPLATE_BYTES) {
    return { kind: 'too_large', bytes: size };
  }
  const content = file.get('content');
  if (file.get('encoding') !== 'base64' || typeof content !== 'string') {
    return bad('$.content');
  }
  const decoded = Buffer.from(content, 'base64');
  if (decoded.length > MAX_TEMPLATE_BYTES) {
    return { kind: 'too_large', bytes: decoded.length };
  }
  return { kind: 'found', text: decoded.toString('utf8') };
}

// ---- scanning markdown ----------------------------------------------------------------------------------------

interface Scanned {
  /** Each level-2 heading outside comments and fences, with the text under it (fenced content counts as text). */
  readonly sections: { readonly heading: string; readonly lines: string[]; guidance: boolean }[];
  /** An HTML comment appears outside a fenced block. */
  readonly guidance: boolean;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// The end of an HTML comment that began on an earlier line. Strictly any `-->` ends one, but guidance comments hold
// diagrams whose arrows (`A-->B`, `A-->>B`) must not: an arrow has a word character before it or a `>` or word
// character after it. A comment that closes on the line it opened on ends at its first `-->`, whatever surrounds it.
const STRICT_END_RE = /-->/;
const COMMENT_END_RE = /(?<!\w)-->(?!>)|-->(?!>)(?=\s*$)/;
const H2_RE = /^ {0,3}##[ \t]+(\S.*?)(?:[ \t]+#+)?[ \t]*$/;

function scan(markdown: string): Scanned {
  const sections: { heading: string; lines: string[]; guidance: boolean }[] = [];
  let guidance = false;
  let fence: string | undefined;
  let inComment = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (fence !== undefined) {
      const close = FENCE_RE.exec(line);
      if (close !== null && close[1] !== undefined && close[1].startsWith(fence.charAt(0)) && close[1].length >= fence.length && line.trim() === close[1]) {
        fence = undefined;
      }
      sections.at(-1)?.lines.push(line);
      continue;
    }
    // Remove comments from the line, carrying an open one over to the next line.
    let kept = '';
    let rest = line;
    let sawComment = false;
    let openedHere = false;
    for (;;) {
      if (inComment) {
        const end = openedHere ? STRICT_END_RE.exec(rest) : COMMENT_END_RE.exec(rest);
        openedHere = false;
        sawComment = true;
        if (end === null) {
          rest = '';
          break;
        }
        rest = rest.slice(end.index + 3);
        inComment = false;
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) {
          kept += rest;
          break;
        }
        kept += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
        openedHere = true;
      }
    }
    if (sawComment) {
      guidance = true;
      const last = sections.at(-1);
      if (last !== undefined && !H2_RE.test(kept)) {
        last.guidance = true;
      }
    }
    const open = FENCE_RE.exec(kept);
    if (open !== null) {
      fence = open[1];
      sections.at(-1)?.lines.push(kept);
      continue;
    }
    const heading = H2_RE.exec(kept);
    if (heading !== null) {
      // A comment on a heading's own line belongs to that section.
      sections.push({ heading: (heading[1] ?? '').trim(), lines: [], guidance: sawComment });
      continue;
    }
    sections.at(-1)?.lines.push(kept);
  }
  return { sections, guidance };
}

// ---- the template ---------------------------------------------------------------------------------------------

export type PrTemplate =
  | { readonly kind: 'ok'; readonly headings: readonly string[] }
  | { readonly kind: 'no_sections' };

/** The level-2 headings of a template, in order, without repeats. A template with none is a typed result. */
export function parsePrTemplate(text: string): PrTemplate {
  const headings = [...new Set(scan(text).sections.map((section) => section.heading))];
  return headings.length === 0 ? { kind: 'no_sections' } : { kind: 'ok', headings };
}

// ---- the check ------------------------------------------------------------------------------------------------

export interface PrBodyCheck {
  /** Sections of the template that the body has, with some text under them. */
  readonly present: readonly string[];
  /** Sections of the template the body has no heading for. */
  readonly missing: readonly string[];
  /** Sections the body has a heading for, with nothing under it (a comment or whitespace is nothing). */
  readonly empty: readonly string[];
  /** The body still holds an HTML comment outside a fenced block. */
  readonly guidanceLeft: boolean;
  /** The template sections that hold such a comment. */
  readonly guidanceSections: readonly string[];
  readonly ok: boolean;
}

/** Whether `body` has every section `template` lists, each with text, and no guidance comment left in. */
export function checkPrBody(template: PrTemplate, body: string): PrBodyCheck {
  const required = template.kind === 'ok' ? template.headings : [];
  const scanned = scan(body);
  const present: string[] = [];
  const missing: string[] = [];
  const empty: string[] = [];
  const guidanceSections: string[] = [];
  for (const heading of required) {
    const found = scanned.sections.filter((section) => section.heading === heading);
    if (found.length === 0) {
      missing.push(heading);
      continue;
    }
    if (found.some((section) => section.guidance)) {
      guidanceSections.push(heading);
    }
    if (found.some((section) => section.lines.some((line) => line.trim() !== ''))) {
      present.push(heading);
    } else {
      empty.push(heading);
    }
  }
  return {
    present,
    missing,
    empty,
    guidanceLeft: scanned.guidance,
    guidanceSections,
    ok: template.kind === 'ok' && missing.length === 0 && empty.length === 0 && !scanned.guidance,
  };
}

// ---- the body the PR opens with -------------------------------------------------------------------------------

/** Which body a PR opened with: the one the session posted, or the one generated from the template. */
export type PrBodySource = 'session' | 'fallback';

export interface ChosenPrBody {
  readonly body: string;
  readonly source: PrBodySource;
  /** Template sections the session's body did not meet (missing, empty or still holding guidance). All of them when it posted none. Names from the template, never body text. */
  readonly unmet: readonly string[];
  /** Why the session's body was not used. Absent for `session`. */
  readonly reason?: 'no_comment' | 'check_failed' | 'comment_too_large' | 'template_unavailable';
}

// The orchestrator's own marker comments. A body from a session is data: one of these in it is removed, so the PR never
// carries a marker another step of the orchestrator would read as its own. Removal can assemble a new marker from the
// pieces around the removed one, so it repeats until the text stops changing, and any opening that is left (one with no
// closing, or split in a way the pattern misses) is made inert by escaping its `<`.
const OWN_MARKER_RE = /<!--\s*orchestrator-[\s\S]*?-->/gi;
const OWN_OPENING_RE = /<!--(\s*orchestrator-)/gi;

/** `body` without any orchestrator marker comment, and with no `<!-- orchestrator-` left in it. */
export function stripOwnMarkers(body: string): string {
  let text = body;
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(OWN_MARKER_RE, '').replace(OWN_OPENING_RE, '&lt;!--$1');
  }
  return text;
}

/** Most sections a fallback lists, and most characters of one heading it repeats. They keep the body far under GitHub's limit however large the template is. */
export const MAX_FALLBACK_SECTIONS = 40;
export const MAX_FALLBACK_HEADING_CHARS = 200;

/** The fixed start of the fallback's pointer line. An open PR whose body holds it was opened with the fallback. */
export const FALLBACK_LINE_PREFIX = 'Sections not provided by the session:';

/** What an open PR's body says about where it came from: the fallback's fixed line, any other text, or nothing. */
export function bodyOrigin(body: string): 'fallback' | 'session' | 'unknown' {
  if (body.trim() === '') {
    return 'unknown';
  }
  return body.includes(FALLBACK_LINE_PREFIX) ? 'fallback' : 'session';
}

function closesIssue(body: string, issue: number): boolean {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}(?!\\d)`, 'i').test(body);
}

/** Adds `Closes #<issue>` unless the body already closes it: the one thing the orchestrator guarantees, since it links the issue. */
export function withClosesLine(body: string, issue: number): string {
  return closesIssue(body, issue) ? body : `${body.replace(/\s+$/, '')}\n\nCloses #${issue}\n`;
}

/**
 * The body for a PR whose session did not post a usable one: every section of `template`, in its order, each with one
 * line saying the session did not provide it, then a line naming the sections that were not met. It holds no section
 * name of its own, so it follows the template. A template without sections gives only the pointer line.
 */
export function fallbackPrBody(template: PrTemplate, unmet: readonly string[]): string {
  const clip = (heading: string) => (heading.length > MAX_FALLBACK_HEADING_CHARS ? `${heading.slice(0, MAX_FALLBACK_HEADING_CHARS)}...` : heading);
  const headings = template.kind === 'ok' ? template.headings : [];
  const lines: string[] = [];
  for (const heading of headings.slice(0, MAX_FALLBACK_SECTIONS)) {
    lines.push(`## ${clip(heading)}`, 'The implementer session did not provide this section.', '');
  }
  const shown = unmet.slice(0, MAX_FALLBACK_SECTIONS).map(clip);
  const left = headings.length - Math.min(headings.length, MAX_FALLBACK_SECTIONS);
  const leftNames = unmet.length - shown.length;
  const named = unmet.length === 0 ? 'the whole description' : `${shown.join(', ')}${leftNames > 0 ? ` and ${leftNames} more` : ''}`;
  if (left > 0) {
    lines.push(`The template has ${left} more section${left === 1 ? '' : 's'} than are listed here.`, '');
  }
  lines.push(`${FALLBACK_LINE_PREFIX} ${named}. See the issue and the status comment.`, '');
  return lines.join('\n');
}

/**
 * Picks the PR body (#707). `sessionBody` is the text the session posted (undefined: none). A body that passes
 * `checkPrBody` against the template read now is used, with `Closes #<issue>` added when it lacks it. Anything else,
 * including an unreadable template, gives the generated fallback: a PR is never blocked by a bad body.
 */
export function choosePrBody(template: PrTemplate, sessionBody: string | undefined, issue: number, tooLarge = false): ChosenPrBody {
  const required = template.kind === 'ok' ? template.headings : [];
  if (template.kind !== 'ok') {
    return { body: withClosesLine(fallbackPrBody(template, []), issue), source: 'fallback', unmet: [], reason: 'template_unavailable' };
  }
  if (sessionBody === undefined) {
    const reason = tooLarge ? 'comment_too_large' : 'no_comment';
    return { body: withClosesLine(fallbackPrBody(template, required), issue), source: 'fallback', unmet: required, reason };
  }
  const cleaned = stripOwnMarkers(sessionBody);
  const check = checkPrBody(template, cleaned);
  if (check.ok) {
    return { body: withClosesLine(cleaned, issue), source: 'session', unmet: [] };
  }
  const unmet = required.filter((heading) => check.missing.includes(heading) || check.empty.includes(heading) || check.guidanceSections.includes(heading));
  // Guidance outside any template section (above the first heading) leaves nothing named; the pointer line says so.
  return { body: withClosesLine(fallbackPrBody(template, unmet), issue), source: 'fallback', unmet, reason: 'check_failed' };
}
