/**
 * Read-only probes of LogSeq HTTP API / DataScript behavior.
 * Evidence for the "Critical LogSeq Datalog Constraints" in CLAUDE.md.
 *
 * Usage: npx tsx scripts/probe-constraints.ts
 * Runs against this worktree's fixture instance (`npx tsx scripts/logseq-instance.ts start`), or
 * the config in LOGSEQ_MCP_CONFIG. It never falls back to ~/.logseq-mcp/config.json, the personal
 * graph (#90): with neither, or with a config on port 12315, it stops before any network call. The fixture reproduces every
 * constraint; row counts differ from the real-graph numbers in CLAUDE.md.
 */
import { loadConfig } from '../src/config.js';
import { LogseqClient } from '../src/client.js';
import { assertNotPersonalLogseq, resolveFixtureConfigPath } from '../tests/integration/helpers/instance-config.js';

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

/**
 * Alias-group probes (#69): how `alias::` is stored, which decides how the
 * link-following tools find every name of a page. Prints counts and shapes
 * only, never names. Every figure marked "must be 0" is an assumption the
 * code relies on; a non-zero value means the alias-set resolver can miss names.
 */
async function probeAliasSets(
  client: LogseqClient,
  rawDq: (q: string, ...inputs: unknown[]) => Promise<Outcome>
) {
  const dq = (q: string, ...inputs: unknown[]) => rawDq(q, ...inputs.map(v => JSON.stringify(v)));
  const query = <T = any>(q: string) => client.callAPI<T>('logseq.DB.datascriptQuery', [q]);
  console.log('\n== Alias groups (#69)');

  const edges = await query<Array<[number, number]>>(`[:find ?p ?a :where [?p :block/alias ?a]]`);
  if (edges.length === 0) {
    console.log('(graph has no aliases: skipping the rest)');
    return;
  }
  const has = new Set(edges.map(([p, a]) => `${p}>${a}`));
  const pairs = new Set(edges.map(([p, a]) => (p < a ? `${p}-${a}` : `${a}-${p}`)));
  console.log(`${'directed alias links / distinct pairs'.padEnd(58)} ${edges.length} / ${pairs.size}`);
  console.log(`${'links without the reverse link (must be 0)'.padEnd(58)} ${edges.filter(([p, a]) => !has.has(`${a}>${p}`)).length}`);
  console.log(`${'links from a page to itself (must be 0)'.padEnd(58)} ${edges.filter(([p, a]) => p === a).length}`);

  // Group sizes, whether each group is a clique (every page links every other), and the longest chain
  const adj = new Map<number, Set<number>>();
  for (const [p, a] of edges) {
    for (const [x, y] of [[p, a], [a, p]]) adj.set(x, (adj.get(x) ?? new Set()).add(y));
  }
  const seen = new Set<number>();
  const sizes = new Map<number, number>();
  let notCliques = 0;
  let longestChain = 0;
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const group = [start];
    seen.add(start);
    for (let i = 0; i < group.length; i++) {
      for (const next of adj.get(group[i])!) if (!seen.has(next)) { seen.add(next); group.push(next); }
    }
    sizes.set(group.length, (sizes.get(group.length) ?? 0) + 1);
    if (!group.every(g => adj.get(g)!.size === group.length - 1)) notCliques++;
    for (const g of group) {
      const dist = new Map([[g, 0]]);
      const queue = [g];
      for (let i = 0; i < queue.length; i++) {
        for (const next of adj.get(queue[i])!) if (!dist.has(next)) { dist.set(next, dist.get(queue[i])! + 1); queue.push(next); }
      }
      longestChain = Math.max(longestChain, ...dist.values());
    }
  }
  console.log(`${'group size -> groups'.padEnd(58)} ${JSON.stringify(Object.fromEntries(sizes))}`);
  console.log(`${'groups that are not cliques (must be 0)'.padEnd(58)} ${notCliques}`);
  console.log(`${'most alias links between two pages of a group (cap: 2)'.padEnd(58)} ${longestChain}`);

  // Which side holds the file: the declaring page has one, the page `alias::` names is a stub
  report('pages declaring an alias that have a file', await dq(
    `[:find (count ?p) . :where [?p :block/alias ?a] [?p :block/file]]`));
  report('alias targets without a file (stubs)', await dq(`[:find (count ?a) . :where [?p :block/alias ?a] (not [?a :block/file])]`));
  report('... stubs that link back to the declaring page', await dq(
    `[:find (count ?a) . :where [?p :block/alias ?a] (not [?a :block/file]) [?a :block/alias ?p]]`));
  const withFiles = await query<Array<[number]>>(`[:find ?p :where [?p :block/alias ?a] [?p :block/file] [?a :block/file]]`);
  console.log(`${'alias links where both pages have a file'.padEnd(58)} ${withFiles.length}`);

  // Why a page needs the whole group: a reference points at whichever name the block used
  report('blocks referencing a stub of a group', await dq(
    `[:find (count ?b) . :where [?p :block/alias ?a] (not [?a :block/file]) [?b :block/refs ?a]]`));
  report('blocks referencing a declaring page', await dq(
    `[:find (count ?b) . :where [?p :block/alias ?a] [?p :block/file] [?b :block/refs ?p]]`));

  // The Editor API's linked references span the group for the declaring page, not for a stub
  const pick = await query<Array<[number, string, string]>>(
    `[:find ?p ?pn ?an :where [?p :block/alias ?a] [?p :block/file] (not [?a :block/file]) [?p :block/name ?pn] [?a :block/name ?an]]`
  );
  if (pick.length > 0) {
    const [, declaring, stub] = pick[0];
    const ids = async (n: string) =>
      new Set(((await client.callAPI<any[]>('logseq.Editor.getPageLinkedReferences', [n])) ?? []).flatMap(g => g[1].map((b: any) => b.id)));
    const [a, b] = [await ids(declaring), await ids(stub)];
    console.log(`${'linked references: declaring page / stub (ids)'.padEnd(58)} ${a.size} / ${b.size}`);
  }
}

