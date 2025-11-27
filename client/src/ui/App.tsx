import React, { useEffect, useMemo, useState } from 'react'
import { fetchAggregates, fetchLatest, fetchRecent, type Measurement, formatJP, fmt1, fetchMeasurements } from '../api'
import Chart from './Chart'
import './styles.css'

const DEBUG = true;
const dlog = (...args: any[]) => { if (DEBUG) console.log('[APP]', ...args); };

// --- Presets -----------------------------
export type Preset = { id: string; name: string; target: number; tolerancePct: number; groupPath?: string };
const PRESET_LS_KEY = 'srdev5_presets_v1';
function loadPresetsLS(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESET_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function savePresetsLS(list: Preset[]) {
  try { localStorage.setItem(PRESET_LS_KEY, JSON.stringify(list)); } catch { }
}
function uuid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function normGroupPath(gp?: string) {
  const s = (gp || '').trim().replace(/\\+/g, '/').replace(/\s*\/\s*/g, '/');
  return s.replace(/^\/+|\/+$/g, '');
}
function topGroup(gp?: string) {
  const n = normGroupPath(gp);
  return n ? n.split('/')[0] : '未分類';
}
function allGroups(list: Preset[]) {
  const set = new Set<string>();
  for (const p of list) {
    const n = normGroupPath(p.groupPath);
    if (!n) { set.add('未分類'); continue; }
    const parts = n.split('/');
    for (let i = 0; i < parts.length; i++) set.add(parts.slice(0, i + 1).join('/'));
  }
  return Array.from(set).sort();
}
function displayPresetLabel(p: Preset) {
  const gp = normGroupPath(p.groupPath);
  return gp ? `${p.name} — [${gp}]` : p.name;
}
const DEFAULT_PRESETS: Preset[] = [
  { id: 'd1', name: '50g ±3%', target: 50, tolerancePct: 3, groupPath: 'デフォルト' },
  { id: 'd2', name: '100g ±2%', target: 100, tolerancePct: 2, groupPath: 'デフォルト' },
];

// Backend returns timestamps like "YYYY-MM-DD HH:mm:ss" in UTC. Parse as UTC.
function parseUtcMs(ts: string): number {
  if (!ts) return NaN;
  // Normalize: "2025-10-24 04:47:02" -> "2025-10-24T04:47:02Z"
  const iso = ts.includes('T') ? ts.replace(' ', 'T').replace(/$/, 'Z') : ts.replace(' ', 'T') + 'Z';
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
  const buckets = Array.from(map.values()).sort((a, b) => a.ts - b.ts);
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
  const [gran, setGran] = useState<Gran>('raw')
  const [gramm, setGramm] = useState<Gramm>(60)
  const [deviation, setDeviation] = useState<Deviation>(3)

  const [scaleType, setScaleType] = useState<ScaleType>('A')
  const [lang, setLang] = useState<Lang>('ja')

  const [latest, setLatest] = useState<Measurement | null>(null)
  const [labels, setLabels] = useState<string[]>([])
  const [values, setValues] = useState<number[]>([])

  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [presetForm, setPresetForm] = useState<{ id?: string; name: string; target: string; tol: string; groupPath: string }>({
    name: '',
    target: String(gramm),
    tol: String(deviation),
    groupPath: '',
  });
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [pdfForm, setPdfForm] = useState<{ mode: 'count' | 'time'; chartLimit: string; timeValue: string; timeUnit: 'min' | 'hour' | 'day'; includeRaw: boolean }>({
    mode: 'count',
    chartLimit: '100',
    timeValue: '3',
    timeUnit: 'min',
    includeRaw: true,
  });
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvForm, setCsvForm] = useState<{ mode: 'count' | 'time'; chartLimit: string; timeValue: string; timeUnit: 'min' | 'hour' | 'day' }>({
    mode: 'count',
    chartLimit: '100',
    timeValue: '3',
    timeUnit: 'min',
  });

  useEffect(() => {
    const fromLS = loadPresetsLS();
    const list = fromLS.length ? fromLS : DEFAULT_PRESETS;
    setPresets(list);
    if (list[0]) setSelectedPreset(list[0].id);
  }, []);

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

  function applyPreset(id: string) {
    const p = presets.find(x => x.id === id); if (!p) return;
    dlog('applyPreset', p);
    setSelectedPreset(id);
    setGramm(p.target);
    setDeviation(p.tolerancePct);
  }

  function saveCurrentAsPreset() {
    const name = window.prompt('プリセット名を入力', `${gramm}g ±${deviation}%`);
    if (!name) return;
    const base = presets.find(x => x.id === selectedPreset);
    const p: Preset = { id: uuid(), name, target: gramm, tolerancePct: deviation, groupPath: normGroupPath(base?.groupPath) };
    const next = [...presets, p];
    setPresets(next);
    savePresetsLS(next);
    setSelectedPreset(p.id);
    dlog('preset saved', p);
  }

  function updateSelectedPresetValues() {
    const id = selectedPreset; if (!id) return;
    const idx = presets.findIndex(p => p.id === id); if (idx < 0) return;
    const copy = [...presets];
    copy[idx] = { ...copy[idx], target: gramm, tolerancePct: deviation };
    setPresets(copy);
    savePresetsLS(copy);
    dlog('preset updated', copy[idx]);
  }

  function renameSelectedPreset() {
    const id = selectedPreset; if (!id) return;
    const idx = presets.findIndex(p => p.id === id); if (idx < 0) return;
    const nextName = window.prompt('プリセット名の変更', presets[idx].name);
    if (!nextName) return;
    const copy = [...presets];
    copy[idx] = { ...copy[idx], name: nextName };
    setPresets(copy);
    savePresetsLS(copy);
    dlog('preset renamed', copy[idx]);
  }

  function deleteSelectedPreset() {
    const id = selectedPreset; if (!id) return;
    const p = presets.find(x => x.id === id);
    if (!p) return;
    if (!window.confirm(`プリセット「${p.name}」を削除しますか？`)) return;
    const next = presets.filter(x => x.id !== id);
    setPresets(next);
    savePresetsLS(next);
    setSelectedPreset(next[0]?.id || '');
    dlog('preset deleted', p);
  }

  function openCreatePresetModal() {
    const sel = presets.find(x => x.id === selectedPreset);
    setPresetForm({
      name: '',
      target: String(gramm),
      tol: String(deviation),
      groupPath: normGroupPath(sel?.groupPath || ''),
    });
    setShowPresetModal(true);
  }
  function openEditPresetModal() {
    const p = presets.find(x => x.id === selectedPreset);
    if (!p) return;
    setPresetForm({
      id: p.id,
      name: p.name,
      target: String(p.target),
      tol: String(p.tolerancePct),
      groupPath: normGroupPath(p.groupPath),
    });
    setShowPresetModal(true);
  }
  function closePresetModal() { setShowPresetModal(false); }
  function savePresetFromModal() {
    const name = presetForm.name.trim() || `${presetForm.target}g ±${presetForm.tol}%`;
    const target = Number(presetForm.target);
    const tol = Number(presetForm.tol);
    if (!Number.isFinite(target) || !Number.isFinite(tol) || target <= 0) { alert('Invalid values'); return; }

    if (presetForm.id) {
      // update existing
      const idx = presets.findIndex(p => p.id === presetForm.id);
      if (idx >= 0) {
        const copy = [...presets];
        copy[idx] = { ...copy[idx], name, target, tolerancePct: tol, groupPath: normGroupPath(presetForm.groupPath) }; setPresets(copy); savePresetsLS(copy); setSelectedPreset(copy[idx].id);
        setGramm(target); setDeviation(tol);
      }
    } else {
      // create new
      const p: Preset = { id: uuid(), name, target, tolerancePct: tol, groupPath: normGroupPath(presetForm.groupPath) }; const next = [...presets, p];
      setPresets(next); savePresetsLS(next); setSelectedPreset(p.id);
      setGramm(target); setDeviation(tol);
    }
    setShowPresetModal(false);
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
          .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        dlog('raw branch: recClean count', recClean.length, 'first', recClean[0]?.ts, 'last', recClean[recClean.length - 1]?.ts);
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
        dlog('1min branch: clean length', clean.length, 'first', clean[0]?.bucket_start_utc, 'last', clean[clean.length - 1]?.bucket_start_utc);
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
        dlog('5min branch: clean length', clean.length, 'first', clean[0]?.bucket_start_utc, 'last', clean[clean.length - 1]?.bucket_start_utc);
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
        dlog('default branch: clean length', clean.length, 'first', clean[0]?.bucket_start_utc, 'last', clean[clean.length - 1]?.bucket_start_utc);
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
  const csvBase = `http://localhost:3001/api/export/csv`
  const pdfUrl = `http://localhost:3001/api/export/pdf?${qs}`
  dlog('export URLs', { csvBase, pdfUrl });
  // --- CSV click handler (opens styled modal similar to PDF) ---
  function handleCsvClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    const lastMode = (localStorage.getItem('srdev5_csv_mode') as 'count' | 'time') || 'count';
    const lastCount = localStorage.getItem('srdev5_csv_chart_limit') || '100';
    const lastTimeValue = localStorage.getItem('srdev5_csv_time_value') || '3';
    const lastTimeUnit = (localStorage.getItem('srdev5_csv_time_unit') as 'min' | 'hour' | 'day') || 'min';
    setCsvForm({
      mode: lastMode === 'time' ? 'time' : 'count',
      chartLimit: lastCount,
      timeValue: lastTimeValue,
      timeUnit: (lastTimeUnit === 'hour' || lastTimeUnit === 'day') ? lastTimeUnit : 'min',
    });
    setShowCsvModal(true);
  }

  function closeCsvModal() { setShowCsvModal(false); }

  function confirmCsvExport() {
    const base = 'http://localhost:3001/api/export/csv';
    let url: string;
    if (csvForm.mode === 'time') {
      const tv = parseInt(csvForm.timeValue, 10);
      const factor = csvForm.timeUnit === 'day' ? 1440 : (csvForm.timeUnit === 'hour' ? 60 : 1);
      const minutes = Number.isFinite(tv) && tv > 0 ? tv * factor : 3;
      localStorage.setItem('srdev5_csv_mode', 'time');
      localStorage.setItem('srdev5_csv_time_value', String(tv));
      localStorage.setItem('srdev5_csv_time_unit', csvForm.timeUnit);
      url = `${base}?process=${proc}&rangeMode=time&rangeMinutes=${minutes}`;
    } else {
      const n = parseInt(csvForm.chartLimit, 10);
      const clamped = Number.isFinite(n) ? Math.max(1, Math.min(n, 5000)) : 100;
      localStorage.setItem('srdev5_csv_mode', 'count');
      localStorage.setItem('srdev5_csv_chart_limit', String(clamped));
      url = `${base}?process=${proc}&rangeMode=count&chartLimit=${clamped}`;
    }
    window.open(url, '_blank', 'noopener');
    setShowCsvModal(false);
  }

  // --- PDF click handler (opens styled modal) ---
  function handlePdfClick(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    const lastMode = (localStorage.getItem('srdev5_pdf_mode') as 'count' | 'time') || 'count';
    const lastCount = localStorage.getItem('srdev5_pdf_chart_limit') || '100';
    const lastRaw = localStorage.getItem('srdev5_pdf_include_raw');
    const includeRaw = lastRaw == null ? true : lastRaw === '1';
    const lastTimeValue = localStorage.getItem('srdev5_pdf_time_value') || '3';
    const lastTimeUnit = (localStorage.getItem('srdev5_pdf_time_unit') as 'min' | 'hour' | 'day') || 'min';
    setPdfForm({
      mode: lastMode === 'time' ? 'time' : 'count',
      chartLimit: lastCount,
      timeValue: lastTimeValue,
      timeUnit: (lastTimeUnit === 'hour' || lastTimeUnit === 'day') ? lastTimeUnit : 'min',
      includeRaw,
    });
    setShowPdfModal(true);
  }

  function closePdfModal() { setShowPdfModal(false); }

  function confirmPdfExport() {
    const n = parseInt(pdfForm.chartLimit, 10);
    const clamped = Number.isFinite(n) ? Math.max(1, Math.min(n, 2000)) : 100;
    // persist shared settings
    localStorage.setItem('srdev5_pdf_chart_limit', String(clamped));
    localStorage.setItem('srdev5_pdf_include_raw', pdfForm.includeRaw ? '1' : '0');

    let url: string;
    if (pdfForm.mode === 'time') {
      const tv = parseInt(pdfForm.timeValue, 10);
      const factor = pdfForm.timeUnit === 'day' ? 1440 : (pdfForm.timeUnit === 'hour' ? 60 : 1);
      const minutes = Number.isFinite(tv) && tv > 0 ? tv * factor : 3;
      localStorage.setItem('srdev5_pdf_mode', 'time');
      localStorage.setItem('srdev5_pdf_time_value', String(tv));
      localStorage.setItem('srdev5_pdf_time_unit', pdfForm.timeUnit);
      url = `${pdfUrl}&rangeMode=time&rangeMinutes=${minutes}&target=${gramm}&tolPct=${deviation}`
        + `&includeRaw=${pdfForm.includeRaw ? '1' : '0'}`
        + `&rawLimit=${pdfForm.includeRaw ? '2000' : '0'}`; // safety cap for raw table
    } else {
      localStorage.setItem('srdev5_pdf_mode', 'count');
      url = `${pdfUrl}&rangeMode=count&chartLimit=${clamped}&target=${gramm}&tolPct=${deviation}`
        + `&includeRaw=${pdfForm.includeRaw ? '1' : '0'}`
        + `&rawLimit=${pdfForm.includeRaw ? clamped : 0}`;
    }

    window.open(url, '_blank', 'noopener');
    setShowPdfModal(false);
  }

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
            onChange={(v: string) => { setGramm(Number(v) as Gramm); setSelectedPreset(''); }}
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
            onChange={(v: string) => { setDeviation(Number(v) as Deviation); setSelectedPreset(''); }}
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
          <span className="ctl-label">プリセット</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="select">
              <select value={selectedPreset} onChange={e => applyPreset(e.target.value)}>
                {(() => {
                  const byTop: Record<string, Preset[]> = {};
                  for (const p of presets) {
                    const tg = topGroup(p.groupPath);
                    (byTop[tg] ||= []).push(p);
                  }
                  const tops = Object.keys(byTop).sort();
                  return tops.map(tg => (
                    <optgroup key={tg} label={tg}>
                      {byTop[tg]
                        .sort((a, b) => displayPresetLabel(a).localeCompare(displayPresetLabel(b)))
                        .map(p => (
                          <option key={p.id} value={p.id}>{displayPresetLabel(p)}</option>
                        ))}
                    </optgroup>
                  ));
                })()}
              </select>
            </div>
            <button className="btn" onClick={openCreatePresetModal}>＋ 新規</button>
            <button className="btn" onClick={openEditPresetModal} disabled={!selectedPreset}>編集</button>
            <button className="btn" onClick={saveCurrentAsPreset}>そのまま保存</button>
            <button className="btn" onClick={updateSelectedPresetValues} disabled={!selectedPreset}>上書き保存</button>
            <button className="btn" onClick={deleteSelectedPreset} disabled={!selectedPreset}>削除</button>
          </div>
        </div>
        <div className="control">
          <a className="btn" href={csvBase} onClick={handleCsvClick} target="_blank" rel="noreferrer">CSVダウンロード</a>
          <a className="btn" href={pdfUrl} onClick={handlePdfClick} target="_blank" rel="noreferrer">PDFダウンロード</a>
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

      {
        showPresetModal && (
          <div className="modal-backdrop" onClick={closePresetModal}>
            <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
              <div className="modal-head">
                <h3 style={{ margin: 0 }}>{presetForm.id ? 'プリセットを編集' : 'プリセットを作成'}</h3>
              </div>
              <div className="modal-body">
                <div className="field">
                  <label>グループパス <small style={{ opacity: .7 }}>（「/」で階層化、例： 魚/鮪/いくら）</small></label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div className="select" style={{ flex: 1 }}>
                      <select
                        value={presetForm.groupPath}
                        onChange={e => setPresetForm({ ...presetForm, groupPath: e.target.value })}
                      >
                        <option value="">（新規／未分類）</option>
                        {allGroups(presets).map(g => (
                          <option key={g} value={g}>{g}</option>
                        ))}
                      </select>
                    </div>
                    <input
                      style={{ flex: 1 }}
                      type="text"
                      value={presetForm.groupPath}
                      onChange={e => setPresetForm({ ...presetForm, groupPath: e.target.value })}
                      placeholder="例: 魚/鮪/いくら"
                    />
                  </div>
                  <div className="hint">左で既存グループを選択、右で新しい階層を入力できます。</div>
                </div>
                <div className="field">
                  <label>商品名</label>
                  <input
                    type="text"
                    value={presetForm.name}
                    onChange={e => setPresetForm({ ...presetForm, name: e.target.value })}
                    placeholder="e.g., 47g ±2%"
                  />
                </div>
                <div className="row">
                  <div className="field">
                    <label>目標重量 (g)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={presetForm.target}
                      onChange={e => setPresetForm({ ...presetForm, target: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>許容差 (%)</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      value={presetForm.tol}
                      onChange={e => setPresetForm({ ...presetForm, tol: e.target.value })}
                    />
                  </div>
                </div>
                <div className="hint">保存すると、グラフにただちに反映されます。</div>
              </div>
              <div className="modal-foot">
                <button className="btn" onClick={savePresetFromModal}>
                  {presetForm.id ? '変更を保存' : '作成'}
                </button>
                <button className="btn ghost" onClick={closePresetModal}>キャンセル</button>
              </div>
            </div>
          </div>
        )
      }

      {showPdfModal && (
        <div className="modal-backdrop" onClick={closePdfModal}>
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <h3 style={{ margin: 0 }}>PDF出力オプション</h3>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>データ範囲の指定</label>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <label><input type="radio" checked={pdfForm.mode === 'count'} onChange={() => setPdfForm(prev => ({ ...prev, mode: 'count' }))} style={{ marginRight: 6 }} />件数で指定</label>
                  <label><input type="radio" checked={pdfForm.mode === 'time'} onChange={() => setPdfForm(prev => ({ ...prev, mode: 'time' }))} style={{ marginRight: 6 }} />時間で指定</label>
                </div>
              </div>

              {pdfForm.mode === 'count' && (
                <div className="field">
                  <label>グラフに含める最新の点数</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={2000}
                      value={pdfForm.chartLimit}
                      onChange={e => setPdfForm(prev => ({ ...prev, chartLimit: e.target.value }))}
                      placeholder="例: 100"
                      style={{ flex: 1 }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn" onClick={() => setPdfForm(prev => ({ ...prev, chartLimit: '50' }))}>50</button>
                      <button className="btn" onClick={() => setPdfForm(prev => ({ ...prev, chartLimit: '100' }))}>100</button>
                      <button className="btn" onClick={() => setPdfForm(prev => ({ ...prev, chartLimit: '200' }))}>200</button>
                    </div>
                  </div>
                  <div className="hint">1〜2000 の範囲で指定できます。現在の目標重量（{gramm}g）はPDFに反映されます。</div>
                </div>
              )}

              {pdfForm.mode === 'time' && (
                <div className="field">
                  <label>時間範囲</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={pdfForm.timeValue}
                      onChange={e => setPdfForm(prev => ({ ...prev, timeValue: e.target.value }))}
                      placeholder="例: 3"
                      style={{ width: 100 }}
                    />
                    <div className="select">
                      <select
                        value={pdfForm.timeUnit}
                        onChange={e => setPdfForm(prev => ({ ...prev, timeUnit: (e.target.value as 'min' | 'hour' | 'day') }))}
                      >
                        <option value="min">分</option>
                        <option value="hour">時間</option>
                        <option value="day">日</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn" onClick={() => setPdfForm(prev => ({ ...prev, timeValue: '3', timeUnit: 'min' }))}>3分</button>
                      <button className="btn" onClick={() => setPdfForm(prev => ({ ...prev, timeValue: '60', timeUnit: 'min' }))}>60分</button>
                      <button className="btn" onClick={() => setPdfForm(prev => ({ ...prev, timeValue: '180', timeUnit: 'min' }))}>180分</button>
                    </div>
                  </div>
                  <div className="hint">グラフ・ヒストグラム・（チェック時）生データ表は、この期間内のデータを使用します。</div>
                </div>
              )}

              <div className="field" style={{ marginTop: 8 }}>
                <label>
                  <input
                    type="checkbox"
                    checked={pdfForm.includeRaw}
                    onChange={e => setPdfForm(prev => ({ ...prev, includeRaw: e.target.checked }))}
                    style={{ marginRight: 8 }}
                  />
                  生データ表を含める
                </label>
                <div className="hint">{pdfForm.mode === 'count' ? 'N は上の点数と同じ値が使われます。' : '選択した期間の生データを含めます。'}</div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={confirmPdfExport}>出力</button>
              <button className="btn ghost" onClick={closePdfModal}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {showCsvModal && (
        <div className="modal-backdrop" onClick={closeCsvModal}>
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-head">
              <h3 style={{ margin: 0 }}>CSV出力オプション</h3>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>データ範囲の指定</label>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <label><input type="radio" checked={csvForm.mode === 'count'} onChange={() => setCsvForm(prev => ({ ...prev, mode: 'count' }))} style={{ marginRight: 6 }} />件数で指定</label>
                  <label><input type="radio" checked={csvForm.mode === 'time'} onChange={() => setCsvForm(prev => ({ ...prev, mode: 'time' }))} style={{ marginRight: 6 }} />時間で指定</label>
                </div>
              </div>

              {csvForm.mode === 'count' && (
                <div className="field">
                  <label>CSVに含める最新の件数</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={5000}
                      value={csvForm.chartLimit}
                      onChange={e => setCsvForm(prev => ({ ...prev, chartLimit: e.target.value }))}
                      placeholder="例: 100"
                      style={{ flex: 1 }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn" onClick={() => setCsvForm(prev => ({ ...prev, chartLimit: '50' }))}>50</button>
                      <button className="btn" onClick={() => setCsvForm(prev => ({ ...prev, chartLimit: '100' }))}>100</button>
                      <button className="btn" onClick={() => setCsvForm(prev => ({ ...prev, chartLimit: '500' }))}>500</button>
                    </div>
                  </div>
                  <div className="hint">1〜5000 の範囲で指定できます。</div>
                </div>
              )}

              {csvForm.mode === 'time' && (
                <div className="field">
                  <label>時間範囲</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={csvForm.timeValue}
                      onChange={e => setCsvForm(prev => ({ ...prev, timeValue: e.target.value }))}
                      placeholder="例: 3"
                      style={{ width: 100 }}
                    />
                    <div className="select">
                      <select
                        value={csvForm.timeUnit}
                        onChange={e => setCsvForm(prev => ({ ...prev, timeUnit: (e.target.value as 'min' | 'hour' | 'day') }))}
                      >
                        <option value="min">分</option>
                        <option value="hour">時間</option>
                        <option value="day">日</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn" onClick={() => setCsvForm(prev => ({ ...prev, timeValue: '3', timeUnit: 'min' }))}>3分</button>
                      <button className="btn" onClick={() => setCsvForm(prev => ({ ...prev, timeValue: '60', timeUnit: 'min' }))}>60分</button>
                      <button className="btn" onClick={() => setCsvForm(prev => ({ ...prev, timeValue: '180', timeUnit: 'min' }))}>180分</button>
                    </div>
                  </div>
                  <div className="hint">この期間のデータをCSVに出力します。</div>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={confirmCsvExport}>出力</button>
              <button className="btn ghost" onClick={closeCsvModal}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

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
