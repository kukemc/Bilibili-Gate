import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  advancedPosition,
  DanmakuRenderer,
  danmakuX,
  lanesCollide,
  layoutDanmaku,
  MAX_ACTIVE_DANMAKU,
  parseAdvancedDanmaku,
} from './danmaku-renderer'
import type { DanmakuComment } from './danmaku-data'

const options = { opacity: 1, fontScale: 1, area: 1 }
const comment = (overrides: Partial<DanmakuComment> = {}): DanmakuComment => ({
  id: '1',
  time: 0,
  mode: 1,
  fontSize: 25,
  color: 0xffffff,
  text: 'hello',
  ...overrides,
})
const layout = (comments: DanmakuComment[], width = 640, height = 360) =>
  layoutDanmaku(comments, width, height, options, (text, size) => text.length * size)

function advanced(overrides: Record<number, unknown> = {}) {
  const values: unknown[] = [0.1, 0.2, '1-0', 10, '<b>plain text</b>', 30, 45, 0.9, 0.8, 4000, 2000, true]
  for (const [key, value] of Object.entries(overrides)) values[Number(key)] = value
  return JSON.stringify(values)
}

describe('danmaku layout and modes', () => {
  it('supports scrolling 1/2/3, reverse 6, top 5 and bottom 4', () => {
    for (const mode of [1, 2, 3]) {
      const [item] = layout([comment({ mode })])
      expect(danmakuX(item, 0, 640)).toBe(640)
      expect(danmakuX(item, 8, 640)).toBe(-125)
      expect(danmakuX(item, 4, 640)).toBe(257.5)
    }
    const [reverse] = layout([comment({ mode: 6 })])
    expect(danmakuX(reverse, 0, 640)).toBe(-125)
    expect(danmakuX(reverse, 8, 640)).toBe(640)
    const [top] = layout([comment({ mode: 5 })])
    const [bottom] = layout([comment({ mode: 4 })])
    expect(top.y).toBe(0)
    expect(bottom.y + bottom.height).toBe(360)
    expect(danmakuX(top, 2, 640)).toBe(257.5)
    expect(top.end).toBe(4)
  })

  it('never executes mode 8 or treats BAS / invalid advanced payloads as ordinary text', () => {
    const result = layout([
      comment({ mode: 8, text: 'throw new Error("executed")' }),
      comment({ mode: 9, text: 'def text t {}' }),
      comment({ mode: 7, text: 'not json' }),
      comment({ mode: 99 }),
    ])
    expect(result).toEqual([])
  })

  it('reserves lanes across font sizes, fixed text and opposite directions', () => {
    const items = layout([
      comment({ id: 'a', mode: 5, fontSize: 48 }),
      comment({ id: 'b', mode: 1, fontSize: 18 }),
      comment({ id: 'c', mode: 6, time: 1 }),
      comment({ id: 'd', mode: 4, time: 2 }),
    ])
    expect(items).toHaveLength(4)
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) expect(lanesCollide(items[a], items[b], 640)).toBe(false)
    }
  })

  it('detects a fast wide follower that would catch up before the first comment exits', () => {
    const [first] = layout([comment({ text: 'x' })])
    const [second] = layout([comment({ text: 'x'.repeat(20), time: 1 })])
    expect(danmakuX(first, 1, 640) + first.width).toBeLessThan(danmakuX(second, 1, 640))
    expect(lanesCollide(first, second, 640)).toBe(true)
  })

  it('permits well-separated followers and deterministically drops overcrowded comments', () => {
    const comments = Array.from({ length: 100 }, (_, i) => comment({ id: String(i) }))
    const first = layout(comments, 640, 64)
    expect(first).toHaveLength(1)
    expect(layout(comments, 640, 64)).toEqual(first)
    const [a] = layout([comment()])
    const [b] = layout([comment({ time: 3 })])
    expect(lanesCollide(a, b, 640)).toBe(false)
  })

  it('bounds advanced active count, truncates text and respects zero area', () => {
    const comments = Array.from({ length: 500 }, (_, i) => comment({ id: String(i), mode: 7, text: advanced() }))
    expect(layout(comments)).toHaveLength(MAX_ACTIVE_DANMAKU)
    expect(layout([comment({ text: 'x'.repeat(10000) })])[0].text).toHaveLength(2048)
    expect(layoutDanmaku(comments, 640, 360, { ...options, area: 0 }, () => 20)).toEqual([])
  })
})

