
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

export const API_BASE = (import.meta.env.VITE_API_BASE || 'http://localhost:3001').replace(/\/+$/, '');
const JSON_HDRS = { Accept: 'application/json' };

// --- Basic Auth support (browser prompt + sessionStorage) ---
// Protects API calls when server uses HTTP Basic Auth.
const AUTH_SS_KEY = 'srdev5_basic_auth_b64_v1';

function b64Basic(user: string, pass: string) {
  // UTF-8 safe base64
  const raw = `${user}:${pass}`;
  const utf8 = encodeURIComponent(raw).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16)));
  return window.btoa(utf8);
}

function getAuthB64(): string | null {
  try { return sessionStorage.getItem(AUTH_SS_KEY); } catch { return null; }
}

function setAuthB64(v: string) {
  try { sessionStorage.setItem(AUTH_SS_KEY, v); } catch { }
}

function clearAuth() {
  try { sessionStorage.removeItem(AUTH_SS_KEY); } catch { }
}

function authHeaderValue(): string | undefined {
  const v = getAuthB64();
  return v ? `Basic ${v}` : undefined;
}

function buildHeaders(extra?: Record<string, string>) {
  const h: Record<string, string> = { ...JSON_HDRS, ...(extra || {}) };
  const auth = authHeaderValue();
  if (auth) h.Authorization = auth;
  return h;
}

function promptForAuth(): boolean {
  const user = window.prompt('Login (Basic Auth) — username');
  if (user == null) return false;
  const pass = window.prompt('Login (Basic Auth) — password');
  if (pass == null) return false;
  setAuthB64(b64Basic(user, pass));
  return true;
}


function qs(obj: Record<string, any> = {}) {
  const u = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => v !== undefined && u.set(k, String(v)));
  return u.toString();
}

export async function getJSON(path: string, params?: Record<string, any>) {
  const url = `${API_BASE}${path}${params ? `?${qs(params)}` : ''}`;

  async function doFetch() {
    const res = await fetch(url, { headers: buildHeaders() });
    const text = await res.text();
    const ct = res.headers.get('content-type') || '';
    return { res, text, ct };
  }

  let { res, text, ct } = await doFetch();

  // If server is protected by Basic Auth and we don't have creds yet (or they changed), prompt once.
  if (res.status === 401) {
    clearAuth();
    const ok = promptForAuth();
    if (ok) ({ res, text, ct } = await doFetch());
  }

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
  return res?.item ?? pickArray(res)[0] ?? (res && typeof res === 'object' && 'weight' in res ? res : null);
}

export const fetchLatest = async (process: string) => {
  const res = await getJSON('/api/measurements/latest', { process, skipZero: 1 });
  const item = pickItem(res);
  if (!item) return null;
  const w = Number(item.weight);
  if (!Number.isFinite(w) || w === 0) return null;
  return { ...item, weight: w };
};

export async function fetchRecent(process: string, limit: number): Promise<Measurement[]> {
  const res = await getJSON('/api/measurements', { process, limit, skipZero: 1 });
  const items = res?.items ?? res?.data ?? res;   
  return Array.isArray(items) ? items : [];     
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
