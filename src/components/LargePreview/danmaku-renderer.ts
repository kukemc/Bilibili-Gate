import type { DanmakuComment } from './danmaku-data'

export interface DanmakuOptions {
  opacity?: number
  fontScale?: number
  /** Fraction of the canvas height available to ordinary comments (0..1). */
  area?: number
}

export const MAX_ACTIVE_DANMAKU = 160
const MAX_LIFETIME = 30
const MAX_TEXT_LENGTH = 2048
const GAP = 8
const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif'
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const finite = (value: unknown, fallback: number): number => {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

type Point = { x: number; y: number }
export interface AdvancedDanmaku {
  text: string
  from: Point
  to: Point
  opacityFrom: number
  opacityTo: number
  duration: number
  moveDuration: number
  delay: number
  rotateZ: number
  rotateY: number
  outline: boolean
  path: Point[]
}

/** Bilibili mode-7 array format. Never evaluates scripts or interprets HTML. */
export function parseAdvancedDanmaku(text: string): AdvancedDanmaku | null {
  if (text.length > 32768) return null
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(data) || data.length < 5 || typeof data[4] !== 'string') return null
  const x = finite(data[0], NaN)
  const y = finite(data[1], NaN)
  const duration = finite(data[3], NaN)
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(duration > 0)) return null
  const alpha = String(data[2] ?? '1').split('-')
  const opacityFrom = clamp(finite(alpha[0], 1), 0, 1)
  const path: Point[] = []
  // Only straight M/L paths are supported; curves are not silently reinterpreted.
  if (typeof data[14] === 'string') {
    const commands = data[14].trim().split(/(?=[ML])/)
    for (const command of commands) {
      if (path.length >= 256) break
      const pair = command
        .slice(1)
        .trim()
        .split(/[\s,]+/)
      const point = { x: Number(pair[0]), y: Number(pair[1]) }
      if (!/^[ML]/.test(command) || pair.length !== 2 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        path.length = 0
        break
      }
      path.push(point)
    }
  }
  return {
    text: data[4].slice(0, MAX_TEXT_LENGTH),
    from: { x, y },
    to: { x: finite(data[7], x), y: finite(data[8], y) },
    opacityFrom,
    opacityTo: clamp(finite(alpha[1], opacityFrom), 0, 1),
    duration: Math.min(duration, MAX_LIFETIME),
    moveDuration: clamp(finite(data[9], duration * 1000) / 1000, 0, MAX_LIFETIME),
    delay: clamp(finite(data[10], 0) / 1000, 0, MAX_LIFETIME),
    rotateZ: finite(data[5], 0),
    rotateY: finite(data[6], 0),
    outline: data[11] !== false && data[11] !== 'false',
    path,
  }
}

/** Fractional coordinates use viewport units; legacy absolute coordinates use 672x438. */
function project(point: Point, width: number, height: number): Point {
  return {
    x: (point.x >= 0 && point.x <= 1 ? point.x : point.x / 672) * width,
    y: (point.y >= 0 && point.y <= 1 ? point.y : point.y / 438) * height,
  }
}

export function advancedPosition(value: AdvancedDanmaku, age: number, width: number, height: number) {
  const progress =
    value.moveDuration === 0 ? (age >= value.delay ? 1 : 0) : clamp((age - value.delay) / value.moveDuration, 0, 1)
  const points = (value.path.length > 1 ? value.path : [value.from, value.to]).map((p) => project(p, width, height))
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y))
  let distance = lengths.reduce((sum, length) => sum + length, 0) * progress
  let position = points.at(-1)!
  for (const [i, length] of lengths.entries()) {
    if (distance <= length) {
      const ratio = length ? distance / length : 0
      position = {
        x: points[i].x + (points[i + 1].x - points[i].x) * ratio,
        y: points[i].y + (points[i + 1].y - points[i].y) * ratio,
      }
      break
    }
    distance -= lengths[i]
  }
  return {
    ...position,
    opacity: value.opacityFrom + (value.opacityTo - value.opacityFrom) * clamp(age / value.duration, 0, 1),
  }
}

export interface DanmakuLayoutItem {
  comment: DanmakuComment
  text: string
  start: number
  end: number
  width: number
  height: number
  fontSize: number
  y: number
  advanced: AdvancedDanmaku | null
}

export function danmakuX(item: DanmakuLayoutItem, time: number, viewportWidth: number): number {
  const progress = clamp((time - item.start) / (item.end - item.start), 0, 1)
  if (item.comment.mode === 6) return -item.width + progress * (viewportWidth + item.width)
  if (item.comment.mode === 4 || item.comment.mode === 5) return (viewportWidth - item.width) / 2
  return viewportWidth - progress * (viewportWidth + item.width)
}