/**
 * Do blocks with a SCHEDULED or DEADLINE date carry `:block/journal-day`? (#140)
 * One yes/no per case, from counts only. The fixture holds the cases: SCHEDULED, DEADLINE and
 * both on journal pages (`journals/2025_01_02.md`, `_07` and `_08`) and on a non-journal page
 * (`pages/schedule cases.md`), all dated in the past. It also counts the blocks that do carry
 * the attribute, and the journal-page rows that need `[?page :block/name]` because of them.
 *
 * Checked by hand on a throwaway copy of the fixture (LogSeq 0.10.15), not repeated here because
 * this script never writes: `logseq.Editor.insertBlock` of a plain, a SCHEDULED and a DEADLINE
 * block gave 3 of 3 with `:block/journal-day` on a journal page and 0 of 3 on a non-journal one.
 * So it is blocks LogSeq creates in the app on a journal page that carry it, whatever their text.
 */
async function probeJournalDay(client: LogseqClient) {
  const query = <T = any>(q: string) => client.callAPI<T>('logseq.DB.datascriptQuery', [q]);
  const count = async (where: string) =>
    (await query<number | null>(`[:find (count ?b) . :where [?b :block/page ?p] ${where}]`)) ?? 0;
  console.log('\n== Scheduled / deadline blocks and :block/journal-day (#140)');

  const onJournal = `[(get-else $ ?p :block/journal? false) ?j] [(= ?j true)]`;
  const onPage = `[(get-else $ ?p :block/journal? false) ?j] [(= ?j false)]`;
  const shapes: Array<[string, string]> = [
    ['SCHEDULED only', `[?b :block/scheduled ?s] (not [?b :block/deadline ?d])`],
    ['DEADLINE only', `[?b :block/deadline ?d] (not [?b :block/scheduled ?s])`],
    ['SCHEDULED and DEADLINE', `[?b :block/scheduled ?s] [?b :block/deadline ?d]`]
  ];
  for (const [where, place] of [
    [onJournal, 'journal page'],
    [onPage, 'non-journal page']
  ] as const) {
    for (const [label, clause] of shapes) {
      const total = await count(`${where} ${clause}`);
      const withDay = await count(`${where} ${clause} [?b :block/journal-day ?day]`);
      const answer =
        total === 0 ? 'n/a (no such block in the graph)' : withDay === total ? 'yes' : withDay === 0 ? 'no' : 'some';
      console.log(`${`${label} on a ${place}`.padEnd(58)} blocks=${total} with journal-day=${withDay} -> ${answer}`);
    }
  }

  // What does carry it. Blocks read from a file never do. A block LogSeq creates itself on a
  // journal page does (today's first, empty block, which a fresh graph always gets).
  const withDay = await count(`[?b :block/journal-day ?day]`);
  const fromFile = await count(`[?b :block/journal-day ?day] [?p :block/file]`);
  const noFile = await count(`[?b :block/journal-day ?day] (not [?p :block/file])`);
  console.log(
    `${'blocks with journal-day: all / page has a file / no file'.padEnd(58)} ${withDay} / ${fromFile} / ${noFile}`
  );
  const scheduledAny = await count(`[(get-else $ ?b :block/scheduled 0) ?s] [(get-else $ ?b :block/deadline 0) ?d] [(+ ?s ?d) ?t] [(> ?t 0)]`);
  const scheduledWithDay = await count(
    `[(get-else $ ?b :block/scheduled 0) ?s] [(get-else $ ?b :block/deadline 0) ?d] [(+ ?s ?d) ?t] [(> ?t 0)] [?b :block/journal-day ?day]`
  );
  console.log(`${'scheduled or deadline blocks: all / with journal-day'.padEnd(58)} ${scheduledAny} / ${scheduledWithDay}`);

  // Why the journal queries keep [?page :block/name]: without it a block that carries
  // journal-day matches as a "page". A range wide enough to hold every journal day.
  const pages = (clause: string) =>
    query<any[]>(
      `[:find ?page :where ${clause} [?page :block/journal-day ?day] [(>= ?day 19000101)] [(<= ?day 99991231)]]`
    );
  const withName = (await pages(`[?page :block/name]`)).length;
  const withoutName = (await pages(``)).length;
  console.log(`${'journal "pages" with / without [?page :block/name]'.padEnd(58)} ${withName} / ${withoutName}`);
  console.log(`${'extra rows without the name clause'.padEnd(58)} ${withoutName - withName}`);
}

