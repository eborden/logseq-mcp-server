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
