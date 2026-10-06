import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { LogseqClient } from './client.js';

/**
 * Every tool parses its arguments before doing any work (#60, ADR-0019): for each
 * parameter each tool advertises, a value of the wrong type is rejected with an
 * error naming it, and LogSeq is never called. Driven by tools/list, so a new tool
 * or parameter is covered without editing this file.
 */

afterEach(() => vi.restoreAllMocks());

interface PropertySchema {
  type?: string;
  enum?: unknown[];
  anyOf?: PropertySchema[];
}

/** A value the parameter accepts. */
function validValue(schema: PropertySchema): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return validValue(schema.anyOf[0]);
  switch (schema.type) {
    case 'number':
      return 1;
    case 'boolean':
      return true;
    default:
      return 'Alice';
  }
}

/** A value of the wrong type for the parameter, with no coercion that could rescue it. */
function wrongValue(schema: PropertySchema): unknown {
  if (schema.enum) return 'not-one-of-them';
  if (schema.anyOf) return ['an', 'array'];
  switch (schema.type) {
    case 'number':
      return '5';
    case 'boolean':
      return 'true';
    default:
      return 5;
  }
}

async function withServer<T>(fn: (mcp: Client, calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const logseq = new LogseqClient({ apiUrl: 'http://localhost:12315', authToken: 'test-token-123' });
  vi.spyOn(logseq, 'callAPI').mockImplementation(async (method: string) => {
    calls.push(method);
    return null as any;
  });
  vi.spyOn(logseq, 'executeDatalogQuery').mockImplementation(async (query: string) => {
    calls.push(query);
    return [] as any;
  });
  const server = createServer(logseq, { tips: false });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    return await fn(mcp, calls);
  } finally {
    await mcp.close();
  }
}

describe('every advertised parameter is parsed before any LogSeq call (#60)', () => {
  it('rejects a wrong-typed value for each parameter of each tool, naming it', async () => {
    await withServer(async (mcp, calls) => {
      const { tools } = await mcp.listTools();
      let checked = 0;
      for (const tool of tools) {
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, PropertySchema>;
        const required = (tool.inputSchema.required ?? []) as string[];
        const valid = Object.fromEntries(required.map(name => [name, validValue(properties[name])]));
        for (const [param, schema] of Object.entries(properties)) {
          const result = (await mcp.callTool({
            name: tool.name,
            arguments: { ...valid, [param]: wrongValue(schema) },
          })) as { isError?: boolean; content: Array<{ text: string }> };
          const label = `${tool.name} ${param}`;
          expect(result.isError, label).toBe(true);
          expect(JSON.parse(result.content[0].text).error, label).toContain(`Invalid parameter '${param}'`);
          expect(calls, label).toEqual([]);
          checked++;
        }
      }
      // A floor, so an empty tools/list can't pass: 15 tools with 54 parameters today
      expect(tools.length).toBeGreaterThanOrEqual(15);
      expect(checked).toBeGreaterThanOrEqual(54);
    });
  });
});

describe('src/index.ts reads no raw arguments (#60)', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('has no args?.x reads', () => {
    // `args.` but not `tool-args.js`
    expect(source).not.toMatch(/(?<![\w-])args\??\./);
  });

  it('has no `as any` casts', () => {
    expect(source).not.toMatch(/\bas any\b/);
  });
});
