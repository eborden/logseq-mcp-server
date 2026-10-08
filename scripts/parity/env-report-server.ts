// A stand-in server for the parity harness's own tests (#124): one tool, `report_env`, that
// answers with the environment variables a server could find a config through, and the clock and
// zone the harness fixes. It lets a test check that the harness gives the server a sandboxed home
// and a fixed "now", without trusting the real server.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const REPORTED_ENV = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'CFFIXED_USER_HOME', 'LOGSEQ_MCP_CONFIG', 'LOGSEQ_MCP_NOW', 'TZ'] as const;

const server = new Server({ name: 'parity-env-report', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'report_env', inputSchema: { type: 'object' } }]
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify(Object.fromEntries(REPORTED_ENV.map(key => [key, process.env[key] ?? null]))) }]
}));
void server.connect(new StdioServerTransport());
