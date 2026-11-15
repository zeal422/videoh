/**
 * bundle-zip.ts: a small store-only ZIP writer and reader for project bundles
 * (0.28.0).
 *
 * Media and fonts are already compressed, so a bundle stores entries without
 * compression. That keeps this module dependency-free and small enough to own:
 * local headers, a central directory, an end-of-central-directory record, and
 * CRC-32.
 *
 * The writer streams each entry: the CRC pass and the write pass read the Blob
 * in chunks, so a large entry never becomes one `ArrayBuffer`. The reader
 * trusts nothing: it rejects encrypted, compressed, and Zip64 entries, checks
 * every bound before slicing, and verifies each entry's CRC before returning
 * its bytes. Path policy (traversal, duplicates, allowed prefixes) lives in
 * `project-bundle.ts`.
 */

/** One entry to store. `data` is written byte-for-byte. */
export interface ZipInputEntry {
  path: string
  data: Blob
}

/** Where a streamed write goes. A File System Access stream fits this shape. */
export interface ZipWriteSink {
  write(chunk: Uint8Array): Promise<void>
}

/** One parsed central-directory entry. */
export interface ZipEntry {
  path: string
  /** General-purpose flags. */
  flags: number
  /** Compression method. Only 0 (store) is accepted by the reader. */
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const UTF8_FLAG = 0x0800
const DATA_DESCRIPTOR_FLAG = 0x0008
const ENCRYPTED_FLAG = 0x0001
/** DOS date 1980-01-01, time 00:00:00: fixed so the archive is deterministic. */
const DOS_DATE = 0x0021
const DOS_TIME = 0
const MAX_UINT32 = 0xffffffff
const MAX_ENTRIES = 0xffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** Continues a CRC-32 from a running value (start with 0, finish with `crc32Final`). */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let value = crc
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC_TABLE[(value ^ (bytes[index] ?? 0)) & 0xff]! ^ (value >>> 8)
  }
  return value >>> 0
}

export function crc32(bytes: Uint8Array): number {
  return (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

function crc32Final(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0
}

async function forEachChunk(
  blob: Blob,
  fn: (chunk: Uint8Array) => Promise<void> | void,
): Promise<void> {
  // `stream()` exists in every browser this app targets and in Node 18+; the
  // fallback keeps a stripped test double working.
  if (typeof blob.stream !== 'function') {
    await fn(new Uint8Array(await blob.arrayBuffer()))
    return
  }
  const reader = blob.stream().getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) await fn(value)
    }
  } finally {
    reader.releaseLock()
  }
}

/** Running CRC and size of a Blob, without materializing it. */
async function checksum(blob: Blob): Promise<{ crc: number; size: number }> {
  let crc = 0xffffffff
  let size = 0
  await forEachChunk(blob, (chunk) => {
    crc = crc32Update(crc, chunk)
    size += chunk.length
  })
  return { crc: crc32Final(crc), size }
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/**
 * Bytes a store-only archive adds around its entry payloads: a local header
 * (30 + name) and a central-directory record (46 + name) per entry, plus the
 * 22-byte end record. The in-memory budget must count these, not just the
 * payload, or an archive just under the limit is built over it.
 */
export function zipStoreOverhead(paths: readonly string[]): number {
  let overhead = 22
  for (const path of paths) overhead += 76 + 2 * textBytes(path).length
  return overhead
}

function u16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function u32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

interface CentralRecord {
  path: Uint8Array
  crc: number
  size: number
  offset: number
}

function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const header = new Uint8Array(30 + name.length)
  u32(header, 0, LOCAL_SIGNATURE)
  u16(header, 4, 20)
  u16(header, 6, UTF8_FLAG)
  u16(header, 8, 0)
  u16(header, 10, DOS_TIME)
  u16(header, 12, DOS_DATE)
  u32(header, 14, crc)
  u32(header, 18, size)
  u32(header, 22, size)
  u16(header, 26, name.length)
  u16(header, 28, 0)
  header.set(name, 30)
  return header
}

function centralHeader(record: CentralRecord): Uint8Array {
  const header = new Uint8Array(46 + record.path.length)
  u32(header, 0, CENTRAL_SIGNATURE)
  u16(header, 4, 20)
  u16(header, 6, 20)
  u16(header, 8, UTF8_FLAG)
  u16(header, 10, 0)
  u16(header, 12, DOS_TIME)
  u16(header, 14, DOS_DATE)
  u32(header, 16, record.crc)
  u32(header, 20, record.size)
  u32(header, 24, record.size)
  u16(header, 28, record.path.length)
  u16(header, 30, 0)
  u16(header, 32, 0)
  u16(header, 34, 0)
  u16(header, 36, 0)
  u32(header, 38, 0)
  u32(header, 42, record.offset)
  header.set(record.path, 46)
  return header
}