/** Exact linear swept-box test, including a faster follower catching up later. */
export function lanesCollide(a: DanmakuLayoutItem, b: DanmakuLayoutItem, width: number): boolean {
  if (a.y + a.height + GAP <= b.y || b.y + b.height + GAP <= a.y) return false
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  if (end <= start) return false
  const deltaStart = danmakuX(a, start, width) - danmakuX(b, start, width)
  const deltaEnd = danmakuX(a, end, width) - danmakuX(b, end, width)
  return Math.max(deltaStart, deltaEnd) > -a.width - GAP && Math.min(deltaStart, deltaEnd) < b.width + GAP
}

/** Precomputed deterministic lanes make seeking/looping identical to linear playback. */
export function layoutDanmaku(
  comments: readonly DanmakuComment[],
  width: number,
  height: number,
  options: Required<DanmakuOptions>,
  measure: (text: string, fontSize: number) => number,
): DanmakuLayoutItem[] {
  if (width <= 0 || height <= 0 || options.area <= 0) return []
  const result: DanmakuLayoutItem[] = []
  let active: DanmakuLayoutItem[] = []
  const availableHeight = height * options.area
  const step = Math.max(12, 32 * options.fontScale)
  for (const comment of [...comments].sort((a, b) => a.time - b.time)) {
    if (!Number.isFinite(comment.time) || comment.time < 0 || ![1, 2, 3, 4, 5, 6, 7].includes(comment.mode)) continue
    const advanced = comment.mode === 7 ? parseAdvancedDanmaku(comment.text) : null
    if (comment.mode === 7 && !advanced) continue
    active = active.filter((item) => item.end > comment.time)
    if (active.length >= MAX_ACTIVE_DANMAKU) continue
    const text = (advanced?.text ?? comment.text).slice(0, MAX_TEXT_LENGTH)
    if (!text) continue
    const fontSize = clamp(finite(comment.fontSize, 25), 8, 96) * options.fontScale
    const lines = text.split(/\r?\n/).slice(0, 16)
    const item: DanmakuLayoutItem = {
      comment,
      text: lines.join('\n'),
      start: comment.time,
      end: comment.time + (advanced?.duration ?? ([4, 5].includes(comment.mode) ? 4 : 8)),
      width: Math.max(...lines.map((line) => measure(line, fontSize))),
      height: lines.length * fontSize * 1.25,
      fontSize,
      y: 0,
      advanced,
    }
    let placed = !!advanced
    if (!advanced) {
      const slots = Math.min(128, Math.floor((availableHeight - item.height) / step) + 1)
      for (let lane = 0; lane < slots; lane++) {
        item.y = comment.mode === 4 ? availableHeight - item.height - lane * step : lane * step
        if (active.every((other) => other.advanced || !lanesCollide(item, other, width))) {
          placed = true
          break
        }
      }
    }
    if (placed) {
      result.push(item)
      active.push(item)
    }
  }
  return result
}

function lowerBound(items: DanmakuLayoutItem[], time: number): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (items[mid].start < time) low = mid + 1
    else high = mid
  }
  return low
}

