// zod 4's API, shipped inside the zod 3.25 package, as in src/utils/parse-args.ts and src/config.ts.
import { z } from 'zod/v4';

/**
 * What LogSeq's responses look like, as zod schemas (#202, foundations 4.2).
 *
 * Every read of LogSeq goes through `callParsed` or `queryParsed` (`src/utils/parse-response.ts`),
 * which checks the response against one of these and hands back the response itself. The schemas
 * are the one place that says which fields the tools rely on and what type each has, and the
 * types in `src/types.ts` are built from them, so a field can't be typed one way and sent another.
 *
 * Rules:
 * - Tolerant reader. A schema names the fields the code reads, and nothing else. A key it doesn't
 *   name (LogSeq adds one in a newer version, or a field no tool reads) is neither required nor
 *   checked, and stays in the object. A field that is optional here is optional because LogSeq
 *   leaves it out sometimes (`updated-at` is missing on about 1 page in 10).
 * - Strict where the code relies on a field: a required field that is missing, or any field of the
 *   wrong type, fails the parse with `LogSeqResponseError`. No coercion, no defaults.
 * - The response is returned as it came, not as zod rebuilt it. zod's output reorders keys (the
 *   schema's first, extras after) and copies every object, and tool output has always carried
 *   LogSeq's own key order and spelling. The schema is a check, not a rewrite.
 * - `null` is not `[]` (BR-0011): a schema says `.nullable()` where LogSeq may answer `null`, and
 *   the tool still decides what `null` means.
 *
 * Two dialects. `logseq.Editor.*` camelizes keys (`originalName`, `journalDay`, `createdAt`), and
 * a Datalog pull keeps LogSeq's own (`original-name`, `journal-day`, `created-at`). Their output
 * is not the same JSON, and the tools' full (non-slim) output carries each entity as it came, so
 * the entities are not rewritten into one shape here. Each boundary says which dialect it gets
 * (`editorPageSchema`, `pulledPageSchema`), and `pageLikeSchema` is a page of either, for a page
 * nested in a block or handed to a reader. `src/utils/entity-fields.ts` reads a field whichever
 * way it is spelled.
 */

/**
 * `{ id }`: a bare reference to a page or a block. Both spellings of the id are accepted and
 * neither is required: the code reads a reference with `?.id` and skips one that has none.
 */
export const entityRefSchema = z.object({ id: z.number().optional(), 'db/id': z.number().optional() });

/**
 * A property map. The keys are the user's property names and the values anything, so all that is
 * checked is that it is a map. (`z.record` would visit every key, and costs several times more.)
 */
const propertiesSchema = z.custom<Record<string, unknown>>(
  value => typeof value === 'object' && value !== null && !Array.isArray(value),
  { error: 'expected an object' }
);

// Page fields LogSeq spells the same in both dialects. `journal?` is one of them.
const pageShared = {
  uuid: z.string().optional(),
  'journal?': z.boolean().optional(),
  // LogSeq 0.10.15 sends only `journal?`. The plugin typings name it `journal`, and the readers have
  // always accepted it, so a response that says so is not an error.
  journal: z.boolean().optional(),
  /** Set when the page is backed by a file; absent on stubs that only exist as link targets */
  file: entityRefSchema.optional(),
  /**
   * Pages linked by `alias::`, as bare ids. LogSeq stores each link in both directions, so the
   * declaring page lists its stubs and every stub lists the declaring page.
   */
  alias: z.array(entityRefSchema).optional(),
  namespace: entityRefSchema.optional(),
  properties: propertiesSchema.optional(),
};

// The Editor API's camelCase spelling of the fields that differ
const pageEditorKeys = {
  originalName: z.string().optional(),
  journalDay: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
};

// A Datalog pull's own spelling. `db/id` is Datascript's name for the id: LogSeq 0.10.15 renames
// it to `id` in a query result, and the reader still accepts it from an older one.
const pagePulledKeys = {
  'db/id': z.number().optional(),
  'original-name': z.string().optional(),
  'journal-day': z.number().optional(),
  'created-at': z.number().optional(),
  'updated-at': z.number().optional(),
  'properties-text-values': propertiesSchema.optional(),
};

/**
 * A page from the Editor API (`getPage`, `getAllPages`, `getCurrentPage`): camelCase keys.
 * `id` and `name` are what `list_pages` reads with no fallback, and every page entity has both (`:block/name`
 * is what makes it a page). `originalName` is read with a fallback to `name` (`pageDisplayName`), so a page
 * that lacks it is fine. The timestamps are optional.
 */
export const editorPageSchema = z.object({
  id: z.number(),
  name: z.string(),
  ...pageShared,
  ...pageEditorKeys,
});

/**
 * A page from a Datalog pull: LogSeq's own kebab-case keys. A pull can take only some attributes, so
 * every field is optional, the id too (`id`, or `db/id` from an older LogSeq): the resolver keys a page
 * by its name when it has no id, and the alias sets and the current-context lookup skip one.
 */
export const pulledPageSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  ...pageShared,
  ...pagePulledKeys,
});

