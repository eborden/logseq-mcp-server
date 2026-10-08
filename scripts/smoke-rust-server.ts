/**
 * Smoke run of the Rust server binary against this worktree's fixture LogSeq (#359).
 *
 * Usage (start the fixture instance first: `npx tsx scripts/logseq-instance.ts start`):
 *   node node_modules/vite-node/vite-node.mjs scripts/smoke-rust-server.ts rust/target/release/logseq-mcp-server
 *
 * It drives the binary over MCP stdio with the SDK client, the way Claude Code does, and calls
 * each of the 16 tools once on a fixture page, reads `logseq://page/{name}` and `logseq://guide`,
 * gets one prompt and lists tools, prompts, resources and resource templates. It prints one
 * PASS or FAIL line per item and a count, never a result's content (BR-0001), and exits 1 on
 * any failure.
 *
 * The config is the one `connectFixture` finds (LOGSEQ_MCP_CONFIG, else this worktree's
 * .logseq-instance/config.json): never ~/.logseq-mcp/config.json, and port 12315 is refused.
 * The server gets a home of its own, so it has no personal config to fall back on.
 */
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectFixture } from '../tests/integration/helpers/fixture-client.js';

const EXPECTED_TOOLS = 16;

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

// Made-up fixture pages and a known fixture block (tests/fixtures/README.md)
const TOOL_CALLS: ToolCall[] = [
  { name: 'logseq_get_graph_info', args: {} },
  { name: 'logseq_get_current_context', args: {} },
  { name: 'logseq_list_pages', args: { name_contains: 'project', limit: 10 } },
  { name: 'logseq_get_page', args: { page_name: 'project atlas', include_children: true } },
  { name: 'logseq_get_page_outline', args: { page_name: 'project atlas' } },
  { name: 'logseq_get_block', args: { block_uuid: '0088f1a0-0000-4000-8000-000000000001' } },
  { name: 'logseq_get_backlinks', args: { page_name: 'Bob' } },
  { name: 'logseq_search_blocks', args: { query: 'launch checklist', limit: 5 } },
  { name: 'logseq_query_by_property', args: { property_key: 'status', property_value: 'active' } },
  { name: 'logseq_build_context', args: { topic_name: 'project atlas' } },
  { name: 'logseq_get_context_for_query', args: { query: 'what is in [[project atlas]]?' } },
  { name: 'logseq_get_concept_network', args: { concept_name: 'Alice', max_depth: 2 } },
  { name: 'logseq_search_by_relationship', args: { topic_a: 'Alice', topic_b: 'Bob', relationship_type: 'references' } },
  { name: 'logseq_query_by_date_range', args: { start_date: 20250101, end_date: 20250131 } },
  { name: 'logseq_get_concept_evolution', args: { concept_name: 'project atlas' } },
  { name: 'logseq_check_links', args: { before: 'Alice met Bob about atlas.', after: '[[Alice]] met [[Bob]] about [[atlas]].' } },
];

let passed = 0;
let failed = 0;

function report(item: string, ok: boolean, why = ''): void {
  if (ok) passed += 1;
  else failed += 1;
  console.error(`${ok ? 'PASS' : 'FAIL'}  ${item}${ok ? '' : `  (${why})`}`);
}

/** Run one check. A failure names the kind of problem, never a value from the graph. */
async function check(item: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    const problem = await run();
    report(item, problem === undefined, problem);
  } catch (error) {
    report(item, false, `threw ${error instanceof Error ? error.constructor.name : typeof error}`);
  }
}

type Content = Array<{ type: string; text?: string }>;

/** A tool result is usable: not flagged as an error, with text that is not a `{ "error": ... }` object. */
function toolProblem(result: { isError?: boolean; content?: unknown }): string | undefined {
  if (result.isError) return 'isError';
  const content = (result.content ?? []) as Content;
  const text = content.find(part => part.type === 'text')?.text;
  if (!text) return 'no text content';
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'error' in parsed) return 'result has an error key';
    } catch {
      return 'JSON that does not parse';
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const binaryArg = process.argv[2];
  if (!binaryArg) throw new Error('Usage: smoke-rust-server.ts <path to the logseq-mcp-server binary>');
  const binary = isAbsolute(binaryArg) ? binaryArg : resolve(binaryArg);

  // Refuses port 12315 and any graph that is not the fixture, before the server starts
  const { configPath } = await connectFixture();

  const dir = await mkdtemp(join(tmpdir(), 'logseq-mcp-smoke-'));
  const home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.LOGSEQ_MCP_NOW;
  env.LOGSEQ_MCP_CONFIG = configPath;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  if (process.platform === 'darwin') env.CFFIXED_USER_HOME = home;

  const transport = new StdioClientTransport({ command: binary, args: [], env, stderr: 'ignore' });
  const mcp = new Client({ name: 'logseq-smoke', version: '1.0.0' }, { capabilities: {} });
  try {
    await mcp.connect(transport);

    await check('initialize: serverInfo and instructions', async () => {
      const info = mcp.getServerVersion();
      if (!info?.name || !info.version) return 'no serverInfo';
      if (!mcp.getInstructions()) return 'no instructions';
      return undefined;
    });

    let toolNames: string[] = [];
    await check(`tools/list: ${EXPECTED_TOOLS} tools`, async () => {
      const { tools } = await mcp.listTools();
      toolNames = tools.map(tool => tool.name);
      if (tools.length !== EXPECTED_TOOLS) return `${tools.length} tools`;
      const bad = tools.filter(tool => tool.inputSchema?.type !== 'object' || JSON.stringify(tool.inputSchema).includes('$ref'));
      if (bad.length > 0) return `${bad.length} schemas with a $ref or no object type`;
      return undefined;
    });

    await check('prompts/list', async () => {
      const { prompts } = await mcp.listPrompts();
      return prompts.length > 0 ? undefined : 'no prompts';
    });
    await check('resources/list: the guide', async () => {
      const { resources } = await mcp.listResources();
      return resources.some(resource => resource.uri === 'logseq://guide') ? undefined : 'no logseq://guide';
    });
    await check('resources/templates/list: the page template', async () => {
      const { resourceTemplates } = await mcp.listResourceTemplates();
      return resourceTemplates.some(template => template.uriTemplate === 'logseq://page/{name}') ? undefined : 'no page template';
    });

    for (const call of TOOL_CALLS) {
      await check(`tools/call ${call.name}`, async () => {
        if (!toolNames.includes(call.name)) return 'not listed';
        return toolProblem((await mcp.callTool({ name: call.name, arguments: call.args })) as { isError?: boolean; content?: unknown });
      });
    }

    await check('resources/read logseq://page/{name}', async () => {
      const { contents } = await mcp.readResource({ uri: `logseq://page/${encodeURIComponent('project atlas')}` });
      const text = contents[0] && 'text' in contents[0] ? contents[0].text : undefined;
      return text ? undefined : 'no text';
    });
    await check('resources/read logseq://guide', async () => {
      const { contents } = await mcp.readResource({ uri: 'logseq://guide' });
      const text = contents[0] && 'text' in contents[0] ? contents[0].text : undefined;
      return text ? undefined : 'no text';
    });
    await check('prompts/get continue_on', async () => {
      const { messages } = await mcp.getPrompt({ name: 'continue_on', arguments: { topic: 'project atlas' } });
      return messages.length > 0 ? undefined : 'no messages';
    });
  } finally {
    await mcp.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }

  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
