import React, { useEffect, useMemo, useState } from 'react'
import { fetchAggregates, fetchLatest, fetchRecent, type Measurement, formatJP, fmt1, fetchMeasurements } from '../api'
import Chart from './Chart'
import './styles.css'

const DEBUG = true;
const dlog = (...args: any[]) => { if (DEBUG) console.log('[APP]', ...args); };

// Backend returns timestamps like "YYYY-MM-DD HH:mm:ss" in UTC. Parse as UTC.
function parseUtcMs(ts: string): number {
  if (!ts) return NaN;
  // Normalize: "2025-10-24 04:47:02" -> "2025-10-24T04:47:02Z"
  const iso = ts.includes('T') ? ts.replace(' ', 'T').replace(/$/,'Z') : ts.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return ms;
}

// Bucket raw measurements into fixed-minute intervals (UTC-based) with average per bucket.
function bucketize(meas: { ts: string; weight: number }[], stepMin: number, windowMin: number) {
  const now = Date.now();
  const fromMs = now - windowMin * 60 * 1000;
  const stepMs = stepMin * 60 * 1000;
  const map = new Map<number, { sum: number; cnt: number; ts: number }>();
  for (const m of meas) {
    const ms = parseUtcMs(m.ts);
    if (!Number.isFinite(ms) || ms < fromMs || ms > now) continue;
    const bucket = Math.floor(ms / stepMs) * stepMs;
    const prev = map.get(bucket) || { sum: 0, cnt: 0, ts: bucket };
    prev.sum += m.weight;
    prev.cnt += 1;
    map.set(bucket, prev);
  }
  const buckets = Array.from(map.values()).sort((a,b) => a.ts - b.ts);
  return buckets.map(b => ({ t: new Date(b.ts).toISOString(), v: b.cnt ? b.sum / b.cnt : 0 }));
}