async function main() {
  // LOGSEQ_MCP_CONFIG if set, else the fixture instance's config; never ~/.logseq-mcp/config.json
  const config = await loadConfig(resolveFixtureConfigPath());
  // Never the personal LogSeq, even when LOGSEQ_MCP_CONFIG names its config: refused before any client exists
  assertNotPersonalLogseq(config.apiUrl);
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
  await probeAliasSets(client, dq);
  await probeJournalDay(client);

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
//   Needs this worktree's fixture instance (`npx tsx scripts/logseq-instance.ts
//   start`) or LOGSEQ_MCP_CONFIG, and refuses port 12315. Do M1-M4 in that
//   instance's LogSeq window, never in the personal one.
//
//   Helper, run from the repo root before and during each step. It prints the
//   shape of each call and nothing else. `--input-type=module` is required:
//   without it `tsx -e` compiles to CJS and the top-level await fails.
//     npx tsx --input-type=module -e "
//       import {loadConfig} from './src/config.js'; import {LogseqClient} from './src/client.js';
//       import {assertNotPersonalLogseq, resolveFixtureConfigPath} from './tests/integration/helpers/instance-config.js';
//       const config = await loadConfig(resolveFixtureConfigPath()); assertNotPersonalLogseq(config.apiUrl);
//       const c = new LogseqClient(config);
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
