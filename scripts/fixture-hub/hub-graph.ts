/**
 * The hub fixture (#89): one page with 120 neighbours, built from a few constants so the files and
 * the counts in tests/fixtures/graph/README.md cannot drift apart. Everything is made up.
 *
 * `buildHubFixture()` is pure and deterministic. `scripts/generate-hub-fixture.ts` writes its
 * output into tests/fixtures/graph, and src/fixture-hub.test.ts fails if the committed files
 * differ from it.
 *
 * Shape (page names are lowercase, as LogSeq stores them):
 *
 *   hub central --> neighbour-out-NN   (OUT_ONLY pages; the hub links them, they do not link back)
 *   hub central --> neighbour-both-NN  (BOTH pages; they link back to the hub)
 *   neighbour-in-NN --> hub central    (IN_ONLY pages; some with a second block that links the hub)
 *   journal 2024_06_17 --> hub central and journal-topic-NN
 *   neighbour-out-NN and neighbour-both-NN --> fringe-NN   (the second ring, file-less pages)
 */

export const HUB_PAGE = 'hub central';
export const OUT_ONLY = 60;
export const BOTH = 10;
export const IN_ONLY = 50;
/**
 * `neighbour-in-01` .. `neighbour-in-NN` hold two blocks that link the hub instead of one.
 * This makes the depth-1 selection deterministic: with the BOTH two-way pages these are the only
 * pages with 2 references, and BOTH + IN_WITH_SECOND_BLOCK equals the default `maxFanout` (15), so
 * there is no tie at the cap. src/fixture-hub.test.ts asserts it. Change one and the other must follow.
 */
export const IN_WITH_SECOND_BLOCK = 5;
/** Pages only the neighbours link, so they sit at depth 2 from the hub. */
export const FRINGE = 40;
export const FRINGE_PER_OUT = 3;
export const FRINGE_PER_BOTH = 4;
/** Journal file 2024_06_17.md, title "Jun 17th, 2024". Dated before 2026 so .gitignore keeps it. */
export const JOURNAL_FILE = 'journals/2024_06_17.md';
export const JOURNAL_TITLE = 'Jun 17th, 2024';
export const JOURNAL_TOPICS = 30;

/** A journal file that links the journal topics is this fixture's, whatever its name. */
export const isHubJournal = (content: string) => content.includes(`[[${topicName(1)}]]`);

const pad = (n: number) => String(n).padStart(2, '0');
export const outName = (n: number) => `neighbour-out-${pad(n)}`;
export const bothName = (n: number) => `neighbour-both-${pad(n)}`;
export const inName = (n: number) => `neighbour-in-${pad(n)}`;
export const fringeName = (n: number) => `fringe-${pad(n)}`;
export const topicName = (n: number) => `journal-topic-${pad(n)}`;

const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
const link = (name: string) => `[[${name}]]`;

/** Fringe pages for neighbour number `n` (1-based): `perPage` consecutive ones, wrapping at FRINGE. */
function fringeFor(n: number, perPage: number, offset: number): string[] {
  return range(perPage).map(j => fringeName(((offset + (n - 1) * perPage + (j - 1)) % FRINGE) + 1));
}

const bothFringe = (n: number) => fringeFor(n, FRINGE_PER_BOTH, 0);
const outFringe = (n: number) => fringeFor(n, FRINGE_PER_OUT, 7);

/** Every committed file this fixture owns: path under tests/fixtures/graph to content. */
export function buildHubFixture(): Map<string, string> {
  const files = new Map<string, string>();

  // The hub: an intro block with no links, then one block per outbound link.
  const hubBlocks = [
    `- ${HUB_PAGE} is a made-up index page. It exists to test caps, so it links many pages and many pages link it.`,
    ...range(OUT_ONLY).map(n => `- Outbound link ${n}: ${link(outName(n))}`),
    ...range(BOTH).map(n => `- Two-way link ${n}: ${link(bothName(n))}`)
  ];
  files.set(`pages/${HUB_PAGE}.md`, hubBlocks.join('\n') + '\n');

  for (const n of range(OUT_ONLY)) {
    files.set(
      `pages/${outName(n)}.md`,
      [
        `- ${outName(n)} is a made-up page. The hub links it and it does not link back.`,
        `- Related: ${outFringe(n).map(link).join(' ')}`
      ].join('\n') + '\n'
    );
  }

  for (const n of range(BOTH)) {
    files.set(
      `pages/${bothName(n)}.md`,
      [
        `- ${bothName(n)} is a made-up page. It links the hub and the hub links it.`,
        `- Back to ${link(HUB_PAGE)}`,
        `- Related: ${bothFringe(n).map(link).join(' ')}`
      ].join('\n') + '\n'
    );
  }

  for (const n of range(IN_ONLY)) {
    const blocks = [
      `- ${inName(n)} is a made-up page. It links the hub and the hub does not link it.`,
      `- Index: ${link(HUB_PAGE)}`
    ];
    if (n <= IN_WITH_SECOND_BLOCK) blocks.push(`- A second note on ${link(HUB_PAGE)}`);
    files.set(`pages/${inName(n)}.md`, blocks.join('\n') + '\n');
  }

  files.set(
    JOURNAL_FILE,
    [
      `- A made-up journal day that links many pages.`,
      `- Reviewed ${link(HUB_PAGE)}`,
      ...range(JOURNAL_TOPICS).map(n => `- Noted ${link(topicName(n))}`)
    ].join('\n') + '\n'
  );

  return files;
}

/** The numbers the README documents. `fringe-NN` and `journal-topic-NN` exist only as link targets. */
export function hubFixtureCounts() {
  return {
    outboundOnly: OUT_ONLY,
    both: BOTH,
    inboundOnly: IN_ONLY,
    /** Distinct non-journal pages the hub links to. */
    hubOutbound: OUT_ONLY + BOTH,
    /** Distinct non-journal pages that link the hub. */
    hubInboundPages: IN_ONLY + BOTH,
    /** Distinct non-journal neighbours in either direction. */
    neighbours: OUT_ONLY + BOTH + IN_ONLY,
    /** Blocks on the hub page. */
    hubBlocks: 1 + OUT_ONLY + BOTH,
    /** Blocks elsewhere that link the hub, the journal's block included. */
    hubInboundBlocks: IN_ONLY + IN_WITH_SECOND_BLOCK + BOTH + 1,
    fringe: FRINGE,
    journalTopics: JOURNAL_TOPICS
  };
}
