// Child process for get-concept-evolution.week-tz.test.ts (#249). Not a test and not built: it is run as
// `node node_modules/vite-node/vite-node.mjs <this file>` with `TZ` in its environment, so the zone is the process's own from the
// start (a vitest worker thread gets a copy of the environment, where assigning `process.env.TZ` does nothing).
//
// stdin: a JSON array of journal days (YYYYMMDD). stdout: JSON `{ zone, keys }`, `keys` mapping each day
// to the week key `getConceptEvolution` gives it. Exits 1 if the zone did not take effect.
import { readFileSync } from 'node:fs';
import { getConceptEvolution } from './get-concept-evolution.js';

// A zone with daylight saving has a different offset in January and April. If it doesn't, the zone
// was not applied and any result would prove nothing, so fail loud.
if (new Date(2025, 0, 1).getTimezoneOffset() === new Date(2025, 3, 9).getTimezoneOffset()) {
  console.error(`TZ=${process.env.TZ} did not give a daylight-saving offset change between 1 January and 9 April 2025`);
  process.exit(1);
}

const days = JSON.parse(readFileSync(0, 'utf8'));

/** The week key of each of `yearDays` (days of one year), as the tool gives it. */
async function weekKeysOf(yearDays) {
  const tree = yearDays.map((day, i) => ({
    id: i + 1,
    uuid: `u-${i + 1}`,
    content: `Block ${i + 1} about [[Concept]]`,
    page: { id: 1000 + i, name: `day ${day}`, journalDay: day }
  }));
  const client = {
    callAPI: async method => {
      if (method === 'logseq.Editor.getPageBlocksTree') return tree;
      if (method === 'logseq.Editor.getPage') return null;
      throw new Error(`unexpected call: ${method}`);
    },
    executeDatalogQuery: async query =>
      query.includes(':in $ ?n') ? [[{ id: 100, name: 'concept', 'original-name': 'Concept' }, 'name']] : []
  };
  // maxEntries 500 is the tool's ceiling; a year has at most 366 mentions here, so none is cut
  const result = await getConceptEvolution(client, 'Concept', { groupBy: 'week', maxEntries: 500 });
  const keys = {};
  for (const [key, blocks] of Object.entries(result.groupedTimeline)) {
    for (const block of blocks) keys[yearDays[block.id - 1]] = key;
  }
  return keys;
}

// One call per year, so no call has more mentions than the cap
const keys = {};
for (const year of new Set(days.map(day => Math.floor(day / 10000)))) {
  Object.assign(keys, await weekKeysOf(days.filter(day => Math.floor(day / 10000) === year)));
}
console.log(JSON.stringify({ zone: process.env.TZ, keys }));
