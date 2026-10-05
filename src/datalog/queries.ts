/**
 * Datalog query builder for LogSeq queries
 * Provides reusable query templates for common graph operations
 */

import { escapeRegex } from '../utils/escape-regex.js';
import { InvalidParameterError } from '../errors.js';

/**
 * A Datalog query plus the values bound to its `:in` variables.
 *
 * `inputs` are raw values, in the order of the `:in` variables after `$`.
 * `LogseqClient.executeDatalogQuery` EDN-encodes them when sending, so
 * callers never build string literals by hand:
 *
 *   const { query, inputs } = DatalogQueryBuilder.getPage(name);
 *   await client.executeDatalogQuery(query, ...inputs);
 */
export interface DatalogQuery {
  query: string;
  inputs: unknown[];
}

/** Strict shape of a block uuid, checked before one is embedded in query text. */
export const BLOCK_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many levels below an embedded block {@link DatalogQueryBuilder.refTargets} fetches. */
export const EMBED_DESCENDANT_LEVELS = 3;

export class DatalogQueryBuilder {
  /**
   * Validate numeric entity ids and build a `ground` binding clause.
   * Ids are the one thing still embedded in query text (collection `:in`
   * inputs are unprobed), so each must be an integer: that rules out NaN,
   * Infinity, fractions and anything that is not a number at all.
   * @param ids - Entity ids (`:db/id`)
   * @param variable - Datalog variable to bind each id to (default `?id`)
   * @returns A where-clause such as `[(ground [1 2 3]) [?id ...]]`
   * @throws Error if any id is not an integer
   */
  static groundIds(ids: number[], variable: string = '?id'): string {
    for (const id of ids) {
      if (!Number.isInteger(id)) {
        throw new Error(`Invalid entity id: ${String(id)} (expected an integer)`);
      }
    }
    return `[(ground [${ids.join(' ')}]) [${variable} ...]]`;
  }

  /**
   * Validate block uuids and build a `ground` binding clause of `#uuid` literals.
   *
   * `:block/uuid` holds UUID values, not strings, so `[(ground ["..."]) [?u ...]]`
   * matches nothing (verified); the `#uuid "..."` tag is what matches. A string
   * collection passed through `:in` would arrive as strings, so the uuids are
   * embedded instead, which is why each must match the strict 8-4-4-4-12 hex
   * pattern first. The pattern excludes quotes, brackets and whitespace, so a
   * validated uuid cannot end the literal early.
   * @param uuids - Block uuids (any hex casing)
   * @param variable - Datalog variable to bind each uuid to
   * @returns A where-clause such as `[(ground [#uuid "..." #uuid "..."]) [?u ...]]`
   * @throws Error if any uuid does not match the pattern
   */
  static groundUuids(uuids: string[], variable: string = '?u'): string {
    const literals = uuids.map(uuid => {
      if (typeof uuid !== 'string' || !BLOCK_UUID_PATTERN.test(uuid)) {
        throw new Error(`Invalid block uuid: ${JSON.stringify(uuid)} (expected 8-4-4-4-12 hex digits)`);
      }
      return `#uuid "${uuid.toLowerCase()}"`;
    });
    return `[(ground [${literals.join(' ')}]) [${variable} ...]]`;
  }

