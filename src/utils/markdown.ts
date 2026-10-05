import { firstLineSnippet } from './snippet.js';

/**
 * The one Markdown renderer (#43). Every tool that takes `format: "markdown"`
 * and the `logseq://page/{name}` resource render through here, so a page looks
 * the same wherever it is read.
 *
 * Layout, the way LogSeq stores a page:
 * - a `#` title, then page properties as `key:: value` lines;
 * - blocks as `- ` bullets, one tab per nesting level, continuation lines of a
 *   multi-line block indented under the bullet;
 * - `((uuid))` refs stay exactly as written. With `resolve_refs` a block also
 *   shows its `resolvedContent` on a `[resolved]` line below it;
 * - a short footer for warnings, `hasMore` and tips (see {@link renderFooter}).
 *
 * The functions are pure: they take the tools' result objects and return text.
 * They are tolerant readers, because the shapes differ by source (Editor API
 * camelCase, Datalog kebab-case, `children` that are unfetched
 * `["uuid", "<id>"]` tuples rather than blocks).
 */

export type Obj = Record<string, any>;

export const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** Original-case title of a page entity in any of the shapes the tools return. */
export function pageTitle(page: unknown, fallback?: string): string {
  const p = isObj(page) ? page : {};
  return (
    nonEmpty(p.originalName) ?? nonEmpty(p['original-name']) ?? nonEmpty(p.name) ?? fallback ?? ''
  );
}

/** `[[Title]]`, the way a page is linked in LogSeq. */
export const pageLink = (page: unknown, fallback?: string): string => `[[${pageTitle(page, fallback)}]]`;

export interface OutlineOptions {
  /** Titles and ids only: each block is its first-line snippet followed by its `((uuid))` */
  compact?: boolean;
  /** Stop after this many characters and report `cut`. Unlimited when omitted. */
  maxChars?: number;
  /** Leave out pre-blocks, whose text is the page properties already rendered above */
  skipPreBlocks?: boolean;
}

export interface Outline {
  lines: string[];
  /** True when `maxChars` stopped the outline before the last block */
  cut: boolean;
}

/** Shown after the start of a first block that alone exceeds `maxChars`. */
export const TRUNCATED_BLOCK_MARKER = '\n[This block is longer than the limit and was truncated here.]';

function bulletText(block: Obj, depth: number, compact: boolean): string {
  const indent = '\t'.repeat(depth);
  if (compact) {
    const uuid = nonEmpty(block.uuid);
    const snippet = firstLineSnippet(block.content);
    const text = [snippet, uuid ? `((${uuid}))` : ''].filter(s => s !== '').join(' ');
    return `${indent}- ${text}`.trimEnd();
  }
  const content = typeof block.content === 'string' ? block.content : '';
  const [first, ...rest] = content.split('\n');
  const lines = [`${indent}- ${first}`, ...rest.map(line => `${indent}  ${line}`)];
  // `content` is never changed; the resolved text is shown beside it, not in place of it
  if (typeof block.resolvedContent === 'string' && block.resolvedContent !== content) {
    const [rFirst, ...rRest] = block.resolvedContent.split('\n');
    lines.push(`${indent}  [resolved] ${rFirst}`, ...rRest.map(line => `${indent}    ${line}`));
  }
  return lines.join('\n');
}

/**
 * Render a block tree as an outline. Stops at `maxChars` when given, and says so
 * through `cut`; the caller owns the notice. Children that are not block objects
 * (unfetched `["uuid", "<id>"]` tuples) are skipped.
 */
