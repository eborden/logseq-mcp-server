/**
 * Read-only probes of LogSeq HTTP API / DataScript behavior.
 * Evidence for the "Critical LogSeq Datalog Constraints" in CLAUDE.md.
 *
 * Usage: npx tsx scripts/probe-constraints.ts
 * Requires LogSeq running with the HTTP API enabled.
 */
import { homedir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';

type Outcome = { ok: boolean; rows?: number; value?: unknown; error?: string };

async function raw(client: LogseqClient, method: string, args: unknown[]): Promise<Outcome> {
  try {
    const result = await client.callAPI<any>(method, args as any[]);
    if (result === null || result === undefined) return { ok: true, value: result };
    if (Array.isArray(result)) return { ok: true, rows: result.length, value: result.slice(0, 1) };
    return { ok: true, value: result };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

function report(label: string, o: Outcome) {
  const summary = o.ok
    ? o.rows !== undefined
      ? `rows=${o.rows}`
      : `value=${JSON.stringify(o.value)?.slice(0, 120)}`
    : `ERROR ${o.error}`;
  console.log(`${label.padEnd(58)} ${summary}`);
}

/** Describes a value without printing it: `string`, `number`, `array(2)<string>`, ... */
function shapeOf(v: unknown): string {
  if (Array.isArray(v)) return `array<${[...new Set(v.map(shapeOf))].join('|')}>`;
  return v === null ? 'null' : typeof v;
}

/**
 * Property-query probes (#33): how `:block/properties` can be filtered in
 * Datalog. Prints shapes and counts only, never property names or values.
 */
async function probeProperties(
  client: LogseqClient,
  rawDq: (q: string, ...inputs: unknown[]) => Promise<Outcome>
) {
  // Same encoding as LogseqClient.executeDatalogQuery: inputs are read as EDN.
  const dq = (q: string, ...inputs: unknown[]) => rawDq(q, ...inputs.map(v => JSON.stringify(v)));
  console.log('\n== Properties (:block/properties)');
  const maps = await client.callAPI<any[][]>('logseq.DB.datascriptQuery', [
    `[:find ?props :where [?b :block/properties ?props]]`
  ]);
  const entries = maps.flatMap(([props]) => Object.entries<unknown>(props));
  const keys = new Set(entries.map(([k]) => k));
  const shapes = new Map<string, number>();
  for (const [, v] of entries) {
    const s = Array.isArray(v) ? 'array' : shapeOf(v);
    shapes.set(s, (shapes.get(s) ?? 0) + 1);
  }
  console.log(`${'distinct property maps / keys'.padEnd(58)} ${maps.length} / ${keys.size}`);
  console.log(`${'value shapes (key,value pairs)'.padEnd(58)} ${JSON.stringify(Object.fromEntries(shapes))}`);
  const strictName = /^[a-z0-9][a-z0-9_-]*$/;
  console.log(
    `${'keys with a dash / uppercase / underscore / not [a-z0-9_-]'.padEnd(58)} ` +
      `${[...keys].filter(k => k.includes('-')).length} / ${[...keys].filter(k => /[A-Z]/.test(k)).length} / ` +
      `${[...keys].filter(k => k.includes('_')).length} / ${[...keys].filter(k => !strictName.test(k)).length}`
  );

  // Pick a probe key whose value is a plain string, and one whose value is an array.
  const pick = (want: (v: unknown) => boolean) =>
    entries.find(([k, v]) => strictName.test(k) && want(v))?.[0];
  const scalarKey = pick(v => typeof v === 'string');
  const arrayKey = pick(v => Array.isArray(v));
  if (!scalarKey || !arrayKey) {
    console.log('(graph has no scalar-string or array-valued property: skipping the rest)');
    return;
  }

  const get = (key: string, kw: string) =>
    `[:find (count ?b) . :where [?b :block/properties ?p] [(get ?p ${kw}) ?v]]`;
  report('get with keyword literal (:key)', await dq(get(scalarKey, `:${scalarKey}`)));
  report('get with string literal ("key")', await dq(get(scalarKey, JSON.stringify(scalarKey))));

  const inQ = `[:find (count ?b) . :in $ ?k :where [?b :block/properties ?p] [(get ?p ?k) ?v]]`;
  report(':in key, EDN string input', await dq(inQ, scalarKey));
  report(':in key, raw EDN keyword input (:key)', await raw(client, 'logseq.DB.datascriptQuery', [inQ, `:${scalarKey}`]));
  const kwQ = `[:find (count ?b) . :in $ ?k :where [?b :block/properties ?p] [(keyword ?k) ?kw] [(get ?p ?kw) ?v]]`;
  report(':in key, (keyword ?k) from EDN string', await dq(kwQ, scalarKey));
  report('(keyword ?k) with an uppercased key', await dq(kwQ, scalarKey.toUpperCase()));

  const valueQ = (clause: string) =>
    `[:find (count ?b) . :in $ ?k ?val :where [?b :block/properties ?p] [(keyword ?k) ?kw] [(get ?p ?kw) ?v] ${clause}]`;
  report('scalar: (str ?v) = ?val', await dq(valueQ(`[(str ?v) ?s] [(= ?s ?val)]`), scalarKey, 'no such value'));
  const sample = await client.callAPI<any[][]>('logseq.DB.datascriptQuery', [
    `[:find ?v :where [?b :block/properties ?p] [(get ?p :${scalarKey}) ?v]]`
  ]);
  report('scalar: (str ?v) = ?val, a real value', await dq(valueQ(`[(str ?v) ?s] [(= ?s ?val)]`), scalarKey, sample[0][0]));

  const arrays = await client.callAPI<any[][]>('logseq.DB.datascriptQuery', [
    `[:find ?v :where [?b :block/properties ?p] [(get ?p :${arrayKey}) ?v]]`
  ]);
  const lengths = new Map<number, number>();
  for (const [v] of arrays) lengths.set(v.length, (lengths.get(v.length) ?? 0) + 1);
  console.log(`${'array-valued property: element counts -> rows'.padEnd(58)} ${JSON.stringify(Object.fromEntries(lengths))}`);
  const multi = arrays.map(([v]) => v).find(v => v.length > 1) ?? arrays[0][0];
  report('array: (str ?v) = first element', await dq(valueQ(`[(str ?v) ?s] [(= ?s ?val)]`), arrayKey, multi[0]));
  report('array: (contains? ?v ?val), first element', await dq(valueQ(`[(contains? ?v ?val)]`), arrayKey, multi[0]));
  report('array: (contains? ?v ?val), no such element', await dq(valueQ(`[(contains? ?v ?val)]`), arrayKey, 'no such value'));
  const strOfArray = await client.callAPI<any[][]>('logseq.DB.datascriptQuery', [
    `[:find ?s :where [?b :block/properties ?p] [(get ?p :${arrayKey}) ?v] [(str ?v) ?s]]`
  ]);
  console.log(
    `${'array: (str ?v) result shape / starts with "#{"'.padEnd(58)} ` +
      `${shapeOf(strOfArray[0][0])} / ${strOfArray.every(([s]) => String(s).startsWith('#{'))}`
  );
  for (const fn of ['string?', 'coll?', 'seq', 'clojure.string/join']) {
    report(`predicate/function ${fn}`, await dq(`[:find (count ?b) . :where [?b :block/properties ?p] [(get ?p :${arrayKey}) ?v] [(${fn} ?v)]]`));
  }

  report('entities with :block/properties (blocks + pages)', await dq(`[:find (count ?b) . :where [?b :block/properties ?p]]`));
  report('... that are blocks (have :block/page)', await dq(`[:find (count ?b) . :where [?b :block/properties ?p] [?b :block/page]]`));
  report('... that are pages (have :block/name)', await dq(`[:find (count ?b) . :where [?b :block/properties ?p] [?b :block/name]]`));
  report('... that are pre-blocks (:block/pre-block? true)', await dq(`[:find (count ?b) . :where [?b :block/properties ?p] [?b :block/pre-block? true]]`));
}

/**
 * Page-resolution probes (#41): how aliases, namespaces and journal days are
 * stored and which query forms work. Prints counts and shapes only, never names.
 */
async function probeResolution(
  client: LogseqClient,
  rawDq: (q: string, ...inputs: unknown[]) => Promise<Outcome>
) {
  const dq = (q: string, ...inputs: unknown[]) => rawDq(q, ...inputs.map(v => JSON.stringify(v)));
  const query = <T = any>(q: string, ...inputs: unknown[]) =>
    client.callAPI<T>('logseq.DB.datascriptQuery', [q, ...inputs.map(v => JSON.stringify(v))]);
  console.log('\n== Page resolution: aliases, namespaces, journal days (#41)');

  report('alias refs (page :block/alias target)', await dq(`[:find (count ?p) . :where [?p :block/alias ?a]]`));
  const sample = await query<any[]>(`[:find (pull ?p [:block/alias]) . :where [?p :block/alias ?a]]`);
  console.log(`${':block/alias value shape (pull)'.padEnd(58)} ${shapeOf((sample as any)?.alias)}`);
  report('alias targets without :block/file (bare stubs)', await dq(`[:find (count ?a) . :where [?p :block/alias ?a] (not [?a :block/file])]`));
  report('... stubs that also have blocks', await dq(`[:find (count ?a) . :where [?p :block/alias ?a] (not [?a :block/file]) [?b :block/page ?a]]`));
  report('alias pairs stored in both directions', await dq(`[:find (count ?p) . :where [?p :block/alias ?a] [?a :block/alias ?p]]`));
  const targets = await query<Array<[number, number]>>(`[:find ?a (count ?p) :where [?p :block/alias ?a]]`);
  console.log(`${'alias targets / shared by more than one page'.padEnd(58)} ${targets.length} / ${targets.filter(([, n]) => n > 1).length}`);

  const namespaced = await query<Array<[string]>>(`[:find ?n :where [?p :block/namespace ?x] [?p :block/name ?n]]`);
  const leaves = new Map<string, number>();
  for (const [n] of namespaced) leaves.set(n.split('/').pop()!, (leaves.get(n.split('/').pop()!) ?? 0) + 1);
  console.log(`${'namespaced pages / distinct leaves / leaves shared'.padEnd(58)} ${namespaced.length} / ${leaves.size} / ${[...leaves.values()].filter(c => c > 1).length}`);
  if (namespaced.length > 0) {
    const leaf = namespaced[0][0].split('/').pop()!;
    report('clojure.string/ends-with? on :block/name', await dq(`[:find (count ?p) . :in $ ?suffix :where [?p :block/name ?n] [?p :block/namespace] [(clojure.string/ends-with? ?n ?suffix)]]`, `/${leaf}`));
  }

  const day = (await query<number[][]>(`[:find ?d :where [?p :block/name] [?p :block/journal-day ?d]]`))[0]?.[0];
  if (day !== undefined) {
    const pull = `(pull ?page [:db/id :block/name])`;
    report('journal page by :block/journal-day, number as :in', await dq(`[:find ${pull} :in $ ?day :where [?page :block/name] [?page :block/journal-day ?day]]`, day));
    const combined = `[:find ${pull} ?via :in $ ?n ?day :where (or-join [?n ?day ?page ?via]
      (and [?page :block/name ?n] [(ground "name") ?via])
      (and [?stub :block/name ?n] [?page :block/alias ?stub] [(ground "alias") ?via])
      (and [?page :block/name] [?page :block/journal-day ?day] [(ground "journal-date") ?via]))]`;
    report('or-join name + alias + journal-day (unknown name, known day)', await dq(combined, 'no such page 41 probe', day));
  }
}

async function main() {
  const config = await loadConfig(join(homedir(), '.logseq-mcp', 'config.json'));
  const client = new LogseqClient(config);
  const dq = (q: string, ...inputs: unknown[]) => raw(client, 'logseq.DB.datascriptQuery', [q, ...inputs]);

  // Pick a real, non-journal page that has blocks to use as the probe subject.
  const pick = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find ?name :where [?p :block/name ?name] [?b :block/page ?p] (not [?p :block/journal? true])]`
  ]);
  const name: string = pick[0][0];
  const prefix = name.slice(0, 3);
  console.log(`probe page: ${JSON.stringify(name)}\n`);

  console.log('== Constraint 1: :in parameters');
  const inQ = `[:find (pull ?p [:db/id :block/name]) :in $ ?n :where [?p :block/name ?n]]`;
  report('embedded literal (baseline)', await dq(`[:find (pull ?p [:db/id :block/name]) :where [?p :block/name ${JSON.stringify(name)}]]`));
  report(':in, bare string input', await dq(inQ, name));
  report(':in, EDN-quoted string input', await dq(inQ, JSON.stringify(name)));

  console.log('\n== Constraint 2: clojure.string functions');
  const fn = (clause: string) =>
    `[:find (pull ?p [:db/id :block/name]) :where [?p :block/name ?n] ${clause}]`;
  report('clojure.string/lower-case', await dq(`[:find ?l :where [?p :block/name ?n] [(clojure.string/lower-case ?n) ?l]]`));
  report('clojure.string/starts-with?', await dq(fn(`[(clojure.string/starts-with? ?n ${JSON.stringify(prefix)})]`)));
  report('clojure.string/includes?', await dq(fn(`[(clojure.string/includes? ?n ${JSON.stringify(prefix)})]`)));
  report('re-pattern + re-find (?i)', await dq(fn(`[(re-pattern ${JSON.stringify('(?i)' + prefix)}) ?re] [(re-find ?re ?n)]`)));
  report('includes? on :block/content', await dq(`[:find (pull ?b [:db/id]) :where [?b :block/content ?c] [(clojure.string/includes? ?c ${JSON.stringify(prefix)})]]`));

  console.log('\n== Constraint 4: logseq.DB.q');
  report('DB.q with Datalog', await raw(client, 'logseq.DB.q', [`[:find (pull ?p [:db/id]) :where [?p :block/name ${JSON.stringify(name)}]]`]));
  report('DB.q with simple query DSL (task TODO)', await raw(client, 'logseq.DB.q', ['(task TODO)']));
  report('DB.q with simple query DSL [[page]]', await raw(client, 'logseq.DB.q', [`[[${name}]]`]));

  console.log('\n== Escaping');
  report('embedded name containing a double quote', await dq(`[:find (pull ?p [:db/id]) :where [?p :block/name "foo "bar"]]`));
  report('same name escaped via JSON.stringify', await dq(`[:find (pull ?p [:db/id]) :where [?p :block/name ${JSON.stringify('foo "bar')}]]`));

  console.log('\n== Aggregates');
  report('(count ?b) by ?name without :with', await dq(`[:find ?name (count ?b) :where [?b :block/refs ?r] [?r :block/name ?name]]`));
  report('(count ?b) by ?name with :with ?b', await dq(`[:find ?name (count ?b) :with ?b :where [?b :block/refs ?r] [?r :block/name ?name]]`));

  console.log('\n== Other attributes');
  report('get-else on :block/updated-at', await dq(`[:find ?n ?u :where [?p :block/name ?n] [(get-else $ ?p :block/updated-at 0) ?u]]`));
  report('pages with :block/updated-at', await dq(`[:find (count ?p) . :where [?p :block/name] [?p :block/updated-at]]`));
  report('pages total', await dq(`[:find (count ?p) . :where [?p :block/name]]`));
  report(':block/journal-day sample', await dq(`[:find ?d . :where [?p :block/journal-day ?d]]`));
  report(':block/path-refs present', await dq(`[:find (count ?b) . :where [?b :block/path-refs]]`));

  await probeProperties(client, dq);
  await probeResolution(client, dq);

  console.log('\n== Block uuids (:block/uuid) (#18)');
  const uuidRows = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find ?u :where [?p :block/name ${JSON.stringify(name)}] [?b :block/page ?p] [?b :block/uuid ?u]]`
  ]);
  const uuidText = String(uuidRows[0][0]);
  const pullUuid = `(pull ?b [:db/id :block/uuid {:block/page [:db/id :block/name]}])`;
  report('ground [string] vs :block/uuid', await dq(`[:find ${pullUuid} :where [(ground [${JSON.stringify(uuidText)}]) [?u ...]] [?b :block/uuid ?u]]`));
  report('ground [#uuid "..."] vs :block/uuid', await dq(`[:find ${pullUuid} :where [(ground [#uuid ${JSON.stringify(uuidText)}]) [?u ...]] [?b :block/uuid ?u]]`));
  report('ground [#uuid known, #uuid absent]', await dq(`[:find ${pullUuid} :where [(ground [#uuid ${JSON.stringify(uuidText)} #uuid "00000000-0000-4000-8000-000000000001"]) [?u ...]] [?b :block/uuid ?u]]`));
  report(':in [?u ...] with a string collection', await dq(`[:find ${pullUuid} :in $ [?u ...] :where [?b :block/uuid ?u]]`, JSON.stringify([uuidText])));
  report('(uuid ?s) function', await dq(`[:find ${pullUuid} :where [(ground ${JSON.stringify(uuidText)}) ?s] [(uuid ?s) ?u] [?b :block/uuid ?u]]`));
  report(':in [?n ...] page names + or-join head [?e ?n]', await dq(`[:find (pull ?e [:db/id]) :in $ [?n ...] :where (or-join [?e ?n] [?e :block/name ?n] (and [?pg :block/name ?n] [?e :block/parent ?pg]))]`, JSON.stringify([name])));

  console.log('\n== API quirks');
  report('unknown method', await raw(client, 'logseq.Editor.noSuchMethod', []));
  report('Editor.getEditingBlockSelection', await raw(client, 'logseq.Editor.getEditingBlockSelection', []));
  report('Editor.getSelectedBlocks', await raw(client, 'logseq.Editor.getSelectedBlocks', []));
  const blk = await client.callAPI<any[]>('logseq.DB.datascriptQuery', [
    `[:find ?u :where [?p :block/name ${JSON.stringify(name)}] [?b :block/page ?p] [?b :block/uuid ?u]]`
  ]);
  const got = await client.callAPI<any>('logseq.Editor.getBlock', [blk[0][0]]);
  console.log(`${'getBlock page / parent shape'.padEnd(58)} page=${JSON.stringify(got?.page)} parent=${JSON.stringify(got?.parent)}`);

  await probeListPagesNull(client, dq);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// list_pages and a null getAllPages (#64, part of #58)
//
// `list_pages` returns `{ pages: [], total: 0 }` when `logseq.Editor.getAllPages`
// returns null (src/tools/list-pages.ts, pinned by a unit test). If null can
// mean "no graph open" or "mid re-index" instead of "empty graph", that reports
// a failure as "none". These probes record what the live, healthy graph returns
// and whether any related call could tell the two cases apart.
//
// Read-only. Prints types, counts and key counts only, never page names, graph
// names or paths. They can't make getAllPages return null: that needs a state
// change, so see the manual probes below.
//
// MANUAL PROBES (the maintainer runs these; this script never changes LogSeq
// state). Use a throwaway graph, not the personal one. Record shapes only
// (null, array(n), error text) and never paste page names or paths anywhere.
//
//   Helper, run from the repo root before and during each step. It prints the
//   shape of each call and nothing else. `--input-type=module` is required:
//   without it `tsx -e` compiles to CJS and the top-level await fails.
//     npx tsx --input-type=module -e "
//       import {homedir} from 'os'; import {join} from 'path';
//       import {loadConfig} from './src/config.js'; import {LogseqClient} from './src/client.js';
//       const c = new LogseqClient(await loadConfig(join(homedir(), '.logseq-mcp', 'config.json')));
//       for (const m of ['logseq.Editor.getAllPages', 'logseq.App.getCurrentGraph']) {
//         try { const r = await c.callAPI(m, []);
//           console.log(m, r === null ? 'null' : Array.isArray(r) ? 'array(' + r.length + ')' : typeof r);
//         } catch (e) { console.log(m, 'ERROR', String(e.message).slice(0, 120)); } }"
//
//   Every step uses a THROWAWAY graph only, never the personal one. Check the
//   graph name in LogSeq before each step.
//
//   M1. Empty graph: in LogSeq create a new, empty throwaway graph and open it.
//       Run the helper. Is getAllPages an empty array, an array of built-in
//       pages, or null? This answers whether null is ever "empty graph".
//   M2. No graph open: in LogSeq open the graph switcher (left sidebar) and
//       choose "All graphs". On the throwaway graph only, click "Remove graph".
//       That only unlinks it from the list and does not delete any files on
//       disk. Do not do this to the personal graph. LogSeq now sits on the
//       graph chooser (or start LogSeq and don't open a graph). Run the
//       helper. Record whether the HTTP server still answers, and the shape of
//       getAllPages and getCurrentGraph (null, error, or an object).
//   M3. During a re-index (throwaway graph only, never the personal one): open
//       the throwaway graph, choose "Re-index" from the graph menu, and run the
//       helper repeatedly (once a second) until the re-index finishes. Record
//       the shapes seen and each transition (error, null, array(0), array(n)).
//   M4. Switching graphs (A and B must both be throwaway graphs, never the
//       personal one): switch from graph A to graph B and run the helper
//       immediately, then again a few seconds later. Record whether the first
//       call is null, an error, or the previous graph's pages.
//
//   Question to answer from M1 to M4: is there a state where getAllPages is
//   null while getCurrentGraph is non-null, or the reverse? If getCurrentGraph
//   is null exactly when getAllPages is null, the tool could throw a guidance
//   error. If null is indistinguishable from an empty graph, only a warning
//   is honest.
// ---------------------------------------------------------------------------
async function probeListPagesNull(
  client: LogseqClient,
  dq: (q: string, ...inputs: unknown[]) => Promise<Outcome>
) {
  console.log('\n== list_pages and a null getAllPages (#64)');

  const describeCall = async (method: string, args: unknown[] = []) => {
    try {
      const r = await client.callAPI<unknown>(method, args as any[]);
      if (r === null || r === undefined) return { shape: String(r), value: r };
      if (Array.isArray(r)) {
        return { shape: `array(${r.length})<${[...new Set(r.map(shapeOf))].join('|')}>`, value: r };
      }
      if (typeof r === 'object') return { shape: `object(${Object.keys(r).length} keys)`, value: r };
      return { shape: typeof r, value: r };
    } catch (e: any) {
      return { shape: `ERROR ${String(e?.message ?? e).slice(0, 120)}`, value: undefined };
    }
  };

  const all = await describeCall('logseq.Editor.getAllPages');
  console.log(`${'getAllPages result shape'.padEnd(58)} ${all.shape}`);
  const pages = Array.isArray(all.value) ? (all.value as any[]) : [];
  const count = (f: (p: any) => boolean) => pages.filter(f).length;
  console.log(
    `${'getAllPages: journal / non-journal / without name'.padEnd(58)} ` +
      `${count(p => p?.journal || p?.['journal?'])} / ${count(p => !(p?.journal || p?.['journal?']))} / ` +
      `${count(p => typeof p?.name !== 'string')}`
  );
  console.log(
    `${'getAllPages: distinct entity keys'.padEnd(58)} ` +
      `${new Set(pages.flatMap(p => Object.keys(p ?? {}))).size}`
  );

  // Does a healthy graph agree with the Datalog page count? If it does, a null
  // getAllPages next to a non-zero Datalog count would be detectable.
  report('Datalog pages total (compare with getAllPages count)', await dq(`[:find (count ?p) . :where [?p :block/name]]`));

  const graph = await describeCall('logseq.App.getCurrentGraph');
  console.log(`${'getCurrentGraph result shape'.padEnd(58)} ${graph.shape}`);
  if (graph.value && typeof graph.value === 'object') {
    // Key -> value type only. The values are the graph's name and path.
    const types = Object.fromEntries(Object.entries(graph.value).map(([k, v]) => [k, shapeOf(v)]));
    console.log(`${'getCurrentGraph: key -> value type (no values)'.padEnd(58)} ${JSON.stringify(types)}`);
  }

  // Other cheap, read-only calls that might signal "a graph is open and loaded".
  console.log(`${'getUserConfigs result shape'.padEnd(58)} ${(await describeCall('logseq.App.getUserConfigs')).shape}`);
  console.log(`${'getCurrentPage result shape'.padEnd(58)} ${(await describeCall('logseq.Editor.getCurrentPage')).shape}`);

  console.log(`${'getAllPages null on this (healthy) graph?'.padEnd(58)} ${all.value === null || all.value === undefined}`);
  console.log('(the null cases need a state change: run manual probes M1 to M4, see the comment above)');
}
