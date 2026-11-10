'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { brotliCompressSync, brotliDecompressSync, constants } = require('node:zlib');
const { createDelta, applyDelta } = require('../electron/delta-codec.cjs');

const MiB = 1024 * 1024;

// Fixed pseudo-random fixtures make compression assertions reproducible.
function noise(size, seed = 0x12345678) {
  const buffer = Buffer.allocUnsafe(size);
  let state = seed;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    buffer[i] = state >>> 24;
  }
  return buffer;
}

function makePatch(instructions, targetSize, opCount, fields = {}) {
  const compressed = brotliCompressSync(instructions, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 1 },
  });
  const header = Buffer.alloc(32);
  header.write('QMXDELTA', 0, 'ascii');
  header.writeUInt32LE(fields.version ?? 1, 8);
  header.writeUInt32LE(targetSize, 12);
  header.writeUInt32LE(fields.instructionSize ?? instructions.length, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(opCount, 24);
  return Buffer.concat([header, compressed]);
}

function copy(offset, length) {
  const op = Buffer.alloc(9);
  op.writeUInt32LE(offset, 1);
  op.writeUInt32LE(length, 5);
  return op;
}

function literal(bytes) {
  const op = Buffer.alloc(5 + bytes.length);
  op[0] = 1;
  op.writeUInt32LE(bytes.length, 1);
  bytes.copy(op, 5);
  return op;
}

function inspectOps(patch) {
  const instructions = brotliDecompressSync(patch.subarray(32));
  const operations = [];
  let cursor = 0;
  while (cursor < instructions.length) {
    const opcode = instructions[cursor++];
    if (opcode === 0) {
      operations.push({ offset: instructions.readUInt32LE(cursor), length: instructions.readUInt32LE(cursor + 4) });
      cursor += 8;
    } else {
      assert.equal(opcode, 1);
      const length = instructions.readUInt32LE(cursor);
      operations.push({ literal: true, length });
      cursor += 4 + length;
    }
  }
  assert.equal(operations.length, patch.readUInt32LE(24));
  return operations;
}

test('empty, short, unrelated, and repetitive inputs roundtrip without mutation', () => {
  const cases = [
    [Buffer.alloc(0), Buffer.alloc(0)],
    [Buffer.alloc(0), Buffer.from('new content')],
    [Buffer.from('old content'), Buffer.alloc(0)],
    [Buffer.from('abc'), Buffer.from('abc')],
    [Buffer.from('abc'), Buffer.from('xyz')],
    [noise(128 * 1024), noise(160 * 1024, 83)],
    [Buffer.alloc(200 * 1024, 65), Buffer.alloc(210 * 1024, 65)],
  ];
  for (const [base, target] of cases) {
    const baseBefore = Buffer.from(base);
    const targetBefore = Buffer.from(target);
    const patch = createDelta(base, target);
    const patchBefore = Buffer.from(patch);
    const result = applyDelta(base, patch, target.length);
    assert.deepEqual(result, target);
    assert.deepEqual(base, baseBefore);
    assert.deepEqual(target, targetBefore);
    assert.deepEqual(patch, patchBefore);
    assert.deepEqual(createDelta(base, target), patch, 'generation is deterministic');
    if (result.length && base.length) {
      result[0] ^= 255;
      assert.deepEqual(base, baseBefore, 'output does not alias the base');
    }
  }
});

test('small changes reuse SHA-256 matched chunks with a compact patch', () => {
  const base = noise(4 * MiB);
  const target = Buffer.from(base);
  target.fill(0x42, 900_000, 900_127);
  target[2_800_000] ^= 255;
  const patch = createDelta(base, target);
  assert.deepEqual(applyDelta(base, patch, target.length), target);
  assert.ok(patch.length < 100 * 1024, `patch size ${patch.length}`);
  const reused = inspectOps(patch).filter((op) => !op.literal).reduce((sum, op) => sum + op.length, 0);
  assert.ok(reused > base.length * 0.97, `reused ${reused} bytes`);
});

test('inserted and removed headers resynchronize content-defined chunks', () => {
  const base = noise(3 * MiB, 19);
  for (const target of [Buffer.concat([noise(1337, 91), base]), base.subarray(1739)]) {
    const patch = createDelta(base, target);
    assert.deepEqual(applyDelta(base, patch, target.length), target);
    assert.ok(patch.length < 80 * 1024, `shifted patch size ${patch.length}`);
    assert.ok(inspectOps(patch).some((op) => !op.literal && op.length > MiB));
  }
});

