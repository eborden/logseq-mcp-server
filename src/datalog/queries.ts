/**
 * Datalog query builder for LogSeq queries
 * Provides reusable query templates for common graph operations
 */

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
}
