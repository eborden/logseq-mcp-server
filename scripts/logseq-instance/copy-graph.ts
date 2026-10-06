/**
 * The real graph copy behind `InstanceDeps.copyDir` (#151), kept apart from the CLI so
 * `src/logseq-instance-copy.test.ts` can run it on a temporary folder.
 */
import { cp, lstat, rm } from 'fs/promises';
import { relative, sep } from 'path';
import { InstanceError, excludedFromCopy } from './instance.js';

/**
 * Copy the graph folder `from` to `to`, which must not exist yet, leaving out every entry
 * `excludedFromCopy` names (paths relative to `from`).
 *
 * Symbolic links are followed (`dereference`): a linked file or directory arrives as a real
 * file or directory, so nothing in the copy leads back into `from`. A link that points outside
 * `from` pulls that content into the copy, which is fine for the committed fixture (it has no
 * links). When the copy fails (a dangling link, a file that cannot be read), the partial copy is
 * deleted and an InstanceError names the source and the cause. An existing `to` is refused
 * and left as it is.
 */
export async function copyGraphDir(from: string, to: string): Promise<void> {
  if (await exists(to)) throw new InstanceError(`${to} already exists; the graph copy goes into a new folder`);
  try {
    await cp(from, to, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      filter: src => src === from || !excludedFromCopy(relative(from, src).split(sep).join('/')),
    });
  } catch (error) {
    await rm(to, { recursive: true, force: true });
    const why = error instanceof Error ? error.message : String(error);
    throw new InstanceError(`could not copy the graph ${from} to ${to}: ${why}. Fix or remove that entry in ${from}.`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
