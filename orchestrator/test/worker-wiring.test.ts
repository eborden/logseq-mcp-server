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

test('the remote implementer is registered with the remote session activity', () => {
  assert.match(source, /createRemoteImplementerActivities\(/);
  assert.match(source, /\.\.\.remoteImplementer\b/);
});
