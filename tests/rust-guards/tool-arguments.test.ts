import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { startLiveServer, type LiveServer } from './live-server.js';

/**
 * ADR-0019: every tool argument is parsed at the boundary, before any work. For every parameter of every tool in the
 * server's own `tools/list`, this sends one wrong-typed value (the other required parameters are right) and requires
 * an error result that names the parameter, with no call to LogSeq. It is the sweep `src/index.args.guard.test.ts`
 * ran against the TypeScript server, driven by the live schema, so a parameter added to a tool is covered at once. A
 * parameter of a kind this file has no sample for fails until a case is added.
 */

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: Array<{ type?: string }>;
  minimum?: number;
};

/** The one type a schema names, an optional parameter's `["number", "null"]` being a number. */
function typeOf(schema: Schema): string | undefined {
  const types = Array.isArray(schema.type) ? schema.type.filter(type => type !== 'null') : [schema.type];
  return types.length === 1 ? types[0] : undefined;
}

/** A right value for a parameter, from its schema. */
function sampleFor(name: string, schema: Schema): unknown {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf?.some(branch => ['string', 'number', 'boolean'].includes(branch.type ?? ''))) return 'x';
  switch (typeOf(schema)) {
    case 'string':
      return 'Alice';
    case 'integer':
      return schema.minimum ?? 0;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    default:
      throw new Error(`No right sample for parameter ${name} of kind ${JSON.stringify(schema)}: add one to tests/rust-guards/tool-arguments.test.ts`);
  }
}

/** A value of the wrong type for a parameter, from its schema. */
function wrongFor(name: string, schema: Schema): unknown {
  if (schema.enum || typeOf(schema) === 'string') return 42;
  if (schema.anyOf) return ['not', 'a', 'scalar'];
  switch (typeOf(schema)) {
    case 'integer':
    case 'number':
    case 'boolean':
      return 'not that';
    default:
      throw new Error(`No wrong sample for parameter ${name} of kind ${JSON.stringify(schema)}: add one to tests/rust-guards/tool-arguments.test.ts`);
  }
}

describe('a wrong-typed argument is refused before any call (ADR-0019)', () => {
  let live: LiveServer;
  let tools: Tool[];

  beforeAll(async () => {
    live = await startLiveServer();
    tools = (await live.client.listTools()).tools;
  }, 30000);

  afterAll(async () => {
    await live?.close();
  });

  it('names the parameter, makes no LogSeq call, for every parameter of every tool', async () => {
    let swept = 0;
    for (const tool of tools) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
      const required = tool.inputSchema.required ?? [];
      for (const [name, schema] of Object.entries(properties)) {
        const args: Record<string, unknown> = {};
        for (const other of required) if (other !== name) args[other] = sampleFor(other, properties[other]);
        args[name] = wrongFor(name, schema);

        live.stub.load([]);
        const result = (await live.client.callTool({ name: tool.name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
        const where = `${tool.name}.${name} = ${JSON.stringify(args[name])}`;

        expect(result.isError, `${where}: ${result.content[0]?.text}`).toBe(true);
        expect(result.content[0].text, `${where} names the parameter`).toContain(`'${name}'`);
        expect(live.stub.calls(), `${where} made a call to LogSeq`).toEqual([]);
        swept++;
      }
    }
    // Every parameter slot of the 16 tools was tried (64 when this was written; it only grows with the schema)
    expect(swept).toBe(tools.reduce((sum, tool) => sum + Object.keys(tool.inputSchema.properties ?? {}).length, 0));
    expect(swept).toBeGreaterThanOrEqual(64);
  }, 120000);
});
