import { LogseqClient } from '../client.js';
import { BlockEntity } from '../types.js';

/**
 * Get a LogSeq block by UUID
 * @param client - LogseqClient instance
 * @param blockUuid - UUID of the block to retrieve
 * @param includeChildren - Whether to include child blocks
 * @returns BlockEntity
 * @throws Error if block not found
 */
export async function getBlock(
  client: LogseqClient,
  blockUuid: string,
  includeChildren: boolean
): Promise<BlockEntity> {
  // Build arguments for API call
  const args: any[] = [blockUuid];

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
    throw new Error(`Block not found: ${blockUuid}`);
  }

  return result;
}
