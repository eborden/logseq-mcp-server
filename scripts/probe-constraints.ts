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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
