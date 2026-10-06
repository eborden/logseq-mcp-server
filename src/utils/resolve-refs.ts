import { LogseqClient } from '../client.js';
import { ResolvedRef, ResultWarning } from '../types.js';
import { DatalogQueryBuilder, EMBED_DESCENDANT_LEVELS } from '../datalog/queries.js';
import { orderSiblings } from './block-tree.js';
import { queryParsed } from './parse-response.js';
import { responses, type RefTarget } from '../response-schemas.js';

/**
 * Resolve `((uuid))` block refs and `{{embed}}`s in returned blocks (#18).
 *
 * The blocks keep their `content` untouched. A block that holds at least one
 * ref or embed gains:
 * - `resolvedContent`: its content with every resolvable ref replaced inline by
 *   the target's text (nested refs resolved too, down to the depth limit);
 * - `resolvedRefs`: one entry per distinct ref found, nested ones included, so
 *   the model still has the uuid to act on and sees why something stayed as is.
 *
 * Batching: refs are fetched breadth first, ONE Datalog query per nesting level
 * (see `DatalogQueryBuilder.refTargets`), so a call costs at most `maxDepth`
 * extra queries however many refs there are, and none when nothing has a ref.
 *
 * Depth: a ref in the returned block is level 1, a ref inside its target level 2,
 * and so on. Refs deeper than `maxDepth` are left as written (`depth_limit`).
 *
 * Cycles: the set of uuids "being expanded" is tracked per path, not shared
 * across siblings. Two siblings that reference the same block both resolve; only
 * a ref back to a block already on the current path is a `cycle`.
 */

export const DEFAULT_REF_DEPTH = 2;
export const DEFAULT_EMBED_LIMIT = 20;

export interface ResolveRefsOptions {
  /** Nesting levels to follow (default 2) */
  maxDepth?: number;
  /** Blocks one embed may show (default 20); the rest are cut with a warning */
  embedLimit?: number;
}

/** What a block needs to have for its refs to be resolved. */
export interface RefBearingBlock {
  uuid?: string;
  content?: string;
  children?: RefBearingBlock[];
}

// A pulled block or page row (see DatalogQueryBuilder.refTargets), as `responses.refTargetRows` checks it
type Row = RefTarget;

type TokenKind = 'ref' | 'block_embed' | 'page_embed';

