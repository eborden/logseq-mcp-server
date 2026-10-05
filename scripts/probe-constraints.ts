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
