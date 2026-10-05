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
}
