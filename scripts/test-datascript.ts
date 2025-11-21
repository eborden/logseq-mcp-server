#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { resolve } from 'path';
import { homedir } from 'os';

async function testDatascript() {
  const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
  const config = await loadConfig(configPath);
  const client = new LogseqClient(config);

  console.log('Testing logseq.DB.datascriptQuery...\n');

  // Test: Find all pages
  console.log('1. Find all pages:');
  const result = await client.callAPI('logseq.DB.datascriptQuery', [
    '[:find (pull ?p [*]) :where [?p :block/name]]'
  ]);
  console.log(`   Result type:`, typeof result);
  console.log(`   Result is null:`, result === null);
  console.log(`   Result is array:`, Array.isArray(result));
  if (Array.isArray(result)) {
    console.log(`   Length: ${result.length}`);
    if (result.length > 0) {
      console.log(`   First 3 results:`, result.slice(0, 3).map((r: any) => {
        const page = Array.isArray(r) ? r[0] : r;
        return page.name || page['original-name'] || page.originalName;
      }));
    }
  }

  // Test 2: Query with parameter
  console.log('\n2. Query with parameter (alex bramer):');
  const query2 = '[:find (pull ?p [*]) :in $ ?page-name-lower :where [?p :block/name ?page-name-lower]]';
  const result2 = await client.callAPI('logseq.DB.datascriptQuery', [query2, 'alex bramer']);
  console.log(`   Result:`, result2);
  console.log(`   Length:`, result2 ? result2.length : 0);
}

testDatascript().catch(console.error);