function endRecord(count: number, directorySize: number, directoryOffset: number): Uint8Array {
  const record = new Uint8Array(22)
  u32(record, 0, END_SIGNATURE)
  u16(record, 4, 0)
  u16(record, 6, 0)
  u16(record, 8, count)
  u16(record, 10, count)
  u32(record, 12, directorySize)
  u32(record, 16, directoryOffset)
  u16(record, 20, 0)
  return record
}

/**
 * Writes a store-only ZIP into `sink`. Entry paths must be unique. The archive
 * is deterministic (fixed timestamps, input order) so the same bundle inputs
 * produce the same bytes.
 */
export async function writeZip(
  entries: readonly ZipInputEntry[],
  sink: ZipWriteSink,
): Promise<void> {
  if (entries.length > MAX_ENTRIES) throw new ZipError('Too many archive entries')
  const seen = new Set<string>()
  const records: CentralRecord[] = []
  let offset = 0

  const write = async (bytes: Uint8Array): Promise<void> => {
    await sink.write(bytes)
    offset += bytes.length
  }

  for (const entry of entries) {
    if (seen.has(entry.path)) throw new ZipError(`Duplicate archive entry: ${entry.path}`)
    seen.add(entry.path)
    const name = textBytes(entry.path)
    if (name.length > 0xffff) throw new ZipError('Archive entry path is too long')
    // The format has no Zip64 here: fail before reading a huge Blob rather
    // than after the CRC pass.
    if (entry.data.size > MAX_UINT32) throw new ZipError('Archive entry is too large')
    if (offset + 30 + name.length + entry.data.size > MAX_UINT32) {
      throw new ZipError('Archive is too large')
    }
    const { crc, size } = await checksum(entry.data)
    if (size !== entry.data.size) throw new ZipError('Archive entry changed while it was written')
    if (size > MAX_UINT32 || offset > MAX_UINT32) throw new ZipError('Archive is too large')
    const record: CentralRecord = { path: name, crc, size, offset }
    records.push(record)
    await write(localHeader(name, crc, size))
    await forEachChunk(entry.data, write)
  }

  const directoryOffset = offset
  for (const record of records) await write(centralHeader(record))
  const directorySize = offset - directoryOffset
  if (directoryOffset > MAX_UINT32 || directorySize > MAX_UINT32) {
    throw new ZipError('Archive is too large')
  }
  await write(endRecord(records.length, directorySize, directoryOffset))
}

/** Builds a store-only ZIP in memory. Use only for small fixtures and fallbacks. */
export async function zipBlob(entries: readonly ZipInputEntry[]): Promise<Blob> {
  const parts: Uint8Array[] = []
  await writeZip(entries, {
    write: async (chunk) => {
      parts.push(chunk)
    },
  })
  return new Blob(parts as BlobPart[], { type: 'application/zip' })
}

function findEndRecord(view: DataView): number {
  // The comment is at most 65535 bytes, so the record starts within the last
  // 65557 bytes. Scan backwards so a comment containing the signature cannot
  // be mistaken for the record.
  const earliest = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (readU32(view, offset) !== END_SIGNATURE) continue
    const commentLength = readU16(view, offset + 20)
    if (offset + 22 + commentLength === view.byteLength) return offset
  }
  throw new ZipError('Not a ZIP archive, or the archive is truncated')
}

/**
 * Parses an archive's central directory. Rejects encrypted entries, anything
 * not stored, Zip64 sizes, duplicate paths, and any record whose bounds exceed
 * the archive.
 */
