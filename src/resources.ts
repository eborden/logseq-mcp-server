import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { LogseqClient } from './client.js';
import { AmbiguousPageError, PageNotFoundError } from './errors.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { listPrompts } from './prompts.js';
import { TOOL_DESCRIPTIONS } from './tool-descriptions.js';
import { getPage } from './tools/get-page.js';

/**
 * MCP resources (#46). Both are read-only and read-only is all this server does:
 *
 * - `logseq://guide`: the reading guide. The server `instructions` plus a one-line
 *   index of the tools and prompts, for hosts that let a user attach a resource to
 *   a conversation, or that don't pass `instructions` to the model.
 * - `logseq://page/{name}`: one page as Markdown text, through the same lookup as
 *   `logseq_get_page` (aliases, ISO dates, case-insensitive names).
 */

export const GUIDE_URI = 'logseq://guide';
const PAGE_URI_PREFIX = 'logseq://page/';
export const PAGE_URI_TEMPLATE = `${PAGE_URI_PREFIX}{name}`;

/** Longest page name accepted in a resource URI, matching the prompt topic limit. */
const MAX_PAGE_NAME_LENGTH = 200;

/**
 * Most characters of a page returned in one read. A page can be far larger than a
 * context window; the cut is announced at the end of the text, never silent.
 */
export const MAX_PAGE_CHARS = 50_000;

/** Resource not found, per the MCP spec (no named constant in this SDK version). */
const RESOURCE_NOT_FOUND = -32002;

const MARKDOWN = 'text/markdown';

/** First line of a tool description: what it does. The rest is when-to-use detail the tool list already carries. */
function summaryLine(description: string): string {
  return description.split('\n', 1)[0].trim();
}

/** The reading guide as Markdown. Pure, so tests can check it against the tool list. */
export function buildGuide(): string {
  const tools = Object.entries(TOOL_DESCRIPTIONS)
    .map(([name, description]) => `- ${name}: ${summaryLine(description)}`)
    .join('\n');
  const prompts = listPrompts()
    .map(p => `- ${p.name}: ${p.description}`)
    .join('\n');
  return [
    '# LogSeq MCP guide',
    '',
    SERVER_INSTRUCTIONS,
    '',
    '## Tools',
    '',
    tools,
    '',
    '## Prompts',
    '',
    prompts,
    '',
    '## Resources',
    '',
    `- ${GUIDE_URI}: this guide`,
    `- ${PAGE_URI_TEMPLATE}: one page as text (URL-encode the name; aliases and ISO dates work)`,
    '',
  ].join('\n');
}

interface BlockLike {
  content?: unknown;
  children?: unknown;
}

const isBlock = (value: unknown): value is BlockLike => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Render a block tree as an outline: one `- ` per block, tab-indented by depth, the
 * way LogSeq files store it. Stops at `budget` characters and reports whether it did.
 */
const TRUNCATED_BLOCK_MARKER = '\n[This block is longer than the limit and was truncated here.]';

function renderBlocks(blocks: unknown[], depth: number, budget: { left: number; cut: boolean }, out: string[]): void {
  for (const block of blocks) {
    if (budget.cut) return;
    // Unfetched children come back as ["uuid", "<id>"] tuples, not blocks
    if (!isBlock(block)) continue;
    const content = typeof block.content === 'string' ? block.content : '';
    const indent = '\t'.repeat(depth);
    const [first, ...rest] = content.split('\n');
    const lines = [`${indent}- ${first}`, ...rest.map(line => `${indent}  ${line}`)];
    const text = lines.join('\n');
    if (text.length + 1 > budget.left) {
      budget.cut = true;
      // A first block over the cap would otherwise render as an empty page.
      // Keep its start, with a marker, so the reader sees real content.
      if (out.length === 0) {
        const marker = TRUNCATED_BLOCK_MARKER;
        out.push(`${text.slice(0, Math.max(0, budget.left - marker.length - 1))}${marker}`);
      }
      return;
    }
    out.push(text);
    budget.left -= text.length + 1;
    if (Array.isArray(block.children)) renderBlocks(block.children, depth + 1, budget, out);
  }
}

/** Page name from a `logseq://page/{name}` URI, or an InvalidParams error. */
function pageNameFromUri(uri: string): string {
  const encoded = uri.slice(PAGE_URI_PREFIX.length);
  let name: string;
  try {
    name = decodeURIComponent(encoded).trim();
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid page name encoding in ${uri}. URL-encode the page name.`);
  }
  if (name === '') {
    throw new McpError(ErrorCode.InvalidParams, `No page name in ${uri}. Use ${PAGE_URI_TEMPLATE}.`);
  }
  if (name.length > MAX_PAGE_NAME_LENGTH) {
    throw new McpError(ErrorCode.InvalidParams, `Page name is ${name.length} characters; the limit is ${MAX_PAGE_NAME_LENGTH}.`);
  }
  return name;
}

/** Read a page as Markdown text. Throws `McpError` for a missing or ambiguous page. */
export async function readPageResource(client: LogseqClient, uri: string): Promise<ReadResourceResult> {
  const name = pageNameFromUri(uri);
  let page;
  try {
    page = await getPage(client, name, true);
  } catch (error) {
    if (error instanceof PageNotFoundError) {
      throw new McpError(RESOURCE_NOT_FOUND, error.message, { uri });
    }
    if (error instanceof AmbiguousPageError) {
      throw new McpError(ErrorCode.InvalidParams, error.message, { uri });
    }
    throw error;
  }

  const title = page.originalName ?? page['original-name'] ?? page.name ?? name;
  const header = [`# ${String(title)}`];
  if (page.resolvedFrom) {
    header.push('', `(resolved from ${JSON.stringify(page.resolvedFrom.name)}, matched by ${page.resolvedFrom.matchedBy})`);
  }
  header.push('');

  const outline: string[] = [];
  const budget = { left: MAX_PAGE_CHARS, cut: false };
  const blocks = Array.isArray(page.children) ? page.children : [];
  renderBlocks(blocks, 0, budget, outline);

  const body = outline.length > 0 || budget.cut ? outline.join('\n') : '(this page has no blocks)';
  const notice = budget.cut
    ? `\n\n[Cut at ${MAX_PAGE_CHARS} characters. The page continues. Use logseq_get_page or logseq_get_block for the rest.]`
    : '';

  return {
    contents: [{ uri, mimeType: MARKDOWN, text: `${header.join('\n')}\n${body}${notice}\n` }],
  };
}

/**
 * Wire `resources/list`, `resources/templates/list` and `resources/read` onto the
 * server. The server must declare the `resources` capability.
 */
export function registerResources(server: Server, client: LogseqClient): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: GUIDE_URI,
        name: 'guide',
        title: 'LogSeq reading guide',
        description: 'How to read this server\'s results, which tool to start with, and an index of tools and prompts.',
        mimeType: MARKDOWN,
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: PAGE_URI_TEMPLATE,
        name: 'page',
        title: 'LogSeq page',
        description: 'One page and its blocks as Markdown text. The name is case-insensitive and may be an alias or an ISO date (2025-01-01) for a journal.',
        mimeType: MARKDOWN,
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const { uri } = request.params;
    if (uri === GUIDE_URI) {
      return { contents: [{ uri, mimeType: MARKDOWN, text: buildGuide() }] };
    }
    if (uri.startsWith(PAGE_URI_PREFIX)) {
      return readPageResource(client, uri);
    }
    throw new McpError(RESOURCE_NOT_FOUND, `Unknown resource ${JSON.stringify(uri)}. Available: ${GUIDE_URI}, ${PAGE_URI_TEMPLATE}.`, { uri });
  });
}