describe('advanced mode parser and media-time positions', () => {
  it('interpolates coordinates, opacity and delayed movement', () => {
    const value = parseAdvancedDanmaku(advanced())!
    expect(value.text).toBe('<b>plain text</b>')
    expect(value.rotateZ).toBe(30)
    expect(value.rotateY).toBe(45)
    expect(advancedPosition(value, 1, 1000, 500)).toEqual({ x: 100, y: 100, opacity: 0.9 })
    const middle = advancedPosition(value, 4, 1000, 500)
    expect(middle.x).toBeCloseTo(500)
    expect(middle.y).toBeCloseTo(250)
    expect(middle.opacity).toBeCloseTo(0.6)
    expect(advancedPosition(value, 9, 1000, 500).x).toBe(900)
  })

  it('scales legacy coordinates and follows M/L paths by distance', () => {
    const value = parseAdvancedDanmaku(advanced({ 0: 336, 1: 219, 7: 672, 8: 438, 10: 0 }))!
    expect(advancedPosition(value, 0, 1344, 876)).toMatchObject({ x: 672, y: 438 })
    const path = parseAdvancedDanmaku(advanced({ 14: 'M0,0L100,0L100,100', 10: 0 }))!
    expect(advancedPosition(path, 2, 672, 438)).toMatchObject({ x: 100, y: 0 })
    expect(advancedPosition(path, 3, 672, 438)).toMatchObject({ x: 100, y: 50 })
  })

  it('validates payloads, clamps lifetime and handles instant delayed movement', () => {
    for (const value of ['{}', 'null', '[1,2]', advanced({ 3: -1 }), advanced({ 0: 'nope' })]) {
      expect(parseAdvancedDanmaku(value)).toBeNull()
    }
    expect(parseAdvancedDanmaku(advanced({ 3: 500 }))!.duration).toBe(30)
    const value = parseAdvancedDanmaku(advanced({ 9: 0, 11: 'false' }))!
    expect(value.outline).toBe(false)
    expect(advancedPosition(value, 1, 1000, 500).x).toBe(100)
    expect(advancedPosition(value, 2, 1000, 500).x).toBe(900)
    expect(parseAdvancedDanmaku(advanced({ 14: 'M0,0 Q10,10 20,20' }))!.path).toEqual([])
  })
})

function fixture() {
  const context = {
    setTransform: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 20 }),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn(),
    strokeText: vi.fn(),
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 640, height: 360 }),
  }
  const video = Object.assign(new EventTarget(), { currentTime: 0, paused: true, ended: false, seeking: false })
  const windowMock = Object.assign(new EventTarget(), { devicePixelRatio: 2 })
  let resizeCallback: () => void = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('window', windowMock)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallback = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    },
  )
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++id, callback)
      return id
    }),
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((frame: number) => frames.delete(frame)),
  )
  const renderer = new DanmakuRenderer(canvas as unknown as HTMLCanvasElement, video as unknown as HTMLVideoElement)
  return {
    renderer,
    context,
    canvas,
    video,
    windowMock,
    frames,
    disconnect,
    resize: () => resizeCallback(),
    frame: () => {
      const [key, callback] = frames.entries().next().value!
      frames.delete(key)
      callback(0)
    },
    event: (name: string) => video.dispatchEvent(new Event(name)),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('renderer lifecycle', () => {
  it('renders when paused, follows media time, stops RAF and reconstructs identical seek lanes', () => {
    const f = fixture()
    f.renderer.setComments([comment({ time: 0 }), comment({ id: '2', time: 1, mode: 6 })])
    expect(f.frames.size).toBe(0)
    expect(f.context.fillText).toHaveBeenCalled()
    f.video.paused = false
    f.event('play')
    expect(f.frames.size).toBe(1)
    f.video.currentTime = 2
    f.context.translate.mockClear()
    f.frame()
    const positions = f.context.translate.mock.calls.slice()
    expect(positions).toHaveLength(2)
    f.video.currentTime = 20
    f.frame()
    f.video.paused = true
    f.event('pause')
    expect(f.frames.size).toBe(0)
    f.video.currentTime = 2
    f.context.translate.mockClear()
    f.event('seeked')
    expect(f.context.translate.mock.calls).toEqual(positions)
    f.video.currentTime = 0
    f.context.translate.mockClear()
    f.event('timeupdate')
    expect(f.context.translate.mock.calls).toHaveLength(1)
    f.renderer.destroy()
  })

  it('updates backing pixels for DPR and cleans listeners, RAF and observer idempotently', () => {
    const f = fixture()
    expect(f.canvas.width).toBe(1280)
    expect(f.canvas.height).toBe(720)
    f.windowMock.devicePixelRatio = 3
    f.resize()
    expect(f.canvas.width).toBe(1920)
    expect(f.context.setTransform).toHaveBeenLastCalledWith(3, 0, 0, 3, 0, 0)
    f.windowMock.devicePixelRatio = 0.75
    f.resize()
    expect(f.canvas.width).toBe(480)
    expect(f.context.setTransform).toHaveBeenLastCalledWith(0.75, 0, 0, 0.75, 0, 0)
    f.video.paused = false
    f.event('play')
    f.renderer.destroy()
    f.renderer.destroy()
    expect(f.disconnect).toHaveBeenCalledTimes(1)
    expect(f.frames.size).toBe(0)
    f.context.clearRect.mockClear()
    f.event('seeked')
    f.resize()
    f.renderer.setComments([comment()])
    f.renderer.setOptions({ opacity: 1 })
    expect(f.context.clearRect).not.toHaveBeenCalled()
  })
})