export function renderOutline(blocks: unknown[], options: OutlineOptions = {}): Outline {
  const { compact = false, maxChars = Infinity, skipPreBlocks = false } = options;
  const out: string[] = [];
  const budget = { left: maxChars, cut: false };

  const walk = (siblings: unknown[], depth: number): void => {
    for (const block of siblings) {
      if (budget.cut) return;
      if (!isObj(block)) continue;
      if (skipPreBlocks && (block['pre-block?'] === true || block['preBlock?'] === true)) continue;
      const text = bulletText(block, depth, compact);
      if (text.length + 1 > budget.left) {
        budget.cut = true;
        // A first block over the cap would otherwise render as an empty page.
        // Keep its start, with a marker, so the reader sees real content.
        if (out.length === 0) {
          out.push(`${text.slice(0, Math.max(0, budget.left - TRUNCATED_BLOCK_MARKER.length - 1))}${TRUNCATED_BLOCK_MARKER}`);
        }
        return;
      }
      out.push(text);
      budget.left -= text.length + 1;
      if (Array.isArray(block.children)) walk(block.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return { lines: out, cut: budget.cut };
}

function propertyValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const parts = value.map(propertyValue).filter((v): v is string => v !== undefined);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return text.trim() === '' ? undefined : text;
}

/** Properties as LogSeq writes them, `key:: value`. Empty values are left out. */
export function renderProperties(properties: unknown): string[] {
  if (!isObj(properties)) return [];
  return Object.entries(properties).flatMap(([key, value]) => {
    const text = propertyValue(value);
    return text === undefined ? [] : [`${key}:: ${text}`];
  });
}

const hasProperties = (properties: unknown): boolean => renderProperties(properties).length > 0;

export interface PageRenderOptions {
  /**
   * Whether the blocks were asked for. A page fetched without them gets a title and
   * properties only; a fetched page with no blocks says so instead of looking empty.
   */
  blocksFetched: boolean;
  compact?: boolean;
  /** Cut the outline here and append {@link PageRenderOptions.cutNotice}. Unlimited when omitted. */
  maxChars?: number;
  /** Text appended on its own paragraph when the outline was cut */
  cutNotice?: string;
  /** Title when the page entity has no name */
  fallbackTitle?: string;
}

/** The `(resolved from "x", matched by alias)` note for a page reached through an alias, date or namespace leaf. */
export function resolvedFromLine(resolvedFrom: unknown): string | undefined {
  if (!isObj(resolvedFrom)) return undefined;
  return `(resolved from ${JSON.stringify(resolvedFrom.name)}, matched by ${String(resolvedFrom.matchedBy)})`;
}

/**
 * One page as Markdown: title, resolved-from note, page properties, then the
 * block outline (children of the page entity). No footer; add one with
 * {@link withFooter}.
 */
export function renderPage(page: Obj, options: PageRenderOptions): string {
  const lines = [`# ${pageTitle(page, options.fallbackTitle)}`, ''];
  const note = resolvedFromLine(page.resolvedFrom);
  if (note) lines.push(note, '');

  const props = renderProperties(page.properties);
  if (props.length > 0) lines.push(...props, '');

  if (!options.blocksFetched) return `${lines.join('\n').trimEnd()}\n`;

  const blocks = Array.isArray(page.children) ? page.children : [];
  const outline = renderOutline(blocks, {
    compact: options.compact,
    maxChars: options.maxChars,
    // The properties block is the page properties, which are rendered above
    skipPreBlocks: props.length > 0,
  });
  const body = outline.lines.length > 0 || outline.cut ? outline.lines.join('\n') : '(this page has no blocks)';
  const notice = outline.cut && options.cutNotice ? `\n\n${options.cutNotice}` : '';
  return `${lines.join('\n')}\n${body}${notice}\n`;
}

/**
 * One block with its children (as many as were fetched), under a `Block ((uuid))`
 * heading. A block's own text is what it holds; its page is not rendered, because
 * the Editor API returns only a page id for it.
 */
export function renderBlock(block: Obj, options: { compact?: boolean } = {}): string {
  const uuid = nonEmpty(block.uuid);
  const heading = uuid ? `# Block ((${uuid}))` : '# Block';
  const outline = renderOutline([block], { compact: options.compact });
  return `${heading}\n\n${outline.lines.join('\n')}\n`;
}

/** A warning as the tools report it. `topic` is set by `get_context_for_query`. */
export interface FooterWarning {
  code?: string;
  message: string;
  howToFetchAll?: string;
  topic?: string;
}

/** The parts of `ResultMeta` the footer shows, plus tips. */
export interface FooterMeta {
  warnings?: readonly FooterWarning[];
  hasMore?: boolean;
  tips?: readonly string[];
}

/**
 * Warnings, `hasMore` and tips as a short footer after a `---` rule, or '' when
 * there is nothing to say. The same information the JSON `meta` carries:
 *
 *     ---
 *     Warnings:
 *     - blocks_truncated: Showing 50 of 80 blocks. Set max_blocks to 80 (or higher) to get all 80.
 *     hasMore: true
 *     Tips:
 *     - logseq_get_backlinks {"page_name":"Alice"}
 */
export function renderFooter(meta: FooterMeta | null | undefined): string {
  const warnings = meta?.warnings ?? [];
  const tips = meta?.tips ?? [];
  const lines: string[] = [];
  if (warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of warnings) {
      const label = w.code ? `${w.code}: ` : '';
      const how = w.howToFetchAll ? ` ${w.howToFetchAll}` : '';
      lines.push(`- ${label}${w.message}${how}`);
    }
  }
  if (meta?.hasMore === true) lines.push('hasMore: true');
  if (tips.length > 0) {
    lines.push('Tips:');
    for (const tip of tips) lines.push(`- ${tip}`);
  }
  return lines.length > 0 ? `---\n${lines.join('\n')}` : '';
}

/** `body` followed by the footer for `meta`, one paragraph apart. Just `body` when the footer is empty. */
export function withFooter(body: string, meta: FooterMeta | null | undefined): string {
  const footer = renderFooter(meta);
  return footer === '' ? body : `${body.trimEnd()}\n\n${footer}\n`;
}
