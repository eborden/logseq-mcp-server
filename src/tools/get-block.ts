import { LogseqClient } from '../client.js';
import { BlockEntity, ResolveRefsMeta } from '../types.js';
import { resolveBlockRefs } from '../utils/resolve-refs.js';
import { buildResultMeta } from '../utils/result-meta.js';
import { BlockNotFoundError } from '../errors.js';

/**
 * Get a LogSeq block by UUID
 * @param client - LogseqClient instance
 * @param blockUuid - UUID of the block to retrieve
 * @param includeChildren - Whether to include child blocks
 * @param options.resolveRefs - Resolve `((uuid))` refs and `{{embed}}`s in the block and
 *   its children: adds `resolvedContent` / `resolvedRefs` to blocks that hold one, plus
 *   `hasMore` / `warnings` on the result. Costs at most 2 extra Datalog queries; off by
 *   default, and then nothing changes.
 * @returns BlockEntity
 * @throws BlockNotFoundError if block not found
 */
export async function getBlock(
  client: LogseqClient,
  blockUuid: string,
  includeChildren: boolean,
  options: { resolveRefs?: boolean } = {}
): Promise<BlockEntity & ResolveRefsMeta> {
  // Build arguments for API call
  const args: unknown[] = [blockUuid];

  // Add options if includeChildren is true
  if (includeChildren) {
    args.push({ includeChildren: true });
  }

  // Call the LogSeq API
  const result = await client.callAPI<BlockEntity | null>(
    'logseq.Editor.getBlock',
    args
  );

  // Check if block was found
  if (result === null) {
    throw new BlockNotFoundError(blockUuid);
  }

  if (options.resolveRefs) {
    const { blocks, warnings } = await resolveBlockRefs(client, [result]);
    return { ...blocks[0], ...buildResultMeta(warnings) };
  }

  return result;
}
