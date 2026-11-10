'use strict';

const { createHash } = require('node:crypto');
const {
  brotliCompressSync,
  brotliDecompressSync,
  constants: zlibConstants,
} = require('node:zlib');

/*
 * Synchronous, deterministic binary delta codec using only Node builtins.
 *
 * Public API:
 *   createDelta(baseBuffer: Buffer, targetBuffer: Buffer): Buffer
 *   applyDelta(baseBuffer: Buffer, patchBuffer: Buffer, expectedSize: number): Buffer
 *
 * All input buffers and reconstructed targets are limited to 256 MiB. expectedSize
 * is mandatory and must be an integer in [0, 256 MiB] supplied by the caller's
 * trusted metadata. applyDelta returns a new Buffer and never changes its inputs.
 * Invalid types, malformed patches, or exceeded limits throw synchronously.
 * This format provides no authentication: authenticate the patch and verify the
 * reconstructed target's digest against trusted metadata outside this module.
 *
 * Version 1 wire format (all integers unsigned, 32-bit little-endian):
 *   0..7   ASCII "QMXDELTA"
 *   8      version = 1
 *   12     uncompressed target byte length
 *   16     uncompressed instruction byte length (at most 512 MiB)
 *   20     compressed instruction byte length
 *   24     instruction count (at most 1,000,000)
 *   28     reserved = 0
 *   32..   exactly one Brotli stream containing the instructions below
 *
 *   COPY    0x00, base offset u32, byte length u32
 *   LITERAL 0x01, byte length u32, that many literal bytes
 *
 * Lengths must be positive. No terminator, trailing bytes, additional Brotli
 * streams, unknown opcodes, or truncated records are allowed. Instructions must
 * produce exactly the header target size and the caller's expectedSize.
 *
 * Chunking uses a fixed 32-bit gear table, minimum 2 KiB, nominal average 8 KiB,
 * and maximum 32 KiB. Base chunks are indexed by SHA-256; target chunks with the
 * same digest and length reference the first matching base chunk. Contiguous
 * literals and copies are coalesced. Brotli quality 4 keeps generation fast.
 */

const MAX_BUFFER_SIZE = 256 * 1024 * 1024;
const MAX_INSTRUCTION_SIZE = 512 * 1024 * 1024;
const MAX_OPS = 1_000_000;
const HEADER_SIZE = 32;
const MAGIC = Buffer.from('QMXDELTA', 'ascii');
const MIN_CHUNK = 2 * 1024;
const MAX_CHUNK = 32 * 1024;
const CHUNK_MASK = 8 * 1024 - 1;

const GEAR = new Uint32Array(256);
let gearSeed = 0x9e3779b9;
for (let i = 0; i < GEAR.length; i += 1) {
  gearSeed ^= gearSeed << 13;
  gearSeed ^= gearSeed >>> 17;
  gearSeed ^= gearSeed << 5;
  GEAR[i] = gearSeed >>> 0;
}

function requireBuffer(value, name) {
  if (!Buffer.isBuffer(value)) throw new TypeError(`${name} must be a Buffer`);
  if (value.length > MAX_BUFFER_SIZE) {
    throw new RangeError(`${name} exceeds the 256 MiB limit`);
  }
}

function invalid(reason) {
  throw new Error(`Invalid delta patch: ${reason}`);
}

// The minimum-size prefix cannot contain a boundary. A 32-bit gear hash forgets
// that prefix after 32 bytes, so skipping its scan preserves resynchronization.
function chunkEnd(buffer, start) {
  const limit = Math.min(start + MAX_CHUNK, buffer.length);
  let cursor = Math.min(start + MIN_CHUNK, limit);
  let hash = 0;
  while (cursor < limit) {
    hash = ((hash << 1) + GEAR[buffer[cursor]]) >>> 0;
    cursor += 1;
    if ((hash & CHUNK_MASK) === 0) break;
  }
  return cursor;
}

function chunkKey(buffer, start, end) {
  return createHash('sha256').update(buffer.subarray(start, end)).digest('hex');
}

/** Create a deterministic delta; buffers are read synchronously and not mutated. */
function createDelta(baseBuffer, targetBuffer) {
  requireBuffer(baseBuffer, 'baseBuffer');
  requireBuffer(targetBuffer, 'targetBuffer');

  const chunks = new Map();
  for (let start = 0; start < baseBuffer.length;) {
    const end = chunkEnd(baseBuffer, start);
    const key = chunkKey(baseBuffer, start, end);
    if (!chunks.has(key)) chunks.set(key, { offset: start, length: end - start });
    start = end;
  }

  const operations = [];
  let instructionSize = 0;
  for (let start = 0; start < targetBuffer.length;) {
    const end = chunkEnd(targetBuffer, start);
    const length = end - start;
    const match = chunks.get(chunkKey(targetBuffer, start, end));
    const copy = match !== undefined && match.length === length;
    const offset = copy ? match.offset : start;
    const previous = operations[operations.length - 1];
    if (previous && previous.copy === copy && previous.offset + previous.length === offset) {
      previous.length += length;
      if (!copy) instructionSize += length;
    } else {
      operations.push({ copy, offset, length });
      instructionSize += copy ? 9 : 5 + length;
    }
    start = end;
  }
  if (operations.length > MAX_OPS || instructionSize > MAX_INSTRUCTION_SIZE) {
    throw new RangeError('Generated delta exceeds instruction limits');
  }

  const instructions = Buffer.allocUnsafe(instructionSize);
  let cursor = 0;
  for (const op of operations) {
    instructions[cursor++] = op.copy ? 0 : 1;
    if (op.copy) {
      instructions.writeUInt32LE(op.offset, cursor);
      cursor += 4;
    }
    instructions.writeUInt32LE(op.length, cursor);
    cursor += 4;
    if (!op.copy) {
      targetBuffer.copy(instructions, cursor, op.offset, op.offset + op.length);
      cursor += op.length;
    }
  }

  const compressed = brotliCompressSync(instructions, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      [zlibConstants.BROTLI_PARAM_LGWIN]: 22,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: instructionSize,
    },
  });
  if (HEADER_SIZE + compressed.length > MAX_BUFFER_SIZE) {
    throw new RangeError('Generated patch exceeds the 256 MiB limit');
  }
  const patch = Buffer.allocUnsafe(HEADER_SIZE + compressed.length);
  MAGIC.copy(patch);
  patch.writeUInt32LE(1, 8);
  patch.writeUInt32LE(targetBuffer.length, 12);
  patch.writeUInt32LE(instructionSize, 16);
  patch.writeUInt32LE(compressed.length, 20);
  patch.writeUInt32LE(operations.length, 24);
  patch.writeUInt32LE(0, 28);
  compressed.copy(patch, HEADER_SIZE);
  return patch;
}