  /**
   * Generate ONE Datalog query that fetches everything a level of `((uuid))`
   * refs and `{{embed}}`s points at:
   * - `blockUuids`: the referenced blocks themselves;
   * - `descendantUuids`: every block up to {@link EMBED_DESCENDANT_LEVELS}
   *   levels below those blocks (for `{{embed ((uuid))}}`);
   * - `pageNames`: each page entity and its top-level blocks (for
   *   `{{embed [[page]]}}`). Names are bound through `:in` as a collection and
   *   lowercased here.
   *
   * Rows are flat pulls of `[id, uuid, content, name, original-name, left, parent, page]`.
   * A uuid with no block, or a page with no entity, simply has no row.
   * Rebuild trees from `parent` and order siblings with `left`.
   * @returns Query and inputs (`[lowercased pageNames]` when there are pages, else none)
   * @throws Error if all three lists are empty or a uuid is malformed
   */
  static refTargets(spec: {
    blockUuids?: string[];
    descendantUuids?: string[];
    pageNames?: string[];
  }): DatalogQuery {
    const blockUuids = spec.blockUuids ?? [];
    const descendantUuids = spec.descendantUuids ?? [];
    const pageNames = (spec.pageNames ?? []).map(name => name.toLowerCase());
    const branches: string[] = [];

    if (blockUuids.length > 0) {
      branches.push(`(and ${DatalogQueryBuilder.groundUuids(blockUuids, '?u')} [?e :block/uuid ?u])`);
    }
    if (descendantUuids.length > 0) {
      branches.push(`(and ${DatalogQueryBuilder.groundUuids(descendantUuids, '?ru')}
               [?r :block/uuid ?ru]
               (or-join [?r ?e]
                 [?e :block/parent ?r]
                 (and [?m1 :block/parent ?r] [?e :block/parent ?m1])
                 (and [?m1 :block/parent ?r] [?m2 :block/parent ?m1] [?e :block/parent ?m2])))`);
    }
    if (pageNames.length > 0) {
      branches.push('[?e :block/name ?n]');
      branches.push('(and [?pg :block/name ?n] [?e :block/parent ?pg])');
    }
    if (branches.length === 0) {
      throw new Error('refTargets needs at least one uuid or page name');
    }

    const head = pageNames.length > 0 ? '[?e ?n]' : '[?e]';
    return {
      query: `[:find (pull ?e [:db/id :block/uuid :block/content :block/name :block/original-name
                              {:block/left [:db/id]} {:block/parent [:db/id]}
                              {:block/page [:db/id :block/name :block/original-name]}])
             ${pageNames.length > 0 ? ':in $ [?n ...]' : ''}
             :where
             (or-join ${head}
               ${branches.join('\n               ')})]`,
      inputs: pageNames.length > 0 ? [pageNames] : []
    };
  }

  /**
   * Generate a Datalog query for concept network traversal
   * @param rootName - The root concept/page name (any casing)
   * @param maxDepth - Maximum depth to traverse
   * @returns Query and inputs (`[lowercased rootName]`)
   */
  static conceptNetwork(rootName: string, maxDepth: number): DatalogQuery {
    const inputs = [rootName.toLowerCase()];

    // For depth=0, return only the root page (case-insensitive)
    if (maxDepth === 0) {
      return {
        query: `[:find (pull ?p [*])
               :in $ ?root-name
               :where
               [?p :block/name ?root-name]]`,
        inputs
      };
    }

    // For depth >= 1, find root page and connected pages (case-insensitive)
    return {
      query: `[:find (pull ?p [*]) (pull ?connected [*]) ?rel-type
             :in $ ?root-name
             :where
             ;; Find root page by name (case-insensitive)
             [?p :block/name ?root-name]

             ;; Find connected pages via references
             (or-join [?p ?connected ?rel-type]
               ;; Outbound: blocks on root page that reference other pages
               (and
                 [?block :block/page ?p]
                 [?block :block/refs ?connected]
                 [?connected :block/name]
                 [(ground "outbound") ?rel-type])

               ;; Inbound: blocks on other pages that reference root
               (and
                 [?block :block/refs ?p]
                 [?block :block/page ?connected]
                 [?connected :block/name]
                 [(ground "inbound") ?rel-type]))]`,
      inputs
    };
  }

  /**
   * Generate one Datalog query that finds every page connected to a whole
   * BFS frontier, in both directions, with a per-direction reference count.
   *
   * Each result row is
   * `[sourceId, connectedId, name, originalName, isJournal, relType, count]`:
   * - `relType` is `"outbound"` when `count` blocks on the source page
   *   reference the connected page, `"inbound"` when `count` blocks on the
   *   connected page reference the source page.
   * - `originalName` is `""` when the page has no `:block/original-name`.
   * - Self-loops (a page referencing itself) are excluded.
   * - Only entities with `:block/name` (pages) are returned.
   *
   * When two frontier pages link to each other, the same links are reported
   * once from each side, so callers must de-duplicate by page pair.
   * The ids are bound straight to `?source` (see `groundIds`).
   *
   * @param frontierIds - Entity ids (`:db/id`) of the pages to expand
   * @returns Query and inputs (no inputs)
   * @throws Error if `frontierIds` is empty or any id is not an integer
   */
  static connectedPages(frontierIds: number[]): DatalogQuery {
    if (frontierIds.length === 0) {
      throw new Error('connectedPages needs at least one frontier id');
    }
    return {
      query: `[:find ?source ?connected ?name ?original-name ?journal ?rel-type (count ?block)
             :where
             ${DatalogQueryBuilder.groundIds(frontierIds, '?source')}
             [?source :block/name]
             (or-join [?source ?connected ?block ?rel-type]
               ;; Outbound: blocks on the source page that reference other pages
               (and
                 [?block :block/page ?source]
                 [?block :block/refs ?connected]
                 [(ground "outbound") ?rel-type])

               ;; Inbound: blocks on other pages that reference the source
               (and
                 [?block :block/refs ?source]
                 [?block :block/page ?connected]
                 [(ground "inbound") ?rel-type]))
             [?connected :block/name ?name]
             [(not= ?source ?connected)]
             [(get-else $ ?connected :block/original-name "") ?original-name]
             [(get-else $ ?connected :block/journal? false) ?journal]]`,
      inputs: []
    };
  }

