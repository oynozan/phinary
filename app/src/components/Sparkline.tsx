import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'

export interface SparkPoint {
  t: number
  v: number
}

interface Props {
  points: SparkPoint[]
  /** Time domain; the line fills it as the market progresses. */
  t0: number
  t1: number
  /** Fixed value domain, or padded around the data when omitted. */
  yDomain?: [number, number]
  reference?: { value: number; label: string }
  /** Vertical marker, e.g. the trading cutoff. */
  marker?: { t: number; label: string }
  color: string
  format: (v: number) => string
  formatTime: (t: number) => string
  label: string
  empty?: string
}

const PAD_TOP = 8
const PAD_BOTTOM = 6
const PAD_RIGHT = 4

export function Sparkline({ points, t0, t1, yDomain, reference, marker, color, format, formatTime, label, empty }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 300, h: 96 })
  const [hover, setHover] = useState<number | undefined>()

  useEffect(() => {
    const el = box.current
    if (!el) {
      return
    }
    const ro = new ResizeObserver(([entry]) => {
      if (entry) {
        setSize({ w: Math.max(40, entry.contentRect.width), h: Math.max(40, entry.contentRect.height) })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const visible = useMemo(() => points.filter((p) => p.t >= t0 && p.t <= t1 && Number.isFinite(p.v)), [points, t0, t1])

  const [y0, y1] = useMemo((): [number, number] => {
    if (yDomain) {
      return yDomain
    }
    const vals = visible.map((p) => p.v)
    if (reference) {
      vals.push(reference.value)
    }
    if (!vals.length) {
      return [0, 1]
    }
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.0002, 1e-9)
    return [lo - pad, hi + pad]
  }, [visible, yDomain, reference])

  const { w, h } = size
  const span = Math.max(1, t1 - t0)
  const x = (t: number) => ((t - t0) / span) * (w - PAD_RIGHT)
  const y = (v: number) => PAD_TOP + (1 - (v - y0) / (y1 - y0 || 1)) * (h - PAD_TOP - PAD_BOTTOM)

  const path = visible.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const last = visible[visible.length - 1]
  const hovered = hover !== undefined ? visible[hover] : undefined

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!visible.length) {
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - rect.left) / (w - PAD_RIGHT)) * span
    let best = 0
    for (let i = 1; i < visible.length; i++) {
      if (Math.abs((visible[i] as SparkPoint).t - t) < Math.abs((visible[best] as SparkPoint).t - t)) {
        best = i
      }
    }
    setHover(best)
  }

  return (
    <div className="spark" ref={box}>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={last ? `${label}, latest ${format(last.v)}` : label}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(undefined)}
      >
        <line x1={0} x2={w} y1={h - PAD_BOTTOM} y2={h - PAD_BOTTOM} stroke="var(--chart-grid)" strokeWidth={1} />
        {reference && reference.value >= y0 && reference.value <= y1 && (
          <g>
            <line
              x1={0}
              x2={w}
              y1={y(reference.value)}
              y2={y(reference.value)}
              stroke="var(--chart-ref)"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
            <text x={w - PAD_RIGHT} y={y(reference.value) - 4} fontSize={10} fill="var(--text-3)" textAnchor="end">
              {reference.label}
            </text>
          </g>
        )}
        {marker && marker.t > t0 && marker.t < t1 && (
          <g>
            <line
              x1={x(marker.t)}
              x2={x(marker.t)}
              y1={PAD_TOP}
              y2={h - PAD_BOTTOM}
              stroke="var(--chart-ref)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            <text x={x(marker.t) + 4} y={PAD_TOP + 8} fontSize={10} fill="var(--text-3)">
              {marker.label}
            </text>
          </g>
        )}
        {path && (
          <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {last && !hovered && (
          <circle cx={x(last.t)} cy={y(last.v)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
        )}
        {hovered && (
          <g>
            <line
              x1={x(hovered.t)}
              x2={x(hovered.t)}
              y1={PAD_TOP}
              y2={h - PAD_BOTTOM}
              stroke="var(--text-3)"
              strokeWidth={1}
            />
            <circle cx={x(hovered.t)} cy={y(hovered.v)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hovered && (
        <div className="spark-tip" style={{ left: Math.min(Math.max(x(hovered.t), 50), w - 50) }}>
          {format(hovered.v)} · {formatTime(hovered.t)}
        </div>
      )}
      {!visible.length && <div className="spark-empty">{empty ?? 'Collecting live data…'}</div>}
    </div>
  )
}