interface Token {
  kind: TokenKind;
  raw: string;
  /** The lowercase uuid, or the page name as written (trimmed) for a page embed */
  target: string;
  /** Lookup key: the lowercase uuid, or the lowercase page name */
  key: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * `{{embed ((uuid))}}`, `{{embed [[page]]}}` and `((uuid))`, in that order of
 * precedence. Only strict uuids match, so `((not a uuid))` is left alone.
 * A new RegExp per use: global regexes carry `lastIndex` state.
 */
const tokenRegex = () =>
  new RegExp(
    `\\{\\{embed\\s+\\(\\((${UUID})\\)\\)\\s*\\}\\}` +
      `|\\{\\{embed\\s+\\[\\[([^\\[\\]\\n]+)\\]\\]\\s*\\}\\}` +
      `|\\(\\((${UUID})\\)\\)`,
    'gi'
  );

function toToken(raw: string, blockEmbed?: string, pageEmbed?: string, ref?: string): Token {
  if (blockEmbed) {
    return { kind: 'block_embed', raw, target: blockEmbed.toLowerCase(), key: blockEmbed.toLowerCase() };
  }
  if (pageEmbed) {
    return { kind: 'page_embed', raw, target: pageEmbed.trim(), key: pageEmbed.trim().toLowerCase() };
  }
  return { kind: 'ref', raw, target: ref!.toLowerCase(), key: ref!.toLowerCase() };
}

function scanTokens(text: string): Token[] {
  return Array.from(text.matchAll(tokenRegex()), m => toToken(m[0], m[1], m[2], m[3]));
}

/** A ref's text: the content without the `id::` property line LogSeq stores in it. */
function cleanContent(content: string | undefined): string {
  return (content ?? '').replace(/^[ \t]*id::[ \t]*[0-9a-f-]{36}[ \t]*(\r?\n|$)/gim, '').trimEnd();
}

/**
 * A row LogSeq made for a `((uuid))` that no real block has (#138). LogSeq 0.10 creates a
 * placeholder entity holding just that uuid: no `:block/page`, `:block/parent` or `:block/name`,
 * and content `id:: <uuid>`. Every real block has a page, and a page has a name, so a row with
 * neither is the placeholder. Content is not the signal: a real empty block with a pinned id
 * holds the same `id::` line and must still resolve.
 */
const isPlaceholder = (row: Row): boolean => row.page?.id == null && row.name == null;

const pageNameOf = (row: Row | undefined | null): string | null =>
  row?.page?.['original-name'] ?? row?.page?.name ?? null;

const textOf = (row: Row): string =>
  row.content !== undefined ? cleanContent(row.content) : (row['original-name'] ?? row.name ?? '');

interface EmbedMember {
  row: Row;
  /** 0 for the embedded block, 1 for its children, 2 for theirs, ... */
  depth: number;
}

interface PageEmbed {
  name: string;
  entity: Row | null;
  top: Row[];
}

/** What the per-level queries found, keyed by lowercase uuid or page name. */
class RefStore {
  /** null: queried and not found */
  blocks = new Map<string, Row | null>();
  trees = new Map<string, EmbedMember[]>();
  pages = new Map<string, PageEmbed>();
}

/** Contents a token makes visible, which are the next level's refs to look for. */
function visibleTexts(store: RefStore, token: Token, limit: number): string[] {
  if (token.kind === 'ref') {
    const row = store.blocks.get(token.key);
    return row ? [textOf(row)] : [];
  }
  if (token.kind === 'block_embed') {
    return (store.trees.get(token.key) ?? []).slice(0, limit).map(m => textOf(m.row));
  }
  return (store.pages.get(token.key)?.top ?? []).slice(0, limit).map(textOf);
}

function walkDescendants(root: Row, childrenOf: Map<number, Row[]>, levels: number): EmbedMember[] {
  const members: EmbedMember[] = [];
  const visited = new Set<number>();
  const walk = (row: Row, depth: number) => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    members.push({ row, depth });
    if (depth >= levels) return;
    const children = childrenOf.get(row.id) ?? [];
    for (const child of orderSiblings(children)) walk(child, depth + 1);
  };
  walk(root, 0);
  return members;
}

async function fetchLevels(
  client: LogseqClient,
  rootTexts: string[],
  maxDepth: number,
  embedLimit: number
): Promise<RefStore> {
  const store = new RefStore();
  const scanned = new Set<string>();
  let texts = rootTexts;

  for (let level = 1; level <= maxDepth && texts.length > 0; level++) {
    const blockUuids = new Set<string>();
    const descendantUuids = new Set<string>();
    const pageNames = new Set<string>();
    const visited: Token[] = [];

    for (const token of texts.flatMap(scanTokens)) {
      const identity = `${token.kind}:${token.key}`;
      if (scanned.has(identity)) continue;
      scanned.add(identity);
      visited.push(token);

      if (token.kind === 'page_embed') {
        if (!store.pages.has(token.key)) pageNames.add(token.key);
        continue;
      }
      const cached = store.blocks.get(token.key);
      if (cached === null) continue;
      if (cached === undefined) blockUuids.add(token.key);
      if (token.kind === 'block_embed' && !store.trees.has(token.key)) {
        descendantUuids.add(token.key);
        blockUuids.add(token.key);
      }
    }

    if (blockUuids.size > 0 || descendantUuids.size > 0 || pageNames.size > 0) {
      const { query, inputs } = DatalogQueryBuilder.refTargets({
        blockUuids: [...blockUuids],
        descendantUuids: [...descendantUuids],
        pageNames: [...pageNames]
      });
      const rows = ((await queryParsed(client, responses.refTargetRows, query, ...inputs)) || [])
        .map(row => row[0])
        .filter(row => row != null);
      ingest(store, rows, blockUuids, descendantUuids, pageNames);
    }

    texts = visited.flatMap(token => visibleTexts(store, token, embedLimit));
  }
  return store;
}