  /**
   * Generate Datalog query to get a page by name
   * @param pageName - The page name (any casing)
   * @returns Query and inputs (`[lowercased pageName]`)
   */
  static getPage(pageName: string): DatalogQuery {
    return {
      query: `[:find (pull ?page [*])
             :in $ ?page-name
             :where
             [?page :block/name ?page-name]]`,
      inputs: [pageName.toLowerCase()]
    };
  }

  /**
   * Generate Datalog query for journal pages whose date falls in a range.
   * `[?page :block/name]` is required: blocks with a scheduled/deadline date
   * also carry `:block/journal-day`, and without it they match as pages.
   * @param startDate - First journal day, inclusive (YYYYMMDD integer)
   * @param endDate - Last journal day, inclusive (YYYYMMDD integer)
   * @returns Query and inputs (`[startDate, endDate]`)
   * @throws Error if either bound is not an integer
   */
  static getJournalPagesInRange(startDate: number, endDate: number): DatalogQuery {
    DatalogQueryBuilder.assertJournalBounds(startDate, endDate);
    return {
      query: `[:find (pull ?page [*])
             :in $ ?start ?end
             :where
             [?page :block/name]
             [?page :block/journal-day ?day]
             [(>= ?day ?start)]
             [(<= ?day ?end)]]`,
      inputs: [startDate, endDate]
    };
  }

  /**
   * Generate Datalog query for every block on the journal pages in a range
   * (flat; callers rebuild the tree from `:block/parent` and `:block/left`).
   *
   * Each block's `refs` come back as referenced-page maps (`id`, `name`,
   * `original-name`, `journal?`, `journal-day` when set) instead of bare `{id}`,
   * so a roll-up of referenced concepts needs no further call. A ref to a block
   * (`((uuid))`) has no `name`.
   * @param startDate - First journal day, inclusive (YYYYMMDD integer)
   * @param endDate - Last journal day, inclusive (YYYYMMDD integer)
   * @returns Query and inputs (`[startDate, endDate]`)
   * @throws Error if either bound is not an integer
   */
  static getJournalBlocksInRange(startDate: number, endDate: number): DatalogQuery {
    DatalogQueryBuilder.assertJournalBounds(startDate, endDate);
    return {
      query: `[:find (pull ?block [* {:block/refs [:db/id :block/name :block/original-name :block/journal? :block/journal-day]}])
             :in $ ?start ?end
             :where
             [?page :block/name]
             [?page :block/journal-day ?day]
             [(>= ?day ?start)]
             [(<= ?day ?end)]
             [?block :block/page ?page]]`,
      inputs: [startDate, endDate]
    };
  }

  /**
   * Generate Datalog query for the journal pages on or before a day. The caller
   * sorts by `journal-day` and slices the newest N in TypeScript, so one query
   * finds "the last N journals that exist" however many days are missing.
   *
   * Pulls only the identifying attributes (a few hundred small maps on a graph
   * with years of journals), not `[*]`. `[?page :block/name]` is required for the
   * same reason as in {@link getJournalPagesInRange}.
   * @param latestDay - Newest journal day to consider, inclusive (YYYYMMDD integer)
   * @returns Query and inputs (`[latestDay]`)
   * @throws Error if `latestDay` is not an integer
   */
  static getJournalPagesUpTo(latestDay: number): DatalogQuery {
    if (!Number.isInteger(latestDay)) {
      throw new Error(`Invalid journal latest date: ${String(latestDay)} (expected an integer)`);
    }
    return {
      query: `[:find (pull ?page [:db/id :block/uuid :block/name :block/original-name :block/journal-day :block/journal?])
             :in $ ?latest
             :where
             [?page :block/name]
             [?page :block/journal-day ?day]
             [(<= ?day ?latest)]]`,
      inputs: [latestDay]
    };
  }

