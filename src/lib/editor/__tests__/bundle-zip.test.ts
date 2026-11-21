import { describe, expect, it } from 'vitest'

import {
  ZipError,
  crc32,
  readZipDirectory,
  readZipEntry,
  writeZip,
  zipBlob,
  type ZipEntry,
  type ZipWriteSink,
} from '../bundle-zip'

/** Collects a written archive into one buffer. */
function collector() {
  const parts: Uint8Array[] = []
  const sink: ZipWriteSink = {
    write: async (chunk) => {
      parts.push(chunk)
    },
  }
  return {
    sink,
    parts,
    bytes: () => {
      const total = parts.reduce((sum, part) => sum + part.length, 0)
      const out = new Uint8Array(total)
      let offset = 0
      for (const part of parts) {
        out.set(part, offset)
        offset += part.length
      }
      return out
    },
  }
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

describe('bundle zip (0.28.0)', () => {
  it('round-trips stored entries with their bytes', async () => {
    const archive = await zipBlob([
      { path: 'manifest.json', data: new Blob(['{"bundleVersion":1}']) },
      { path: 'media/media_a/clip.mp4', data: new Blob([new Uint8Array([1, 2, 3, 4])]) },
      { path: 'fonts/font_a/text.woff2', data: new Blob(['font bytes']) },
    ])
    const entries = await readZipDirectory(archive)
    expect(entries.map((entry) => entry.path)).toEqual([
      'manifest.json',
      'media/media_a/clip.mp4',
      'fonts/font_a/text.woff2',
    ])
    const media = await readZipEntry(archive, entries[1]!)
    expect([...(await bytesOf(media))]).toEqual([1, 2, 3, 4])
    const font = await readZipEntry(archive, entries[2]!)
    expect(await font.text()).toBe('font bytes')
  })

  it('writes the same bytes for the same inputs', async () => {
    const entries = [{ path: 'a.txt', data: new Blob(['same']) }]
    const first = await bytesOf(await zipBlob(entries))
    const second = await bytesOf(await zipBlob(entries))
    expect([...first]).toEqual([...second])
  })

  it('streams a large entry to the sink in chunks instead of one buffer', async () => {
    const chunkStream = () => {
      let remaining = 3
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (remaining === 0) {
            controller.close()
            return
          }
          remaining -= 1
          controller.enqueue(new Uint8Array(1024).fill(remaining + 1))
        },
      })
    }
    const fakeBlob = { size: 3072, stream: chunkStream } as unknown as Blob
    const output = collector()
    await writeZip([{ path: 'big.bin', data: fakeBlob }], output.sink)
    // Writes: local header, three data chunks, central header, end record.
    expect(output.parts.length).toBeGreaterThanOrEqual(6)
    const archive = new Blob([output.bytes() as BlobPart])
    const entries = await readZipDirectory(archive)
    const entry = await readZipEntry(archive, entries[0]!)
    expect(entry.size).toBe(3072)
    const bytes = await bytesOf(entry)
    expect(bytes[0]).toBe(3)
    expect(bytes[3071]).toBe(1)
  })

  it('rejects a compressed entry', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['hello']) }])
    const bytes = await bytesOf(archive)
    const view = new DataView(bytes.buffer)
    // Central directory method field: find the signature, +10 is the method.
    let central = -1
    for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        central = offset
        break
      }
    }
    expect(central).toBeGreaterThanOrEqual(0)
    view.setUint16(central + 10, 8, true)
    await expect(readZipDirectory(new Blob([bytes as BlobPart]))).rejects.toThrow(
      'Compressed archive entries are not supported',
    )
  })

  it('rejects an encrypted entry', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['hello']) }])
    const bytes = await bytesOf(archive)
    const view = new DataView(bytes.buffer)
    let central = -1
    for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        central = offset
        break
      }
    }
    view.setUint16(central + 8, 1, true)
    await expect(readZipDirectory(new Blob([bytes as BlobPart]))).rejects.toThrow(
      'Encrypted archive entries are not supported',
    )
  })

  it('rejects a Zip64 size marker', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['hello']) }])
    const bytes = await bytesOf(archive)
    const view = new DataView(bytes.buffer)
    let central = -1
    for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        central = offset
        break
      }
    }
    view.setUint32(central + 20, 0xffffffff, true)
    await expect(readZipDirectory(new Blob([bytes as BlobPart]))).rejects.toThrow('Zip64')
  })

  it('rejects a central directory whose declared size is a memory bomb', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['hello']) }])
    const bytes = await bytesOf(archive)
    const view = new DataView(bytes.buffer)
    for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        view.setUint32(offset + 12, 0x10000000, true)
        break
      }
    }
    await expect(readZipDirectory(new Blob([bytes as BlobPart]))).rejects.toThrow(
      'central directory is too large',
    )
  })

  it('rejects a truncated archive', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['hello']) }])
    const bytes = await bytesOf(archive)
    await expect(readZipDirectory(new Blob([bytes.slice(0, 10) as BlobPart]))).rejects.toThrow(
      'Not a ZIP archive',
    )
  })

  it('rejects an entry whose bytes were corrupted', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['hello']) }])
    const bytes = await bytesOf(archive)
    // The local header is 30 bytes + the 5-byte name; flip a data byte.
    bytes[36] = bytes[36]! ^ 0xff
    const broken = new Blob([bytes as BlobPart])
    const entries = await readZipDirectory(broken)
    await expect(readZipEntry(broken, entries[0]!)).rejects.toThrow('Archive entry is corrupt')
  })

  it('rejects duplicate entry paths while writing and while reading', async () => {
    const input = [
      { path: 'a.txt', data: new Blob(['one']) },
      { path: 'a.txt', data: new Blob(['two']) },
    ]
    await expect(writeZip(input, collector().sink)).rejects.toThrow('Duplicate archive entry')
  })

  it('computes the standard CRC-32 of a known string', () => {
    // "123456789" is the canonical CRC-32 check value.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('refuses an archive with too many entries', async () => {
    const archive = await zipBlob([
      { path: 'a.txt', data: new Blob(['a']) },
      { path: 'b.txt', data: new Blob(['b']) },
    ])
    await expect(readZipDirectory(archive, { maxEntries: 1 })).rejects.toThrow(
      'Too many archive entries',
    )
  })

  it('reports the axis of a malformed directory rather than hanging', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['hello']) }])
    const bytes = await bytesOf(archive)
    // Break the central-directory signature but keep the EOCD intact.
    const view = new DataView(bytes.buffer)
    for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === 0x06054b50) {
        const directoryOffset = view.getUint32(offset + 16, true)
        view.setUint32(directoryOffset, 0, true)
        break
      }
    }
    await expect(readZipDirectory(new Blob([bytes as BlobPart]))).rejects.toThrow(ZipError)
  })

  it('rejects a local header whose name bytes differ from the central record', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['abcdef']) }])
    const bytes = await bytesOf(archive)
    const entries = await readZipDirectory(new Blob([bytes as BlobPart]))
    const local = entries[0]!.localHeaderOffset
    // Same length, one different byte: only a real byte comparison catches it.
    bytes[local + 30] = bytes[local + 30]! ^ 0xff
    await expect(readZipDirectory(new Blob([bytes as BlobPart]))).rejects.toThrow(
      /name does not match/,
    )
  })

  it('rejects a nonzero local extra field', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['abcdef']) }])
    const bytes = await bytesOf(archive)
    const entries = await readZipDirectory(new Blob([bytes as BlobPart]))
    const view = new DataView(bytes.buffer)
    view.setUint16(entries[0]!.localHeaderOffset + 28, 1, true)
    await expect(readZipDirectory(new Blob([bytes as BlobPart]))).rejects.toThrow(
      /unexpected extra field/,
    )
  })

  it('ignores a forged larger local-header size and reads the central-size bytes', async () => {
    const archive = await zipBlob([{ path: 'a.txt', data: new Blob(['abcdef']) }])
    const bytes = await bytesOf(archive)
    const entries = await readZipDirectory(new Blob([bytes as BlobPart]))
    const view = new DataView(bytes.buffer)
    const local = entries[0]!.localHeaderOffset
    // Local header: +18 compressed size, +22 uncompressed size.
    view.setUint32(local + 18, 0x7fffffff, true)
    view.setUint32(local + 22, 0x7fffffff, true)

    const entry = await readZipEntry(new Blob([bytes as BlobPart]), entries[0]!)
    expect(await entry.text()).toBe('abcdef')
  })
})