export async function readZipDirectory(
  blob: Blob,
  options: { maxEntries?: number } = {},
): Promise<ZipEntry[]> {
  if (blob.size < 22) throw new ZipError('Not a ZIP archive, or the archive is truncated')
  const tailLength = Math.min(blob.size, 22 + 0xffff)
  const tail = new DataView(await blob.slice(blob.size - tailLength).arrayBuffer())
  const end = findEndRecord(tail)
  const disk = readU16(tail, end + 4)
  const directoryDisk = readU16(tail, end + 6)
  const count = readU16(tail, end + 10)
  const directorySize = readU32(tail, end + 12)
  const directoryOffset = readU32(tail, end + 16)
  if (disk !== 0 || directoryDisk !== 0) throw new ZipError('Multi-disk archives are not supported')
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  if (count > maxEntries) throw new ZipError('Too many archive entries')
  // The directory holds at most 46 bytes plus a bounded name/extra/comment per
  // entry; a larger declared size is a memory bomb, not a valid archive.
  if (directorySize > maxEntries * 700 + 1024) {
    throw new ZipError('The archive central directory is too large')
  }
  if (directoryOffset + directorySize > blob.size) {
    throw new ZipError('The archive central directory is truncated')
  }
  if (count === 0) return []
  const directory = new DataView(
    await blob.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer(),
  )
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries: ZipEntry[] = []
  const paths = new Set<string>()
  let cursor = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.byteLength) throw new ZipError('The archive directory is truncated')
    if (readU32(directory, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('The archive directory is malformed')
    }
    const flags = readU16(directory, cursor + 8)
    const method = readU16(directory, cursor + 10)
    const crc = readU32(directory, cursor + 16)
    const compressedSize = readU32(directory, cursor + 20)
    const uncompressedSize = readU32(directory, cursor + 24)
    const nameLength = readU16(directory, cursor + 28)
    const extraLength = readU16(directory, cursor + 30)
    const commentLength = readU16(directory, cursor + 32)
    const localHeaderOffset = readU32(directory, cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > directory.byteLength) throw new ZipError('The archive directory is truncated')
    if (flags & ENCRYPTED_FLAG) throw new ZipError('Encrypted archive entries are not supported')
    if (method !== 0) throw new ZipError('Compressed archive entries are not supported')
    if (compressedSize === MAX_UINT32 || uncompressedSize === MAX_UINT32) {
      throw new ZipError('Zip64 archives are not supported')
    }
    if (compressedSize !== uncompressedSize) {
      throw new ZipError('Stored archive entries must have equal sizes')
    }
    let path: string
    try {
      path = decoder.decode(directory.buffer.slice(cursor + 46, cursor + 46 + nameLength))
    } catch {
      throw new ZipError('The archive contains a path that is not UTF-8')
    }
    if (!path || path.includes('\0')) throw new ZipError('The archive contains an invalid path')
    if (paths.has(path)) throw new ZipError(`Duplicate archive entry: ${path}`)
    paths.add(path)
    if (localHeaderOffset + 30 > blob.size) {
      throw new ZipError('The archive entry is truncated')
    }
    entries.push({
      path,
      flags,
      method,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    })
    cursor = next
  }
  // Never read past a declared entry's bytes: the local header must fit and so
  // must the file name, extra field, and data.
  for (const entry of entries) {
    const header = new DataView(
      await blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer(),
    )
    if (readU32(header, 0) !== LOCAL_SIGNATURE) throw new ZipError('The archive entry is malformed')
    const nameLength = readU16(header, 26)
    const extraLength = readU16(header, 28)
    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
    if (dataStart + entry.compressedSize > blob.size) {
      throw new ZipError('The archive entry is truncated')
    }
    if (entry.flags & DATA_DESCRIPTOR_FLAG) {
      throw new ZipError('Streamed archive entries with data descriptors are not supported')
    }
  }
  return entries
}

/**
 * Reads one entry's bytes and verifies its CRC. Throws on a CRC mismatch so a
 * damaged archive is refused before anything reaches the media store.
 */
export async function readZipEntry(blob: Blob, entry: ZipEntry): Promise<Blob> {
  const header = new DataView(
    await blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer(),
  )
  if (header.byteLength < 30) throw new ZipError('The archive entry is truncated')
  if (readU32(header, 0) !== LOCAL_SIGNATURE) throw new ZipError('The archive entry is malformed')
  const nameLength = readU16(header, 26)
  const extraLength = readU16(header, 28)
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > blob.size) throw new ZipError('The archive entry is truncated')
  // Return the slice itself after verifying it: copying the verified bytes
  // into a new Blob would double the peak memory for a large entry. The CRC
  // pass runs chunk by chunk for the same reason.
  const slice = blob.slice(dataStart, dataEnd)
  let crc = 0xffffffff
  await forEachChunk(slice, (chunk) => {
    crc = crc32Update(crc, chunk)
  })
  if (crc32Final(crc) !== entry.crc32) throw new ZipError(`Archive entry is corrupt: ${entry.path}`)
  return slice
}
