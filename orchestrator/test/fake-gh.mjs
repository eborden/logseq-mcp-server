// A fake `gh` for the GitHub activity tests (#628): no network, no real repository. It is a tiny stateful stand-in
// for the handful of `gh` commands the activities run. The tests start it through a one-line shell wrapper,
//   exec node fake-gh.mjs <state.json> "$@"
// so the activities' own `ghPath` setting selects it and the production code needs no test switch.
//
// State (JSON, rewritten after each call) holds the raw shapes GitHub answers with, so the activities' parsers see
// realistic input: `board`, `issues`, `comments`, `blockedBy`, `pulls`, `refs`, `reviews`, `gate`, `rateLimit` (and `addStatus`, the Status
// `gh project item-add` gives a new item, Backlog when unset; `addStatusAfterReads: n` gives it only after n board reads). A board entry of `type: 'PullRequest'` is a PR's item.
// Every call is appended to `<state>.calls.jsonl` as { argv, stdin }, which is what the tests assert on.
// `faults` is a queue of canned answers: the first fault whose `match` is a substring of the joined argv and that
// still has `times` left (after `skip` calls let through) is answered instead of the real handler (rate limits, malformed output, HTTP errors, a hang
// with `delayMs`, a race with `addPulls`).
//
// Every name in the tests' state is made up (Alice, issue 123, "project atlas"); nothing here comes from a real graph.

import { appendFileSync, readFileSync, writeFileSync, writeSync } from 'node:fs';

const [statePath, ...argv] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const stdin = argv.includes('--input') ? readFileSync(0, 'utf8') : undefined;
appendFileSync(`${statePath}.calls.jsonl`, `${JSON.stringify({ argv, stdin })}\n`);

function save() {
  writeFileSync(statePath, JSON.stringify(state));
}

function respond({ stdout = '', stderr = '', exit = 0 }) {
  // Synchronous writes, so the exit below cannot cut the answer short.
  writeSync(1, stdout);
  writeSync(2, stderr);
  process.exit(exit);
}

function http(status, body, headers = {}) {
  const text = { 200: 'OK', 201: 'Created', 404: 'Not Found' }[status] ?? 'Status';
  const head = Object.entries({ 'Content-Type': 'application/json; charset=utf-8', ...headers })
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  return `HTTP/2.0 ${status} ${text}\r\n${head}\r\n\r\n${body === undefined ? '' : JSON.stringify(body)}`;
}

function page(items, params) {
  const perPage = Number(params.get('per_page') ?? 30);
  const index = Number(params.get('page') ?? 1);
  return items.slice((index - 1) * perPage, index * perPage);
}

// Canned answers first.
const joined = argv.join(' ');
for (const fault of state.faults ?? []) {
  if (fault.times > 0 && joined.includes(fault.match)) {
    // `skip` lets the first calls through, so a fault can hit a later call (the read after a write).
    if ((fault.skip ?? 0) > 0) {
      fault.skip -= 1;
      save();
      continue;
    }
    fault.times -= 1;
    // `add` lets a fault stand for a race: the thing the caller is about to create appears first.
    state.pulls.push(...(fault.addPulls ?? []));
    save();
    if (fault.delayMs !== undefined) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fault.delayMs);
    }
    respond(fault);
  }
}

if (argv[0] === 'project') {
  const flag = (name) => argv[argv.indexOf(name) + 1];
  if (argv[1] === 'item-list') {
    const query = flag('--query') ?? '';
    const wanted = /^status:(.+)$/.exec(query)?.[1];
    const matching = state.board.filter((item) => wanted === undefined || item.status === wanted);
    const items = matching.slice(0, Number(flag('--limit') ?? 30)).map((item) => ({
      content: {
        body: 'text the activities must not read',
        number: item.number,
        repository: item.repository ?? 'eborden/logseq-mcp-server',
        title: 'title the activities must not read',
        type: item.type ?? 'Issue',
        url: `https://github.com/eborden/logseq-mcp-server/issues/${item.number}`,
      },
      id: `PVTI_${item.number}`,
      labels: [],
      status: item.status,
      title: 'x',
    }));
    respond({ stdout: JSON.stringify({ items, totalCount: matching.length }) });
  }
  if (argv[1] === 'item-add') {
    // Like the real command: adding an item that is already on the board changes nothing. A new item gets the
    // board's default Status (`addStatus`, Backlog unless a test says otherwise).
    const [, kindPath, numberText] = /\/(issues|pull)\/(\d+)$/.exec(flag('--url')) ?? [];
    const number = Number(numberText);
    const isPr = kindPath === 'pull';
    const exists = isPr ? state.pulls.some((pr) => pr.number === number) : state.issues[number] !== undefined;
    if (!exists) {
      respond({ stderr: 'fake gh: no such issue or pull request\n', exit: 1 });
    }
    if (!state.board.some((item) => item.number === number)) {
      const type = isPr ? 'PullRequest' : 'Issue';
      state.board.push(
        state.addStatusAfterReads === undefined
          ? { number, status: state.addStatus ?? 'Backlog', type }
          : { number, type, pendingStatus: state.addStatus ?? 'Backlog', pendingReads: state.addStatusAfterReads },
      );
      save();
    }
    respond({ stdout: JSON.stringify({ id: `PVTI_${number}` }) });
  }
  if (argv[1] === 'item-edit') {
    const number = Number(/\/(?:issues|pull)\/(\d+)$/.exec(flag('--url'))?.[1]);
    const item = state.board.find((candidate) => candidate.number === number);
    if (item === undefined) {
      respond({ stderr: 'fake gh: no such item\n', exit: 1 });
    }
    item.status = flag('--value');
    save();
    respond({ stdout: JSON.stringify({ id: `PVTI_${number}` }) });
  }
  respond({ stderr: `fake gh: unhandled project command\n`, exit: 1 });
}

