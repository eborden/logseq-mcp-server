import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';

// Guards for decisions held by the GitHub Actions workflows (#96).
//
// No YAML parser is a dependency, and adding one for two small files isn't worth
// it, so this reads the workflows with a minimal block-YAML reader. It handles
// what the workflows use: `key: value` maps nested by indentation, block lists
// (`- item`), inline lists (`[a, b]`), quoted scalars, comments and block scalars
// (`run: |`, kept as their dedented text). Anything it can't read throws, so a workflow rewritten in a form it
// doesn't know fails the test loudly instead of passing it by accident.

interface YamlNode {
  /** The scalar after `key:` or `- `, unquoted, or a block scalar's dedented text. Empty when the value is a nested block. */
  value: string;
  /** Child keys in order. Duplicates throw. */
  map: Map<string, YamlNode>;
  /** Block list items (`- x`) directly under this node. */
  items: YamlNode[];
  line: number;
}

const newNode = (value: string, line: number): YamlNode => ({ value, map: new Map(), items: [], line });

function unquote(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** Drop a trailing ` # comment` that isn't inside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/** Split `key: value` (or `key:`). Returns null when the text is not a mapping entry. */
function splitKey(text: string): { key: string; value: string } | null {
  const m = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
  return m ? { key: unquote(m[1]), value: m[2] ?? '' } : null;
}

function parseWorkflowYaml(source: string): YamlNode {
  const root = newNode('', 0);
  // Each open block: the node it fills, the indent of its entries (-1 until the first one sets
  // it) and the indent of the line that opened it. An entry must sit deeper than that line,
  // except a block list under a key, which YAML allows at the key's own indent.
  type Block = { node: YamlNode; indent: number; opener: number; listAtOpener?: boolean };
  const stack: Block[] = [{ node: root, indent: 0, opener: -1 }];
  const closes = (block: Block, indent: number, isItem: boolean) =>
    block.indent === -1
      ? indent < block.opener || (indent === block.opener && !(isItem && block.listAtOpener))
      : indent < block.indent || (indent === block.opener && !isItem); // a list at its key's indent ends at the next key
  const lines = source.split('\n');
  // An open `|` or `>` scalar: the indent of its key and the node that receives its lines.
  let blockScalar: { indent: number; node: YamlNode; lines: string[] } | null = null;
  const closeBlockScalar = () => {
    if (!blockScalar) return;
    const body = blockScalar.lines;
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    const pad = Math.min(...body.filter(l => l.trim() !== '').map(l => l.length - l.trimStart().length));
    blockScalar.node.value = body.map(l => l.slice(Number.isFinite(pad) ? pad : 0)).join('\n');
    blockScalar = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;
    const indent = raw.length - raw.trimStart().length;
    if (blockScalar) {
      if (raw.trim() === '' || indent > blockScalar.indent) {
        blockScalar.lines.push(raw); // text of a `|` or `>` scalar
        continue;
      }
      closeBlockScalar();
    }
    if (raw.trim() === '') continue;
    if (raw.slice(0, indent).includes('\t')) throw new Error(`Tab indentation on line ${lineNo}`);
    if (raw.trimStart().startsWith('#')) continue;

    const isItem = /^-(?:\s|$)/.test(raw.trimStart());
    while (stack.length > 1 && closes(stack[stack.length - 1], indent, isItem)) stack.pop();
    let top = stack[stack.length - 1];
    if (top.indent === -1) top.indent = indent;
    if (indent !== top.indent) throw new Error(`Unexpected indentation on line ${lineNo}: ${raw.trim()}`);

    let text = stripComment(raw.trimStart());
    let entryIndent = indent;
    let owner = top.node;

    if (text === '-' || text.startsWith('- ')) {
      if (owner.map.size > 0) throw new Error(`Can't read line ${lineNo}: a list item among map keys`);
      const item = newNode('', lineNo);
      owner.items.push(item);
      const rest = text.slice(1).trimStart();
      if (rest === '') {
        stack.push({ node: item, indent: -1, opener: indent });
        continue;
      }
      const kv = splitKey(rest);
      if (!kv) {
        item.value = unquote(rest);
        continue;
      }
      // `- key: value` opens a map whose further keys sit at the indent of `key`.
      entryIndent = indent + (text.length - rest.length);
      stack.push({ node: item, indent: entryIndent, opener: indent });
      owner = item;
      text = rest;
    }

    const kv = splitKey(text);
    if (!kv) throw new Error(`Can't read line ${lineNo}: ${raw.trim()}`);
    if (owner.items.length > 0) throw new Error(`Can't read line ${lineNo}: a map key among list items`);
    if (owner.map.has(kv.key)) throw new Error(`Duplicate key "${kv.key}" on line ${lineNo}`);
    const child = newNode('', lineNo);
    owner.map.set(kv.key, child);
    if (kv.value === '') {
      stack.push({ node: child, indent: -1, opener: entryIndent, listAtOpener: true });
    } else if (/^[|>][+-]?\d*$/.test(kv.value)) {
      blockScalar = { indent: entryIndent, node: child, lines: [] };
    } else {
      child.value = unquote(kv.value);
    }
  }
  closeBlockScalar();
  return root;
}

function at(node: YamlNode, ...path: string[]): YamlNode {
  let current = node;
  for (const [i, key] of path.entries()) {
    const next = current.map.get(key);
    if (!next) throw new Error(`Workflow has no "${path.slice(0, i + 1).join('.')}"`);
    current = next;
  }
  return current;
}

/** A list written either inline (`[22, 24]`) or as block items. */
function listOf(node: YamlNode): string[] {
  if (node.items.length > 0) return node.items.map(item => item.value);
  const inline = /^\[(.*)\]$/.exec(node.value);
  if (!inline) throw new Error(`Expected a list on line ${node.line}, got "${node.value}"`);
  return inline[1].split(',').map(unquote).filter(v => v !== '');
}

/**
 * The trigger keys of a workflow. `on` may be a map, an inline list or a single
 * event name. YAML 1.1 reads a bare `on` key as `true`, so that spelling counts too.
 */
function triggers(workflow: YamlNode): string[] {
  const keys = ['on', 'true'].filter(k => workflow.map.has(k));
  if (keys.length !== 1) throw new Error(`Expected exactly one "on" key, found ${keys.length}`);
  const on = workflow.map.get(keys[0])!;
  if (on.map.size > 0) return [...on.map.keys()];
  if (on.value.startsWith('[')) return listOf(on);
  return on.value === '' ? [] : [on.value];
}

/** A job's `if:` condition with any `${{ }}` wrapper removed. */
function jobCondition(job: YamlNode): string | undefined {
  const raw = job.map.get('if')?.value;
  if (raw === undefined) return undefined;
  const wrapped = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(raw);
  return (wrapped ? wrapped[1] : raw).trim();
}

const readWorkflow = (name: string) =>
  readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf-8');

describe('workflow YAML reader', () => {
  it('reads nested maps, block and inline lists, comments and block scalars', () => {
    const doc = parseWorkflowYaml(
      [
        'on:',
        '  workflow_dispatch: # manual',
        '    inputs:',
        '      dry_run:',
        '        default: true',
        'jobs:',
        '  a:',
        "    if: ${{ github.ref == 'refs/heads/main' }}",
        '    strategy:',
        '      matrix:',
        '        node: [22, "24"]',
        '        os:',
        '          - ubuntu-latest',
        '    steps:',
        '      - uses: x',
        '        with:',
        '          k: v',
        '      - run: |',
        '          echo "a: b"',
        '          - not a list item',
        'flat:',
        '- one',
        '- two',
        'empty:',
        'after: x',
      ].join('\n'),
    );
    expect(triggers(doc)).toEqual(['workflow_dispatch']);
    expect(at(doc, 'on', 'workflow_dispatch', 'inputs', 'dry_run', 'default').value).toBe('true');
    expect(jobCondition(at(doc, 'jobs', 'a'))).toBe("github.ref == 'refs/heads/main'");
    expect(listOf(at(doc, 'jobs', 'a', 'strategy', 'matrix', 'node'))).toEqual(['22', '24']);
    expect(listOf(at(doc, 'jobs', 'a', 'strategy', 'matrix', 'os'))).toEqual(['ubuntu-latest']);
    const steps = at(doc, 'jobs', 'a', 'steps').items;
    expect(steps).toHaveLength(2);
    expect(at(steps[0], 'with', 'k').value).toBe('v');
    expect(at(steps[1], 'run').value).toBe('echo "a: b"\n- not a list item');
    expect(listOf(at(doc, 'flat'))).toEqual(['one', 'two']);
    expect(at(doc, 'empty').map.size).toBe(0);
    expect(at(doc, 'after').value).toBe('x');
  });

  it('reads the inline and single-event forms of on', () => {
    expect(triggers(parseWorkflowYaml('on: [push, workflow_dispatch]'))).toEqual(['push', 'workflow_dispatch']);
    expect(triggers(parseWorkflowYaml('on: push'))).toEqual(['push']);
    expect(triggers(parseWorkflowYaml('"on":\n  push:'))).toEqual(['push']);
  });

  it('throws on a duplicate key or a line it cannot read', () => {
    expect(() => parseWorkflowYaml('on:\n  push:\n  push:')).toThrow(/Duplicate key/);
    expect(() => parseWorkflowYaml('on:\n  {push: {}}')).toThrow(/Can't read/);
    expect(() => parseWorkflowYaml('on: push\n"on": pull_request')).toThrow(/Duplicate key/);
    expect(() => triggers(parseWorkflowYaml('on: push\ntrue: pull_request'))).toThrow(/exactly one/);
    expect(() => parseWorkflowYaml('steps:\n  - a\n  next: b')).toThrow(/among list items/);
  });
});

// ADR-0017 (manual-npm-publish): publishing runs only when the maintainer starts
// the workflow by hand, from main, and a run defaults to a dry run.
describe('ADR-0017: publish.yml is manual, main-only and dry-run by default', () => {
  const publish = parseWorkflowYaml(readWorkflow('publish.yml'));

  it('triggers on workflow_dispatch and nothing else', () => {
    expect(triggers(publish)).toEqual(['workflow_dispatch']);
  });

  it('has a boolean dry_run input that defaults to true', () => {
    const dryRun = at(publish, 'on', 'workflow_dispatch', 'inputs', 'dry_run');
    expect(at(dryRun, 'type').value).toBe('boolean');
    expect(at(dryRun, 'default').value).toBe('true');
  });

  it('the step that publishes reads dry_run and runs npm publish --dry-run when it is set', () => {
    const steps = [...at(publish, 'jobs').map.values()].flatMap(job => job.map.get('steps')?.items ?? []);
    const publishing = steps.filter(step => /\bnpm\s+publish\b/.test(step.map.get('run')?.value ?? ''));
    expect(publishing).toHaveLength(1);
    const [step] = publishing;
    expect(at(step, 'env', 'DRY_RUN').value).toMatch(/^\$\{\{\s*inputs\.dry_run\s*\}\}$/);
    // The first npm publish in the script is the dry run, inside the DRY_RUN = true branch.
    const script = at(step, 'run').value.split('\n').map(line => line.trim());
    const check = script.findIndex(line => /^if \[ "\$DRY_RUN" = "true" \]; then$/.test(line));
    const firstPublish = script.findIndex(line => /\bnpm\s+publish\b/.test(line));
    expect(check, 'the publish script must branch on $DRY_RUN').toBeGreaterThanOrEqual(0);
    expect(firstPublish).toBe(check + 1);
    expect(script[firstPublish]).toMatch(/\s--dry-run(?:\s|$)/);
  });

  it('gates every job to refs/heads/main', () => {
    const jobs = [...at(publish, 'jobs').map.entries()];
    expect(jobs.length).toBeGreaterThan(0);
    for (const [name, job] of jobs) {
      // Extra conditions may be added with &&; an || would open the gate.
      const condition = jobCondition(job);
      expect(condition ?? '(no if: condition)', `job "${name}" must be gated to main`).toMatch(
        /^github\.ref == 'refs\/heads\/main'(?:\s*&&(?!.*\|\|).*)?$/,
      );
    }
  });
});

/** Raw-text lines that publish to a registry or use npm's publish token. */
function publishLines(name: string, text: string): string[] {
  return text
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\b(?:npm|pnpm|yarn)\s+publish\b|\bNODE_AUTH_TOKEN\b|\bNPM_TOKEN\b/.test(line))
    .map(({ n }) => `${name}:${n}`);
}

// The guards above read only publish.yml, so an `npm publish` step added to another
// workflow (ci.yml runs on every push to main) would reverse ADR-0017 with all of
// them green. This scans the raw text, because the YAML reader skips `run: |` bodies.
describe('ADR-0017: no other workflow publishes', () => {
  const WORKFLOWS_DIR = new URL('../.github/workflows/', import.meta.url);

  it('flags publish commands and the npm token in raw workflow text', () => {
    expect(
      publishLines('x.yml', ['run: npm ci', '  npm  publish --access public', 'env: { NODE_AUTH_TOKEN: x }', 'pnpm publish', 'secrets.NPM_TOKEN', 'npm run publish-docs'].join('\n')),
    ).toEqual(['x.yml:2', 'x.yml:3', 'x.yml:4', 'x.yml:5']);
  });

  it('no workflow besides publish.yml runs npm publish or reads NODE_AUTH_TOKEN or NPM_TOKEN', () => {
    const others = readdirSync(WORKFLOWS_DIR).filter(name => /\.ya?ml$/.test(name) && name !== 'publish.yml');
    expect(others.length).toBeGreaterThan(0);
    const hits = others.flatMap(name => publishLines(name, readFileSync(new URL(name, WORKFLOWS_DIR), 'utf-8')));
    expect(hits, 'publishing belongs only in publish.yml (ADR-0017)').toEqual([]);
  });
});

// ADR-0022 (minimum-node-22-12): engines.node is the dev toolchain's floor, and CI
// tests the oldest major that satisfies it and the newest (24).
describe('ADR-0022: CI covers the engines.node floor', () => {
  const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf-8'));
  const pkg = readJson('../package.json');
  const lock = readJson('../package-lock.json');
  const NEWEST_MAJOR = '24';

  type Version = [number, number, number];
  const parseVersion = (text: string): Version => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
    if (!m) throw new Error(`Not a plain x.y.z version: "${text}"`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const floorOf = (range: string): Version => {
    const m = /^>=\s*(\S+)$/.exec(range.trim());
    if (!m) throw new Error(`engines.node should be a single ">=x.y.z" floor, got "${range}"`);
    return parseVersion(m[1]);
  };
  /** Lowest version a `^x.y.z || >=x.y.z` range allows at or above `major`.0.0. Other syntax throws. */
  const lowestFrom = (range: string, major: number): Version | undefined => {
    const candidates = range.split('||').flatMap((part): Version[] => {
      const m = /^(\^|>=)\s*(\S+)$/.exec(part.trim());
      if (!m) throw new Error(`Can't read engines range part "${part.trim()}"`);
      const v = parseVersion(m[2]);
      if (m[1] === '^') return v[0] >= major ? [v] : [];
      return v[0] >= major ? [v] : [[major, 0, 0]];
    });
    return candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])[0];
  };

  const floor = floorOf(pkg.engines.node);
  const floorMajor = String(floor[0]);

  /** Jobs in ci.yml that run the unit tests, with their Node matrix. */
  const unitTestJobs = () => {
    const ci = parseWorkflowYaml(readWorkflow('ci.yml'));
    return [...at(ci, 'jobs').map.entries()]
      .filter(([, job]) => (job.map.get('steps')?.items ?? []).some(step => step.map.get('run')?.value === 'npx vitest run src'))
      .map(([name, job]) => ({ name, job, nodes: listOf(at(job, 'strategy', 'matrix', 'node')) }));
  };

  it('ci.yml has a unit-test job with a Node matrix', () => {
    expect(unitTestJobs().length).toBeGreaterThan(0);
  });

  it(`each unit-test job runs on the floor's major and on Node ${NEWEST_MAJOR}, and nothing below the floor`, () => {
    for (const { name, nodes } of unitTestJobs()) {
      expect(nodes, `job "${name}"`).toContain(floorMajor);
      expect(nodes, `job "${name}"`).toContain(NEWEST_MAJOR);
      for (const node of nodes) expect(Number(node), `job "${name}" runs Node ${node}`).toBeGreaterThanOrEqual(floor[0]);
    }
  });

  it('each unit-test job sets up the Node version from its matrix', () => {
    for (const { name, job } of unitTestJobs()) {
      const setup = at(job, 'steps').items.find(step => step.map.get('uses')?.value.startsWith('actions/setup-node@'));
      expect(setup, `job "${name}" has no actions/setup-node step`).toBeDefined();
      expect(at(setup!, 'with', 'node-version').value).toMatch(/^\$\{\{\s*matrix\.node\s*\}\}$/);
    }
  });

  it('the lockfile root carries the same engines.node as package.json', () => {
    expect(lock.packages[''].engines.node).toBe(pkg.engines.node);
  });

  it("the floor is the dev toolchain's (vite) lowest supported version in the floor's major or later", () => {
    const viteEngines = lock.packages['node_modules/vite']?.engines?.node;
    expect(viteEngines, 'vite is no longer in the lockfile; update ADR-0022 and this test').toBeDefined();
    expect(lowestFrom(viteEngines, floor[0])?.join('.')).toBe(floor.join('.'));
  });

  it('reads engines ranges', () => {
    expect(lowestFrom('^20.19.0 || >=22.12.0', 22)).toEqual([22, 12, 0]);
    expect(lowestFrom('^20.19.0 || >=22.12.0', 24)).toEqual([24, 0, 0]);
    expect(lowestFrom('>=18.0.0', 22)).toEqual([22, 0, 0]);
    expect(() => lowestFrom('22.x', 22)).toThrow(/Can't read/);
    expect(() => floorOf('^22.12.0')).toThrow(/single/);
  });
});
