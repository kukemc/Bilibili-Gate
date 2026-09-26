import { request } from '$request'

/** Raw data only: advanced/script modes must never be evaluated as JavaScript or HTML. */
export interface DanmakuComment {
  id: string
  /** Absolute video timestamp, in seconds (not segment-relative). */
  time: number
  mode: number
  fontSize: number
  color: number
  text: string
  weight?: number
}

const MAX_SEGMENT_BYTES = 4 * 1024 * 1024
const MAX_COMMENTS = 50_000
const CACHE_TTL = 5 * 60_000
const MAX_CACHE_BYTES = 16 * 1024 * 1024
const segmentCache = new Map<string, { value: DanmakuComment[]; expires: number; size: number }>()
const cidCache = new Map<string, { value: number; expires: number }>()
let cacheBytes = 0

function abortError() {
  return new DOMException('Danmaku request aborted', 'AbortError')
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

/** Also settles promptly when an adapter does not implement transport cancellation. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) reject(abortError())
        else resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(signal.aborted ? abortError() : error)
      },
    )
  })
}

function invalid(): never {
  throw new Error('Invalid danmaku protobuf response')
}

/** Bounds-checked protobuf subset; unknown scalar/fixed/length-delimited fields are skipped. */
class Reader {
  position = 0
  constructor(readonly bytes: Uint8Array) {}

  get done() {
    return this.position === this.bytes.length
  }

  varint(): bigint {
    let result = 0n
    for (let i = 0; i < 10; i++) {
      if (this.position >= this.bytes.length) invalid()
      const byte = this.bytes[this.position++]!
      if (i === 9 && byte > 1) invalid()
      result |= BigInt(byte & 0x7f) << BigInt(i * 7)
      if (!(byte & 0x80)) return result
    }
    return invalid()
  }

  tag(): [number, number] {
    const tag = this.varint()
    if (tag > 0xffffffffn || tag < 8n) invalid()
    return [Number(tag >> 3n), Number(tag & 7n)]
  }

  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.position) invalid()
    const result = this.bytes.subarray(this.position, this.position + length)
    this.position += length
    return result
  }

  bytesField(): Uint8Array {
    const length = this.varint()
    if (length > BigInt(this.bytes.length - this.position)) invalid()
    return this.take(Number(length))
  }

  skip(wire: number) {
    switch (wire) {
      case 0:
        this.varint()
        break
      case 1:
        this.take(8)
        break
      case 2:
        this.bytesField()
        break
      case 5:
        this.take(4)
        break
      default:
        // Groups are not used by this schema; rejecting them avoids recursive parsing.
        invalid()
    }
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function decodeComment(bytes: Uint8Array): DanmakuComment {
  const reader = new Reader(bytes)
  const comment: DanmakuComment = { id: '0', time: 0, mode: 0, fontSize: 0, color: 0, text: '' }
  let idString: string | undefined
  while (!reader.done) {
    const [field, wire] = reader.tag()
    if ([1, 2, 3, 4, 5, 9].includes(field)) {
      if (wire !== 0) invalid()
      const value = reader.varint()
      if (field === 1) {
        // Keep int64 IDs out of Number, including IDs above Number.MAX_SAFE_INTEGER.
        if (value > 0x7fffffffffffffffn) invalid()
        comment.id = value.toString()
      } else {
        const number = Number(value)
        if (value > (field === 5 ? 0xffffffffn : 0x7fffffffn)) invalid()
        if (field === 2) comment.time = number / 1000
        if (field === 3) comment.mode = number
        if (field === 4) comment.fontSize = number
        if (field === 5) comment.color = number
        if (field === 9) comment.weight = number
      }
    } else if (field === 7 || field === 12) {
      if (wire !== 2) invalid()
      const text = utf8.decode(reader.bytesField())
      if (field === 7) comment.text = text
      else idString = text
    } else {
      reader.skip(wire)
    }
  }
  if (idString) {
    if (!/^\d+$/.test(idString)) invalid()
    comment.id = idString
  }
  return comment
}

function decodeSegment(data: unknown): DanmakuComment[] {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : invalid()
  if (bytes.byteLength > MAX_SEGMENT_BYTES) throw new Error('Danmaku segment is too large')
  const reader = new Reader(bytes)
  const comments: DanmakuComment[] = []
  while (!reader.done) {
    const [field, wire] = reader.tag()
    if (field === 1) {
      if (wire !== 2) invalid()
      if (comments.length >= MAX_COMMENTS) throw new Error('Too many danmaku comments')
      comments.push(decodeComment(reader.bytesField()))
    } else if (field === 2) {
      if (wire !== 0) invalid()
      if (reader.varint() !== 0n) throw new Error('Danmaku is unavailable')
    } else {
      reader.skip(wire)
    }
  }
  return comments
}

function cloneComments(value: DanmakuComment[]) {
  return value.map((comment) => ({ ...comment }))
}

function removeSegment(key: string) {
  const entry = segmentCache.get(key)
  if (entry) cacheBytes -= entry.size
  segmentCache.delete(key)
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Fetch one 6-minute segment, with a one-based segmentIndex. Errors are never cached.
 * Uses the existing credentialed web API Axios client (not the APP-signed GM client).
 * Independent in-flight requests prevent one caller's abort from cancelling another.
 * Successes use a 5-minute LRU: at most 32 segments / ~16 MiB of decoded data.
 * All mode values are preserved, including 7/8/9: callers must choose safe renderers.
 */
export async function loadDanmakuSegment(
  cid: number,
  segmentIndex: number,
  signal?: AbortSignal,
): Promise<DanmakuComment[]> {
  checkAbort(signal)
  if (!positiveInteger(cid) || !positiveInteger(segmentIndex)) {
    throw new RangeError('cid and segmentIndex must be positive safe integers')
  }
  const key = `${cid}:${segmentIndex}`
  const cached = segmentCache.get(key)
  if (cached && cached.expires > Date.now()) {
    segmentCache.delete(key)
    segmentCache.set(key, cached)
    return cloneComments(cached.value)
  }
  removeSegment(key)
  const response = await abortable(
    request.get<unknown>('/x/v2/dm/web/seg.so', {
      params: { type: 1, oid: cid, segment_index: segmentIndex },
      responseType: 'arraybuffer',
      signal,
      timeout: 15_000,
    }),
    signal,
  )
  checkAbort(signal)
  const comments = decodeSegment(response.data)
  // Account for UTF-16 strings and per-comment overhead, not just compressed wire bytes.
  const size = comments.reduce((total, item) => total + 128 + 2 * (item.id.length + item.text.length), 0)
  if (size <= MAX_CACHE_BYTES) {
    removeSegment(key)
    segmentCache.set(key, { value: comments, expires: Date.now() + CACHE_TTL, size })
    cacheBytes += size
    while (segmentCache.size > 32 || cacheBytes > MAX_CACHE_BYTES) {
      removeSegment(segmentCache.keys().next().value!)
    }
  }
  return cloneComments(comments)
}

/** Resolve the video's default/first-page CID; multi-part callers should supply their selected page CID. */
export async function resolveDanmakuCid(bvid: string, signal?: AbortSignal): Promise<number> {
  checkAbort(signal)
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new TypeError('Invalid bvid')
  const cached = cidCache.get(bvid)
  if (cached && cached.expires > Date.now()) {
    cidCache.delete(bvid)
    cidCache.set(bvid, cached)
    return cached.value
  }
  cidCache.delete(bvid)
  const response = await abortable(
    request.get<{
      code: number
      message?: string
      data?: { cid?: number; pages?: { cid?: number }[] }
    }>('/x/web-interface/view', { params: { bvid }, signal, timeout: 15_000 }),
    signal,
  )
  checkAbort(signal)
  const json = response.data
  if (json?.code !== 0)
    throw new Error(`Resolve danmaku cid failed: ${json?.message || json?.code || 'invalid response'}`)
  const cid = json.data?.cid ?? json.data?.pages?.[0]?.cid
  if (typeof cid !== 'number' || !positiveInteger(cid)) throw new Error('Video response has no valid cid')
  cidCache.set(bvid, { value: cid, expires: Date.now() + CACHE_TTL })
  while (cidCache.size > 128) cidCache.delete(cidCache.keys().next().value!)
  return cid
}
