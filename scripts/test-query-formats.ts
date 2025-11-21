#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { resolve } from 'path';
import { homedir } from 'os';

async function testFormats() {
  const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
  const config = await loadConfig(configPath);
  const client = new LogseqClient(config);

  console.log('Testing query formats...\n');

  // Format 1: Simple query string only
  console.log('1. Simple query string (no parameters):');
  const query1 = '[:find (pull ?p [:block/name :db/id]) :where [?p :block/name] :limit 3]';
  const result1 = await client.callAPI('logseq.DB.datascriptQuery', [query1]);
  console.log(`   Result length: ${result1 ? result1.length : 'null'}`);
  if (result1 && result1.length > 0) {
    console.log(`   First result:`, result1[0]);
  }

  //Format 2: With :inputs object
  console.log('\n2. Query with :inputs object format:');
  const queryObj = {
    query: '[:find (pull ?p [*]) :in $ ?page-name :where [?p :block/name ?page-name]]',
    inputs: ['alex bramer']
  };
  try {
    const result2 = await client.callAPI('logseq.DB.datascriptQuery', [queryObj]);
    console.log(`   Result:`, result2);
  } catch (error) {
    console.error(`   ERROR:`, error instanceof Error ? error.message : error);
  }

  // Format 3: Query string + separate inputs parameter
  console.log('\n3. Query string with separate inputs parameter:');
  const query3 = '[:find (pull ?p [*]) :in $ ?page-name :where [?p :block/name ?page-name]]';
  try {
    const result3 = await client.callAPI('logseq.DB.datascriptQuery', [query3, 'alex bramer']);
    console.log(`   Result:`, result3);
    console.log(`   Length:`, result3 ? result3.length : 0);
  } catch (error) {
    console.error(`   ERROR:`, error instanceof Error ? error.message : error);
  }
}

testFormats().catch(console.error);
