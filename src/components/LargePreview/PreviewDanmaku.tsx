import { useEffect, useRef, useState, type RefObject } from 'react'
import { useSnapshot } from 'valtio'
import { settings } from '$modules/settings'
import { loadDanmakuSegment, resolveDanmakuCid, type DanmakuComment } from './danmaku-data'
import { DanmakuRenderer } from './danmaku-renderer'

/** Mounted only while the preview is visible. No requests are made by idle cards. */
export function PreviewDanmaku({
  videoRef,
  bvid,
  cid,
}: {
  videoRef: RefObject<HTMLVideoElement | null>
  bvid: string
  cid?: number
}) {
  const options = useSnapshot(settings.videoCard.videoPreview.danmaku)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<DanmakuRenderer | null>(null)
  const [status, setStatus] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!options.enabled || !video || !canvas) {
      setStatus('')
      return
    }
    const renderer = new DanmakuRenderer(canvas, video)
    rendererRef.current = renderer
    renderer.setOptions(settings.videoCard.videoPreview.danmaku)
    const lifetime = new AbortController()
    const segments = new Map<number, DanmakuComment[]>()
    const pending = new Map<number, AbortController>()
    const failures = new Map<number, number>()
    let resolvedCid = cid
    let wanted = new Set<number>()
    let disposed = false

    const currentSegment = () => {
      const current = Math.floor(Math.max(0, video.currentTime) / 360) + 1
      return Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(current, Math.ceil(video.duration / 360))
        : current
    }
    const updateStatus = () => {
      if (disposed) return
      const current = currentSegment()
      setStatus(
        segments.has(current)
          ? segments.get(current)!.length
            ? ''
            : '当前分段暂无弹幕'
          : failures.has(current)
            ? '弹幕加载失败，点击重试'
            : '弹幕加载中…',
      )
    }
    const publish = () => {
      if (disposed) return
      renderer.setComments([...segments.values()].flat().sort((a, b) => a.time - b.time))
      updateStatus()
    }
    const sync = () => {
      if (disposed || !resolvedCid) return
      const current = currentSegment()
      const last = Number.isFinite(video.duration) && video.duration > 0 ? Math.ceil(video.duration / 360) : current + 1
      // Previous segment preserves comments crossing a segment boundary; prefetch the next.
      wanted = new Set([current, current - 1, current + 1].filter((n) => n > 0 && n <= last))
      let removed = false
      for (const n of segments.keys()) {
        if (!wanted.has(n)) {
          segments.delete(n)
          removed = true
        }
      }
      for (const [n, controller] of pending) {
        if (!wanted.has(n)) {
          controller.abort()
          pending.delete(n)
        }
      }
      for (const n of failures.keys()) if (!wanted.has(n)) failures.delete(n)
      if (removed) publish()
      for (const n of wanted) {
        if (segments.has(n) || pending.has(n) || Date.now() - (failures.get(n) ?? 0) < 15000) continue
        const controller = new AbortController()
        pending.set(n, controller)
        void loadDanmakuSegment(resolvedCid, n, controller.signal)
          .then((comments) => {
            if (disposed || controller.signal.aborted || !wanted.has(n)) return
            segments.set(n, comments)
            failures.delete(n)
            publish()
          })
          .catch(() => {
            if (disposed || controller.signal.aborted) return
            failures.set(n, Date.now())
          })
          .finally(() => {
            if (pending.get(n) === controller) pending.delete(n)
            updateStatus()
          })
      }
      updateStatus()
    }
    setStatus('弹幕加载中…')
    if (resolvedCid) sync()
    else
      void resolveDanmakuCid(bvid, lifetime.signal)
        .then((value) => {
          if (disposed) return
          resolvedCid = value
          sync()
        })
        .catch(() => {
          if (!disposed) setStatus('弹幕加载失败，点击重试')
        })
    video.addEventListener('timeupdate', sync)
    video.addEventListener('seeking', sync)
    video.addEventListener('loadedmetadata', sync)
    return () => {
      disposed = true
      lifetime.abort()
      for (const controller of pending.values()) controller.abort()
      video.removeEventListener('timeupdate', sync)
      video.removeEventListener('seeking', sync)
      video.removeEventListener('loadedmetadata', sync)
      renderer.destroy()
      rendererRef.current = null
    }
  }, [bvid, cid, options.enabled, retry, videoRef])

  useEffect(() => {
    rendererRef.current?.setOptions({ opacity: options.opacity, fontScale: options.fontScale, area: options.area })
  }, [options.opacity, options.fontScale, options.area])

  return (
    <>
      <canvas
        ref={canvasRef}
        aria-hidden='true'
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          display: options.enabled ? 'block' : 'none',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 12,
          maxWidth: '70%',
          color: 'white',
          fontSize: 12,
          textShadow: '0 1px 3px black',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <details>
          <summary
            style={{
              cursor: 'pointer',
              width: 'fit-content',
              background: '#0009',
              borderRadius: 4,
              padding: '3px 8px',
            }}
          >
            弹幕{options.enabled ? '开' : '关'}
          </summary>
          <div style={{ display: 'grid', gap: 8, padding: 10, background: '#111e', borderRadius: 6 }}>
            <label>
              <input
                type='checkbox'
                checked={options.enabled}
                onChange={(e) => {
                  settings.videoCard.videoPreview.danmaku.enabled = e.target.checked
                }}
              />{' '}
              显示弹幕
            </label>
            <label>
              不透明度{' '}
              <input
                aria-label='弹幕不透明度'
                type='range'
                min='0.1'
                max='1'
                step='0.05'
                value={options.opacity}
                onChange={(e) => {
                  settings.videoCard.videoPreview.danmaku.opacity = Number(e.target.value)
                }}
              />
            </label>
            <label>
              字号{' '}
              <input
                aria-label='弹幕字号'
                type='range'
                min='0.5'
                max='2'
                step='0.1'
                value={options.fontScale}
                onChange={(e) => {
                  settings.videoCard.videoPreview.danmaku.fontScale = Number(e.target.value)
                }}
              />
            </label>
            <label>
              显示区域{' '}
              <select
                aria-label='弹幕显示区域'
                value={options.area}
                onChange={(e) => {
                  settings.videoCard.videoPreview.danmaku.area = Number(e.target.value)
                }}
              >
                <option value={0.25}>四分之一</option>
                <option value={0.5}>半屏</option>
                <option value={0.75}>四分之三</option>
                <option value={1}>全屏</option>
              </select>
            </label>
            <span>支持滚动、顶/底部、逆向和定位弹幕；不执行代码/BAS 弹幕。</span>
          </div>
        </details>
        {options.enabled && status && (
          <button
            type='button'
            style={{ marginTop: 4, background: '#0009', color: 'white', border: 0, borderRadius: 4, cursor: 'pointer' }}
            onClick={() => setRetry((n) => n + 1)}
          >
            {status}
          </button>
        )}
      </div>
    </>
  )
}
