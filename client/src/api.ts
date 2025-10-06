
export type Measurement = {
  id: number;
  ts: string;
  raw: string | null;
  weight: number | null;
  unit: string | null;
  status: string | null;
  source: string | null;
  process: 'molding' | 'packaging' | null;
  stable: 0 | 1 | null;
  is_error: 0 | 1 | null;
};

export type Aggregate = {
  bucket_start_utc: string;
  avg_weight: number | null;
  min_weight: number | null;
  max_weight: number | null;
  count: number;
};

const API_BASE = 'http://localhost:3001';

export async function fetchLatest(process: 'molding' | 'packaging') {
  const u = new URL(API_BASE + '/api/measurements/latest'); u.searchParams.set('process', process);
  const r = await fetch(u); const j = await r.json(); return j.data ?? null;
}
export async function fetchRecent(process: 'molding' | 'packaging', limit=300) {
  const u = new URL(API_BASE + '/api/measurements'); u.searchParams.set('process', process); u.searchParams.set('limit', String(limit));
  const r = await fetch(u); const j = await r.json(); return j.data ?? [];
}
export async function fetchAggregates(process: 'molding' | 'packaging', windowMin?: number, stepMin?: number) {
  const u = new URL(API_BASE + '/api/aggregates'); u.searchParams.set('process', process);
  if (windowMin) u.searchParams.set('windowMin', String(windowMin));
  if (stepMin) u.searchParams.set('stepMin', String(stepMin));
  const r = await fetch(u); return r.json();
}

export function formatJP(utc: string) {
  try { const d = new Date(utc + 'Z'); return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }); }
  catch { return utc; }
}
export function fmt1(v?: number | null) { if (v == null || Number.isNaN(v)) return '—'; return v.toFixed(1); }
