
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const sqlite = sqlite3.verbose();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

const PORT = process.env.PORT || 3001;
const ERROR_MIN = parseFloat(process.env.ERROR_MIN ?? '0');
const ERROR_MAX = parseFloat(process.env.ERROR_MAX ?? '50000');
const PDF_FONT = process.env.PDF_FONT || path.join(process.cwd(), 'fonts', 'NotoSansJP-Regular.ttf');
const DEFAULT_PROCESS = process.env.DEFAULT_PROCESS || 'molding';



const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

export const db = new sqlite.Database(DB_PATH, (err) => {
  if (err) {
    console.error('DB open error:', err);
    process.exit(1);
  }
});

// Promise helpers for sqlite3 callbacks

const dbAllP = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});
const dbGetP = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

// Normalize query value: pick last if array (e.g., ?a=1&a=0)
function qPickLast(v) {
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function detectError(weight) {
  if (weight == null || Number.isNaN(weight)) return 1;
  if (weight < ERROR_MIN) return 1;
  if (weight > ERROR_MAX) return 1;
  return 0;
}

function parseFromRaw(raw) {
  if (typeof raw !== 'string') return {};
  const m = raw.match(/([+-]?\d+(?:\.\d+)?)/);
  const weight = m ? Number(parseFloat(m[1]).toFixed(1)) : null;
  const flags = (raw.match(/[A-Za-z]+/g) || []).join(' ');
  const stable = flags.toUpperCase().includes('S');  
  const unit = /\bG(RAM|R)?\b/i.test(raw) ? 'g' : 'g';
  return { weight, unit, status: flags, stable };
}

function useJPFont(doc) {
  try { if (fs.existsSync(PDF_FONT)) { doc.font(PDF_FONT); return true; } } catch { }
  return false;
}
function formatJST(utc) {
  try { const d = new Date(utc + 'Z'); return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }); }
  catch { return utc; }
}
function formatJSTShort(utc) {
  try { return new Date(utc + 'Z').toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }); }
  catch { return utc; }
}
function t(lang, hasJP, key) {
  const JA = {
    title_molding: '工程: 成型 レポート',
    title_packaging: '工程: 包装 レポート',
    period: (w, s) => `期間: 直近 ${w} 分, 集計間隔: ${s} 分`,
    latest_val: (w) => `最新値: ${w} g`,
    latest_time: (ts) => `時刻: UTC ${ts.utc} ／ JST ${ts.jst}`,
    warn_error: '※ エラー値を検出しました',
    section_agg: '集計（平均・最小・最大・件数）',
    no_data: 'データがありません（期間/粒度を見直してください）',
    section_raw: '直近の生データ',
    raw_line: (r) => `${r.ts}    ${r.w} g    安定:${r.stable ? 'はい' : '—'}    エラー:${r.err ? 'はい' : '—'}`,
    agg_line: (r) => `${r.ts}  平均:${r.avg} g  最小:${r.min}  最大:${r.max}  件数:${r.c}`,
    warn_font: '⚠ 日本語フォントが見つかりません。server/fonts/NotoSansJP-Regular.ttf を配置するか、.env の PDF_FONT を設定してください。'
  };
  const EN = {
    title_molding: 'Process: Molding — Report',
    title_packaging: 'Process: Packaging — Report',
    period: (w, s) => `Period: last ${w} min, Step: ${s} min`,
    latest_val: (w) => `Latest: ${w} g`,
    latest_time: (ts) => `Time: UTC ${ts.utc} / JST ${ts.jst}`,
    warn_error: 'Error value detected',
    section_agg: 'Aggregates (avg/min/max/count)',
    no_data: 'No data (adjust window/step)',
    section_raw: 'Recent raw data',
    raw_line: (r) => `${r.ts}    ${r.w} g    stable:${r.stable ? 'yes' : '—'}    error:${r.err ? 'yes' : '—'}`,
    agg_line: (r) => `${r.ts}  avg:${r.avg} g  min:${r.min}  max:${r.max}  count:${r.c}`,
    warn_font: '⚠ JP font not found. Put NotoSansJP-Regular.ttf under server/fonts/ or set PDF_FONT in .env.'
  };
  const L = (lang === 'ja' && hasJP) ? JA : EN;
  return L[key];
}