/** Apply a patch using the exact target size from the caller's trusted metadata. */
function applyDelta(baseBuffer, patchBuffer, expectedSize) {
  requireBuffer(baseBuffer, 'baseBuffer');
  requireBuffer(patchBuffer, 'patchBuffer');
  if (!Number.isInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_BUFFER_SIZE) {
    throw new RangeError('expectedSize must be an integer from 0 to 256 MiB');
  }
  if (patchBuffer.length < HEADER_SIZE) invalid('truncated header');
  if (!patchBuffer.subarray(0, 8).equals(MAGIC)) invalid('bad magic');
  if (patchBuffer.readUInt32LE(8) !== 1) invalid('unsupported version');
  if (patchBuffer.readUInt32LE(28) !== 0) invalid('reserved field is nonzero');

  const targetSize = patchBuffer.readUInt32LE(12);
  const instructionSize = patchBuffer.readUInt32LE(16);
  const compressedSize = patchBuffer.readUInt32LE(20);
  const opCount = patchBuffer.readUInt32LE(24);
  if (targetSize !== expectedSize) invalid('target size differs from expectedSize');
  if (instructionSize > MAX_INSTRUCTION_SIZE) invalid('instruction size exceeds 512 MiB');
  if (opCount > MAX_OPS) invalid('instruction count exceeds 1,000,000');
  if (compressedSize === 0 || compressedSize !== patchBuffer.length - HEADER_SIZE) {
    invalid('compressed size mismatch or trailing bytes');
  }
  // Every operation writes at least one byte and has at least five encoded bytes.
  // Literal bytes plus nine bytes per operation also give a tight output bound.
  if (opCount > targetSize || instructionSize < opCount * 5 ||
      instructionSize > targetSize + opCount * 9 ||
      (opCount === 0 && (instructionSize !== 0 || targetSize !== 0))) {
    invalid('impossible instruction sizes');
  }

  let instructions;
  try {
    const decoded = brotliDecompressSync(patchBuffer.subarray(HEADER_SIZE), {
      // zlib requires a positive limit, even for an empty instruction stream.
      maxOutputLength: Math.max(1, instructionSize),
      info: true,
    });
    if (decoded.engine.bytesWritten !== compressedSize) invalid('trailing compressed bytes');
    instructions = decoded.buffer;
  } catch (error) {
    invalid(`Brotli decoding failed (${error.message})`);
  }
  if (instructions.length !== instructionSize) invalid('uncompressed instruction size mismatch');

  // Validate the complete program before allocating the target buffer. A second
  // linear pass copies data without storing an attacker-controlled operation list.
  let cursor = 0;
  let written = 0;
  for (let i = 0; i < opCount; i += 1) {
    if (cursor >= instructions.length) invalid('truncated instruction');
    const opcode = instructions[cursor++];
    let length;
    if (opcode === 0) {
      if (instructions.length - cursor < 8) invalid('truncated copy');
      const offset = instructions.readUInt32LE(cursor);
      length = instructions.readUInt32LE(cursor + 4);
      cursor += 8;
      if (offset > baseBuffer.length || length > baseBuffer.length - offset) {
        invalid('copy outside base buffer');
      }
    } else if (opcode === 1) {
      if (instructions.length - cursor < 4) invalid('truncated literal length');
      length = instructions.readUInt32LE(cursor);
      cursor += 4;
      if (length > instructions.length - cursor) invalid('truncated literal data');
      cursor += length;
    } else {
      invalid('unknown opcode');
    }
    if (length === 0) invalid('zero-length operation');
    if (length > targetSize - written) invalid('operation exceeds target size');
    written += length;
  }
  if (cursor !== instructions.length) invalid('trailing instructions or incorrect operation count');
  if (written !== targetSize) invalid('instructions do not produce the exact target size');

  const target = Buffer.allocUnsafe(targetSize);
  cursor = 0;
  written = 0;
  for (let i = 0; i < opCount; i += 1) {
    const opcode = instructions[cursor++];
    if (opcode === 0) {
      const offset = instructions.readUInt32LE(cursor);
      const length = instructions.readUInt32LE(cursor + 4);
      cursor += 8;
      baseBuffer.copy(target, written, offset, offset + length);
      written += length;
    } else {
      const length = instructions.readUInt32LE(cursor);
      cursor += 4;
      instructions.copy(target, written, cursor, cursor + length);
      cursor += length;
      written += length;
    }
  }
  return target;
}

module.exports = { createDelta, applyDelta };
