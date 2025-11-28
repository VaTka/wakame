import React, { useEffect, useRef } from 'react'

const DEBUG = true;
const dlog = (...args: any[]) => { if (DEBUG) console.log('[CHART]', ...args); };

type Props = {
  labels: string[]
  values: number[]
  upperLimit?: number
  lowerLimit?: number
  showPointTimes?: boolean
  target?: number
}

export default function Chart({ labels, values, upperLimit, lowerLimit, showPointTimes, target }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    dlog('render start', { labelsLen: labels.length, valuesLen: values.length, upperLimit, lowerLimit, target, showPointTimes });
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // --- HiDPI/Retina ---
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const cssW = canvas.clientWidth || 900
    const cssH = canvas.clientHeight || 280
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr)
      canvas.height = Math.floor(cssH * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = cssW, h = cssH

    const L = 48, R = 16, T = 12, B = 24
    const PW = Math.max(1, w - L - R) // plot width
    const PH = Math.max(1, h - T - B) // plot height

    ctx.clearRect(0, 0, w, h)

    ctx.strokeStyle = '#1c2430'
    for (let i = 0; i <= 5; i++) {
      const y = T + (i * PH) / 5
      ctx.beginPath()
      ctx.moveTo(L, y)
      ctx.lineTo(w - R, y)
      ctx.stroke()
    }
    ctx.strokeStyle = '#98a6b3'
    ctx.beginPath()
    ctx.moveTo(L, T); ctx.lineTo(L, h - B)
    ctx.moveTo(L, h - B); ctx.lineTo(w - R, h - B)
    ctx.stroke()

    // --- DATA ---
    const data: { t: string; v: number }[] = labels.map((t, i) => ({ t, v: Number(values[i]) }))
      .filter(d => Number.isFinite(d.v));
    if (data.length === 0) return;
    dlog('data built', { count: data.length, first: data[0], last: data[data.length - 1] });

    const nums = data.map(d => d.v);

    let minY = Math.min(...nums)
    let maxY = Math.max(...nums)
    dlog('value stats', { min: minY, max: maxY });

    if (typeof upperLimit === 'number') maxY = Math.max(maxY, upperLimit)
    if (typeof lowerLimit === 'number') minY = Math.min(minY, lowerLimit)

    const hasTargetProp = typeof target === 'number' && Number.isFinite(target)
    const targetY = hasTargetProp
      ? target as number
      : (typeof upperLimit === 'number' && typeof lowerLimit === 'number'
        ? (upperLimit + lowerLimit) / 2
        : undefined)

    if (typeof targetY === 'number' && !(typeof upperLimit === 'number' && typeof lowerLimit === 'number')) {
      minY = Math.min(minY, targetY)
      maxY = Math.max(maxY, targetY)
    }


    let yMin: number, yMax: number

    if (typeof upperLimit === 'number' && typeof lowerLimit === 'number') {
      const range = upperLimit - lowerLimit
      const margin = range * 0.2
      yMin = lowerLimit - margin
      yMax = upperLimit + margin
    } else {

      const span = Math.max(1e-6, maxY - minY)
      let pad: number
      if (span < 2) pad = 0.2
      else if (span < 10) pad = span * 0.05
      else pad = span * 0.1
      yMin = minY - pad
      yMax = maxY + pad
    }
    dlog('y-scale', { yMin, yMax });

    const ySpan = Math.max(1e-6, yMax - yMin)

    const mapX = (i: number, n: number) => L + (n <= 1 ? PW / 2 : (i / (n - 1)) * PW)
    const mapY = (v: number) => {
      const r = (v - yMin) / ySpan
      return T + (1 - r) * PH
    }

    if (typeof upperLimit === 'number') {
      const yU = mapY(upperLimit)
      ctx.fillStyle = 'rgba(255, 0, 0, 0.08)'
      ctx.fillRect(L, T, PW, Math.max(0, yU - T))
    }
    if (typeof lowerLimit === 'number') {
      const yL = mapY(lowerLimit)
      ctx.fillStyle = 'rgba(255, 165, 0, 0.08)'
      ctx.fillRect(L, yL, PW, (h - B) - yL)
    }

    if (typeof targetY === 'number' && Number.isFinite(targetY)) {
      const yT = mapY(targetY)
      ctx.save()
      ctx.strokeStyle = '#34d399'
      ctx.lineWidth = 1.5
      ctx.setLineDash([2, 2])
      ctx.beginPath()
      ctx.moveTo(L, yT)
      ctx.lineTo(w - R, yT)
      ctx.stroke()

      ctx.fillStyle = '#34d399'
      ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial'
      ctx.fillText(`目標 ${targetY.toFixed(1)} g`, w - R - 140, yT - 6)
      ctx.restore()
    }


    ctx.save()
    ctx.setLineDash([6, 4])

    if (typeof upperLimit === 'number') {
      const yU = mapY(upperLimit)
      ctx.strokeStyle = '#ff6b6b'
      ctx.beginPath(); ctx.moveTo(L, yU); ctx.lineTo(w - R, yU); ctx.stroke()
      ctx.fillStyle = '#ff6b6b'
      ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial'
      ctx.fillText(`上限 ${upperLimit.toFixed(1)} g`, w - R - 140, yU - 6)
    }

    if (typeof lowerLimit === 'number') {
      const yL = mapY(lowerLimit)
      ctx.strokeStyle = '#ffc061'
      ctx.beginPath(); ctx.moveTo(L, yL); ctx.lineTo(w - R, yL); ctx.stroke()
      ctx.fillStyle = '#ffc061'
      ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial'
      ctx.fillText(`下限 ${lowerLimit.toFixed(1)} g`, w - R - 140, yL - 6)
    }

    ctx.restore()
    ctx.setLineDash([])

    ctx.beginPath()
    const n = nums.length
    dlog('draw line', { n });
    for (let i = 0; i < n; i++) {
      const v = data[i].v;
      const x = mapX(i, n)
      const y = mapY(v)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#4da3ff'
    ctx.stroke()

    const maxDots = 800;
    const stepDots = Math.max(1, Math.ceil(n / maxDots));

    for (let i = 0; i < n; i += stepDots) {
      const v = data[i].v;
      const x = mapX(i, n);
      const y = mapY(v);
      if (i % 100 === 0 || i === n - 1) dlog('dot', { i, v, x, y });

      const hasUpper = typeof upperLimit === 'number' && Number.isFinite(upperLimit);
      const hasLower = typeof lowerLimit === 'number' && Number.isFinite(lowerLimit);
      const hasTarget = typeof targetY === 'number' && Number.isFinite(targetY);

      const outHigh = hasUpper && v > (upperLimit as number);
      const outLow = hasLower && v < (lowerLimit as number);

      let fill = '#7dd3fc';
      if (outHigh) {
        fill = '#ff6b6b';
      }
      else if (outLow) {
        fill = '#ffc061';
      }
      else if (hasTarget) {
        if (v > (targetY as number)) fill = '#a78bfa';
        else if (v < (targetY as number)) fill = '#0ea5e9';
        else if (v == (targetY as number)) fill = '#EFBF04';
      }

      const radius = (outHigh || outLow) ? 3.8 : 3.2;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();

      const text = `${v.toFixed(1)} g`;

      let ty = y + 3 * 6;
      const bottomLimit = h - B;
      const lineH = 12;

      ctx.font = '10px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial';

      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(text, x, ty);

      ctx.fillText(text, x, ty);
    }


    ctx.fillStyle = '#98a6b3'
    ctx.font = '10px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial'
    const step = Math.max(1, Math.ceil(data.length / 6));
    dlog('x labels', { step, total: data.length });
    for (let i = 0; i < data.length; i += step) {
      const x = mapX(i, data.length);
      ctx.fillText(data[i]?.t ?? '', x - 20, h - 6);
    }
    if (data.length > 1) {
      const xLast = mapX(data.length - 1, data.length);
      ctx.fillText(data[data.length - 1]?.t ?? '', xLast - 20, h - 6);
    }

    if (showPointTimes) {
      const font = '10px Menlo, Consolas, monospace';
      ctx.font = font;

      const maxLabels = 800;
      const stepLbl = Math.max(1, Math.ceil(n / maxLabels));

      for (let i = 0; i < n; i += stepLbl) {
        const v = data[i].v;
        const x = mapX(i, n);
        const y = mapY(v);

        let text = String(data[i]?.t ?? '');
        const parsed = Date.parse(text);
        if (!Number.isNaN(parsed)) {
          const d = new Date(parsed);
          text = d.toLocaleTimeString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
        }
        if (!text) continue;

        const padX = 3, padY = 2;
        const tw = ctx.measureText(text).width;
        const th = 12;

        let tx = x + 6;
        let ty = y - 6;

        const L = 48, R = 16, T = 12, B = 24;
        const w = canvas.width / (window.devicePixelRatio || 1);
        const h = canvas.height / (window.devicePixelRatio || 1);
        const boxW = tw + padX * 2;
        const boxH = th + padY * 2;

        if (tx + boxW > w - R) tx = x - 6 - boxW;
        if (ty - boxH < T) ty = y + 6 + boxH;

        ctx.fillStyle = 'rgba(15,21,29,0.85)';
        ctx.fillRect(tx, ty - boxH, boxW, boxH);

        ctx.strokeStyle = 'rgba(152,166,179,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx, ty - boxH, boxW, boxH);

        ctx.fillStyle = '#e6eef7';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, tx + padX, ty - padY);
      }
    }
    dlog('render end');

  }, [labels, values, upperLimit, lowerLimit, target, showPointTimes])

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: '100%', height: 280,
        background: '#0f141b',
        borderRadius: 12,
        border: '1px solid #1c2430',
        display: 'block'
      }}
    />
  )
}
