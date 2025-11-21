#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { DatalogQueryBuilder } from '../src/datalog/queries.js';
import { resolve } from 'path';
import { homedir } from 'os';

async function testQuery() {
  const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
  const config = await loadConfig(configPath);
  const client = new LogseqClient(config);

  const testPage = 'alex bramer';
  console.log(`Testing concept network query for "${testPage}"...\n`);

  // Generate query
  const query = DatalogQueryBuilder.conceptNetwork(testPage, 2);
  console.log('Generated query:');
  console.log(query);
  console.log();

  // Execute
  const results = await client.executeDatalogQuery(query);
  console.log(`Results length: ${results ? results.length : 'null'}`);

  if (results && results.length > 0) {
    console.log(`\nFirst 3 results:`);
    for (let i = 0; i < Math.min(3, results.length); i++) {
      console.log(`\nResult ${i}:`);
      console.log(`  Tuple length: ${results[i].length}`);
      console.log(`  [0] Root page:`, results[i][0]);
      console.log(`  [1] Connected page:`, results[i][1]);
      console.log(`  [2] Rel type:`, results[i][2]);
    }
  }
}

testQuery().catch(console.error);