// POST /api/ingest
app.post('/api/ingest', async (req, res) => {
  try {
    const { raw, weight, unit, status, source, process: processFromBody, stable } = req.body || {};

    let w = weight, u = unit, st = status, stbl = stable;
    if ((w == null || Number.isNaN(w)) && typeof raw === 'string') {
      const p = parseFromRaw(raw);
      if (p.weight != null) w = p.weight;
      if (u == null && p.unit) u = p.unit;
      if (st == null && p.status) st = p.status;
      if (stbl == null && typeof p.stable === 'boolean') stbl = p.stable ? 1 : 0;
    }

    const proc = (processFromBody ?? process.env.DEFAULT_PROCESS ?? 'molding');

    if (raw == null && (w == null || Number.isNaN(w))) {
      return res.status(400).json({ error: 'Missing payload: raw or weight required' });
    }

    const is_error =
      (w == null || Number.isNaN(w)) ? 1 :
        (w < ERROR_MIN || w > ERROR_MAX) ? 1 : 0;

    const r = await db.run(
      'INSERT INTO measurements (raw, weight, unit, status, source, process, stable, is_error) VALUES (?,?,?,?,?,?,?,?)',
      raw ?? null, weight ?? null, unit ?? 'g', status ?? null, source ?? 'serial', proc, stable ?? null, is_error
    );
    const row = await db.get('SELECT * FROM measurements WHERE id = ?', r.lastID);
    res.json({ ok: true, data: row });
  } catch (e) {
    console.error('Ingest error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, pid: process.pid, time: Date.now() });
});

// GET /api/measurements
app.get('/api/measurements', (req, res) => {
  const { where, params } = buildWhere(req.query);
  const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);

  const sql = `
    SELECT id, ts, raw, weight, unit, status, source, process, stable, is_error
    FROM measurements
    ${where}
    ORDER BY ts DESC
    LIMIT ?
  `;
  db.all(sql, [...params, limit], (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ items: rows });
  });
});