/**
 * A page of either dialect, with every field optional: the page nested in a block (a bare
 * `{ id }` from the Editor API, a whole page when a pull nests one), or a page a reader is handed.
 */
export const pageLikeSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  ...pageShared,
  originalName: pageEditorKeys.originalName,
  journalDay: pageEditorKeys.journalDay,
  createdAt: pageEditorKeys.createdAt,
  updatedAt: pageEditorKeys.updatedAt,
  ...pagePulledKeys,
});

/**
 * The page nested in a block, or one of its `refs`: a bare `{ id }` from the Editor API, a few
 * attributes when a pull nests one, or a whole page. Only what the readers take from such a page
 * is checked (`entity-fields`, `top_concepts`): a block carries one page and several refs, so a
 * result of thousands of blocks checks thousands of these, and each field costs time.
 */
export const nestedPageSchema = z.object({
  id: z.number().optional(),
  'db/id': z.number().optional(),
  name: z.string().optional(),
  originalName: z.string().optional(),
  'original-name': z.string().optional(),
  'journal?': z.boolean().optional(),
  journal: z.boolean().optional(),
  journalDay: z.number().optional(),
  'journal-day': z.number().optional(),
});

/**
 * A block, in the fields both dialects spell the same and the code reads: `id`, `uuid`, `content`,
 * `page`, `parent`, `left`, `properties`, `marker` and `refs`. The ones that differ (`path-refs` /
 * `pathRefs`, `properties-order` / `propertiesOrder`, `journal-day` / `journalDay`) are not read
 * from the wire: a tool camelizes a pulled block first (`camelizeBlock`), or passes it through as
 * it came. A field nothing reads (`format`, `scheduled`, `deadline`) is not checked.
 *
 * `children` is not checked: without `includeChildren` the Editor API gives unfetched
 * `["uuid", "<id>"]` tuples there, not blocks.
 *
 * Kept small on purpose: results of thousands of blocks are checked row by row (see
 * `scripts/measure-parse-time.ts`).
 */
export const blockSchema = z.object({
  id: z.number(),
  uuid: z.string(),
  // Read with a fallback to '' (date range, search term) or skipped when not text (current context),
  // and a block with no `:block/content` omits the key, so it is optional
  content: z.string().optional(),
  page: nestedPageSchema.optional(),
  parent: entityRefSchema.optional(),
  left: entityRefSchema.optional(),
  properties: propertiesSchema.optional(),
  marker: z.string().optional(),
  refs: z.array(nestedPageSchema).optional(),
});

/** The graph `logseq.App.getCurrentGraph` says is open. */
export const graphInfoSchema = z.object({
  url: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
});

/**
 * A block as the outline's query pulls it: only `id`, `uuid`, `content`, `left` and `parent`. The
 * outline has always read the id as `db/id` too, and a parent as a bare number, so a pull that says
 * so is not an error here.
 */
export const outlineBlockSchema = z
  .object({
    id: z.number().optional(),
    'db/id': z.number().optional(),
    uuid: z.string(),
    content: z.string().optional(), // the snippet is '' for a block with none
    left: entityRefSchema.optional(),
    parent: z.union([entityRefSchema, z.number()]).optional(),
  })
  .refine(block => block.id !== undefined || block['db/id'] !== undefined, { error: 'a block needs an id' });

/**
 * A block or page row that `refTargets` pulls to resolve `((uuid))` refs and embeds
 * (`src/utils/resolve-refs.ts`). It holds whichever of these the target has: a block has
 * `uuid`, `content`, `left`, `parent` and `page`; a page has `name` and `original-name`.
 * A placeholder LogSeq makes for a `((uuid))` that no real block has holds only `id`,
 * `uuid` and `content`.
 */
export const refTargetSchema = z.object({
  id: z.number(),
  uuid: z.string().optional(),
  content: z.string().optional(),
  name: z.string().optional(),
  'original-name': z.string().optional(),
  left: entityRefSchema.optional(),
  parent: entityRefSchema.optional(),
  page: z
    .object({ id: z.number().optional(), name: z.string().optional(), 'original-name': z.string().optional() })
    .optional(), // a placeholder row has no page (`isPlaceholder` reads `page?.id`)
});

/** What `connectedPages` answers per row: `[sourceId, connectedId, name, originalName, isJournal, relType, count]`. */
const connectedRowSchema = z.tuple(
  [z.number(), z.number(), z.string(), z.string(), z.boolean(), z.enum(['outbound', 'inbound']), z.number()]
);

/**
 * Datalog rows, whose cells are `columns`. LogSeq answers `null` instead of rows in some states
 * (BR-0011), so a tool decides what that means; it is never `[]`. A row is the cells its `:find` asks
 * for, which the tool destructures, so the columns are all named here.
 */
const rows = <T extends readonly [z.ZodType, ...z.ZodType[]]>(...columns: T) =>
  z.array(z.tuple(columns)).nullable();

/**
 * What `getCurrentPage` answers: a page, or the block the user zoomed into. It has the page's `name` or
 * it hasn't (the test the tool itself applies), and the answer is checked as the one it is, so a mismatch
 * reports its own path (`originalName`, `content`) instead of "Invalid input" for a whole union.
 */
