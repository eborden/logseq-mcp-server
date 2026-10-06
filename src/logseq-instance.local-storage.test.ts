import { describe, it, expect } from 'vitest';
import {
  crc32c,
  levelDbFiles,
  localStorageEntries,
  logFile,
  logseqGraphId,
  logseqSeedItems,
  maskCrc,
  storageString,
  varint,
  versionEdit,
  writeBatch,
} from '../scripts/logseq-instance/local-storage.js';

// The LevelDB files scripts/logseq-instance.ts writes to seed a fresh LogSeq profile (#118).
// These pin the byte layout. That real LevelDB (and Chromium) reads them was checked by hand:
// a seeded profile read back with a LevelDB library, then launched LogSeq on the fixture graph.

const bytes = (...values: number[]) => Buffer.from(values);

function unmaskCrc(masked: number): number {
  const rot = (masked - 0xa282ead8) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}

describe('crc32c', () => {
  it('matches the standard check values', () => {
    expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
    expect(crc32c(Buffer.alloc(32))).toBe(0x8a9136aa); // RFC 3720, 32 bytes of zeros
    expect(crc32c(Buffer.alloc(32, 0xff))).toBe(0x62a8ab43);
  });

  it('is masked the way LevelDB masks it', () => {
    const crc = crc32c(Buffer.from('foo'));
    expect(maskCrc(crc)).not.toBe(crc);
    expect(unmaskCrc(maskCrc(crc))).toBe(crc);
  });
});

describe('varint', () => {
  it.each([
    [0, [0x00]],
    [1, [0x01]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [300, [0xac, 0x02]],
  ])('encodes %i', (value, expected) => {
    expect(varint(value)).toEqual(bytes(...expected));
  });

  it('encodes values past 2^53 exactly', () => {
    expect(varint(2n ** 56n)).toEqual(bytes(0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01));
  });

  it('rejects a negative number', () => {
    expect(() => varint(-1)).toThrow(RangeError);
  });
});

describe('logFile', () => {
  it('is one FULL record: masked crc of type + payload, length, type, payload', () => {
    const payload = Buffer.from('hello');
    const file = logFile(payload);

    expect(file.length).toBe(7 + payload.length);
    expect(file.readUInt16LE(4)).toBe(payload.length);
    expect(file.readUInt8(6)).toBe(1);
    expect(file.subarray(7)).toEqual(payload);
    expect(unmaskCrc(file.readUInt32LE(0))).toBe(crc32c(Buffer.concat([bytes(1), payload])));
  });

  it('refuses a record that would not fit one 32 KiB block', () => {
    expect(() => logFile(Buffer.alloc(32768 - 6))).toThrow(RangeError);
    expect(() => logFile(Buffer.alloc(32768 - 7))).not.toThrow();
  });
});

describe('writeBatch', () => {
  it('holds the sequence, the count and one put per entry', () => {
    const batch = writeBatch([[Buffer.from('k'), Buffer.from('vv')]], 7n);

    expect(batch.readBigUInt64LE(0)).toBe(7n);
    expect(batch.readUInt32LE(8)).toBe(1);
    expect(batch.subarray(12)).toEqual(bytes(1, 1, 0x6b, 2, 0x76, 0x76));
  });
});

describe('versionEdit', () => {
  it('names the bytewise comparator and the log, next-file and sequence numbers', () => {
    const name = Buffer.from('leveldb.BytewiseComparator');
    expect(versionEdit(2, 3, 0)).toEqual(
      Buffer.concat([bytes(1, name.length), name, bytes(2, 2, 9, 0, 3, 3, 4, 0)]),
    );
  });
});

describe('levelDbFiles', () => {
  it('writes CURRENT, the manifest it names and the log the manifest points at', () => {
    const files = levelDbFiles([[Buffer.from('a'), Buffer.from('b')]]);

    expect([...files.keys()]).toEqual(['CURRENT', 'MANIFEST-000001', '000002.log']);
    expect(files.get('CURRENT')!.toString()).toBe('MANIFEST-000001\n');
    expect(files.get('MANIFEST-000001')).toEqual(logFile(versionEdit(2, 3, 0)));
    expect(files.get('000002.log')).toEqual(logFile(writeBatch([[Buffer.from('a'), Buffer.from('b')]])));
  });
});

describe('storageString', () => {
  it('stores Latin-1 text with format byte 1', () => {
    expect(storageString('ab')).toEqual(bytes(1, 0x61, 0x62));
    expect(storageString('café')).toEqual(bytes(1, 0x63, 0x61, 0x66, 0xe9));
  });

  it('stores anything wider as UTF-16LE with format byte 0', () => {
    expect(storageString('a→')).toEqual(bytes(0, 0x61, 0x00, 0x92, 0x21));
  });
});

describe('localStorageEntries', () => {
  const now = new Date('2025-01-01T00:00:00.000Z');
  const entries = localStorageEntries({ 'current-repo': '"x"' }, now);
  const byKey = new Map(entries.map(([k, v]) => [k.toString('latin1'), v]));

  it('writes the schema version, the area metadata and each item under the file:// origin', () => {
    expect([...byKey.keys()]).toEqual(['VERSION', 'META:file://', 'METAACCESS:file://', '_file://\x00\x01current-repo']);
    expect(byKey.get('VERSION')!.toString()).toBe('1');
    expect(byKey.get('_file://\x00\x01current-repo')).toEqual(bytes(1, 0x22, 0x78, 0x22));
  });

  it('stamps the metadata with Chromium time (microseconds since 1601) and the area size', () => {
    const micros = BigInt(now.getTime()) * 1000n + 11644473600000000n;
    const size = 2 * ('current-repo'.length + '"x"'.length);
    expect(byKey.get('META:file://')).toEqual(Buffer.concat([bytes(0x08), varint(micros), bytes(0x10), varint(size)]));
    expect(byKey.get('METAACCESS:file://')).toEqual(Buffer.concat([bytes(0x08), varint(micros)]));
  });
});

describe('logseqSeedItems', () => {
  it('opens the graph, enables the HTTP API server and turns telemetry off, as EDN values', () => {
    expect(logseqSeedItems('/work/tree/tests/fixtures/graph')).toEqual({
      'current-repo': '"logseq_local_/work/tree/tests/fixtures/graph"',
      'http-server-enabled': 'true',
      'instrument-disabled': 'true',
    });
  });

  it('escapes a path that needs it in the EDN string', () => {
    expect(logseqSeedItems('/a "b"')['current-repo']).toBe('"logseq_local_/a \\"b\\""');
    expect(logseqGraphId('/g')).toBe('logseq_local_/g');
  });
});
