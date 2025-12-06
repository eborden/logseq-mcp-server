#!/usr/bin/env npx tsx

/**
 * Test script to inspect what logseq.App.getCurrentGraph returns
 *
 * Usage:
 *   npx tsx scripts/test-current-graph.ts
 *
 * Prerequisites:
 *   - LogSeq must be running
 *   - HTTP API must be enabled in LogSeq settings
 *   - Config file at ~/.logseq-mcp/config.json
 */

import { LogseqClient } from '../src/client.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

async function testCurrentGraph() {
  try {
    // Load config
    const configPath = join(homedir(), '.logseq-mcp', 'config.json');
    const configContent = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    const clientConfig = {
      apiUrl: config.apiUrl || 'http://127.0.0.1:12315',
      authToken: config.authToken || ''
    };

    console.log(`Connecting to: ${clientConfig.apiUrl}`);
    console.log(`Using token: ${clientConfig.authToken ? '[present]' : '[none]'}\n`);

    const client = new LogseqClient(clientConfig);

    console.log('Testing logseq.App.getCurrentGraph...\n');

    // Test getCurrentGraph
    const graphInfo = await client.callAPI('logseq.App.getCurrentGraph');
    console.log('getCurrentGraph returned:');
    console.log(JSON.stringify(graphInfo, null, 2));
    console.log('\n---\n');

    // Test getInfo
    console.log('Testing logseq.App.getInfo...\n');
    const appInfo = await client.callAPI('logseq.App.getInfo');
    console.log('getInfo returned:');
    console.log(JSON.stringify(appInfo, null, 2));
    console.log('\n---\n');

    // Test getVersion
    console.log('Testing logseq.App.getVersion...\n');
    const version = await client.callAPI('logseq.App.getVersion');
    console.log('getVersion returned:');
    console.log(JSON.stringify(version, null, 2));
    console.log('\n---\n');

    // Try potential path-related methods
    const methodsToTry = [
      'logseq.App.getGraphPath',
      'logseq.App.getGraphUri',
      'logseq.App.getGraphDirectory',
      'logseq.Graph.getPath',
      'logseq.Graph.getDirectory',
      'logseq.App.getUserConfigs',
      'logseq.App.getStateFromStore'
    ];

    console.log('Trying potential path-related methods...\n');
    for (const method of methodsToTry) {
      try {
        const result = await client.callAPI(method as any);
        console.log(`✅ ${method} returned:`);
        console.log(JSON.stringify(result, null, 2));
        console.log('');
      } catch (error) {
        console.log(`❌ ${method} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testCurrentGraph();
