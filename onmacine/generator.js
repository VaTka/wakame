

import 'dotenv/config';
import axios from 'axios';

// Optional HTTP Basic Auth for protected backend endpoints
// Set in env: BASIC_AUTH_USER / BASIC_AUTH_PASS
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || '';

function axiosAuthConfig() {
  // axios supports Basic Auth via `auth` option
  if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
    return { auth: { username: BASIC_AUTH_USER, password: BASIC_AUTH_PASS } };
  }
  return {};
}

const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
const API = `${BACKEND_URL}/api/ingest`;
const TICK_MS = parseInt(process.env.GEN_TICK_MS || '500', 10);
const AMP = parseFloat(process.env.GEN_AMP || '500');
const NOISE = parseFloat(process.env.GEN_NOISE || '1');
const MODE = (process.env.GEN_PROCESS || 'both').toLowerCase();

let t = 0;
function nextValue() {
  const base = AMP/2 + (AMP/2) * Math.sin(t / 20);
  const noise = (Math.random() - 0.5) * 2 * NOISE;
  t++;
  return parseFloat((base + noise).toFixed(1));
}

function nextProcess(prev) {
  if (MODE === 'molding') return 'molding';
  if (MODE === 'packaging') return 'packaging';
  return prev === 'molding' ? 'packaging' : 'molding';
}

let lastProc = 'packaging';
async function tick() {
  const weight = nextValue();
  lastProc = nextProcess(lastProc);
  const status = weight >= 0 ? 'S' : 'E';
  const raw = `+${weight.toFixed(1)} G ${status}`;
  try {
    await axios.post(
      API,
      { raw, weight, unit: 'g', status, process: lastProc, source: 'simulator' },
      { timeout: 3000, ...axiosAuthConfig() }
    );
    console.log(`[sim ${lastProc}] sent: ${weight} g`);
  } catch (e) { console.error('[sim] error', e.response?.status, e.response?.data || e.message); }
}
console.log(
  `[sim] start: ${MODE} → ${API} every ${TICK_MS} ms` +
    (BASIC_AUTH_USER && BASIC_AUTH_PASS ? ` (basic auth: ${BASIC_AUTH_USER})` : ' (no auth)')
);
setInterval(tick, TICK_MS);
