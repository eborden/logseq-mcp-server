// A stand-in server for the parity harness's own tests (#340): one tool, `late_calls`, that makes
// three LogSeq Editor calls, as `get_current_context` does, and returns its result as soon as the
// first answer is in. The other two calls are sent 50ms later, so they reach the stub after the
// result. It is the case the harness must wait for before it reads the stub's call log.
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const METHODS = ['logseq.Editor.getCurrentPage', 'logseq.Editor.getCurrentBlock', 'logseq.Editor.getSelectedBlocks'];
const DELAY_MS = 50;

async function call(method: string): Promise<void> {
  const { apiUrl, authToken } = JSON.parse(readFileSync(process.env.LOGSEQ_MCP_CONFIG as string, 'utf8')) as { apiUrl: string; authToken: string };
  await fetch(`${apiUrl}/api`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args: [] })
  });
}

const server = new Server({ name: 'parity-late-calls', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'late_calls', inputSchema: { type: 'object' } }]
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  await call(METHODS[0]);
  setTimeout(() => void Promise.all(METHODS.slice(1).map(call)), DELAY_MS);
  return { content: [{ type: 'text', text: 'returned before the other calls were sent' }] };
});
void server.connect(new StdioServerTransport());
