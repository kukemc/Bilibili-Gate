import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DanmakuData from './danmaku-data'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('$request', () => ({ request: { get } }))

// Encode real protobuf wire bytes, not JSON-shaped fixtures.
function varint(value: number | bigint): number[] {
  let remaining = BigInt(value)
  const bytes: number[] = []
  do {
    const byte = Number(remaining & 127n)
    remaining >>= 7n
    bytes.push(byte | (remaining ? 128 : 0))
  } while (remaining)
  return bytes
}
const numberField = (field: number, value: number | bigint) => [...varint(field * 8), ...varint(value)]
const bytesField = (field: number, value: number[]) => [...varint(field * 8 + 2), ...varint(value.length), ...value]
const textField = (field: number, value: string) => bytesField(field, [...new TextEncoder().encode(value)])
const segment = (...comments: number[][]) => new Uint8Array(comments.flatMap((value) => bytesField(1, value))).buffer
const sample = () => segment([...numberField(1, 42), ...numberField(3, 1), ...textField(7, 'hello')])

let api: typeof DanmakuData
beforeEach(async () => {
  vi.resetModules()
  get.mockReset()
  vi.restoreAllMocks()
  api = await import('./danmaku-data')
})

describe('loadDanmakuSegment', () => {
  it('decodes int64 IDs without precision loss, time, modes, strings, color and weight', async () => {
    get.mockResolvedValue({
      data: segment([
        ...numberField(1, 9223372036854775807n),
        ...numberField(2, 360123),
        ...numberField(3, 6),
        ...numberField(4, 36),
        ...numberField(5, 0x123456),
        ...textField(7, '你好 👋'),
        ...numberField(9, 10),
      ]),
    })
    await expect(api.loadDanmakuSegment(123, 2)).resolves.toEqual([
      {
        id: '9223372036854775807',
        time: 360.123,
        mode: 6,
        fontSize: 36,
        color: 0x123456,
        text: '你好 👋',
        weight: 10,
      },
    ])
    expect(get).toHaveBeenCalledWith(
      '/x/v2/dm/web/seg.so',
      expect.objectContaining({
        params: { type: 1, oid: 123, segment_index: 2 },
        responseType: 'arraybuffer',
        timeout: 15000,
      }),
    )
  })

  it('preserves all modes as inert data, prefers idStr and accepts proto3 defaults', async () => {
    const modes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 42]
    get.mockResolvedValue({
      data: segment(
        ...modes.map((mode) => [
          ...numberField(1, 7),
          ...numberField(3, mode),
          ...textField(12, '9007199254740993'),
          ...textField(7, 'throw new Error("must not execute")'),
        ]),
        [],
      ),
    })
    const comments = await api.loadDanmakuSegment(1, 1)
    expect(comments.slice(0, -1).map((item) => item.mode)).toEqual(modes)
    expect(comments[0]!.id).toBe('9007199254740993')
    expect(comments.at(-1)).toEqual({ id: '0', time: 0, mode: 0, fontSize: 0, color: 0, text: '' })
  })

  it('skips unknown wire 0/1/2/5 fields at both levels and respects typed-array offsets', async () => {
    const unknown = [
      ...numberField(30, 1),
      ...varint(31 * 8 + 1),
      ...new Array(8).fill(0),
      ...bytesField(32, [1, 2]),
      ...varint(33 * 8 + 5),
      0,
      0,
      0,
      0,
    ]
    const wire = [...bytesField(1, [...textField(7, 'ok'), ...unknown]), ...unknown]
    const padded = new Uint8Array([255, ...wire, 255])
    get.mockResolvedValue({ data: padded.subarray(1, -1) })
    expect((await api.loadDanmakuSegment(1, 1))[0]!.text).toBe('ok')
  })

  it.each([
    ['truncated varint', [128]],
    ['overflow varint', new Array(10).fill(255)],
    ['zero field', [0]],
    ['oversized tag', varint(0x100000000n)],
    ['unsupported group', [11]],
    ['truncated length', [10, 128]],
    ['oversized length', [10, 127]],
    ['wrong element wire', [8, 1]],
    ['wrong known-field wire', bytesField(1, [18, 0])],
    ['invalid UTF-8', bytesField(1, bytesField(7, [255]))],
    ['invalid idStr', bytesField(1, textField(12, 'not-an-id'))],
    ['negative progress', bytesField(1, numberField(2, 0xffffffffffffffffn))],
    ['out of range int32', bytesField(1, numberField(3, 0x80000000n))],
    ['truncated fixed64', [25, 0]],
    ['truncated fixed32', [29, 0]],
    ['closed dm state', numberField(2, 1)],
  ])('rejects %s and never caches failures', async (_name, bytes) => {
    get.mockResolvedValueOnce({ data: new Uint8Array(bytes).buffer }).mockResolvedValueOnce({ data: sample() })
    await expect(api.loadDanmakuSegment(1, 1)).rejects.toThrow()
    await expect(api.loadDanmakuSegment(1, 1)).resolves.toHaveLength(1)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('rejects non-binary, oversized and excessive-comment responses', async () => {
    for (const data of [
      '{"code":-403}',
      new Uint8Array(4 * 1024 * 1024 + 1),
      new Uint8Array(Array.from({ length: 50_001 }, () => [10, 0]).flat()),
    ]) {
      get.mockResolvedValueOnce({ data })
      await expect(api.loadDanmakuSegment(1, 1)).rejects.toThrow()
    }
  })

  it('accepts a genuinely empty segment and isolates cached values from mutation', async () => {
    get.mockResolvedValueOnce({ data: new ArrayBuffer(0) }).mockResolvedValueOnce({ data: sample() })
    await expect(api.loadDanmakuSegment(1, 1)).resolves.toEqual([])
    await expect(api.loadDanmakuSegment(1, 1)).resolves.toEqual([])
    const first = await api.loadDanmakuSegment(1, 2)
    first[0]!.text = 'changed'
    first.push(first[0]!)
    expect(await api.loadDanmakuSegment(1, 2)).toHaveLength(1)
    expect((await api.loadDanmakuSegment(1, 2))[0]!.text).toBe('hello')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('bounds segment cache using LRU and TTL', async () => {
    get.mockResolvedValue({ data: sample() })
    for (let index = 1; index <= 32; index++) await api.loadDanmakuSegment(1, index)
    await api.loadDanmakuSegment(1, 1) // refresh LRU
    await api.loadDanmakuSegment(1, 33)
    await api.loadDanmakuSegment(1, 1)
    expect(get).toHaveBeenCalledTimes(33)
    await api.loadDanmakuSegment(1, 2)
    expect(get).toHaveBeenCalledTimes(34)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    await api.loadDanmakuSegment(1, 1)
    expect(get).toHaveBeenCalledTimes(35)
  })

  it('propagates network errors without caching', async () => {
    get.mockRejectedValueOnce(new Error('HTTP 403')).mockResolvedValueOnce({ data: sample() })
    await expect(api.loadDanmakuSegment(1, 1)).rejects.toThrow('HTTP 403')
    await expect(api.loadDanmakuSegment(1, 1)).resolves.toHaveLength(1)
  })

  it('rejects invalid arguments without requests', async () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(api.loadDanmakuSegment(value, 1)).rejects.toThrow(RangeError)
      await expect(api.loadDanmakuSegment(1, value)).rejects.toThrow(RangeError)
    }
    expect(get).not.toHaveBeenCalled()
  })

  it('handles pre-abort, in-flight cancellation, ignored adapters and independent callers', async () => {
    const controller = new AbortController()
    const { promise, resolve: finish } = Promise.withResolvers<{ data: ArrayBuffer }>()
    get.mockReturnValueOnce(promise).mockResolvedValue({ data: sample() })
    const pending = api.loadDanmakuSegment(1, 1, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    await expect(api.loadDanmakuSegment(1, 1)).resolves.toHaveLength(1)
    finish({ data: new ArrayBuffer(0) })
    await Promise.resolve()
    await expect(api.loadDanmakuSegment(1, 1)).resolves.toHaveLength(1)
    await expect(api.loadDanmakuSegment(1, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[0]![1].signal).toBe(controller.signal)
  })
})

describe('resolveDanmakuCid', () => {
  const bvid = 'BV1xx411c7mD'
  it('resolves and caches the default cid and supports pages fallback', async () => {
    get
      .mockResolvedValueOnce({ data: { code: 0, data: { cid: 123 } } })
      .mockResolvedValueOnce({ data: { code: 0, data: { pages: [{ cid: 456 }] } } })
    await expect(api.resolveDanmakuCid(bvid)).resolves.toBe(123)
    await expect(api.resolveDanmakuCid(bvid)).resolves.toBe(123)
    await expect(api.resolveDanmakuCid('BV1xx411c7mE')).resolves.toBe(456)
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledWith('/x/web-interface/view', expect.objectContaining({ params: { bvid } }))
  })

  it.each([
    { code: -404, message: 'not found' },
    { code: 0 },
    { code: 0, data: { cid: 0 } },
    { code: 0, data: { cid: '123' } },
    { code: 0, data: { cid: Number.MAX_SAFE_INTEGER + 1 } },
  ])('does not cache API failures: %j', async (data) => {
    get.mockResolvedValueOnce({ data }).mockResolvedValueOnce({ data: { code: 0, data: { cid: 123 } } })
    await expect(api.resolveDanmakuCid(bvid)).rejects.toThrow()
    await expect(api.resolveDanmakuCid(bvid)).resolves.toBe(123)
  })

  it('validates bvid and aborts before any request', async () => {
    await expect(api.resolveDanmakuCid('../invalid')).rejects.toThrow(TypeError)
    const controller = new AbortController()
    controller.abort()
    await expect(api.resolveDanmakuCid(bvid, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(get).not.toHaveBeenCalled()
  })

  it('cancels an in-flight cid lookup without caching its late result', async () => {
    const controller = new AbortController()
    const { promise, resolve } = Promise.withResolvers<unknown>()
    get.mockReturnValueOnce(promise).mockResolvedValue({ data: { code: 0, data: { cid: 456 } } })
    const pending = api.resolveDanmakuCid(bvid, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    resolve({ data: { code: 0, data: { cid: 123 } } })
    await Promise.resolve()
    await expect(api.resolveDanmakuCid(bvid)).resolves.toBe(456)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('bounds cid cache and expires successful results', async () => {
    get.mockResolvedValue({ data: { code: 0, data: { cid: 123 } } })
    const id = (index: number) => `BV${index.toString().padStart(10, '0')}`
    for (let index = 0; index < 129; index++) await api.resolveDanmakuCid(id(index))
    await api.resolveDanmakuCid(id(0))
    expect(get).toHaveBeenCalledTimes(130)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    await api.resolveDanmakuCid(id(0))
    expect(get).toHaveBeenCalledTimes(131)
  })
})