export class DanmakuRenderer {
  private readonly context: CanvasRenderingContext2D | null
  private options: Required<DanmakuOptions> = { opacity: 0.85, fontScale: 1, area: 1 }
  private comments: DanmakuComment[] = []
  private layout: DanmakuLayoutItem[] = []
  private active: DanmakuLayoutItem[] = []
  private cursor = 0
  private lastTime = -Infinity
  private width = 0
  private height = 0
  private dpr = 1
  private raf: number | null = null
  private destroyed = false
  private readonly observer: ResizeObserver | null
  private dprQuery: MediaQueryList | null = null
  private readonly events = [
    'play',
    'playing',
    'pause',
    'ended',
    'seeking',
    'seeked',
    'timeupdate',
    'loadedmetadata',
    'emptied',
  ] as const

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly video: HTMLVideoElement,
  ) {
    this.context = canvas.getContext('2d')
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(this.resize)
    this.observer?.observe(canvas)
    window.addEventListener('resize', this.resize)
    for (const event of this.events) video.addEventListener(event, this.onVideoEvent)
    this.watchDpr()
    this.resize()
    this.schedule()
  }

  setComments(comments: DanmakuComment[]): void {
    if (this.destroyed) return
    this.comments = comments.map((comment) => ({ ...comment }))
    this.rebuild()
  }

  setOptions(options: DanmakuOptions): void {
    if (this.destroyed) return
    const previous = this.options
    this.options = {
      opacity: clamp(finite(options.opacity, previous.opacity), 0, 1),
      fontScale: clamp(finite(options.fontScale, previous.fontScale), 0.25, 4),
      area: clamp(finite(options.area, previous.area), 0, 1),
    }
    if (this.options.fontScale !== previous.fontScale || this.options.area !== previous.area) this.rebuild()
    else this.render()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stop()
    this.observer?.disconnect()
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    window.removeEventListener('resize', this.resize)
    for (const event of this.events) this.video.removeEventListener(event, this.onVideoEvent)
    this.comments = []
    this.layout = []
    this.active = []
    this.context?.clearRect(0, 0, this.width, this.height)
  }

  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    this.dprQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
        : null
    this.dprQuery?.addEventListener('change', this.onDprChange)
  }

  private readonly onDprChange = () => {
    this.watchDpr()
    this.resize()
  }

  private readonly resize = () => {
    if (this.destroyed) return
    const rect = this.canvas.getBoundingClientRect()
    const width = Math.max(0, rect.width)
    const height = Math.max(0, rect.height)
    const dpr = Math.max(0.1, window.devicePixelRatio || 1)
    const changed = width !== this.width || height !== this.height
    if (!changed && this.dpr === dpr) return
    this.width = width
    this.height = height
    this.dpr = dpr
    this.canvas.width = Math.round(width * dpr)
    this.canvas.height = Math.round(height * dpr)
    this.context?.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (changed) this.rebuild()
    else this.render()
  }

  private rebuild(): void {
    const ctx = this.context
    if (!ctx) return
    this.layout = layoutDanmaku(this.comments, this.width, this.height, this.options, (text, size) => {
      ctx.font = `bold ${size}px ${FONT}`
      return ctx.measureText(text).width
    })
    this.lastTime = -Infinity
    this.render()
  }

  private readonly onVideoEvent = (event: Event) => {
    if (this.destroyed) return
    if (event.type === 'seeking' || event.type === 'seeked' || event.type === 'emptied') this.lastTime = -Infinity
    this.render()
    if (this.video.paused || this.video.ended || this.video.seeking) this.stop()
    else this.schedule()
  }

  private stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
  }

  private schedule(): void {
    if (
      this.destroyed ||
      !this.context ||
      this.raf !== null ||
      this.video.paused ||
      this.video.ended ||
      this.video.seeking
    )
      return
    this.raf = requestAnimationFrame(this.tick)
  }

  private readonly tick = () => {
    this.raf = null
    if (this.destroyed) return
    if (this.dpr !== Math.max(0.1, window.devicePixelRatio || 1)) this.resize()
    this.render()
    this.schedule()
  }

  private render(): void {
    const ctx = this.context
    if (!ctx || this.destroyed) return
    const time = finite(this.video.currentTime, 0)
    if (time < this.lastTime || time - this.lastTime > 1) {
      this.active = []
      this.cursor = lowerBound(this.layout, time - MAX_LIFETIME)
    } else {
      this.active = this.active.filter((item) => item.end > time)
    }
    while (this.cursor < this.layout.length && this.layout[this.cursor].start <= time) {
      const item = this.layout[this.cursor++]
      if (item.end > time && this.active.length < MAX_ACTIVE_DANMAKU) this.active.push(item)
    }
    this.lastTime = time
    ctx.clearRect(0, 0, this.width, this.height)
    if (!this.options.opacity) return
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    for (const item of this.active) {
      ctx.save()
      ctx.font = `bold ${item.fontSize}px ${FONT}`
      ctx.fillStyle = `#${(finite(item.comment.color, 0xffffff) & 0xffffff).toString(16).padStart(6, '0')}`
      ctx.strokeStyle = '#000000'
      ctx.lineWidth = Math.max(2, item.fontSize / 12)
      ctx.globalAlpha = this.options.opacity
      if (item.advanced) {
        const position = advancedPosition(item.advanced, time - item.start, this.width, this.height)
        ctx.globalAlpha *= position.opacity
        ctx.translate(position.x, position.y)
        ctx.rotate((item.advanced.rotateZ * Math.PI) / 180)
        // Canvas 2D orthographic approximation, not CSS perspective/3D projection.
        ctx.scale(Math.cos((item.advanced.rotateY * Math.PI) / 180), 1)
      } else {
        ctx.translate(danmakuX(item, time, this.width), item.y)
      }
      for (const [index, line] of item.text.split('\n').entries()) {
        const y = index * item.fontSize * 1.25
        if (!item.advanced || item.advanced.outline) ctx.strokeText(line, 0, y)
        ctx.fillText(line, 0, y)
      }
      ctx.restore()
    }
  }
}