  private static assertJournalBounds(startDate: number, endDate: number): void {
    for (const [label, value] of [['start', startDate], ['end', endDate]] as const) {
      if (!Number.isInteger(value)) {
        throw new Error(`Invalid journal ${label} date: ${String(value)} (expected an integer)`);
      }
    }
  }

  /**
   * Generate Datalog query to get blocks for a page
   * @param pageName - The page name (any casing)
   * @returns Query and inputs (`[lowercased pageName]`)
   */
  static getPageBlocks(pageName: string): DatalogQuery {
    return {
      query: `[:find (pull ?block [*])
             :in $ ?page-name
             :where
             [?page :block/name ?page-name]
             [?block :block/page ?page]]`,
      inputs: [pageName.toLowerCase()]
    };
  }

  /**
   * Generate Datalog query for blocks whose content contains `text`
   * (case-insensitive, literal match), each with its page's name inline.
   *
   * The pattern goes in as an `:in` input and `re-pattern` compiles it inside
   * LogSeq. Two escaping layers apply: `escapeRegex` here makes the text match
   * literally, and `LogseqClient.executeDatalogQuery` EDN-encodes the input.
   * `(?i)` makes the match case-insensitive, since `lower-case` is unavailable.
   *
   * @param text - Literal text to search for
   * @returns Query and inputs (`["(?i)" + escaped text]`)
   */
  static searchBlocks(text: string): DatalogQuery {
    return {
      query: `[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}])
             :in $ ?pattern
             :where
             [?b :block/content ?c]
             [(re-pattern ?pattern) ?re]
             [(re-find ?re ?c)]]`,
      inputs: ['(?i)' + escapeRegex(text)]
    };
  }

  /**
   * Generate Datalog query for full page entities by id
   * @param pageIds - Page entity ids (`:db/id`), each an integer
   * @returns Query and inputs (none: ids are validated integers)
   * @throws Error if any id is not an integer
   */
  static getPagesByIds(pageIds: number[]): DatalogQuery {
    return {
      query: `[:find (pull ?p [*])
             :where
             ${DatalogQueryBuilder.groundIds(pageIds, '?p')}
             [?p :block/name]]`,
      inputs: []
    };
  }

  /**
   * Generate Datalog query for blocks that reference a page, with each
   * block's full page entity (including journalDay) nested in the result
   * @param pageName - The referenced page name (any casing)
   * @returns Query and inputs (`[lowercased pageName]`)
   */
  static getBlocksReferencingPage(pageName: string): DatalogQuery {
    return {
      query: `[:find (pull ?block [:db/id :block/uuid :block/content :block/marker :block/properties :block/format {:block/page [*]}])
             :in $ ?page-name
             :where
             [?page :block/name ?page-name]
             [?block :block/refs ?page]]`,
      inputs: [pageName.toLowerCase()]
    };
  }

  /**
   * Generate Datalog query for blocks on one page that reference another
   * page. Matching is on `:block/refs`, so `[[Topic]]`, `#topic`,
   * `#[[multi word]]` and uuid-style refs all count, in any casing, and
   * plain text that merely contains the name does not.
   * @param pageName - The page whose blocks are searched (any casing)
   * @param refName - The page the blocks must reference (any casing)
   * @returns Query and inputs (`[lowercased pageName, lowercased refName]`)
   */
  static blocksOnPageReferencing(pageName: string, refName: string): DatalogQuery {
    return {
      query: `[:find (pull ?block [*])
             :in $ ?page-name ?ref-name
             :where
             [?page :block/name ?page-name]
             [?ref :block/name ?ref-name]
             [?block :block/page ?page]
             [?block :block/refs ?ref]]`,
      inputs: [pageName.toLowerCase(), refName.toLowerCase()]
    };
  }

