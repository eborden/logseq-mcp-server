import { LogseqClient } from '../client.js';
import { DatalogQueryBuilder } from '../datalog/queries.js';
import type { PageLike, ResultWarning } from '../types.js';
import { entityId, pageDisplayName, pageName as nameOf } from './entity-fields.js';
import { queryParsed } from './parse-response.js';
import { responses } from '../response-schemas.js';

/**
 * Most pages one alias group may hold here. Groups are written by hand
 * (`alias:: a, b, c`), so a handful is normal; the cap only bounds the id
 * lists embedded in follow-up queries, and a group that exceeds it says so.
 */
export const MAX_ALIAS_SET_SIZE = 50;

/** One page of an alias group. */
export interface AliasMember {
  id: number;
  /** Lowercased `:block/name` */
  name: string;
  originalName: string;
}

/**
 * Every page that names the same thing (#69): the page asked about plus the
 * pages it aliases and the pages aliasing it, in either direction. `alias::`
 * makes two names one concept, but a reference written under either name
 * points at its own page entity, so a tool that follows links to one page id
 * misses the rest. `members[0]` is always the page asked about; the others are
 * ordered by name so output never depends on row order.
 */
export interface AliasSet {
  members: AliasMember[];
  /** True when the group was cut at {@link MAX_ALIAS_SET_SIZE} */
  truncated: boolean;
}

/** The `resolvedAliases` field a tool adds to its result (or `meta`) when the page has aliases. */
export interface ResolvedAliases {
  resolvedAliases?: string[];
}

function memberOf(page: PageLike | null | undefined): AliasMember | null {
  const id = entityId(page);
  return typeof id === 'number' ? { id, name: nameOf(page), originalName: pageDisplayName(page) } : null;
}

/** An alias set holding only `page`: no query, nothing to union. */
export function singleAliasSet(page: PageLike): AliasSet {
  const member = memberOf(page);
  return { members: member ? [member] : [], truncated: false };
}

/**
 * Whether a page entity pulled by Datalog has any alias link. LogSeq stores
 * every alias in both directions, so the target of `alias:: x` carries the link
 * back (verified by `scripts/probe-constraints.ts`, which must report no
 * one-directional link). A page without `:block/alias` therefore has no
 * aliases and needs no query.
 */
export function hasAliasLinks(page: PageLike | null | undefined): boolean {
  return Array.isArray(page?.alias) && page.alias.length > 0;
}

/** Page ids of the set. */
export const aliasIds = (set: AliasSet): number[] => set.members.map(member => member.id);

/** Lowercased page names of the set. */
export const aliasNames = (set: AliasSet): string[] => set.members.map(member => member.name);

/** True when the set holds more than the page asked about. */
export const hasAliases = (set: AliasSet): boolean => set.members.length > 1;

/** Order two alias names by `en` collation, then by code unit when `en` ties them. */
export function compareAliasNames(a: string, b: string): number {
  return a.localeCompare(b, 'en') || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * `resolvedAliases` for a result: the original-case names the tool covered,
 * sorted so asking by either name of the group reports the same list (a
 * result's `resolvedFrom` says which name was asked). Absent when the page
 * has no aliases, so default output is unchanged.
 */
export function resolvedAliases(set: AliasSet): ResolvedAliases {
  if (!hasAliases(set)) return {};
  const names = set.members.map(member => member.originalName);
  // One comparison pinned to `en`: names that differ only in accents or case
  // still order the same on any host, whatever the process locale. Names `en`
  // collation ties (NFC and NFD forms, a soft hyphen or zero-width joiner)
  // fall back to code-unit order, so the order never follows arrival order.
  return { resolvedAliases: names.sort(compareAliasNames) };
}

/** The `alias_set_truncated` warning for each set that was cut, empty otherwise. */
export function aliasSetWarnings(...sets: AliasSet[]): ResultWarning[] {
  return sets
    .filter(set => set.truncated)
    .map(set => ({
      code: 'alias_set_truncated',
      message:
        `The alias group of "${set.members[0]?.originalName ?? ''}" has more than ${MAX_ALIAS_SET_SIZE} pages; ` +
        `only the page itself and ${MAX_ALIAS_SET_SIZE - 1} aliases were used, so references written under ` +
        'the other names are missing. The maximum cannot be raised.'
    }));
}

/** Fold query members into a set: start page first, the rest by name, capped. */
function buildSet(start: AliasMember, found: AliasMember[]): AliasSet {
  const others = new Map<number, AliasMember>();
  for (const member of found) if (member.id !== start.id) others.set(member.id, member);
  const sorted = [...others.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id - b.id
  );
  const room = MAX_ALIAS_SET_SIZE - 1;
  return { members: [start, ...sorted.slice(0, room)], truncated: sorted.length > room };
}

/**
 * The alias sets of several resolved pages, in one Datalog query for all of
 * them, and none when no page has an alias link. Pass the pages exactly as
 * {@link requirePage} returned them.
 *
 * Infrastructure errors (connection, timeout, auth) propagate: an alias lookup
 * that failed must not look like "no aliases".
 */
export async function resolveAliasSets(client: LogseqClient, pages: PageLike[]): Promise<AliasSet[]> {
  const starts = pages.map(page => singleAliasSet(page));
  const withLinks = starts
    .map((set, i) => ({ id: set.members[0]?.id, linked: hasAliasLinks(pages[i]) }))
    .filter((entry): entry is { id: number; linked: true } => entry.linked && entry.id !== undefined);
  if (withLinks.length === 0) return starts;

  const { query, inputs } = DatalogQueryBuilder.aliasSets([...new Set(withLinks.map(entry => entry.id))]);
  const rows = (await queryParsed(client, responses.aliasSetRows, query, ...inputs)) || [];

  const byStart = new Map<number, AliasMember[]>();
  for (const [startId, page] of rows) {
    const member = memberOf(page);
    if (!member) continue;
    byStart.set(startId, [...(byStart.get(startId) ?? []), member]);
  }
  return starts.map(set => {
    const start = set.members[0];
    return start && byStart.has(start.id) ? buildSet(start, byStart.get(start.id)!) : set;
  });
}

/** The alias set of one resolved page (see {@link resolveAliasSets}). */
export async function resolveAliasSet(client: LogseqClient, page: PageLike): Promise<AliasSet> {
  return (await resolveAliasSets(client, [page]))[0];
}

/**
 * The alias set of a page known only by name, or null when no page has that
 * name or it has no aliases. For free text that may or may not be a page name
 * (a `search_term`), where "not a page" is an ordinary answer, not an error.
 */
export async function resolveAliasSetByName(
  client: LogseqClient,
  name: string
): Promise<AliasSet | null> {
  const { query, inputs } = DatalogQueryBuilder.aliasSetByName(name);
  const rows = (await queryParsed(client, responses.aliasSetByNameRows, query, ...inputs)) || [];
  const first = rows.map(([start]) => memberOf(start)).find(member => member !== null);
  if (!first) return null;
  const found = rows.map(([, member]) => memberOf(member)).filter((m): m is AliasMember => m !== null);
  const set = buildSet(first, found);
  return hasAliases(set) ? set : null;
}
