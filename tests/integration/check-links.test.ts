import { describe, it, expect, beforeAll } from 'vitest';
import { LogseqClient } from '../../src/client.js';
import { checkLinks } from '../../src/tools/check-links.js';
import { connectFixture } from './helpers/fixture-client.js';

/**
 * logseq_check_links (#146) against the fixture graph, with exact results.
 *
 * Read-only. The pages it relies on (tests/fixtures/README.md, "Page resolution and
 * aliases"): `project atlas` declares the alias `atlas`, whose stub has no file; `project
 * borealis` and `project cascade` both declare `roadmap`; `archive` exists with no file and no
 * alias; `Alice` has a file and a capitalized original name.
 */

/** Terms no fixture page or alias has. */
const MADE_UP = ['zz check links probe 146 alpha', 'zz check links probe 146 beta'];

describe('check_links on the fixture graph (#146)', () => {
  let client: LogseqClient;
  /** Every API call the tool makes, by method, so a stray Editor call is counted too */
  const calls: string[] = [];

  /** `calls` is the number of API calls of any method; `methods` names them. */
  const counted = async <T>(run: () => Promise<T>): Promise<{ result: T; calls: number; methods: string[] }> => {
    const before = calls.length;
    const result = await run();
    const methods = calls.slice(before);
    return { result, calls: methods.length, methods };
  };

  beforeAll(async () => {
    ({ client } = await connectFixture());

    const original = client.callAPI.bind(client);
    client.callAPI = (async (method: string, args?: any[]) => {
      calls.push(method);
      return original(method, args);
    }) as typeof client.callAPI;
  });

  it('resolves names, aliases and file-less pages, and fails what is missing or ambiguous, in one query', async () => {
    const before = `ALICE and project atlas use atlas; see archive, the roadmap, ${MADE_UP[0]} and ${MADE_UP[1]}.`;
    const after =
      `[[ALICE]] and [[project atlas]] use [[atlas]]; see [[archive]], the [[roadmap]], ` +
      `[[${MADE_UP[0]}]] and [[${MADE_UP[1]}]].`;

    const { result, calls: used, methods } = await counted(() => checkLinks(client, before, after));

    // One call in all, and it is the Datalog query: no Editor call
    expect(used).toBe(1);
    expect(methods).toEqual(['logseq.DB.datascriptQuery']);
    expect(result.prose).toEqual({ ok: true });
    expect(result.brackets).toEqual({ ok: true, opens: 7, closes: 7 });
    expect(result.refsPreserved).toEqual({ ok: true, removed: [] });
    expect(result.refs).toEqual({
      ok: false,
      resolved: [
        { term: 'ALICE', page: 'Alice', matchedBy: 'name' },
        // File-less, but a page: linking it creates nothing
        { term: 'archive', page: 'archive', matchedBy: 'name' },
        // The stub has no file, so the alias reaches the page that declares it
        { term: 'atlas', page: 'project atlas', matchedBy: 'alias' },
        { term: 'project atlas', page: 'project atlas', matchedBy: 'name' },
      ],
      unresolved: MADE_UP,
      ambiguous: [
        {
          term: 'roadmap',
          candidates: ['project borealis', 'project cascade'],
          totalCandidates: 2,
          preexisting: false,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.totals).toEqual({ refsBefore: 0, refsAfter: 7, terms: 7 });
    expect(result.warnings).toEqual([]);
  });

  it('passes a pass that links only real pages', async () => {
    const { result } = await counted(() =>
      checkLinks(client, 'Alice reviewed atlas.', '[[Alice]] reviewed [[atlas]].')
    );

    expect(result.ok).toBe(true);
    expect(result.refs.resolved).toEqual([
      { term: 'Alice', page: 'Alice', matchedBy: 'name' },
      { term: 'atlas', page: 'project atlas', matchedBy: 'alias' },
    ]);
  });

  it('reports an ambiguous ref the note already had without failing on it', async () => {
    const { result } = await counted(() =>
      checkLinks(client, 'Alice and the [[roadmap]]', '[[Alice]] and the [[roadmap]]')
    );

    expect(result.ok).toBe(true);
    expect(result.refs.ambiguous).toEqual([
      { term: 'roadmap', candidates: ['project borealis', 'project cascade'], totalCandidates: 2, preexisting: true },
    ]);
  });

  it('fails a second copy of the ambiguous roadmap, even though the note already linked it', async () => {
    const { result } = await counted(() =>
      checkLinks(client, '[[roadmap]] and the roadmap', '[[roadmap]] and the [[roadmap]]')
    );

    expect(result.ok).toBe(false);
    expect(result.refs.ambiguous).toEqual([
      { term: 'roadmap', candidates: ['project borealis', 'project cascade'], totalCandidates: 2, preexisting: false },
    ]);
  });

  it('fails a removed ref, which the prose check alone passes', async () => {
    const { result } = await counted(() =>
      checkLinks(client, '[[Alice]] met Bob', 'Alice met [[Bob]]')
    );

    expect(result.prose).toEqual({ ok: true });
    expect(result.refs.ok).toBe(true);
    expect(result.refsPreserved).toEqual({ ok: false, removed: [{ term: 'Alice', before: 1, after: 0 }] });
    expect(result.ok).toBe(false);
  });

  it('makes no call for a text without refs', async () => {
    const { result, calls: used } = await counted(() => checkLinks(client, 'no links', 'no links'));

    expect(result.ok).toBe(true);
    expect(used).toBe(0);
  });
});