  /**
   * Generate Datalog query for blocks that reference `topicA`, restricted to
   * pages that also contain a block referencing `topicB`. Both matches are on
   * `:block/refs`, so casing and tag/link syntax do not matter.
   * @param topicA - The page the returned blocks must reference (any casing)
   * @param topicB - The page some other block on the same page must reference (any casing)
   * @returns Query and inputs (`[lowercased topicA, lowercased topicB]`)
   */
  static blocksReferencingInPagesLinking(topicA: string, topicB: string): DatalogQuery {
    return {
      query: `[:find (pull ?block [*])
             :in $ ?a-name ?b-name
             :where
             [?a :block/name ?a-name]
             [?b :block/name ?b-name]
             [?linker :block/refs ?b]
             [?linker :block/page ?page]
             [?block :block/page ?page]
             [?block :block/refs ?a]]`,
      inputs: [topicA.toLowerCase(), topicB.toLowerCase()]
    };
  }

  /**
   * Generate Datalog query for the pages one reference hop away from a set
   * of pages, in both directions (pages they reference and pages that
   * reference them). One query covers a whole BFS frontier.
   * @param pageIds - Page entity ids (`:db/id`), each must be an integer
   * @returns Query and no inputs (ids are embedded via `groundIds`)
   * @throws Error if any id is not an integer
   */
  static neighborPages(pageIds: number[]): DatalogQuery {
    return {
      query: `[:find ?neighbor
             :where
             ${DatalogQueryBuilder.groundIds(pageIds, '?p')}
             (or-join [?p ?neighbor]
               (and
                 [?block :block/page ?p]
                 [?block :block/refs ?neighbor]
                 [?neighbor :block/name])
               (and
                 [?block :block/refs ?p]
                 [?block :block/page ?neighbor]
                 [?neighbor :block/name]))]`,
      inputs: []
    };
  }

  /**
   * Normalize a property name to the key LogSeq stores in `:block/properties`.
   * LogSeq keeps property keys lowercase with dashes (`created-at`), while the
   * Editor API returns them camelCase (`createdAt`). Both spellings are
   * accepted here, plus underscores: `createdAt`, `created-at` and
   * `Created_At` all become `created-at`.
   * @param name - Property name in any of those spellings
   * @returns The stored key, without a leading colon
   * @throws InvalidParameterError unless the name is letters, digits, `-` and `_`
   */
  static normalizePropertyKey(name: string): string {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      throw new InvalidParameterError(
        'property_key',
        String(name),
        'a property name made of letters, digits, "-" and "_", starting with a letter or digit',
        'status'
      );
    }
    return name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/_/g, '-')
      .toLowerCase();
  }

  /**
   * Generate Datalog query for blocks whose property `propertyName` matches
   * `propertyValue`, each with its page's name inline.
   *
   * Both the key and the value are `:in` inputs; nothing is embedded. The key
   * is a string that `(keyword ?key)` turns into the keyword
   * `:block/properties` is indexed by (`get` with a string key matches
   * nothing, and an EDN-encoded string input cannot be a keyword).
   *
   * Matching, per property value `?v` (LogSeq has no `string?`/`coll?`
   * predicates, so one rule covers both shapes):
   * - scalars (string, number, boolean): `(str ?v)` equals the value, the same
   *   as the old `String(value) === propertyValue`;
   * - multi-value properties (sets, e.g. `type:: [[a]], [[b]]`): any element
   *   equals the value (`contains?`). A one-element set therefore matches like
   *   a scalar, as before. The old comma-joined match (`"a,b"`) is gone.
   *
   * `[?b :block/page]` keeps blocks only: page entities carry their own
   * `:block/properties`, but the page's first block holds the same
   * properties, and that is the one the Editor API returned.
   *
   * @param propertyName - Property name (see `normalizePropertyKey`)
   * @param propertyValue - Value to match (compared as a string)
   * @returns Query and inputs (`[normalized key, value]`)
   * @throws InvalidParameterError if the property name is invalid
   */
  static blocksByProperty(propertyName: string, propertyValue: string): DatalogQuery {
    return {
      query: `[:find (pull ?b [* {:block/page [:db/id :block/name :block/original-name]}])
             :in $ ?key ?value
             :where
             [?b :block/properties ?props]
             [?b :block/page]
             [(keyword ?key) ?kw]
             [(get ?props ?kw) ?v]
             (or-join [?v ?value]
               (and
                 [(str ?v) ?s]
                 [(= ?s ?value)])
               [(contains? ?v ?value)])]`,
      inputs: [DatalogQueryBuilder.normalizePropertyKey(propertyName), String(propertyValue)]
    };
  }
}