// Safe label formatter for Japanese locale, never returns "Invalid Date"
function formatJPLabel(ts: string): string {
  const ms = parseUtcMs(ts);
  if (!Number.isFinite(ms)) return String(ts ?? '');
  return new Date(ms).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

type Proc = 'molding' | 'packaging'
type Gran = 'raw' | '1min' | '5min' | 'default'
type Gramm = number
type Deviation = number
type ScaleType = 'A' | 'B'
type Lang = 'en' | 'ja'

const PROC_LABEL: Record<Proc, string> = { molding: '成型工程', packaging: '包装工程' }
const GRAN_LABEL: Record<Gran, string> = { raw: '更新ごと', '1min': '1分平均', '5min': '5分平均', default: '既定（要件）' }
const SCALE_LABEL: Record<ScaleType, string> = { A: 'タイプA（現行）', B: 'タイプB（準備中）' }
const LANG_LABEL: Record<Lang, string> = { en: 'EN', ja: '日本語' }

export default function App() {
  const [proc, setProc] = useState<Proc>('molding')
  const [gran, setGran] = useState<Gran>('default')
  const [gramm, setGramm] = useState<Gramm>(60)
  const [deviation, setDeviation] = useState<Deviation>(3)

  const [scaleType, setScaleType] = useState<ScaleType>('A')
  const [lang, setLang] = useState<Lang>('ja')

  const [latest, setLatest] = useState<Measurement | null>(null)
  const [labels, setLabels] = useState<string[]>([])
  const [values, setValues] = useState<number[]>([])

  const windowMin = useMemo(() => proc === 'packaging' ? 20 : 60, [proc])

  function buildExportQS() {
    dlog('buildExportQS start', { proc, gran, lang });
    const qs = new URLSearchParams({ process: proc, lang })
    if (gran === 'raw') {
      // 粒度1: показувати останні 3 хв, сирі точки
      qs.set('windowMin', '3')
      qs.set('stepMin', '1')
      qs.set('includeRaw', '1')
      qs.set('rawLimit', '500')
    } else if (gran === '1min') {
      // 粒度2: остання 1 година, бін 1 хв
      qs.set('windowMin', '60')
      qs.set('stepMin', '1')
    } else if (gran === '5min') {
      // 粒度3: останні 3 години, бін 5 хв
      qs.set('windowMin', '180')
      qs.set('stepMin', '5')
    } else {
      // 既定（要件）: останні 24 години, бін 30 хв
      qs.set('windowMin', '1440')
      qs.set('stepMin', '30')
    }
    dlog('buildExportQS result', Object.fromEntries(qs.entries()));
    return qs.toString()
  }

  async function load() {
    try {
      console.time('load');
      dlog('load start', { proc, gran });
      dlog('HERe');
      const lat = await fetchLatest(proc);
      setLatest(lat);
      dlog('setLatest called with', lat);
      // keep previous latest on intermittent nulls
      if (!lat) {
        // do not early-return; allow series update, but avoid using null latest downstream
      }
      dlog('latest', lat, 'gran', gran)

      if (gran === 'raw') {
        // 粒度1: останні 3 хв (сирі виміри)
        const rec = await fetchRecent(proc, 500);
        dlog('raw branch: rec count', rec?.length);
        const now = Date.now();
        const threeMinAgo = now - 3 * 60 * 1000;
        const recClean = rec
          .filter(r => {
            const okW = Number.isFinite(r.weight) && r.weight !== 0;
            const ms = parseUtcMs(r.ts as any);
            const okT = Number.isFinite(ms) && ms >= threeMinAgo;
            if (!okT) dlog('raw drop by time', { ts: r.ts, ms, threeMinAgo });
            if (!okW) dlog('raw drop by weight', { weight: r.weight, ts: r.ts });
            return okW && okT;
          })
          .sort((a,b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        dlog('raw branch: recClean count', recClean.length, 'first', recClean[0]?.ts, 'last', recClean[recClean.length-1]?.ts);
        if (recClean.length > 0) {
          const minMs = Math.min(...recClean.map(r => parseUtcMs(r.ts as any)));
          const maxMs = Math.max(...recClean.map(r => parseUtcMs(r.ts as any)));
          dlog('raw branch: window ms', { threeMinAgo, minMs, maxMs, now });
        }
        const newLabels = recClean.map(r => formatJPLabel(r.ts));
        const newValues = recClean.map(r => r.weight as number);
        dlog('raw branch: newValues length', newValues.length);
        if (newValues.length > 0) {
          dlog('raw branch: updating state');
          setLabels(newLabels);
          setValues(newValues);
        } else {
          dlog('raw branch: skip state update (empty slice)');
        }
      } else if (gran === '1min') {
        // 粒度2: показувати останню 1 годину, оновлення щохвилини
        const res = await fetchMeasurements({ process: proc, windowMin: 60, stepMin: 1 });
        const items = res.data ?? [];
        dlog('1min branch: items length', items.length);
        const clean = items.filter((b: any) => Number.isFinite(b.avg_weight) && b.avg_weight !== 0);
        dlog('1min branch: clean length', clean.length, 'first', clean[0]?.bucket_start_utc, 'last', clean[clean.length-1]?.bucket_start_utc);
        let newLabels: string[];
        let newValues: number[];
        if (clean.length === 0) {
          dlog('1min branch: API empty, falling back to client bucketing from recent raw');
          const rec = await fetchRecent(proc, 1800);
          const recClean = rec.filter(r => Number.isFinite(r.weight) && r.weight !== 0);
          const buckets = bucketize(recClean as any, 1, 60);
          newLabels = buckets.map(b => formatJPLabel(b.t));
          newValues = buckets.map(b => b.v);
        } else {
          newLabels = clean.map((b: any) => formatJPLabel(b.bucket_start_utc));
          newValues = clean.map((b: any) => b.avg_weight);
        }
        dlog('1min branch: after select source', { source: clean.length === 0 ? 'fallback:recent' : 'api', len: newValues.length });
        if (newValues.length > 0) {
          dlog('1min branch: updating state');
          setLabels(newLabels);
          setValues(newValues);
        } else {
          dlog('1min branch: skip state update (empty slice)');
        }
      } else if (gran === '5min') {
        // 粒度3: показувати останні 3 години, оновлення кожні 5 хв
        const res = await fetchMeasurements({ process: proc, windowMin: 180, stepMin: 5 });
        const items = res.data ?? [];
        dlog('5min branch: items length', items.length);
        const clean = items.filter((b: any) => Number.isFinite(b.avg_weight) && b.avg_weight !== 0);
        dlog('5min branch: clean length', clean.length, 'first', clean[0]?.bucket_start_utc, 'last', clean[clean.length-1]?.bucket_start_utc);
        let newLabels: string[];
        let newValues: number[];
        if (clean.length === 0) {
          dlog('5min branch: API empty, falling back to client bucketing from recent raw');
          const rec = await fetchRecent(proc, 3000);
          const recClean = rec.filter(r => Number.isFinite(r.weight) && r.weight !== 0);
          const buckets = bucketize(recClean as any, 5, 180);
          newLabels = buckets.map(b => formatJPLabel(b.t));
          newValues = buckets.map(b => b.v);
        } else {
          newLabels = clean.map((b: any) => formatJPLabel(b.bucket_start_utc));
          newValues = clean.map((b: any) => b.avg_weight);
        }
        dlog('5min branch: after select source', { source: clean.length === 0 ? 'fallback:recent' : 'api', len: newValues.length });
        if (newValues.length > 0) {
          dlog('5min branch: updating state');
          setLabels(newLabels);
          setValues(newValues);
        } else {
          dlog('5min branch: skip state update (empty slice)');
        }
      } else {
        // 既定（要件）: показувати останні 24 години, оновлення кожні 30 хв
        const res = await fetchMeasurements({ process: proc, windowMin: 1440, stepMin: 30 });
        const items = res.data ?? [];
        dlog('default branch: items length', items.length);
        const clean = items.filter((b: any) => Number.isFinite(b.avg_weight) && b.avg_weight !== 0);
        dlog('default branch: clean length', clean.length, 'first', clean[0]?.bucket_start_utc, 'last', clean[clean.length-1]?.bucket_start_utc);
        const newLabels = clean.map((b: any) => formatJPLabel(b.bucket_start_utc));
        const newValues = clean.map((b: any) => b.avg_weight);
        dlog('default branch: newValues length', newValues.length);
        if (newValues.length > 0) {
          dlog('default branch: updating state');
          setLabels(newLabels);
          setValues(newValues);
        } else {
          dlog('default branch: skip state update (empty slice)');
        }
      }
      console.timeEnd('load');
    } catch (e) {
      console.error('load error', e)
    }
  }

  const intervalMs = useMemo(() => {
    let val: number;
    if (gran === 'raw') val = 2000;
    else if (gran === '1min') val = 60_000;
    else if (gran === '5min') val = 5 * 60_000;
    else val = 30 * 60_000;
    dlog('intervalMs computed', { gran, intervalMs: val });
    return val;
  }, [gran]);

  useEffect(() => {
    dlog('interval effect start', { proc, gran, intervalMs });
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      clearInterval(id);
      dlog('interval cleared');
    };
  }, [proc, gran, intervalMs]);

  const qs = buildExportQS()
  const csvUrl = `http://localhost:3001/api/export/csv?${qs}`
  const pdfUrl = `http://localhost:3001/api/export/pdf?${qs}`
  const svgUrl = `http://localhost:3001/api/export/svg?${qs}`
  dlog('export URLs', { csvUrl, pdfUrl, svgUrl });

  function calculateMenuItem(amount: number, step: number = 1) {
    let res = []
    for (let i = 1; i <= amount; i = i + step) {
      res.push({ value: `${i}`, label: `${i}%` })
    }
    return res
  }

  const latestWeight = latest?.weight ?? null
  const targetWeight = Number(gramm || 0)

  const hasBounds = Number.isFinite(targetWeight) && Number.isFinite(deviation) && targetWeight > 0;
  const upper = hasBounds ? targetWeight * (1 + deviation / 100) : null;
  const lower = hasBounds ? targetWeight * (1 - deviation / 100) : null;

  const isHigh = latestWeight != null && upper != null && latestWeight > upper;
  const isLow = latestWeight != null && lower != null && latestWeight < lower;
  const outOfRange = isHigh || isLow;

  const pctDiff = (latestWeight != null && targetWeight > 0)
    ? ((latestWeight - targetWeight) / targetWeight) * 100
    : null;

  return (
    <div className="wrap">
      <header>
        <h1>製品重量モニタ（g・小数点第1位）</h1>
        <p>単一ビューで工程・粒度・計量タイプを切替え</p>
      </header>

      <div className="controls">
        <div className="control">
          <span className="ctl-label">工程</span>
          <Select value={proc} onChange={v => setProc(v as Proc)} options={[
            { value: 'molding', label: PROC_LABEL.molding },
            { value: 'packaging', label: PROC_LABEL.packaging },
          ]} />
        </div>
        <div className="control">
          <span className="ctl-label">粒度</span>
          <Select value={gran} onChange={v => setGran(v as Gran)} options={[
            { value: 'raw', label: GRAN_LABEL.raw },
            { value: '1min', label: GRAN_LABEL['1min'] },
            { value: '5min', label: GRAN_LABEL['5min'] },
            { value: 'default', label: GRAN_LABEL.default },
          ]} />
        </div>
        <div className="control">
          <span className="ctl-label">計量タイプ</span>
          <Select value={scaleType} onChange={v => setScaleType(v as ScaleType)} options={[
            { value: 'A', label: SCALE_LABEL.A },
            { value: 'B', label: SCALE_LABEL.B },
          ]} />
        </div>
        <div className="control">
          <span className="ctl-label">目標重量</span>
          <Select
            value={String(gramm)}
            onChange={(v: string) => setGramm(Number(v) as Gramm)}
            options={[
              { value: "10", label: "10g" },
              { value: "20", label: "20g" },
              { value: "40", label: "40g" },
              { value: "60", label: "60g" },
              { value: "80", label: "80g" },
              { value: "100", label: "100g" },
              { value: "120", label: "120g" },
              { value: "140", label: "140g" },
              { value: "160", label: "160g" },
              { value: "180", label: "180g" },
              { value: "200", label: "200g" },
              { value: "300", label: "300g" },
            ]} />
        </div>
        <div className="control">
          <span className="ctl-label">重量許容範囲(%)</span>
          <Select
            value={String(deviation)}
            onChange={(v: string) => setDeviation(Number(v) as Deviation)}
            options={calculateMenuItem(100)} />
        </div>
        <div className="control">
          <span className="ctl-label">言語</span>
          <Select value={lang} onChange={v => setLang(v as Lang)} options={[
            { value: 'ja', label: LANG_LABEL.ja },
            { value: 'en', label: LANG_LABEL.en },
          ]} />
        </div>
        <div className="control">
          <a className="btn" href={csvUrl} target="_blank" rel="noreferrer">CSVダウンロード</a>
          <a className="btn" href={pdfUrl} target="_blank" rel="noreferrer">PDFダウンロード</a>
          <a className="btn" href={svgUrl} target="_blank" rel="noreferrer">SVGダウンロード</a>
        </div>
      </div>

      {scaleType === 'B' && (
        <div className="note">
          タイプBは準備中です（現在はタイプAのデータを表示）。フォーマットが確定次第、専用パーサーを追加します。
        </div>
      )}

      <section className="cards">
        <div className="card">
          <div className="card-head">
            <div className="label">{PROC_LABEL[proc]} - 最新値</div>

            {outOfRange && (
              <div
                className={`badge ${isHigh ? 'bad-high' : 'bad-low'}`}
                title={
                  `Target ${targetWeight} g • ` +
                  (pctDiff != null ? `${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(1)}%` : '')
                }
              >
                <span className="dot" />
                <span className="badge-text">{isHigh ? '上限超過' : '下限未満'}</span>
                {pctDiff != null && (
                  <span className="pct">{pctDiff >= 0 ? '+' : ''}{pctDiff.toFixed(1)}%</span>
                )}
              </div>
            )}
          </div>

          <div className="value">
            {fmt1(latest?.weight)} <span className="unit">g</span>
          </div>
          <div className="meta">
            {latest ? `${formatJPLabel(latest.ts)} ／ 安定:${latest.stable ? 'はい' : '—'}` : '—'}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>{PROC_LABEL[proc]} — {GRAN_LABEL[gran]}</h2>
        <Chart labels={labels} values={values} upperLimit={gramm + gramm / 100 * deviation} lowerLimit={gramm - gramm / 100 * deviation} showPointTimes={true} target={gramm} />
        <small className="muted">ウィンドウ: {gran === 'raw' ? '直近3分' : gran === '1min' ? '直近1時間' : gran === '5min' ? '直近3時間' : '直近24時間'} ／ 粒度: {GRAN_LABEL[gran]}</small>
      </section>
    </div>
  )
}

function Select({ value, onChange, options }: { value: string, onChange: (v: string) => void, options: { value: string, label: string }[] }) {
  return (
    <div className="select">
      <select value={value} onChange={e => { dlog('Select change', { from: value, to: e.target.value }); onChange(e.target.value) }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}
