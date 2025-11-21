#!/usr/bin/env node
/**
 * Test Datalog query to debug issues
 */

import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { resolve } from 'path';
import { homedir } from 'os';

async function testQuery() {
  const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
  const config = await loadConfig(configPath);
  const client = new LogseqClient(config);

  console.log('Testing Datalog queries...\n');

  // Test 1: Get all pages (working reference)
  console.log('1. Getting all pages using Editor.getAllPages:');
  const allPages = await client.callAPI('logseq.Editor.getAllPages');
  console.log(`   Found ${allPages.length} pages`);
  console.log(`   First 3 pages:`, allPages.slice(0, 3).map((p: any) => p.name || p.originalName));

  // Test 2: Simple Datalog query
  console.log('\n2. Testing simple Datalog query (find all pages):');
  const query1 = '[:find (pull ?p [*]) :where [?p :block/name]]';
  const result1 = await client.executeDatalogQuery(query1);
  console.log(`   Result type:`, typeof result1, result1 === null ? 'NULL' : 'NOT NULL');
  if (result1) {
    console.log(`   Result length: ${result1.length}`);
    console.log(`   First result:`, result1[0]);
  } else {
    console.log(`   Result is null!`);
  }

  // Test 3: Query with parameter
  const testPage = allPages[0].name || allPages[0].originalName;
  console.log(`\n3. Testing query with parameter for page: "${testPage}"`);

  const query2 = '[:find (pull ?p [*]) :in $ ?page-name :where [?p :block/name ?page-name-lower] [(clojure.string/lower-case ?page-name) ?page-name-lower]]';
  try {
    const result2 = await client.executeDatalogQuery(query2, testPage);
    console.log(`   Result length: ${result2.length}`);
    console.log(`   Result:`, result2);
  } catch (error) {
    console.error(`   ERROR:`, error);
  }

  // Test 4: Query without lowercase
  console.log(`\n4. Testing direct page name lookup for: "${testPage}"`);
  const testPageLower = testPage.toLowerCase();
  const query3 = '[:find (pull ?p [*]) :in $ ?page-name-lower :where [?p :block/name ?page-name-lower]]';
  const result3 = await client.executeDatalogQuery(query3, testPageLower);
  console.log(`   Result length: ${result3.length}`);
  console.log(`   Found:`, result3.length > 0 ? 'YES' : 'NO');
}

testQuery().catch(console.error);
