#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { resolve } from 'path';
import { homedir } from 'os';

async function testMethods() {
  const configPath = resolve(homedir(), '.logseq-mcp', 'config.json');
  const config = await loadConfig(configPath);
  const client = new LogseqClient(config);

  console.log('Testing LogSeq API methods...\n');

  // Test if logseq.DB.q exists
  console.log('1. Testing if logseq.DB.q method exists:');
  try {
    const result = await client.callAPI('logseq.DB.q', ['[:find ?e :where [?e :db/id]]']);
    console.log(`   Method exists! Result type:`, typeof result);
    console.log(`   Result is null:`, result === null);
    console.log(`   Result value:`, result);
  } catch (error) {
    console.error(`   ERROR:`, error instanceof Error ? error.message : error);
  }

  // Test DB.datascriptQuery (alternative method name)
  console.log('\n2. Testing logseq.DB.datascriptQuery:');
  try {
    const result = await client.callAPI('logseq.DB.datascriptQuery', ['[:find ?e :where [?e :db/id]]']);
    console.log(`   Result:`, result);
  } catch (error) {
    console.error(`   ERROR:`, error instanceof Error ? error.message : error);
  }

  // List available DB methods
  console.log('\n3. Checking LogSeq version:');
  try {
    const version = await client.callAPI('logseq.App.getInfo');
    console.log(`   LogSeq info:`, version);
  } catch (error) {
    console.error(`   ERROR:`, error instanceof Error ? error.message : error);
  }
}

testMethods().catch(console.error);
