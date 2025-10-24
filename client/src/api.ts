
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

const API_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:3001').replace(/\/+$/, '');
const JSON_HDRS = { Accept: 'application/json' };


function qs(obj: Record<string, any> = {}) {
  const u = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => v !== undefined && u.set(k, String(v)));
  return u.toString();
}

export async function getJSON(path: string, params?: Record<string, any>) {
  const url = `${API_BASE}${path}${params ? `?${qs(params)}` : ''}`;
  // console.log(url)
  const res = await fetch(url, { headers: JSON_HDRS });
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
  if (!ct.includes('application/json')) throw new Error(`Expected JSON from ${url}, got ${ct}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

type AnyJson = any;

function pickArray(res: AnyJson) {
  if (Array.isArray(res)) return res;
  return res?.items ?? res?.data ?? [];
}

function pickItem(res: AnyJson) {
  // Підтримує {item}, {items:[0]}, {data:[0]}, або вже готовий об’єкт
  return res?.item ?? pickArray(res)[0] ?? (res && typeof res === 'object' && 'weight' in res ? res : null);
}

export const fetchLatest = async (process: string) => {
  const res = await getJSON('/api/measurements/latest', { process, skipZero: 1 });
  const item = pickItem(res);
  if (!item) return null;
  const w = Number(item.weight);
  // фільтр нулів/некоректних
  if (!Number.isFinite(w) || w === 0) return null;
  return { ...item, weight: w };
};

export async function fetchRecent(process: string, limit: number): Promise<Measurement[]> {
  const res = await getJSON('/api/measurements', { process, limit, skipZero: 1 });
  const items = res?.items ?? res?.data ?? res;      // підхоплюємо будь-яку схему
  return Array.isArray(items) ? items : [];          // гарантуємо масив назовні
}

export const fetchMeasurements = async (opts: any) =>
  getJSON('/api/measurements', { ...opts, skipZero: 1 });

export const fetchAggregates = async (opts: any) =>
  getJSON('/api/aggregates', { ...opts, skipZero: 1 });

export function formatJP(utc: string) {
  try { const d = new Date(utc + 'Z'); return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }); }
  catch { return utc; }
}
export function fmt1(v?: number | null) { if (v == null || Number.isNaN(v)) return '—'; return v.toFixed(1); }