test('reordered regions use copies with nonmonotonic base offsets', () => {
  const base = noise(4 * MiB, 77);
  const target = Buffer.concat([
    base.subarray(2 * MiB, 3 * MiB), base.subarray(0, MiB),
    base.subarray(3 * MiB), base.subarray(MiB, 2 * MiB),
  ]);
  const patch = createDelta(base, target);
  assert.deepEqual(applyDelta(base, patch, target.length), target);
  assert.ok(patch.length < 160 * 1024, `reordered patch size ${patch.length}`);
  const copies = inspectOps(patch).filter((op) => !op.literal);
  assert.ok(copies.some((op, i) => i > 0 && op.offset < copies[i - 1].offset));
});

test('accepts the documented wire format with mixed literal and copy records', () => {
  const base = Buffer.from('abcdef');
  const instructions = Buffer.concat([copy(3, 3), literal(Buffer.from('!')), copy(0, 3)]);
  assert.equal(applyDelta(base, makePatch(instructions, 7, 3), 7).toString(), 'def!abc');
});

test('rejects invalid input types and untrusted expected sizes', () => {
  const empty = Buffer.alloc(0);
  const patch = createDelta(empty, empty);
  for (const value of [null, undefined, 'bytes', new Uint8Array(0), {}]) {
    assert.throws(() => createDelta(value, empty), /baseBuffer must be a Buffer/);
    assert.throws(() => createDelta(empty, value), /targetBuffer must be a Buffer/);
    assert.throws(() => applyDelta(value, patch, 0), /baseBuffer must be a Buffer/);
    assert.throws(() => applyDelta(empty, value, 0), /patchBuffer must be a Buffer/);
  }
  for (const size of [undefined, null, '0', -1, 0.5, NaN, Infinity, 256 * MiB + 1]) {
    assert.throws(() => applyDelta(empty, patch, size), /expectedSize/);
  }
});

test('enforces the 256 MiB limit for base, target, and patch buffers', () => {
  // One shared, uninitialized allocation exercises all limits without three huge
  // fixtures or touching hundreds of MiB of physical memory.
  const huge = Buffer.allocUnsafe(256 * MiB + 1);
  const empty = Buffer.alloc(0);
  assert.throws(() => createDelta(huge, empty), /baseBuffer exceeds/);
  assert.throws(() => createDelta(empty, huge), /targetBuffer exceeds/);
  assert.throws(() => applyDelta(huge, empty, 0), /baseBuffer exceeds/);
  assert.throws(() => applyDelta(empty, huge, 0), /patchBuffer exceeds/);
});

test('rejects bad headers, impossible sizes, oversized metadata, and target mismatches', () => {
  const base = Buffer.from('abc');
  const valid = makePatch(copy(0, 3), 3, 1);
  const mutations = [
    [0, 0, /magic/], [8, 2, /version/], [28, 1, /reserved/],
    [12, 4, /expectedSize/], [12, 0xffffffff, /expectedSize/],
    [16, 512 * MiB + 1, /512 MiB/], [24, 1_000_001, /1,000,000/],
    [24, 0xffffffff, /1,000,000/], [20, 0, /compressed size/],
    [20, 0xffffffff, /compressed size/], [16, 0xffffffff, /512 MiB/],
    [16, 0, /impossible/], [24, 0, /impossible/],
  ];
  for (const [offset, value, pattern] of mutations) {
    const patch = Buffer.from(valid);
    patch.writeUInt32LE(value, offset);
    assert.throws(() => applyDelta(base, patch, 3), pattern);
  }
  assert.throws(() => applyDelta(base, valid.subarray(0, 31), 3), /truncated header/);
  assert.throws(() => applyDelta(base, makePatch(Buffer.alloc(0), 1, 0), 1), /impossible/);
  assert.throws(() => applyDelta(base, makePatch(copy(0, 1), 1, 2), 1), /impossible/);
});

test('rejects every truncated patch prefix and both outer and inner trailing junk', () => {
  const base = Buffer.from('abc');
  const valid = makePatch(copy(0, 3), 3, 1);
  for (let size = 0; size < valid.length; size += 1) {
    assert.throws(() => applyDelta(base, valid.subarray(0, size), 3), /Invalid delta patch/);
  }
  assert.throws(() => applyDelta(base, Buffer.concat([valid, Buffer.from([0])]), 3), /compressed size/);
  for (const extra of [Buffer.from([0]), valid.subarray(32)]) {
    const patch = Buffer.concat([valid, extra]);
    patch.writeUInt32LE(patch.length - 32, 20);
    assert.throws(() => applyDelta(base, patch, 3), /trailing compressed bytes/);
  }
  const truncated = Buffer.from(valid.subarray(0, valid.length - 1));
  truncated.writeUInt32LE(truncated.length - 32, 20);
  assert.throws(() => applyDelta(base, truncated, 3), /Brotli decoding failed/);
  const corrupt = Buffer.from(valid);
  corrupt.fill(255, 32);
  assert.throws(() => applyDelta(base, corrupt, 3), /Brotli decoding failed/);
});

