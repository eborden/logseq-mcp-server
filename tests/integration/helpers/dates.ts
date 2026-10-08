/** A date as LogSeq's `YYYYMMDD` integer, from the local calendar day: what the server reads as today, in this process's zone. */
export function formatLogseqDate(date: Date): number {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  return parseInt(`${year}${month}${day}`);
}