if (argv[0] === 'api') {
  let method = 'GET';
  const fields = new Map();
  let route;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-i') continue;
    if (arg === '-X') method = argv[++i];
    else if (arg === '--input') i += 1;
    else if (arg === '-f' || arg === '-F') {
      const pair = argv[++i];
      fields.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    } else route ??= arg;
  }
  const url = new URL(route, 'https://api.github.test/');
  const path = url.pathname.replace(/^\//, '');
  const params = url.searchParams;
  const send = (status, body) => respond({ stdout: http(status, body) });

  // What the real API does for a missing issue or PR (checked against it, read-only): HTTP 200, the item `null`, one
  // NOT_FOUND error, and `gh` exits 1 with the message on stderr.
  const notFound = (key) =>
    respond({
      stdout: http(200, {
        data: { repository: { [key]: null } },
        errors: [{ type: 'NOT_FOUND', path: ['repository', key], locations: [{ line: 1, column: 86 }], message: `Could not resolve to a ${key} with the number of ${fields.get('number')}.` }],
      }),
      stderr: 'gh: Could not resolve to an item with that number.\n',
      exit: 1,
    });

  if (path === 'graphql') {
    const query = fields.get('query') ?? '';
    const number = Number(fields.get('number'));
    if (query.includes('projectItems')) {
      // The query names `issue(number...)` or `pullRequest(number...)`; the answer carries the same key.
      const isPr = query.includes('pullRequest(number');
      const key = isPr ? 'pullRequest' : 'issue';
      const item = state.board.find((candidate) => candidate.number === number && (candidate.type === 'PullRequest') === isPr);
      const exists = item !== undefined || (isPr ? state.pulls.some((pr) => pr.number === number) : state.issues[number] !== undefined);
      // An item whose default Status arrives later (the board's own workflow runs after the add): the first
      // `pendingReads` reads show no Status, the next one shows `pendingStatus`.
      if (item?.pendingReads !== undefined) {
        if (item.pendingReads > 0) {
          item.pendingReads -= 1;
        } else {
          item.status = item.pendingStatus;
          delete item.pendingReads;
          delete item.pendingStatus;
        }
        save();
      }
      const nodes = item === undefined ? [] : [
        {
          id: `PVTI_${number}`,
          project: { number: 1, owner: { login: 'eborden' } },
          fieldValueByName: item.status === undefined ? null : { name: item.status },
        },
      ];
      if (!exists) {
        notFound(key);
      }
      send(200, { data: { repository: { [key]: { projectItems: { pageInfo: { hasNextPage: false }, nodes } } } } });
    }
    if (query.includes('reviewThreads')) {
      if (state.gate[number] === undefined) {
        notFound('pullRequest');
      }
      send(200, { data: { repository: { pullRequest: state.gate[number] } } });
    }
    respond({ stderr: 'fake gh: unhandled graphql\n', exit: 1 });
  }
  if (path === 'rate_limit') {
    send(200, state.rateLimit);
  }
  let match;
  if ((match = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path)) && method === 'GET') {
    // `issues/<n>` answers for a PR too, with a `pull_request` key (GitHub does the same).
    const pr = state.pulls.find((candidate) => String(candidate.number) === match[1]);
    const issue = state.issues[match[1]] ?? (pr === undefined ? undefined : { number: pr.number, author_association: pr.author_association, pull_request: {} });
    issue === undefined ? respond({ stdout: http(404, { message: 'Not Found' }), stderr: 'gh: Not Found (HTTP 404)\n', exit: 1 }) : send(200, issue);
  }
  if ((match = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path))) {
    send(200, page(state.comments[match[1]] ?? [], params));
  }
  if ((match = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/dependencies\/blocked_by$/.exec(path))) {
    send(200, page(state.blockedBy[match[1]] ?? [], params));
  }
  if ((match = /^repos\/[^/]+\/[^/]+\/git\/matching-refs\/heads\/(.+)$/.exec(path))) {
    send(200, page(state.refs.filter((ref) => ref.ref.startsWith(`refs/heads/${match[1]}`)), params));
  }
  if (/^repos\/[^/]+\/[^/]+\/pulls$/.test(path) && method === 'GET') {
    const head = params.get('head')?.split(':')[1];
    const base = params.get('base');
    const open = state.pulls.filter((pr) => (head === undefined || pr.head.ref === head) && (base === null || pr.base?.ref === base));
    send(200, page(open, params));
  }
  if (/^repos\/[^/]+\/[^/]+\/pulls$/.test(path) && method === 'POST') {
    const sent = JSON.parse(stdin);
    const number = 1000 + state.pulls.length + 1;
    const pr = {
      number,
      html_url: `https://github.com/eborden/logseq-mcp-server/pull/${number}`,
      author_association: 'OWNER',
      head: { ref: sent.head },
      base: { ref: sent.base },
      body: sent.body,
    };
    state.pulls.push(pr);
    save();
    send(201, pr);
  }
  if ((match = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path))) {
    const reviews = (state.reviews[match[1]] ??= []);
    if (method === 'GET') {
      send(200, page(reviews, params));
    }
    const sent = JSON.parse(stdin);
    const review = { id: 5000 + reviews.length + 1, body: sent.body, author_association: 'OWNER', commit_id: sent.commit_id };
    reviews.push(review);
    save();
    send(200, review);
  }
  respond({ stdout: http(404, { message: 'Not Found' }), stderr: `gh: Not Found (HTTP 404)\n`, exit: 1 });
}

respond({ stderr: 'fake gh: unhandled command\n', exit: 1 });