/** Offsets of the central records and the end record in a stored archive. */
function archiveAxes(bytes: Uint8Array): { view: DataView; central: number[]; end: number } {
  const view = new DataView(bytes.buffer)
  const central: number[] = []
  let end = -1
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    const signature = view.getUint32(offset, true)
    if (signature === 0x02014b50) central.push(offset)
    if (signature === 0x06054b50) end = offset
  }
  return { view, central, end }
}

async function oneEntryArchive(text = 'hello'): Promise<Uint8Array> {
  return bytesOf(await zipBlob([{ path: 'a.txt', data: new Blob([text]) }]))
}

function rewrap(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart])
}

describe('bundle zip hostile archives (0.29.0)', () => {
  it('reads a blob without stream() through one arrayBuffer fallback', async () => {
    const data = new Uint8Array([1, 2, 3, 4])
    const fake = {
      size: data.length,
      arrayBuffer: async () => data.buffer.slice(0),
    } as unknown as Blob
    const output = collector()
    await writeZip([{ path: 'a.bin', data: fake }], output.sink)
    const archive = rewrap(output.bytes())
    const [entry] = await readZipDirectory(archive)
    expect(await (await readZipEntry(archive, entry!)).arrayBuffer()).toEqual(data.buffer)
  })

  it('skips an empty stream chunk instead of hashing undefined bytes', async () => {
    const fake = {
      size: 0,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(undefined as unknown as Uint8Array)
            controller.close()
          },
        }),
    } as unknown as Blob
    const output = collector()
    await writeZip([{ path: 'empty.bin', data: fake }], output.sink)
    expect(output.bytes().length).toBeGreaterThan(0)
  })

  it('refuses more entries than the 16-bit count can name', async () => {
    const entries = Array.from({ length: 0x10000 }, (_, index) => ({
      path: `f${index}`,
      data: new Blob([]),
    }))
    await expect(writeZip(entries, collector().sink)).rejects.toThrow('Too many archive entries')
  })

  it('refuses an entry path longer than the 16-bit name field', async () => {
    await expect(
      writeZip([{ path: 'x'.repeat(0x10000), data: new Blob([]) }], collector().sink),
    ).rejects.toThrow('path is too long')
  })

  it('refuses a declared entry larger than 4 GiB before reading it', async () => {
    const fake = { size: 0x1_0000_0000, arrayBuffer: async () => new ArrayBuffer(0) } as Blob
    await expect(writeZip([{ path: 'huge.bin', data: fake }], collector().sink)).rejects.toThrow(
      'too large',
    )
  })

  it('refuses an entry whose bytes change between size check and checksum', async () => {
    const fake = {
      size: 3,
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }),
    } as unknown as Blob
    await expect(writeZip([{ path: 'short.bin', data: fake }], collector().sink)).rejects.toThrow(
      'changed while it was written',
    )
  })

  it('finds the end record through a trailing archive comment', async () => {
    const bytes = await oneEntryArchive()
    const comment = new Uint8Array(30)
    const next = new Uint8Array(bytes.length + comment.length)
    next.set(bytes)
    next.set(comment, bytes.length)
    const view = new DataView(next.buffer)
    const { end } = archiveAxes(bytes)
    view.setUint16(end + 20, comment.length, true)
    const entries = await readZipDirectory(rewrap(next))
    expect(entries.map((entry) => entry.path)).toEqual(['a.txt'])
  })

  it('ignores a comment that contains a forged end signature', async () => {
    const bytes = await oneEntryArchive()
    const comment = new Uint8Array(40)
    // A forged signature 8 bytes into the comment, with a bogus comment length
    // at its +20 that cannot match the real remaining comment length.
    new DataView(comment.buffer).setUint32(8, 0x06054b50, true)
    comment[28] = 1
    const next = new Uint8Array(bytes.length + comment.length)
    next.set(bytes)
    next.set(comment, bytes.length)
    const view = new DataView(next.buffer)
    const { end } = archiveAxes(bytes)
    view.setUint16(end + 20, comment.length, true)
    const entries = await readZipDirectory(rewrap(next))
    expect(entries.map((entry) => entry.path)).toEqual(['a.txt'])
  })

  it('refuses a multi-disk archive', async () => {
    const bytes = await oneEntryArchive()
    const { view, end } = archiveAxes(bytes)
    view.setUint16(end + 4, 1, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('Multi-disk')
  })

  it('refuses a central directory that runs past the archive', async () => {
    const bytes = await oneEntryArchive()
    const { view, end } = archiveAxes(bytes)
    view.setUint32(end + 16, bytes.length, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('central directory is truncated')
  })

  it('reads an empty archive as no entries', async () => {
    const archive = await zipBlob([])
    await expect(readZipDirectory(archive)).resolves.toEqual([])
  })

  it('refuses a directory record smaller than one header', async () => {
    const bytes = await oneEntryArchive()
    const { view, end } = archiveAxes(bytes)
    view.setUint16(end + 10, 1, true)
    view.setUint32(end + 12, 10, true)
    view.setUint32(end + 16, 0, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('directory is truncated')
  })

  it('refuses a record whose name runs past the declared directory', async () => {
    const bytes = await oneEntryArchive()
    const { view, central, end } = archiveAxes(bytes)
    view.setUint16(central[0]! + 28, 0xffff, true)
    view.setUint32(end + 12, 60, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('directory is truncated')
  })

  it('refuses stored sizes that disagree', async () => {
    const bytes = await oneEntryArchive()
    const { view, central } = archiveAxes(bytes)
    view.setUint32(central[0]! + 24, 9, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('equal sizes')
  })

  it('refuses a path containing a NUL byte', async () => {
    const bytes = await oneEntryArchive()
    const { central } = archiveAxes(bytes)
    bytes[central[0]! + 46] = 0
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('invalid path')
  })

  it('refuses duplicate paths inside the directory', async () => {
    const archive = await zipBlob([
      { path: 'a.txt', data: new Blob(['one']) },
      { path: 'b.txt', data: new Blob(['two']) },
    ])
    const bytes = await bytesOf(archive)
    const { central } = archiveAxes(bytes)
    bytes[central[1]! + 46] = 'a'.charCodeAt(0)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('Duplicate archive entry')
  })

  it('refuses an entry whose local header starts past the archive', async () => {
    const bytes = await oneEntryArchive()
    const { view, central } = archiveAxes(bytes)
    view.setUint32(central[0]! + 42, bytes.length, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('entry is truncated')
  })

  it('refuses an entry with a broken local signature', async () => {
    const bytes = await oneEntryArchive()
    bytes[0] = 0
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('entry is malformed')
  })

  it('refuses a local name length that disagrees with the directory', async () => {
    const bytes = await oneEntryArchive()
    const { view } = archiveAxes(bytes)
    view.setUint16(26, 1, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('name does not match')
  })

  it('refuses an entry whose declared bytes extend past the archive', async () => {
    const bytes = await oneEntryArchive()
    const { view, central } = archiveAxes(bytes)
    view.setUint32(central[0]! + 20, 0x100, true)
    view.setUint32(central[0]! + 24, 0x100, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('entry is truncated')
  })

  it('refuses a streamed entry that carries a data descriptor', async () => {
    const bytes = await oneEntryArchive()
    const { view, central } = archiveAxes(bytes)
    view.setUint16(central[0]! + 8, 0x0008, true)
    await expect(readZipDirectory(rewrap(bytes))).rejects.toThrow('data descriptors')
  })

  it('refuses to read an entry whose header slice is too short', async () => {
    const bytes = await oneEntryArchive()
    const forged = {
      path: 'a.txt',
      pathBytes: new Uint8Array([97]),
      flags: 0,
      method: 0,
      crc32: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      localHeaderOffset: bytes.length - 10,
    } satisfies ZipEntry
    await expect(readZipEntry(rewrap(bytes), forged)).rejects.toThrow('entry is truncated')
  })

  it('refuses to read an entry with a broken local signature', async () => {
    const bytes = await oneEntryArchive()
    const forged = {
      path: 'a.txt',
      pathBytes: new Uint8Array([97]),
      flags: 0,
      method: 0,
      crc32: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      localHeaderOffset: 1,
    } satisfies ZipEntry
    await expect(readZipEntry(rewrap(bytes), forged)).rejects.toThrow('entry is malformed')
  })

  it('refuses to read entry bytes that extend past the archive', async () => {
    const bytes = await oneEntryArchive()
    const [entry] = await readZipDirectory(rewrap(bytes))
    await expect(
      readZipEntry(rewrap(bytes), { ...entry!, compressedSize: 0xffff }),
    ).rejects.toThrow('entry is truncated')
  })
})
