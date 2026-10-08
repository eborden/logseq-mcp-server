// The shapes of LogSeq's answers that the larger made-up cases of scripts/measure-latency.ts build on. Every page,
// block and name is made up (BR-0001).

export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export interface PageSpec {
  id: number;
  name: string;
  originalName: string;
  /** Backed by a file: not a stub */
  file?: boolean;
  journalDay?: number;
}

/** A page as the resolver's `pull [*]` answers it: kebab-case keys. */
export const pulledPage = ({ id, name, originalName, file, journalDay }: PageSpec) => ({
  id,
  uuid: uuid(id),
  name,
  'original-name': originalName,
  ...(file ? { file: { id: id + 5000 } } : {}),
  ...(journalDay ? { 'journal?': true, 'journal-day': journalDay } : { 'journal?': false })
});

export const ATLAS: PageSpec = { id: 10, name: 'project atlas', originalName: 'Project Atlas', file: true };