test('rejects malicious copy ranges, lengths, opcodes, and inconsistent programs', () => {
  const base = Buffer.from('abc');
  const cases = [
    [copy(3, 1), 1, 1, /copy outside/],
    [copy(0xffffffff, 1), 1, 1, /copy outside/],
    [copy(1, 0xffffffff), 1, 1, /copy outside/],
    [copy(0, 0), 1, 1, /zero-length/],
    [copy(0, 3), 2, 1, /exceeds target/],
    [copy(0, 2), 3, 1, /exact target/],
    [Buffer.from([9, 0, 0, 0, 0]), 1, 1, /unknown opcode/],
    [Buffer.from([0, 0, 0, 0, 0]), 1, 1, /truncated copy/],
    [Buffer.from([1, 2, 0, 0, 0]), 2, 1, /truncated literal data/],
    [Buffer.from([1, 255, 255, 255, 255]), 1, 1, /truncated literal data/],
    [literal(Buffer.alloc(0)), 1, 1, /zero-length/],
    [literal(Buffer.from('abc')), 2, 1, /exceeds target/],
    [Buffer.concat([copy(0, 1), literal(Buffer.from('a'))]), 3, 3, /truncated instruction/],
    [Buffer.concat([copy(0, 1), Buffer.from([1])]), 1, 1, /trailing instructions/],
    [Buffer.concat([copy(0, 1), Buffer.from([1])]), 2, 2, /truncated literal length/],
    [Buffer.concat([copy(0, 1), Buffer.from([0])]), 2, 2, /truncated copy/],
    [copy(0, 3), 3, 1, /uncompressed instruction size mismatch/, { instructionSize: 10 }],
  ];
  for (const [program, size, count, pattern, fields] of cases) {
    assert.throws(() => applyDelta(base, makePatch(program, size, count, fields), size), pattern);
  }
});

test('deterministic varied edits roundtrip across short and chunk-sized inputs', () => {
  for (let i = 0; i < 48; i += 1) {
    const base = noise(i < 16 ? i * 337 : i * 4093, i + 1);
    const split = Math.floor(base.length / 3);
    const target = Buffer.concat([
      base.subarray(split), noise(i * 23, 100 + i), base.subarray(0, split),
    ]);
    assert.deepEqual(applyDelta(base, createDelta(base, target), target.length), target);
  }
});

test('bounds Brotli output to declared instruction size to stop compressed output bombs', () => {
  // A highly compressible 16 MiB stream advertises only nine decoded bytes.
  // maxOutputLength must reject it before materializing the entire stream.
  const patch = makePatch(Buffer.alloc(16 * MiB), 1, 1, { instructionSize: 9 });
  assert.ok(patch.length < 4096);
  assert.throws(() => applyDelta(Buffer.from('a'), patch, 1), /Brotli decoding failed/);
  const emptyPatch = makePatch(Buffer.from([0, 0]), 0, 0, { instructionSize: 0 });
  assert.throws(() => applyDelta(Buffer.alloc(0), emptyPatch, 0), /Brotli decoding failed/);
});

test('representative 30 MiB edits generate quickly and preserve chunk reuse', () => {
  const { performance } = require('node:perf_hooks');
  const base = noise(30 * MiB, 101);
  const target = Buffer.concat([Buffer.from('new application header\n'), base]);
  target.fill(0x7f, 17 * MiB, 17 * MiB + 511);
  const started = performance.now();
  const patch = createDelta(base, target);
  const elapsed = performance.now() - started;
  assert.deepEqual(applyDelta(base, patch, target.length), target);
  assert.ok(patch.length < 160 * 1024, `patch size ${patch.length}`);
  // Leave headroom for loaded CI machines; report actual timing for the <5s goal.
  assert.ok(elapsed < 15_000, `30 MiB generation took ${elapsed.toFixed(1)} ms`);
  console.log(`delta-codec 30 MiB: create ${elapsed.toFixed(1)} ms, patch ${patch.length} bytes`);
});
