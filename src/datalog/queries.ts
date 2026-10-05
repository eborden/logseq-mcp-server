/**
 * Datalog query builder for LogSeq queries
 * Provides reusable query templates for common graph operations
 */

import { escapeRegex } from '../utils/escape-regex.js';

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
}