function ingest(
  store: RefStore,
  rows: Row[],
  blockUuids: Set<string>,
  descendantUuids: Set<string>,
  pageNames: Set<string>
): void {
  const byUuid = new Map<string, Row>();
  const childrenOf = new Map<number, Row[]>();
  for (const row of rows) {
    if (typeof row.uuid === 'string') byUuid.set(row.uuid.toLowerCase(), row);
    const parentId = row.parent?.id;
    if (parentId !== undefined) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(row);
      childrenOf.set(parentId, list);
    }
  }

  // A placeholder counts as not found: its ref or embed is `missing`, not `ok` with empty text (#138)
  for (const uuid of blockUuids) {
    const row = byUuid.get(uuid);
    store.blocks.set(uuid, row && !isPlaceholder(row) ? row : null);
  }

  for (const uuid of descendantUuids) {
    const root = store.blocks.get(uuid);
    if (root) store.trees.set(uuid, walkDescendants(root, childrenOf, EMBED_DESCENDANT_LEVELS));
  }

  for (const name of pageNames) {
    const entity = rows.find(row => row.name !== undefined && row.name.toLowerCase() === name) ?? null;
    const top = entity
      ? orderSiblings(childrenOf.get(entity.id) ?? [])
      : [];
    store.pages.set(name, { name, entity, top });
  }
}

class Renderer {
  private warnings = new Map<string, ResultWarning>();
  private depthLimited = new Set<string>();

  constructor(
    private store: RefStore,
    private maxDepth: number,
    private embedLimit: number
  ) {}

  /** Render `text`, whose own refs are at `depth`, pushing one entry per ref into `sink`. */
  render(text: string, path: string[], depth: number, sink: ResolvedRef[]): string {
    return text.replace(tokenRegex(), (raw: string, blockEmbed?: string, pageEmbed?: string, ref?: string) => {
      const token = toToken(raw, blockEmbed, pageEmbed, ref);
      return this.expand(token, path, depth, sink);
    });
  }

  allWarnings(): ResultWarning[] {
    const warnings = [...this.warnings.values()];
    if (this.depthLimited.size > 0) {
      warnings.push({
        code: 'refs_depth_limit',
        message:
          `${this.depthLimited.size} reference(s) were not followed because they are more than ` +
          `${this.maxDepth} levels deep. They are left as written.`,
        howToFetchAll:
          'Fetch each ref whose status is "depth_limit" with logseq_get_block (its uuid) ' +
          'or logseq_get_page (its page).'
      });
    }
    return warnings;
  }

  private expand(token: Token, path: string[], depth: number, sink: ResolvedRef[]): string {
    const isPage = token.kind === 'page_embed';
    const pathKey = isPage ? `page:${token.key}` : token.key;
    const entry: ResolvedRef = {
      ...(isPage ? {} : { uuid: token.key }),
      ...(token.kind === 'ref' ? {} : { embed: isPage ? ('page' as const) : ('block' as const) }),
      content: null,
      page: isPage ? token.target : null,
      status: 'ok'
    };
    sink.push(entry);

    if (path.includes(pathKey)) {
      entry.status = 'cycle';
      if (!isPage) entry.page = pageNameOf(this.store.blocks.get(token.key));
      return token.raw;
    }
    const target = isPage ? this.store.pages.get(token.key) : this.store.blocks.get(token.key);
    if (depth > this.maxDepth || target === undefined) {
      entry.status = 'depth_limit';
      this.depthLimited.add(pathKey);
      return token.raw;
    }
    if (target === null || (isPage && !(target as PageEmbed).entity)) {
      entry.status = 'missing';
      return token.raw;
    }

    const next = [...path, pathKey];
    let text: string;
    if (token.kind === 'page_embed') {
      const page = target as PageEmbed;
      const shown = page.top.slice(0, this.embedLimit);
      entry.page = page.entity!['original-name'] ?? page.entity!.name ?? token.target;
      text = shown.map(row => `- ${this.render(textOf(row), next, depth + 1, sink)}`).join('\n');
      text += this.truncationNote(
        { key: pathKey, what: `page "${entry.page}"`, unit: 'top-level blocks', fetch:
          `Call logseq_get_page with page_name "${entry.page}" and include_children true.` },
        shown.length,
        page.top.length
      );
    } else if (token.kind === 'block_embed') {
      const row = target as Row;
      entry.page = pageNameOf(row);
      const members = this.store.trees.get(token.key) ?? [{ row, depth: 0 }];
      const shown = members.slice(0, this.embedLimit);
      text = shown
        .map(({ row: member, depth: memberDepth }) => {
          const rendered = this.render(textOf(member), next, depth + 1, sink);
          return memberDepth === 0 ? rendered : `${'  '.repeat(memberDepth)}- ${rendered}`;
        })
        .join('\n');
      text += this.truncationNote(
        { key: pathKey, what: `block ${token.key}`, unit: 'blocks', fetch:
          `Call logseq_get_block with block_uuid "${token.key}" and include_children true.` },
        shown.length,
        members.length
      );
    } else {
      const row = target as Row;
      entry.page = pageNameOf(row) ?? (row.name !== undefined ? (row['original-name'] ?? row.name) : null);
      text = this.render(textOf(row), next, depth + 1, sink);
    }
    entry.content = text;
    return text;
  }

