import React, { useEffect, useRef } from 'react'

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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // масштаб у CSS-пікселі
    const w = cssW, h = cssH

    // --- внутрішня область графіка ---
    const L = 48, R = 16, T = 12, B = 24
    const PW = Math.max(1, w - L - R) // plot width
    const PH = Math.max(1, h - T - B) // plot height

    // фон
    ctx.clearRect(0, 0, w, h)

    // сітка
    ctx.strokeStyle = '#1c2430'
    for (let i = 0; i <= 5; i++) {
      const y = T + (i * PH) / 5
      ctx.beginPath()
      ctx.moveTo(L, y)
      ctx.lineTo(w - R, y)
      ctx.stroke()
    }
    // осі (ліворуч і внизу)
    ctx.strokeStyle = '#98a6b3'
    ctx.beginPath()
    ctx.moveTo(L, T); ctx.lineTo(L, h - B)
    ctx.moveTo(L, h - B); ctx.lineTo(w - R, h - B)
    ctx.stroke()

    // --- дані ---

    const now = Date.now();
    const tenMinAgo = now - 1 * 60 * 1000;

    const filtered: { t: string; v: number }[] = [];

    for (let i = 0; i < labels.length; i++) {
      const ts = new Date(labels[i]).getTime();
      if (!isNaN(ts) && ts >= tenMinAgo) {
        filtered.push({ t: labels[i], v: values[i] });
      }
    }

    // якщо дані після фільтрації є — використовуємо їх
    const labels10 = filtered.length ? filtered.map(f => f.t) : labels;
    const values10 = filtered.length ? filtered.map(f => f.v) : values;


    // const nums = values.map(Number).filter(v => Number.isFinite(v))
    const nums = values10.map(Number).filter(v => Number.isFinite(v));
    if (nums.length === 0) return

    // --- адаптивне масштабування з урахуванням порогів ---
    let minY = Math.min(...nums)
    let maxY = Math.max(...nums)

    // включаємо порогові значення в розрахунок
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
      // якщо є обидва пороги — масштабуємось навколо них
      const range = upperLimit - lowerLimit
      const margin = range * 0.2   // трішки запасу зверху/знизу
      yMin = lowerLimit - margin
      yMax = upperLimit + margin
    } else {
      // fallback якщо порогів немає
      const span = Math.max(1e-6, maxY - minY)
      let pad: number
      if (span < 2) pad = 0.2
      else if (span < 10) pad = span * 0.05
      else pad = span * 0.1
      yMin = minY - pad
      yMax = maxY + pad
    }

    const ySpan = Math.max(1e-6, yMax - yMin)

    const mapX = (i: number, n: number) => L + (n <= 1 ? PW / 2 : (i / (n - 1)) * PW)
    const mapY = (v: number) => {
      const r = (v - yMin) / ySpan
      return T + (1 - r) * PH
    }

    // --- підсвічування зон ---
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

    // --- лінія цільового значення ---
    if (typeof targetY === 'number' && Number.isFinite(targetY)) {
      const yT = mapY(targetY)
      ctx.save()
      ctx.strokeStyle = '#34d399'           // спокійний зелений
      ctx.lineWidth = 1.5
      ctx.setLineDash([2, 2])               // відрізняється від меж ([6,4])
      ctx.beginPath()
      ctx.moveTo(L, yT)
      ctx.lineTo(w - R, yT)
      ctx.stroke()

      // підпис на правому краї
      ctx.fillStyle = '#34d399'
      ctx.font = '11px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial'
      ctx.fillText(`目標 ${targetY.toFixed(1)} g`, w - R - 140, yT - 6)
      ctx.restore()
    }


    // --- порогові лінії (пунктир) ---
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

    ctx.restore()         // скинути пунктир
    ctx.setLineDash([])

    // --- основна лінія (малюємо ОСТАННЬОЮ) ---
    ctx.beginPath()
    const n = nums.length
    nums.forEach((v, i) => {
      const x = mapX(i, n)
      const y = mapY(v)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#4da3ff'
    ctx.stroke()

    // точки (зональне фарбування відносно target / меж)
    const maxDots = 800;
    const stepDots = Math.max(1, Math.ceil(n / maxDots));

    for (let i = 0; i < n; i += stepDots) {
      const v = nums[i];
      const x = mapX(i, n);
      const y = mapY(v);

      const hasUpper = typeof upperLimit === 'number' && Number.isFinite(upperLimit);
      const hasLower = typeof lowerLimit === 'number' && Number.isFinite(lowerLimit);
      const hasTarget = typeof targetY === 'number' && Number.isFinite(targetY);

      const outHigh = hasUpper && v > (upperLimit as number);
      const outLow = hasLower && v < (lowerLimit as number);
      const match = hasTarget && v == (lowerLimit as number);


      // класи зони: поза межами / між target і upper / між lower і target / нейтрал
      let fill = '#7dd3fc'; // дефолт (в межах і без target)
      if (outHigh) {
        fill = '#ff6b6b';
      }
      else if (outLow) {
        fill = '#ffc061';
      }
      else if (hasTarget) {
        if (v > (targetY as number)) fill = '#a78bfa';   // ↑ вища за ціль, але в межах (фіолетовий)
        else if (v < (targetY as number)) fill = '#0ea5e9'; // ↓ нижча за ціль, але в межах (блакитний)
        else if (v == (targetY as number)) fill = '#EFBF04'; // 
      }

      const radius = (outHigh || outLow) ? 3.8 : 3.2;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();

      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.stroke();

      // --- підпис ваги під точкою ---
      // текст: одна десяткова + "g" (можеш прибрати "g", якщо не треба)
      const text = `${v.toFixed(1)} g`;

      // позиція підпису (під точкою, але не виходимо за низом графіка)
      let ty = y + 3*6;
      const bottomLimit = h - B;                    // низ поля побудови
      const lineH = 12;                             // висота рядка для 10px
      // if (ty + lineH > bottomLimit) ty = y - 6 - lineH;  // якщо не влазить знизу — малюємо над точкою

      // легкий "halo" для читабельності: спочатку strokeText темним, потім fillText світлим
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(text, x, ty);

      // ctx.fillStyle = '#e6eef7';
      ctx.fillText(text, x, ty);
    }


    // --- X-підписи (рідше) ---
    ctx.fillStyle = '#98a6b3'
    ctx.font = '10px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial'
    const step = Math.max(1, Math.ceil(labels10.length / 6));
    for (let i = 0; i < labels10.length; i += step) {
      const x = mapX(i, labels10.length);
      ctx.fillText(labels10[i] ?? '', x - 20, h - 6);
    }
    // останній підпис
    if (labels.length > 1) {
      const xLast = mapX(labels.length - 1, labels.length)
      ctx.fillText(labels[labels.length - 1] ?? '', xLast - 20, h - 6)
    }

    // --- підписи часу біля точок (опційно) ---
    if (showPointTimes) {
      const font = '10px Menlo, Consolas, monospace';
      ctx.font = font;

      // обмежимо кількість підписів, щоб не вбити FPS на дуже довгих серіях
      const maxLabels = 800;
      const stepLbl = Math.max(1, Math.ceil(n / maxLabels));

      for (let i = 0; i < n; i += stepLbl) {
        const v = nums[i];
        const x = mapX(i, n);
        const y = mapY(v);

        let text = String(labels[i] ?? '');
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

        // виміряємо ширину для фонового бейджа
        const padX = 3, padY = 2;
        const tw = ctx.measureText(text).width;
        const th = 12; // приблизна висота рядка для 10px

        // позиція підпису (трохи справа-вище точки)
        let tx = x + 6;
        let ty = y - 6;

        // не виходити за межі полотна
        const L = 48, R = 16, T = 12, B = 24;
        const w = canvas.width / (window.devicePixelRatio || 1);
        const h = canvas.height / (window.devicePixelRatio || 1);
        const boxW = tw + padX * 2;
        const boxH = th + padY * 2;

        if (tx + boxW > w - R) tx = x - 6 - boxW;   // якщо не влазить праворуч — малюємо зліва
        if (ty - boxH < T) ty = y + 6 + boxH;   // якщо не влазить зверху — малюємо під точкою

        // фоновий бейдж
        ctx.fillStyle = 'rgba(15,21,29,0.85)'; // темний напівпрозорий
        ctx.fillRect(tx, ty - boxH, boxW, boxH);

        // рамка (легка)
        ctx.strokeStyle = 'rgba(152,166,179,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(tx, ty - boxH, boxW, boxH);

        // сам текст
        ctx.fillStyle = '#e6eef7';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, tx + padX, ty - padY);
      }
    }



  }, [labels, values, upperLimit, lowerLimit])

  // ширину краще віддати на розсуд контейнера
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
