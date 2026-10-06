/**
 * Seeds a fresh Chromium profile's localStorage with a few keys, before the app first runs (#118).
 *
 * LogSeq's first window has no graph argument: it restores the last graph from the localStorage
 * key `current-repo` (`frontend.state`, `(storage/get :git/current-repo)`). A fresh profile has
 * none, so it opens the demo graph, and the HTTP API server does not start on the demo graph.
 * Writing that key before the first launch makes the first window open the graph we chose.
 *
 * Chromium keeps localStorage in a LevelDB database under `<profile>/Local Storage/leveldb`. A
 * new database needs only three files, so this writes them directly instead of pulling in a
 * native LevelDB binding:
 *
 * - `CURRENT` names the manifest.
 * - `MANIFEST-000001` holds one version edit: the comparator, the log number, the next file
 *   number and the last sequence number.
 * - `000002.log` holds one write batch with every entry. LevelDB replays it when it opens the
 *   database, then writes the usual table files itself.
 *
 * Only for a profile the caller created and owns: the files replace whatever is in `dir`.
 *
 * Formats: LevelDB's `doc/log_format.md`, `db/version_edit.cc` and `db/write_batch.cc`; the
 * localStorage key layout matches what Chromium writes for LogSeq's `file://` origin (checked by
 * reading a profile Chromium created).
 */

/** The origin LogSeq's renderer runs on (`file://.../electron.html`). */
export const LOGSEQ_ORIGIN = 'file://';

/** LevelDB's default comparator, which Chromium's localStorage database uses. */
const COMPARATOR = 'leveldb.BytewiseComparator';

/** LevelDB log files are split into 32 KiB blocks; a record header is 7 bytes. */
const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7;
const LOG_RECORD_FULL = 1;

/** Microseconds from 1601-01-01 (Chromium's base::Time epoch) to 1970-01-01. */
const CHROMIUM_EPOCH_OFFSET_US = 11644473600000000n;

let crcTable: Uint32Array | undefined;

/** CRC-32C (Castagnoli), the checksum LevelDB uses. */
export function crc32c(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** LevelDB stores masked CRCs (`crc32c::Mask`), so a CRC of data that holds CRCs stays useful. */
export function maskCrc(crc: number): number {
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

/** Unsigned LEB128, LevelDB's varint32/varint64 and protobuf's varint. */
export function varint(value: number | bigint): Buffer {
  let v = BigInt(value);
  if (v < 0n) throw new RangeError(`varint of a negative number: ${v}`);
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

function lengthPrefixed(data: Uint8Array): Buffer {
  return Buffer.concat([varint(data.length), data]);
}

/**
 * One log file holding one record. Records that would cross a block boundary are split by real
 * LevelDB writers; this one throws instead, which is enough for a handful of small keys.
 */
export function logFile(record: Uint8Array): Buffer {
  if (record.length > LOG_BLOCK_SIZE - LOG_HEADER_SIZE) {
    throw new RangeError(`log record of ${record.length} bytes does not fit one block`);
  }
  const header = Buffer.alloc(LOG_HEADER_SIZE);
  const typed = Buffer.concat([Buffer.from([LOG_RECORD_FULL]), record]);
  header.writeUInt32LE(maskCrc(crc32c(typed)), 0);
  header.writeUInt16LE(record.length, 4);
  header.writeUInt8(LOG_RECORD_FULL, 6);
  return Buffer.concat([header, record]);
}

/** A write batch putting every entry, starting at `sequence`. */
export function writeBatch(entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>, sequence = 1n): Buffer {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(sequence, 0);
  head.writeUInt32LE(entries.length, 8);
  const puts = entries.map(([key, value]) =>
    Buffer.concat([Buffer.from([1]) /* kTypeValue */, lengthPrefixed(key), lengthPrefixed(value)]),
  );
  return Buffer.concat([head, ...puts]);
}

/** The version edit a new database starts from (tags from `db/version_edit.cc`). */
export function versionEdit(logNumber: number, nextFileNumber: number, lastSequence: number): Buffer {
  return Buffer.concat([
    varint(1), lengthPrefixed(Buffer.from(COMPARATOR, 'latin1')),
    varint(2), varint(logNumber),
    varint(9), varint(0), // prev log number
    varint(3), varint(nextFileNumber),
    varint(4), varint(lastSequence),
  ]);
}

/** The files of a new LevelDB database holding `entries`, by file name. */
export function levelDbFiles(entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>): Map<string, Buffer> {
  const manifest = 'MANIFEST-000001';
  return new Map([
    ['CURRENT', Buffer.from(`${manifest}\n`, 'latin1')],
    [manifest, logFile(versionEdit(2, 3, 0))],
    ['000002.log', logFile(writeBatch(entries))],
  ]);
}

/**
 * A localStorage string as Chromium stores it: one format byte, then Latin-1 (`1`) when every
 * UTF-16 code unit fits a byte, or UTF-16LE (`0`) otherwise.
 */
export function storageString(value: string): Buffer {
  const latin1 = [...value].every(ch => ch.charCodeAt(0) < 256 && ch.length === 1);
  return latin1
    ? Buffer.concat([Buffer.from([1]), Buffer.from(value, 'latin1')])
    : Buffer.concat([Buffer.from([0]), Buffer.from(value, 'utf16le')]);
}

/** Protobuf message of varint fields, by field number. */
function varintMessage(fields: ReadonlyArray<readonly [number, bigint]>): Buffer {
  return Buffer.concat(fields.flatMap(([field, value]) => [varint(field << 3), varint(value)]));
}

/**
 * LevelDB entries for a localStorage area on `origin` holding `items`, plus the schema version and
 * the area's metadata rows (`META:` last-modified and size, `METAACCESS:` last-accessed) that
 * Chromium keeps next to the data.
 */
export function localStorageEntries(
  items: Readonly<Record<string, string>>,
  now: Date,
  origin = LOGSEQ_ORIGIN,
): Array<[Buffer, Buffer]> {
  const time = BigInt(now.getTime()) * 1000n + CHROMIUM_EPOCH_OFFSET_US;
  const data = Object.entries(items).map(([key, value]): [Buffer, Buffer] => [
    Buffer.concat([Buffer.from(`_${origin}\x00`, 'latin1'), storageString(key)]),
    storageString(value),
  ]);
  // Chromium counts the area's size in UTF-16 bytes; it recomputes it on the next write.
  const sizeBytes = Object.entries(items).reduce((sum, [k, v]) => sum + 2 * (k.length + v.length), 0);
  return [
    [Buffer.from('VERSION'), Buffer.from('1')],
    [Buffer.from(`META:${origin}`, 'latin1'), varintMessage([[1, time], [2, BigInt(sizeBytes)]])],
    [Buffer.from(`METAACCESS:${origin}`, 'latin1'), varintMessage([[1, time]])],
    ...data,
  ];
}

/** LogSeq's id for a folder graph on the native file system (`frontend.config/local-db-prefix`). */
export function logseqGraphId(graphDir: string): string {
  return `logseq_local_${graphDir}`;
}

/**
 * The localStorage items for a profile that opens `graphDir` on its first launch. LogSeq reads
 * every value as EDN (`frontend.storage/get`), and a JSON string is a valid EDN string.
 * `instrument-disabled` turns off LogSeq's usage telemetry for the instance.
 */
export function logseqSeedItems(graphDir: string): Record<string, string> {
  return {
    'current-repo': JSON.stringify(logseqGraphId(graphDir)),
    'http-server-enabled': 'true',
    'instrument-disabled': 'true',
  };
}