// GET /api/measurements/latest
app.get('/api/measurements/latest', (req, res) => {
  try {
    const { where, params } = buildWhere({
      ...req.query,
      skipZero: req.query.skipZero ?? '1'
    });

    const sql = `
      SELECT id, ts, raw, weight, unit, status, source, process, stable, is_error
      FROM measurements
      ${where}
      ORDER BY ts DESC
      LIMIT 1
    `;
    db.get(sql, params, (err, row) => {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({ item: row ?? null });
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// GET /api/aggregates
app.get('/api/aggregates', (req, res) => {
  const { where, params } = buildWhere(req.query);
  const binSec = parseInt(req.query.binSec || '300', 10);
  const sql = `
    WITH base AS (
      SELECT ts, weight
      FROM measurements
      ${where}
    ),
    buckets AS (
      SELECT 
        CAST((ts / 1000) / ? AS INTEGER) AS bucket,
        weight
      FROM base
    )
    SELECT 
      bucket,
      AVG(weight) AS avg_weight,
      COUNT(*)   AS n
    FROM buckets
    GROUP BY bucket
    ORDER BY bucket ASC
  `;
  db.all(sql, [binSec, ...params], (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ items: rows, binSec });
  });
});


app.get('/api/export/csv', async (req, res) => {
  try {
    const process = qPickLast(req.query.process) || 'molding';
    const defWindow = process === 'packaging' ? 20 : 60;
    const windowMin = Math.max(1, parseInt(qPickLast(req.query.windowMin) || String(defWindow), 10));

    // New: CSV supports the same range controls as PDF
    const rangeMode = qPickLast(req.query.rangeMode) === 'time' ? 'time' : 'count';
    const rangeMinutes = Math.max(0, parseInt(qPickLast(req.query.rangeMinutes) || '0', 10));
    const chartLimit = Math.max(0, parseInt(qPickLast(req.query.chartLimit) || '0', 10));

    let rows = [];
    if (rangeMode === 'time' && rangeMinutes > 0) {
      rows = await dbAllP(
        `SELECT * FROM measurements
         WHERE process = ? AND ts >= datetime('now', ?)
         ORDER BY id ASC`,
        [process, `-${rangeMinutes} minutes`]
      );
    } else if (chartLimit > 0) {
      const tmp = await dbAllP(
        `SELECT * FROM measurements
         WHERE process = ?
         ORDER BY id DESC
         LIMIT ?`,
        [process, Math.min(chartLimit, 5000)]
      );
      rows = tmp.reverse(); // chronological
    } else {
      // Backward compatible: use windowMin if no explicit range passed
      rows = await dbAllP(
        `SELECT * FROM measurements
         WHERE process = ? AND ts >= datetime('now', ?)
         ORDER BY id ASC`,
        [process, `-${windowMin} minutes`]
      );
    }

    // UTF-8 + BOM so Excel opens correctly
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${process}-export.csv"`);
    res.write('\ufeff'); // BOM for Excel

    const EOL = '\r\n';
    const header = ['id', 'ts', 'weight', 'unit', 'status', 'source', 'process', 'stable', 'is_error', 'raw'];
    res.write(header.join(',') + EOL);

    const csvEscape = (val) => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    for (const r of rows) {
      const rawClean = (r.raw ?? '').replace(/\r?\n/g, ' ');
      const cols = [
        r.id,
        r.ts,
        (r.weight ?? ''),
        (r.unit ?? ''),
        (r.status ?? ''),
        (r.source ?? ''),
        (r.process ?? ''),
        (r.stable ?? ''),
        (r.is_error ?? ''),
        rawClean
      ].map(csvEscape);
      res.write(cols.join(',') + EOL);
    }

    res.end();
  } catch (e) {
    console.error('CSV export error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});


// PDF export
app.get('/api/export/pdf', async (req, res) => {
  // 1) Parse query params
  const process = qPickLast(req.query.process) || 'molding';
  const defWindow = process === 'packaging' ? 20 : 60;
  const defStep = process === 'packaging' ? 5 : 15;
  const windowMin = Math.max(1, parseInt(qPickLast(req.query.windowMin) ?? String(defWindow), 10));
  const stepMin = Math.max(1, parseInt(qPickLast(req.query.stepMin) ?? String(defStep), 10));
  const includeRaw = qPickLast(req.query.includeRaw) === '1';
  const rawLimit = Math.min(parseInt(qPickLast(req.query.rawLimit) ?? '300', 10), 1000);
  const lang = (qPickLast(req.query.lang) === 'ja' ? 'ja' : 'en');
  const includeChart = qPickLast(req.query.includeChart) !== '0'; // default: on
  const chartLimit = Math.min(parseInt(qPickLast(req.query.chartLimit) ?? '100', 10), 2000);
  const includeHistogram = qPickLast(req.query.includeHistogram) !== '0'; // default: on
  const target = Number.parseFloat(qPickLast(req.query.target) ?? qPickLast(req.query.targetWeight) ?? '');
  const hasTarget = Number.isFinite(target);
  const tolPct = Number.parseFloat(qPickLast(req.query.tolPct) ?? '');
  const hasTol = Number.isFinite(tolPct) && tolPct >= 0;
  const lowerTol = hasTarget && hasTol ? target * (1 - tolPct / 100) : null;
  const upperTol = hasTarget && hasTol ? target * (1 + tolPct / 100) : null;
  const labelAll = qPickLast(req.query.labelAll) === '1';

  // 2) Parse new rangeMode param
  const rangeMode = qPickLast(req.query.rangeMode) === 'time' ? 'time' : 'count';
  const rangeMinutes = Math.max(0, parseInt(qPickLast(req.query.rangeMinutes) ?? '0', 10));

  // 2) Fetch DB data BEFORE starting the PDF stream
  let latest = null;
  let aggr = [];
  let rawRows = [];
  try {
    latest = await dbGetP('SELECT * FROM measurements WHERE process = ? ORDER BY id DESC LIMIT 1', [process]);
    aggr = await dbAllP(`
      WITH src AS (
        SELECT * FROM measurements WHERE process = ? AND ts >= datetime('now', ?)
      ),
      bucketed AS (
        SELECT CAST(strftime('%s', ts) / (?*60) AS INTEGER) * (?*60) AS bucket_epoch, weight
        FROM src WHERE weight IS NOT NULL AND is_error = 0
      )
      SELECT datetime(bucket_epoch, 'unixepoch') AS bucket_start_utc,
             ROUND(AVG(weight), 1) AS avg_weight,
             MIN(weight) AS min_weight,
             MAX(weight) AS max_weight,
             COUNT(*) AS count
      FROM bucketed
      GROUP BY bucket_epoch
      ORDER BY bucket_epoch ASC;
    `, [process, `-${windowMin} minutes`, stepMin, stepMin]);
    if (includeRaw) {
      if (rangeMode === 'time' && rangeMinutes > 0) {
        const cap = Math.min(rawLimit > 0 ? rawLimit : 2000, 5000);
        rawRows = await dbAllP(
          'SELECT ts, weight, stable, is_error FROM measurements WHERE process = ? AND ts >= datetime(\'now\', ?) ORDER BY id DESC LIMIT ?',
          [process, `-${rangeMinutes} minutes`, cap]
        );
      } else {
        const rawLimitEff = Math.max(1, Math.min(chartLimit, rawLimit));
        rawRows = await dbAllP(
          'SELECT ts, weight, stable, is_error FROM measurements WHERE process = ? ORDER BY id DESC LIMIT ?',
          [process, rawLimitEff]
        );
      }
    }
  } catch (e) {
    console.error('PDF export DB error:', e);
    return res.status(500).json({ error: 'Server error' });
  }

  // 3) Start PDF stream only after data is ready
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${process}-report.pdf"`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  try {
    const HAS_JP = useJPFont(doc);
    if (lang === 'ja' && !HAS_JP) {
      doc.fillColor('red').fontSize(10).text(t('en', false, 'warn_font')).fillColor('black');
    }

    const title = process === 'packaging' ? t(lang, HAS_JP, 'title_packaging') : t(lang, HAS_JP, 'title_molding');
    doc.fontSize(18).text(title, { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(12).text(t(lang, HAS_JP, 'period')(windowMin, stepMin));
    doc.moveDown(0.5);
    if (latest) {
      const w = (latest.weight == null) ? '—' : Number(latest.weight).toFixed(1);
      doc.text(t(lang, HAS_JP, 'latest_val')(w));
      doc.text(t(lang, HAS_JP, 'latest_time')({ utc: latest.ts, jst: formatJST(latest.ts) }));
      if (latest.is_error) doc.fillColor('red').text(t(lang, HAS_JP, 'warn_error')).fillColor('black');
    } else {
      doc.text(lang === 'ja' && HAS_JP ? '最新値: なし' : 'No latest value');
    }

    doc.moveDown(1);
    doc.fontSize(14).text(t(lang, HAS_JP, 'section_agg'));
    doc.moveDown(0.5);
    doc.fontSize(11);
    if (!Array.isArray(aggr) || aggr.length === 0) {
      doc.text(t(lang, HAS_JP, 'no_data'));
    } else {
      aggr.forEach(r => {
        const avg = (r.avg_weight == null || Number.isNaN(r.avg_weight)) ? '—' : Number(r.avg_weight).toFixed(1);
        doc.text(t(lang, HAS_JP, 'agg_line')({ ts: formatJST(r.bucket_start_utc), avg, min: r.min_weight, max: r.max_weight, c: r.count }));
      });
    }

    // === Chart: last N (default 100) weights ===
    if (includeChart) {
      try {
        let chartRows;
        if (rangeMode === 'time' && rangeMinutes > 0) {
          chartRows = await dbAllP(
            'SELECT ts, weight FROM measurements WHERE process = ? AND weight IS NOT NULL AND is_error = 0 AND ts >= datetime(\'now\', ?) ORDER BY id DESC',
            [process, `-${rangeMinutes} minutes`]
          );
        } else {
          chartRows = await dbAllP(
            'SELECT ts, weight FROM measurements WHERE process = ? AND weight IS NOT NULL AND is_error = 0 ORDER BY id DESC LIMIT ?',
            [process, chartLimit]
          );
        }

        const series = (chartRows || [])
          .reverse()
          .map(r => ({ ts: r.ts, w: Number(r.weight) }))
          .filter(p => Number.isFinite(p.w));

        doc.moveDown(1);
        const chartTitle = (lang === 'ja' && HAS_JP)
          ? (rangeMode === 'time' && rangeMinutes > 0 ? '直近の重量（期間内）' : `直近の重量（最大${chartLimit}件）`)
          : (rangeMode === 'time' && rangeMinutes > 0 ? 'Recent weights (time range)' : `Recent weights (up to ${chartLimit})`);
        doc.fontSize(14).text(chartTitle);
        doc.moveDown(0.25);

        const x = doc.page.margins.left;
        const yTop = doc.y; // current flow position
        const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const H = 160;

        if (series.length < 2) {
          doc.fontSize(11).text((lang === 'ja' && HAS_JP) ? 'データが不足しています。' : 'Not enough data.');
        } else {
          // If the dataset is large, draw the chart on a landscape page (rotate 90°)
          const rotateLarge = (rangeMode === 'time' && rangeMinutes > 10) || series.length > 50;

          // Helper: draw single chart for the current page (uses current margins/page size)
          const drawChartSingle = (pts) => {
            const values = pts.map(p => p.w);
            const minW = Math.min(...values);
            const maxW = Math.max(...values);
            const minIdx = values.indexOf(minW);
            const maxIdx = values.indexOf(maxW);

            let pad = (maxW - minW) * 0.1 || 1;
            let vMin = minW - pad;
            let vMax = maxW + pad;
            if (hasTarget) {
              if (target < vMin) vMin = target;
              if (target > vMax) vMax = target;
            }

            const x = doc.page.margins.left;
            const yTop = doc.y;
            const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
            const H = 180; // a bit taller since we have more room on landscape

            const yFor = (v) => yTop + H - ((v - vMin) / ((vMax - vMin) || 1)) * H;
            const xFor = (i) => {
              const denom = Math.max(1, pts.length - 1);
              return x + (i / denom) * W;
            };

            // frame
            doc.save();
            doc.roundedRect(x, yTop, W, H, 6).strokeColor('#b5c0cc').lineWidth(0.5).stroke();
            // grid lines (5 rows)
            for (let i = 0; i <= 4; i++) {
              const gy = yTop + (i / 4) * H;
              doc.moveTo(x, gy).lineTo(x + W, gy).strokeColor('#e6ebf1').lineWidth(0.5).stroke();
            }

            // optional target line
            if (hasTarget) {
              const yT = yFor(target);
              if (yT >= yTop - 2 && yT <= yTop + H + 2) {
                doc.dash(3, { space: 2 });
                doc.moveTo(x, yT).lineTo(x + W, yT).strokeColor('#888').lineWidth(1).stroke();
                doc.undash();
                const targetLabel = (lang === 'ja' && HAS_JP) ? '目標' : 'Target';
                doc.fontSize(9).fillColor('black').text(`${targetLabel}: ${target.toFixed(1)} g`, x + W - 120, yT - 10, { width: 116, align: 'right' });
              }
            }

            // polyline
            doc.moveTo(xFor(0), yFor(pts[0].w));
            for (let i = 1; i < pts.length; i++) doc.lineTo(xFor(i), yFor(pts[i].w));
            doc.strokeColor('#007aff').lineWidth(1.5).stroke();

            // dashed vertical guides (throttled)
            const N = pts.length;
            doc.save();
            doc.dash(1, { space: 2 });
            doc.strokeColor('#d0d7df').lineWidth(0.5);
            const vgStep = Math.max(1, Math.ceil(N / 100)); // cap ~100 guides
            for (let i = 0; i < N; i += vgStep) {
              const px = xFor(i), py = yFor(pts[i].w);
              doc.moveTo(px, py + 1).lineTo(px, yTop + H).stroke();
            }
            doc.undash();
            doc.restore();

            // point markers
            for (let i = 0; i < N; i++) {
              const px = xFor(i), py = yFor(pts[i].w);
              doc.save().circle(px, py, 1.6).fill('#c7d3e0').restore();
            }

            // weight labels — ALWAYS show all when it reasonably fits; otherwise spaced with Min/Max priority
            // Heuristics:
            //  - Force ALL labels if ?labelAll=1
            //  - Portrait: show all up to ~80 points; Landscape: up to ~120 points
            //  - Or if average horizontal step >= estimated label width
            const fontPt = pts.length > 120 ? 7 : 8;
            doc.fontSize(fontPt); // set size before measuring text width

            const sample = '000.0 g';
            const estW = Math.ceil(doc.widthOfString(sample)) + 2; // estimated label width in px
            const avgDx = W / Math.max(1, N - 1);
            const wantAll = labelAll || (!rotateLarge && N <= 80) || (rotateLarge && N <= 120) || (avgDx >= estW);

            if (wantAll) {
              // Label EVERY point (alternate vertically to reduce collisions)
              for (let i = 0; i < N; i++) {
                const px = xFor(i), py = yFor(pts[i].w);
                const offY = (i % 2 === 0) ? -10 : 6;
                const lbl = `${pts[i].w.toFixed(1)} g`;
                const lblW = Math.max(estW, Math.ceil(doc.widthOfString(lbl)) + 2);
                const tx = Math.min(Math.max(px - lblW / 2, x + 2), x + W - lblW - 2);
                const ty = Math.min(Math.max(py + offY, yTop + 2), yTop + H - 12);
                doc.fontSize(fontPt).fillColor('black').text(lbl, tx, ty, { width: lblW, align: 'center' });
              }
            } else {
              // Too dense → keep Min/Max and add more only when far enough in pixels
              const minIdxSet = new Set([minIdx, maxIdx]);
              const minDx = estW + 4; // spacing threshold between label centers
              let lastLblX = -1e9;
              const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => {
                const aExt = minIdxSet.has(a) ? 0 : 1;
                const bExt = minIdxSet.has(b) ? 0 : 1;
                if (aExt !== bExt) return aExt - bExt; // extremes first
                return a - b;
              });
              for (const i of order) {
                const px = xFor(i), py = yFor(pts[i].w);
                if (!minIdxSet.has(i) && (px - lastLblX) < minDx) continue;
                const offY = (i % 2 === 0) ? -10 : 6;
                const lbl = `${pts[i].w.toFixed(1)} g`;
                const lblW = Math.max(estW, Math.ceil(doc.widthOfString(lbl)) + 2);
                const tx = Math.min(Math.max(px - lblW / 2, x + 2), x + W - lblW - 2);
                const ty = Math.min(Math.max(py + offY, yTop + 2), yTop + H - 12);
                doc.fontSize(fontPt).fillColor('black').text(lbl, tx, ty, { width: lblW, align: 'center' });
                lastLblX = px;
              }
            }

            // min/max markers with captions
            const minLabel = (lang === 'ja' && HAS_JP) ? '最小' : 'Min';
            const maxLabel = (lang === 'ja' && HAS_JP) ? '最大' : 'Max';
            const xMax = xFor(maxIdx), yMaxPx = yFor(maxW);
            doc.save().circle(xMax, yMaxPx, 2.5).fill('#ff3b30').restore();
            doc.fontSize(9).fillColor('black').text(`${maxLabel}: ${maxW.toFixed(1)} g`, xMax + 6, Math.max(yTop, yMaxPx - 10), { width: 140 });
            const xMin = xFor(minIdx), yMinPx = yFor(minW);
            doc.save().circle(xMin, yMinPx, 2.5).fill('#34c759').restore();
            doc.fontSize(9).fillColor('black').text(`${minLabel}: ${minW.toFixed(1)} g`, Math.max(x, xMin - 146), Math.min(yTop + H - 12, yMinPx + 4), { width: 140, align: 'right' });

            // bottom time labels — pixel-spaced checkerboard
            const lblW = 40;
            const fontBtm = pts.length > 120 ? 7 : 8;
            const minPx = lblW + 8;
            let lastX = -1e9; let toggle = 0;
            for (let i = 0; i < pts.length; i++) {
              const px = xFor(i);
              const isEdge = (i === 0 || i === pts.length - 1);
              if (!isEdge && (px - lastX) < minPx) continue;
              const tx = Math.min(Math.max(px - lblW / 2, x + 2), x + W - lblW - 2);
              const ty = (toggle++ % 2 === 0) ? (yTop + H - 10) : (yTop + H + 4);
              doc.fontSize(fontBtm).fillColor('black').text(formatJSTShort(pts[i].ts), tx, ty, { width: lblW, align: 'center' });
              lastX = px;
            }

            doc.restore();
            doc.y = yTop + H + 36;
            doc.x = doc.page.margins.left;
          };

          if (rotateLarge) {
            // Move to a new landscape page for the chart
            doc.addPage({ layout: 'landscape', margin: 40 });
            useJPFont(doc);
            doc.x = doc.page.margins.left;
            // small note
            const note = (lang === 'ja' && HAS_JP)
              ? '※ データ量が多いため、グラフを横向きページに回転して表示します。'
              : '※ Large dataset — rendering chart on a rotated (landscape) page.';
            doc.fontSize(9).fillColor('#666').text(note).fillColor('black');
            doc.moveDown(0.25);
            drawChartSingle(series);
            // Return to portrait page for the rest of the report
            doc.addPage({ layout: 'portrait', margin: 40 });
            useJPFont(doc);
            doc.x = doc.page.margins.left;
          } else {
            // Draw inline on the current (portrait) page
            drawChartSingle(series);
          }
        }
      } catch (e) {
        // if chart fails, do not break the whole PDF
        doc.moveDown(0.5);
        doc.fillColor('red').fontSize(10).text((lang === 'ja' && HAS_JP) ? 'グラフ描画中にエラーが発生しました。' : 'Chart rendering error.');
        doc.fillColor('black');
      }
    }

    // === Histogram: classification vs target & tolerance ===
    if (includeHistogram) {
      try {
        let histRows;
        if (rangeMode === 'time' && rangeMinutes > 0) {
          histRows = await dbAllP(
            'SELECT ts, weight FROM measurements WHERE process = ? AND weight IS NOT NULL AND is_error = 0 AND ts >= datetime(\'now\', ?) ORDER BY id DESC',
            [process, `-${rangeMinutes} minutes`]
          );
        } else {
          histRows = await dbAllP(
            'SELECT ts, weight FROM measurements WHERE process = ? AND weight IS NOT NULL AND is_error = 0 ORDER BY id DESC LIMIT ?',
            [process, chartLimit]
          );
        }
        const seriesH = (histRows || [])
          .reverse()
          .map(r => Number(r.weight))
          .filter(v => Number.isFinite(v));

        doc.moveDown(0.75);
        const histTitle = (lang === 'ja' && HAS_JP)
          ? 'ヒストグラム（目標と許容に基づく）'
          : 'Histogram (vs target & tolerance)';
        doc.x = doc.page.margins.left;
        doc.fontSize(14).text(histTitle, doc.page.margins.left, undefined, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'left' });
        doc.moveDown(0.25);

        if (seriesH.length < 1) {
          doc.fontSize(11).text((lang === 'ja' && HAS_JP) ? 'データが不足しています。' : 'Not enough data.');
        } else {
          // Boundaries
          const up = (hasTarget && hasTol) ? upperTol : ERROR_MAX;
          const lo = (hasTarget && hasTol) ? lowerTol : ERROR_MIN;

          let aboveOut = 0, aboveWithin = 0, belowWithin = 0, belowOut = 0;
          for (const w of seriesH) {
            if (w > up) aboveOut++;
            else if (w < lo) belowOut++;
            else if (hasTarget && w >= target) aboveWithin++;
            else belowWithin++;
          }

          const x = doc.page.margins.left;
          const yTop = doc.y;
          const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
          const H = 140;

          // frame + grid
          doc.save();
          doc.roundedRect(x, yTop, W, H, 6).strokeColor('#b5c0cc').lineWidth(0.5).stroke();
          for (let i = 0; i <= 4; i++) {
            const gy = yTop + (i / 4) * H;
            doc.moveTo(x, gy).lineTo(x + W, gy).strokeColor('#e6ebf1').lineWidth(0.5).stroke();
          }

          const counts = [aboveOut, aboveWithin, belowWithin, belowOut];
          const labels = (lang === 'ja' && HAS_JP)
            ? ['上限超過', '目標超え(内)', '目標未満(内)', '下限未満']
            : ['Out of upper', 'Above target (in)', 'Below target (in)', 'Below lower'];
          const colors = ['#ff3b30', '#007aff', '#007aff', '#ff9f0a'];
          const maxC = Math.max(...counts, 1);
          const gap = 18;
          const barW = Math.min(60, (W - gap * (counts.length + 1)) / counts.length);
          let bx = x + gap;
          for (let i = 0; i < counts.length; i++) {
            const h = (counts[i] / maxC) * (H - 28);
            const by = yTop + H - h - 18;
            doc.rect(bx, by, barW, h).fillColor(colors[i]).fill();
            doc.fontSize(9).fillColor('#222').text(String(counts[i]), bx, by - 12, { width: barW, align: 'center' });
            doc.fontSize(9).fillColor('#666').text(labels[i], bx - 10, yTop + H - 14, { width: barW + 20, align: 'center' });
            bx += barW + gap;
          }
          doc.restore();
          doc.y = yTop + H + 24;
        }
      } catch (e) {
        doc.moveDown(0.5);
        doc.fillColor('red').fontSize(10).text((lang === 'ja' && HAS_JP) ? 'ヒストグラムの描画中にエラー' : 'Histogram rendering error');
        doc.fillColor('black');
      }
    }

    if (includeRaw) {
      const shown = Array.isArray(rawRows) ? rawRows.length : 0;
      doc.addPage();
      useJPFont(doc);
      const rawTitle = (lang === 'ja' && HAS_JP)
        ? (rangeMode === 'time' && rangeMinutes > 0 ? `直近の生データ（期間内 ${shown}件）` : `直近の生データ（最新${shown}件）`)
        : (rangeMode === 'time' && rangeMinutes > 0 ? `Recent raw data (time range, ${shown})` : `Recent raw data (last ${shown})`);
      doc.fontSize(14).text(rawTitle);
      doc.moveDown(0.5);
      doc.fontSize(10);
      (rawRows || []).reverse().forEach(r => {
        const w = (r.weight == null) ? '—' : Number(r.weight).toFixed(1);
        doc.text(t(lang, HAS_JP, 'raw_line')({ ts: formatJST(r.ts), w, stable: !!r.stable, err: !!r.is_error }));
      });
    }

    doc.end();
  } catch (e) {
    console.error('PDF export render error:', e);
    try {
      doc.fillColor('red').fontSize(12).text('PDF generation error');
      doc.end();
    } catch (_) {}
  }
});


app.listen(PORT, () => console.log(`API listening on ${process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`}`));

function toMs(v) {
  if (v == null) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : undefined;
}

function buildWhere(q = {}) {
  const cond = [], params = [];
  if (q.process) { cond.push('process = ?'); params.push(q.process); }
  const from = toMs(q.from), to = toMs(q.to);
  if (from !== undefined) { cond.push('ts >= ?'); params.push(from); }
  if (to !== undefined) { cond.push('ts <= ?'); params.push(to); }
  const skipZero = q.skipZero === undefined ? true : q.skipZero === '1' || q.skipZero === true;
  if (skipZero) cond.push('weight IS NOT NULL AND weight != 0');
  const skipUnstable = q.skipUnstable === '1' || q.skipUnstable === true;
  if (skipUnstable) cond.push('(stable IS NULL OR stable = 1)');
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return { where, params };
}

db.serialize(() => {
  db.run('PRAGMA journal_mode=WAL;');    
  db.run('PRAGMA synchronous=NORMAL;');
  db.run('PRAGMA busy_timeout=5000;');   

  db.run(`
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')),
      raw TEXT,
      weight REAL,
      unit TEXT,
      status TEXT,
      source TEXT,
      process TEXT,
      stable INTEGER,
      is_error INTEGER
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_measurements_process_ts
    ON measurements(process, ts)
  `);
});