const pageOrBlockSchema = z
  .custom<z.infer<typeof editorPageSchema> | z.infer<typeof blockSchema>>(
    value => typeof value === 'object' && value !== null && !Array.isArray(value),
    { error: 'expected an object' }
  )
  .superRefine((value, ctx) => {
    const chosen = 'name' in value && value.name !== undefined ? editorPageSchema : blockSchema;
    const result = chosen.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
  });

/**
 * What each LogSeq call the tools make answers, by the shape the tool reads. `.nullable()` is
 * what LogSeq may answer instead of the value, and a tool treats it as its own case (BR-0011),
 * never as `[]`. A pull cell is nullable where the tool already skips a null cell.
 */
export const responses = {
  // logseq.Editor.* (camelCase)
  /** `getPage`: the page, or `null` when there is none */
  editorPage: editorPageSchema.nullable(),
  /** `getAllPages` */
  editorPages: z.array(editorPageSchema).nullable(),
  /** `getAllPages`, read for the names of pages only (the closest-name suggestions) */
  pageNames: z.array(z.object({ originalName: z.string().optional() })).nullable(),
  /** `getBlock`, `getCurrentBlock` */
  block: blockSchema.nullable(),
  /** `getPageBlocksTree`, `getSelectedBlocks` */
  blocks: z.array(blockSchema).nullable(),
  /**
   * `getPageLinkedReferences`: `[sourcePage, blocks]` per page that links. The page is read
   * through `entity-fields`, which takes either spelling, so it is checked as a `PageLike`;
   * it can be `null`, and then the blocks name their page.
   */
  linkedReferences: z.array(z.tuple([pageLikeSchema.nullable(), z.array(blockSchema)])).nullable(),
  /** `getCurrentPage`: a page, or the block the user zoomed into */
  pageOrBlock: pageOrBlockSchema.nullable(),
  /** `getCurrentGraph` */
  graphInfo: graphInfoSchema.nullable(),

  // logseq.DB.datascriptQuery (a pull keeps LogSeq's kebab-case)
  /** `[page]`: one pulled page per row */
  pageRows: rows(pulledPageSchema),
  /** `[page | null]`: pages by id, where a row's page can be `null` */
  nullablePageRows: rows(pulledPageSchema.nullable()),
  /** `[block]`: one pulled block per row */
  blockRows: rows(blockSchema),
  /** `[block | null]`: blocks, where a tool skips a `null` cell */
  nullableBlockRows: rows(blockSchema.nullable()),
  /**
   * `[block | null]`, for the keyword search, which has always skipped a row whose `content` is not
   * a string instead of failing on it (`searchBlocksWithMeta`). Only that row is checked here; the
   * rows it keeps are then checked as blocks (`blockList`).
   */
  searchRows: rows(z.object({ id: z.number(), content: z.unknown() }).nullable()),
  /** A list of blocks that must all be whole */
  blockList: z.array(blockSchema),
  /**
   * A list of keyword-search hits: whole blocks whose `content` is text. `searchBlocksWithMeta`
   * keeps only rows with string content before it checks them here, so the type can say it.
   */
  searchHitList: z.array(blockSchema.extend({ content: z.string() })),
  /** `[page, via]`: the resolver's first query. `via` is `name` (or absent), `alias` or `journal-date` */
  resolverRows: rows(pulledPageSchema, z.string().optional()),
  /** `[page, via, name]`: link targets, one row per name and route */
  linkTargetRows: rows(pulledPageSchema.nullable(), z.string(), z.unknown()), // a row whose name isn't text is skipped
  /** `[startId, member]`: the alias group of each start page */
  aliasSetRows: rows(z.number(), pulledPageSchema),
  /** `[start, member]`: the alias group of a page found by name */
  aliasSetByNameRows: rows(pulledPageSchema, pulledPageSchema),
  /** `[sourceId, connectedId, name, originalName, isJournal, relType, count]` */
  connectedRows: z.array(connectedRowSchema).nullable(),
  /** `[id]`: page ids */
  idRows: rows(z.number()),
  /** `[block | null]`: the blocks of a page's outline */
  outlineRows: rows(outlineBlockSchema.nullable()),
  /** `[target]`: what a `((uuid))` ref or embed points at, a block or a page */
  refTargetRows: rows(refTargetSchema.nullable()),
} as const;

export type EntityRef = z.infer<typeof entityRefSchema>;
export type EditorPage = z.infer<typeof editorPageSchema>;
export type PulledPage = z.infer<typeof pulledPageSchema>;
export type PageLike = z.infer<typeof pageLikeSchema>;
export type WireBlock = z.infer<typeof blockSchema>;
/** A block with text content, as a keyword-search hit always is */
export type SearchHitBlock = WireBlock & { content: string };
export type GraphInfo = z.infer<typeof graphInfoSchema>;
export type RefTarget = z.infer<typeof refTargetSchema>;
export type OutlineRow = z.infer<typeof outlineBlockSchema>;
