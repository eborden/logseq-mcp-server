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
 * or parameter is covered without editing this file, as long as its type is one the
 * guard has sample values for (string, number, integer, boolean, an enum or an anyOf
 * of those). Any other type fails with a message saying which case to add.
 */

afterEach(() => vi.restoreAllMocks());

interface PropertySchema {
  type?: string;
  enum?: unknown[];
  anyOf?: PropertySchema[];
}

/** The schema's type, or a clear failure for a type the guard has no sample values for yet. */
function typeOf(schema: PropertySchema): 'string' | 'number' | 'integer' | 'boolean' {
  const type = schema.type;
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return type;
  throw new Error(`guard has no value for type ${JSON.stringify(type)}: add a case to validValue and wrongValue`);
}

/** A value the parameter accepts. */
function validValue(schema: PropertySchema): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return validValue(schema.anyOf[0]);
  switch (typeOf(schema)) {
    case 'string':
      return 'Alice';
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
  }
}

/** A value of the wrong type for the parameter, with no coercion that could rescue it. */
function wrongValue(schema: PropertySchema): unknown {
  if (schema.enum) return 'not-one-of-them';
  if (schema.anyOf) return ['an', 'array'];
  switch (typeOf(schema)) {
    case 'string':
      return 5;
    case 'number':
      return '5';
    case 'integer':
      // A number, but not a whole one: what `.int()` is there to reject
      return 1.5;
    case 'boolean':
      return 'true';
  }
}

describe("the guard's sample values", () => {
  it('cover integer parameters (z.number().int())', () => {
    expect(validValue({ type: 'integer' })).toBe(1);
    expect(wrongValue({ type: 'integer' })).toBe(1.5);
  });

  it('fail clearly for a type they have no values for', () => {
    expect(() => wrongValue({ type: 'array' })).toThrow('guard has no value for type "array"');
    expect(() => validValue({})).toThrow('guard has no value for type undefined');
  });
});

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
      // A floor, so an empty tools/list can't pass: 16 tools with 56 parameters today
      expect(tools.length).toBeGreaterThanOrEqual(16);
      expect(checked).toBeGreaterThanOrEqual(56);
    });
  });
});

describe('src/index.ts reads no raw arguments (#60)', () => {
  const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  /** The identifier `args` (or `rawArgs`), not `tool-args.js`, `parseArgs` or `rawArgs`. */
  const uses = (identifier: string) => source.match(new RegExp(`(?<![\\w-])${identifier}(?![\\w-])`, 'g')) ?? [];

  it('uses args only to parse it: parseArgs(<schema>, args), one call per tool', () => {
    const declaration = 'const args = resolveParamAliases(name, rawArgs);';
    expect(source.split(declaration)).toHaveLength(2);
    const parseCalls = source.match(/\bparseArgs\(\w+Args, args\)/g) ?? [];
    // Everything else (args.x, args['x'], { x } = args, a cast) is a raw read
    const rest = source.replace(declaration, '').replace(/\bparseArgs\(\w+Args, args\)/g, '');
    expect(rest.match(/(?<![\w-])args(?![\w-])/g) ?? []).toEqual([]);
    expect(parseCalls).toHaveLength(16);
    expect(parseCalls).toHaveLength(uses('args').length - 1);
  });

  it('uses rawArgs only to fold the aliases in', () => {
    expect(uses('rawArgs')).toHaveLength(2);
    expect(source).toContain('const { name, arguments: rawArgs } = request.params;');
    expect(source).toContain('resolveParamAliases(name, rawArgs)');
  });

  it('has no `as any` casts', () => {
    expect(source).not.toMatch(/\bas any\b/);
  });
});