  private truncationNote(
    info: { key: string; what: string; unit: string; fetch: string },
    shown: number,
    total: number
  ): string {
    if (total <= shown) return '';
    const key = `embed:${info.key}`;
    if (!this.warnings.has(key)) {
      this.warnings.set(key, {
        code: 'embed_truncated',
        message: `Embed of ${info.what} shows ${shown} of ${total} ${info.unit}.`,
        howToFetchAll: info.fetch
      });
    }
    return `\n[... ${total - shown} more ${info.unit} not shown]`;
  }
}

/** Every block content in these trees, nested children included. */
function collectContents(blocks: RefBearingBlock[], into: string[] = []): string[] {
  for (const block of blocks) {
    if (typeof block.content === 'string') into.push(block.content);
    if (Array.isArray(block.children)) collectContents(block.children, into);
  }
  return into;
}

function dedupeRefs(refs: ResolvedRef[]): ResolvedRef[] {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.embed ?? 'ref'}:${ref.uuid ?? ref.page?.toLowerCase()}:${ref.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve the refs and embeds in `roots` and their nested `children`.
 *
 * Returns copies with `resolvedContent` / `resolvedRefs` added to the blocks that
 * hold a ref or embed (the input is not mutated, and `content` is never changed).
 * Blocks without one come back as they were, and when no block has one there is
 * no API call at all. Otherwise there is at most one Datalog query per level, up
 * to `maxDepth`.
 *
 * @param client - LogseqClient instance
 * @param roots - Returned blocks (trees or flat), each with `uuid` and `content`
 * @param options - Depth and embed caps
 * @returns The annotated blocks (same order) and any warnings (capped embeds,
 *   refs left at the depth limit) for the caller to merge into its `ResultMeta`
 */
export async function resolveBlockRefs<T extends RefBearingBlock>(
  client: LogseqClient,
  roots: T[],
  options: ResolveRefsOptions = {}
): Promise<{ blocks: T[]; warnings: ResultWarning[] }> {
  const { maxDepth = DEFAULT_REF_DEPTH, embedLimit = DEFAULT_EMBED_LIMIT } = options;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error(`Invalid ref depth: ${String(maxDepth)} (expected an integer, 0 or more)`);
  }
  if (!Number.isInteger(embedLimit) || embedLimit < 1) {
    throw new Error(`Invalid embed limit: ${String(embedLimit)} (expected an integer, 1 or more)`);
  }

  const contents = collectContents(roots);
  if (!contents.some(content => scanTokens(content).length > 0)) {
    return { blocks: roots, warnings: [] };
  }

  const store = await fetchLevels(client, contents, maxDepth, embedLimit);
  const renderer = new Renderer(store, maxDepth, embedLimit);

  const annotate = (block: T): T => {
    const out: T = { ...block };
    if (typeof block.content === 'string' && scanTokens(block.content).length > 0) {
      const path = typeof block.uuid === 'string' ? [block.uuid.toLowerCase()] : [];
      const refs: ResolvedRef[] = [];
      const resolvedContent = renderer.render(block.content, path, 1, refs);
      Object.assign(out, { resolvedContent, resolvedRefs: dedupeRefs(refs) });
    }
    if (Array.isArray(block.children)) {
      // A block's children are blocks of the same kind the caller passed in
      out.children = block.children.map(child => annotate(child as T));
    }
    return out;
  };

  return { blocks: roots.map(annotate), warnings: renderer.allWarnings() };
}
