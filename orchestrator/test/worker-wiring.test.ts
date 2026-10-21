// The worker is not started by any test, so a factory that is imported and never called goes unnoticed until a real run
// asks for its activity (#677: `runRemoteImplementerSession` was imported by the worker and never registered).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function importedFactories(): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/activities\/[^']+'/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim();
      if (/^create\w*Activities$/.test(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

test('every activity factory the worker imports is called, so its activities are registered', () => {
  const factories = importedFactories();
  assert.ok(factories.length >= 6, `expected the worker's factories, found ${factories.length}`);
  for (const name of factories) {
    assert.match(source, new RegExp(`${name}\\(`), `${name} is imported by src/worker.ts but never called`);
  }
});

test('the queue watcher activities are registered, with a Temporal client connection of the worker (#723)', () => {
  assert.match(source, /createQueueActivities\(\{ client: new Client\(/);
  assert.match(source, /\.\.\.queue\b/);
  assert.match(source, /Connection\.connect\(/);
});

test('both connections are closed on every path, each close in its own attempt, through one helper (#723)', () => {
  // The helper closes both, with allSettled, so one close that throws cannot skip the other.
  const helper = /async function closeBoth\([^)]*\)[^{]*\{([\s\S]*?)\n\}\n/.exec(source)?.[1];
  assert.ok(helper !== undefined, 'closeBoth is missing');
  assert.match(helper, /Promise\.allSettled\(\[[^\]]*native\.close\(\)[^\]]*\]\)/);
  assert.match(helper, /Promise\.allSettled\(\[[^\]]*client\?\.close\(\)[^\]]*\]\)/);

  // Nothing closes a connection outside the helper, where a throw would skip the other close.
  const outside = source.replace(helper, '');
  assert.doesNotMatch(outside, /\bconnection\.close\(/);
  assert.doesNotMatch(outside, /\bclientConnection\.close\(/);

  // The four paths: the client connect fails, the main worker create fails, the host worker create fails, and the end of main.
  assert.equal((source.match(/closeBoth\(connection, undefined\)/g) ?? []).length, 1, 'client connect failure');
  assert.equal((source.match(/closeBoth\(connection, clientConnection\)/g) ?? []).length, 3, 'main create failure, host create failure and finally');
  const connectCatch = /Connection\.connect\([^\n]*\)\.catch\([^\n]*\{\s*await closeBoth\(connection, undefined\);/.test(source);
  assert.ok(connectCatch, 'the client connect failure closes the worker connection');
  assert.match(source, /Worker\.create\(\{[\s\S]*?\.\.\.queue \}[\s\S]*?\}\)\.catch\(async[^\n]*\{[^}]*await closeBoth\(connection, clientConnection\);\s*throw error;/, 'the main worker create failure');
  assert.match(source, /: await Worker\.create\(\{[\s\S]*?\}\)\.catch\(async[^\n]*\{[\s\S]*?await closeBoth\(connection, clientConnection\);\s*throw error;/, 'the host worker create failure');
  assert.match(source, /\} finally \{\s*await closeBoth\(connection, clientConnection\);\s*\}/, 'the end of main');
});

test('the remote implementer is registered with the remote session activity', () => {
  assert.match(source, /createRemoteImplementerActivities\(/);
  assert.match(source, /\.\.\.remoteImplementer\b/);
});
