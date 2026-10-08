/**
 * The few Datalog queries the integration suites run themselves, for setup and for checks that look at LogSeq
 * rather than at a tool. They bind strings with `:in`, as every query does (ADR-0013, CLAUDE.md constraint 1);
 * the client EDN-encodes the inputs.
 */

export interface DatalogQuery {
  query: string;
  inputs: unknown[];
}

/** The page entity named so, in any casing (`:block/name` is lowercase). Rows are `[pageEntity]`. */
export function getPageQuery(pageName: string): DatalogQuery {
  return {
    query: `[:find (pull ?page [*])
             :in $ ?page-name
             :where
             [?page :block/name ?page-name]]`,
    inputs: [pageName.toLowerCase()]
  };
}

/** A block uuid as a Datalog literal (`#uuid "..."`); a string never matches `:block/uuid` (CLAUDE.md, constraint 7). */
export function uuidLiteral(uuid: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error(`not a uuid: ${uuid}`);
  return `#uuid "${uuid}"`;
}
