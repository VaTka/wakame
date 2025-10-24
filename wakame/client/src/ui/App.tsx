
import React, { useEffect, useMemo, useState } from 'react'
import { fetchAggregates, fetchLatest, fetchRecent, type Measurement, formatJP, fmt1 } from '../api'
import Chart from './Chart'
import './styles.css'

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
    const qs = new URLSearchParams({ process: proc, lang })
    if (gran === '1min') {
      qs.set('windowMin', (proc === 'packaging' ? 20 : 60).toString())
      qs.set('stepMin', '1')
    } else if (gran === '5min') {
      qs.set('windowMin', (proc === 'packaging' ? 20 : 60).toString())
      qs.set('stepMin', '5')
    } else if (gran === 'raw') {
      qs.set('windowMin', (proc === 'packaging' ? 20 : 60).toString())
      qs.set('stepMin', '1')
      qs.set('includeRaw', '1')
      qs.set('rawLimit', '300')
    }
    return qs.toString()
  }

  async function load() {
    try {
      const lat = await fetchLatest(proc)
      setLatest(lat)

      if (gran === 'raw') {
        const rec = await fetchRecent(proc, 300)
        const xs = rec.map(r => formatJP(r.ts)).reverse()
        const ys = rec.map(r => (r.weight ?? 0)).reverse()
        setLabels(xs); setValues(ys)
      } else if (gran === '1min') {
        const res = await fetchAggregates(proc, windowMin, 1)
        setLabels(res.data.map((b: any) => formatJP(b.bucket_start_utc)))
        setValues(res.data.map((b: any) => b.avg_weight ?? 0))
      } else if (gran === '5min') {
        const res = await fetchAggregates(proc, windowMin, 5)
        setLabels(res.data.map((b: any) => formatJP(b.bucket_start_utc)))
        setValues(res.data.map((b: any) => b.avg_weight ?? 0))
      } else {
        const res = await fetchAggregates(proc) // defaults: 60/15 or 20/5
        setLabels(res.data.map((b: any) => formatJP(b.bucket_start_utc)))
        setValues(res.data.map((b: any) => b.avg_weight ?? 0))
      }
    } catch (e) {
      console.error('load error', e)
    }
  }

  useEffect(() => { load(); const id = setInterval(load, 2000); return () => clearInterval(id) }, [proc, gran])

  const qs = buildExportQS()
  const csvUrl = `http://localhost:3001/api/export/csv?${qs}`
  const pdfUrl = `http://localhost:3001/api/export/pdf?${qs}`
  const svgUrl = `http://localhost:3001/api/export/svg?${qs}`

  function calculateMenuItem(amount: number, step: number = 1) {
    let res = []
    for (let i = 1; i <= amount; i = i + step) {
      res.push({ value: `${i}`, label: `${i}%` })
    }
    return res
  }

  const latestWeight = latest?.weight ?? null
  const targetWeight = Number(gramm || 0)

  const isHigh = latestWeight != null && typeof deviation && latestWeight > (gramm + gramm / 100 * deviation)
  const isLow = latestWeight != null && typeof deviation && latestWeight < (gramm - gramm / 100 * deviation)
  const outOfRange = isHigh || isLow

  const pctDiff = (latestWeight != null && targetWeight > 0)
    ? ((latestWeight - targetWeight) / targetWeight) * 100
    : null

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
            {latest ? `${formatJP(latest.ts)} ／ 安定:${latest.stable ? 'はい' : '—'}` : '—'}
          </div>
        </div>
      </section>

      <section className="card">
        <h2>{PROC_LABEL[proc]} — {GRAN_LABEL[gran]}</h2>
        <Chart labels={labels} values={values} upperLimit={gramm + gramm / 100 * deviation} lowerLimit={gramm - gramm / 100 * deviation} showPointTimes={true} />
        <small className="muted">ウィンドウ: {proc === 'packaging' ? '直近20分' : '直近1時間'} ／ 粒度: {GRAN_LABEL[gran]}</small>
      </section>
    </div>
  )
}

function Select({ value, onChange, options }: { value: string, onChange: (v: string) => void, options: { value: string, label: string }[] }) {
  return (
    <div className="select">
      <select value={value} onChange={e => onChange(e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}
