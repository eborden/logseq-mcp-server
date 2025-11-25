/**
 * Datalog query builder for LogSeq queries
 * Provides reusable query templates for common graph operations
 */

export interface ContextLimits {
  maxBlocks?: number;
  maxRelatedPages?: number;
  maxReferences?: number;
}

export class DatalogQueryBuilder {
  /**
   * Generate a Datalog query for concept network traversal
   * @param rootName - The root concept/page name
   * @param maxDepth - Maximum depth to traverse
   * @returns Datalog query string
   */
  static conceptNetwork(rootName: string, maxDepth: number): string {
    const rootNameLower = rootName.toLowerCase();

    // For depth=0, return only the root page (case-insensitive)
    if (maxDepth === 0) {
      return `[:find (pull ?p [*])
               :where
               [?p :block/name "${rootNameLower}"]]`;
    }

    // For depth >= 1, find root page and connected pages (case-insensitive)
    return `[:find (pull ?p [*]) (pull ?connected [*]) ?rel-type
             :where
             ;; Find root page by name (case-insensitive)
             [?p :block/name "${rootNameLower}"]

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
                 [(ground "inbound") ?rel-type]))]`;
  }


  /**
   * Generate a Datalog query for building context about a topic
   * @param pageName - The page name to build context for
   * @param limits - Limits for blocks, related pages, and references
   * @returns Datalog query string
   */
  /**
   * Generate Datalog query to get a page by name
   * @param pageName - The page name
   * @returns Datalog query string
   */
  static getPage(pageName: string): string {
    const pageNameLower = pageName.toLowerCase();
    return `[:find (pull ?page [*])
             :where
             [?page :block/name "${pageNameLower}"]]`;
  }

  /**
   * Generate Datalog query to get blocks for a page
   * @param pageName - The page name
   * @returns Datalog query string
   */
  static getPageBlocks(pageName: string): string {
    const pageNameLower = pageName.toLowerCase();
    return `[:find (pull ?block [*])
             :where
             [?page :block/name "${pageNameLower}"]
             [?block :block/page ?page]]`;
  }

  // Deprecated: Use getPage() and getPageBlocks() instead
  // Kept for backwards compatibility with tests
  static buildContext(pageName: string, limits: ContextLimits): string {
    return DatalogQueryBuilder.getPage(pageName);
  }

  /**
   * Generate a Datalog query for relationship-based search
   * @param topicA - First topic
   * @param topicB - Second topic
   * @param relationshipType - Type of relationship to search for
   * @returns Datalog query string
   */
  static searchByRelationship(
    topicA: string,
    topicB: string,
    relationshipType: string
  ): string {
    if (relationshipType === 'references') {
      // Find blocks about topicA that reference topicB
      return `[:find (pull ?block [*])
               :in $ ?topic-a ?topic-b
               :where
               ;; Find topicB page
               [(clojure.string/lower-case ?topic-b) ?topic-b-lower]
               [?page-b :block/name ?topic-b-lower]

               ;; Find blocks that mention topicA and reference topicB
               [?block :block/content ?content]
               [(clojure.string/includes? ?content ?topic-a)]
               [?block :block/refs ?page-b]]`;
    } else if (relationshipType === 'referenced-by') {
      // Find blocks about topicA in pages referenced by topicB
      return `[:find (pull ?block [*])
               :in $ ?topic-a ?topic-b
               :where
               ;; Find topicB page
               [(clojure.string/lower-case ?topic-b) ?topic-b-lower]
               [?page-b :block/name ?topic-b-lower]

               ;; Find pages referenced by topicB
               [?block-b :block/page ?page-b]
               [?block-b :block/refs ?ref-page]

               ;; Find blocks about topicA in those pages
               [?block :block/page ?ref-page]
               [?block :block/content ?content]
               [(clojure.string/includes? ?content ?topic-a)]]`;
    }

    // Default case - return basic query
    return `[:find (pull ?block [*])
             :in $ ?topic-a ?topic-b
             :where
             [?block :block/content ?content]
             [(clojure.string/includes? ?content ?topic-a)]]`;
  }
}
