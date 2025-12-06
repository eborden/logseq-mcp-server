#!/usr/bin/env tsx
import { resolve } from 'path';
import { homedir } from 'os';
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { getGraphInfo } from '../src/tools/get-graph-info.js';

async function main() {
  console.log('Testing logseq_get_graph_info...\n');

  // Load config
  const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
  const config = await loadConfig(configPath);

  // Create client
  const client = new LogseqClient(config);

  // Call tool
  const result = await getGraphInfo(client);

  // Display results
  console.log('Graph Info:');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nPath can be used to construct file paths:');
  console.log(`${result.path}/pages/Weekly 2025-12-01.md`);
}

main().catch(console.error);
