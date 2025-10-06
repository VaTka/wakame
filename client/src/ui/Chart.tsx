
import React, { useEffect, useRef } from 'react'

export default function Chart({ labels, values }: { labels: string[], values: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.width, h = canvas.height
    ctx.clearRect(0, 0, w, h)

    // grid
    ctx.strokeStyle = '#1c2430'
    for (let i = 0; i < 6; i++) {
      const y = i * (h / 5)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }

    if (values.length === 0) return

    const minY = Math.min(...values)
    const maxY = Math.max(...values)
    const padY = (maxY - minY) * 0.1 || 1
    const yMin = minY - padY
    const yMax = maxY + padY

    // line
    ctx.beginPath()
    const n = Math.max(values.length, 1)
    values.forEach((v, i) => {
      const x = (i / (n - 1)) * (w - 20) + 10
      const yNorm = (v - yMin) / (yMax - yMin)
      const y = h - (yNorm * (h - 20)) - 10
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.lineWidth = 2
    ctx.strokeStyle = '#4da3ff'
    ctx.stroke()

    // sparse x labels
    ctx.fillStyle = '#98a6b3'
    ctx.font = '10px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial'
    const step = Math.ceil(labels.length / 6)
    labels.forEach((lab, i) => {
      if (i % step === 0 || i === labels.length - 1) {
        const x = (i / (labels.length - 1 || 1)) * (w - 20) + 10
        ctx.fillText(lab, x - 20, h - 2)
      }
    })
  }, [labels, values])

  return <canvas ref={canvasRef} width={900} height={280} style={{ background: '#0f141b', borderRadius: 12, border: '1px solid #1c2430', display:'block' }} />
}
