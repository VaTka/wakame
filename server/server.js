
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || './data.sqlite';
const ERROR_MIN = parseFloat(process.env.ERROR_MIN ?? '0');
const ERROR_MAX = parseFloat(process.env.ERROR_MAX ?? '50000');
const PDF_FONT = process.env.PDF_FONT || path.join(process.cwd(), 'fonts', 'NotoSansJP-Regular.ttf');
const DEFAULT_PROCESS = process.env.DEFAULT_PROCESS || 'molding';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

let db;
(async () => {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')), -- stored UTC
      raw TEXT,
      weight REAL,
      unit TEXT,
      status TEXT,
      source TEXT,
      process TEXT,      -- 'molding' | 'packaging' | null
      stable INTEGER,    -- 0/1
      is_error INTEGER   -- 0/1
    );
    CREATE INDEX IF NOT EXISTS idx_ts ON measurements(ts);
    CREATE INDEX IF NOT EXISTS idx_process ON measurements(process);
  `);
})();

function detectError(weight) {
  if (weight == null || Number.isNaN(weight)) return 1;
  if (weight < ERROR_MIN) return 1;
  if (weight > ERROR_MAX) return 1;
  return 0;
}

function parseFromRaw(raw) {
  if (typeof raw !== 'string') return {};
  // витягуємо перше число (допускаємо +/-, десяткову крапку)
  const m = raw.match(/([+-]?\d+(?:\.\d+)?)/);
  const weight = m ? Number(parseFloat(m[1]).toFixed(1)) : null;
  // літерні прапорці (наприклад "G S")
  const flags = (raw.match(/[A-Za-z]+/g) || []).join(' ');
  const stable = flags.toUpperCase().includes('S');  // "S" = стабільно (як у тебе)
  // одиницю спробуємо вгадати: G/GR/GRAM тощо => "g"
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


    // якщо прийшов лише raw — парсимо
    let w = weight, u = unit, st = status, stbl = stable;
    if ((w == null || Number.isNaN(w)) && typeof raw === 'string') {
      const p = parseFromRaw(raw);
      if (p.weight != null) w = p.weight;
      if (u == null && p.unit) u = p.unit;
      if (st == null && p.status) st = p.status;
      if (stbl == null && typeof p.stable === 'boolean') stbl = p.stable ? 1 : 0;
    }

    // дефолтний процес, якщо не передано
    const proc = (processFromBody ?? process.env.DEFAULT_PROCESS ?? 'molding');

    // валідація: достатньо мати raw або weight
    if (raw == null && (w == null || Number.isNaN(w))) {
      return res.status(400).json({ error: 'Missing payload: raw or weight required' });
    }

    // помилка для агрегацій, якщо ваги нема або за межами трешхолдів
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


// GET /api/measurements
app.get('/api/measurements', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '300', 10), 5000);
    const proc = req.query.process || null;
    const rows = proc
      ? await db.all('SELECT * FROM measurements WHERE process = ? ORDER BY id DESC LIMIT ?', proc, limit)
      : await db.all('SELECT * FROM measurements ORDER BY id DESC LIMIT ?', limit);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('Query error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/measurements/latest
app.get('/api/measurements/latest', async (req, res) => {
  try {
    const proc = req.query.process || null;
    const row = proc
      ? await db.get('SELECT * FROM measurements WHERE process = ? ORDER BY id DESC LIMIT 1', proc)
      : await db.get('SELECT * FROM measurements ORDER BY id DESC LIMIT 1');
    res.json({ ok: true, data: row || null });
  } catch (e) {
    console.error('Latest error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/aggregates
app.get('/api/aggregates', async (req, res) => {
  try {
    const process = req.query.process || 'molding';
    const defWindow = process === 'packaging' ? 20 : 60;
    const defStep = process === 'packaging' ? 5 : 15;
    const windowMin = Math.max(1, parseInt(req.query.windowMin || String(defWindow), 10));
    const stepMin = Math.max(1, parseInt(req.query.stepMin || String(defStep), 10));

    const rows = await db.all(`
      WITH src AS (
        SELECT * FROM measurements
        WHERE process = ? AND ts >= datetime('now', ?)
      ), bucketed AS (
        SELECT CAST(strftime('%s', ts) / (?*60) AS INTEGER) * (?*60) AS bucket_epoch, weight
        FROM src
        WHERE weight IS NOT NULL AND is_error = 0
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

    res.json({ ok: true, data: rows, windowMin, stepMin });
  } catch (e) {
    console.error('Aggregates error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// CSV export (robust quoting + CRLF + BOM)
app.get('/api/export/csv', async (req, res) => {
  try {
    const process = req.query.process || 'molding';
    const defWindow = process === 'packaging' ? 20 : 60;
    const windowMin = Math.max(1, parseInt(req.query.windowMin || String(defWindow), 10));

    const rows = await db.all(`
      SELECT * FROM measurements
      WHERE process = ? AND ts >= datetime('now', ?)
      ORDER BY id ASC
    `, [process, `-${windowMin} minutes`]);

    // UTF-8 + BOM так, щоб Excel відкрив правильно
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${process}-export.csv"`);
    res.write('\ufeff'); // BOM для Excel

    // CRLF-рядки — Excel це любить
    const EOL = '\r\n';
    const header = ['id', 'ts', 'weight', 'unit', 'status', 'source', 'process', 'stable', 'is_error', 'raw'];
    res.write(header.join(',') + EOL);

    // Правильне екранування: коми/лапки/переноси/пробіли на краях
    const csvEscape = (val) => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    for (const r of rows) {
      // На всяк випадок приберемо переноси з raw, щоб не розривало рядок у Excel
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
  try {
    const process = req.query.process || 'molding';
    const defWindow = process === 'packaging' ? 20 : 60;
    const defStep = process === 'packaging' ? 5 : 15;
    const windowMin = Math.max(1, parseInt(req.query.windowMin || String(defWindow), 10));
    const stepMin = Math.max(1, parseInt(req.query.stepMin || String(defStep), 10));
    const includeRaw = req.query.includeRaw === '1';
    const rawLimit = Math.min(parseInt(req.query.rawLimit || '300', 10), 1000);
    const lang = (req.query.lang === 'ja' ? 'ja' : 'en');

    const latest = await db.get('SELECT * FROM measurements WHERE process = ? ORDER BY id DESC LIMIT 1', process);
    const aggr = await db.all(`
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

    const rawRows = includeRaw
      ? await db.all('SELECT ts, weight, stable, is_error FROM measurements WHERE process = ? ORDER BY id DESC LIMIT ?', process, rawLimit)
      : [];

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${process}-report.pdf"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
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
      const w = (latest.weight == null) ? '—' : latest.weight.toFixed(1);
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
    if (aggr.length === 0) {
      doc.text(t(lang, HAS_JP, 'no_data'));
    } else {
      aggr.forEach(r => {
        const avg = (r.avg_weight == null || Number.isNaN(r.avg_weight)) ? '—' : r.avg_weight.toFixed(1);
        doc.text(t(lang, HAS_JP, 'agg_line')({ ts: formatJST(r.bucket_start_utc), avg, min: r.min_weight, max: r.max_weight, c: r.count }));
      });
    }

    if (includeRaw) {
      doc.addPage();
      useJPFont(doc);
      doc.fontSize(14).text(t(lang, HAS_JP, 'section_raw'));
      doc.moveDown(0.5);
      doc.fontSize(10);
      rawRows.reverse().forEach(r => {
        const w = (r.weight == null) ? '—' : r.weight.toFixed(1);
        doc.text(t(lang, HAS_JP, 'raw_line')({ ts: formatJST(r.ts), w, stable: !!r.stable, err: !!r.is_error }));
      });
    }

    doc.end();
  } catch (e) {
    console.error('PDF export error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// SVG export
app.get('/api/export/svg', async (req, res) => {
  try {
    const process = req.query.process || 'molding';
    const defWindow = process === 'packaging' ? 20 : 60;
    const defStep = process === 'packaging' ? 5 : 15;
    const windowMin = Math.max(1, parseInt(req.query.windowMin || String(defWindow), 10));
    const stepMin = Math.max(1, parseInt(req.query.stepMin || String(defStep), 10));
    const lang = (req.query.lang === 'ja' ? 'ja' : 'en');

    const aggr = await db.all(`
      WITH src AS (
        SELECT * FROM measurements WHERE process = ? AND ts >= datetime('now', ?)
      ),
      bucketed AS (
        SELECT CAST(strftime('%s', ts) / (?*60) AS INTEGER) * (?*60) AS bucket_epoch, weight
        FROM src WHERE weight IS NOT NULL AND is_error = 0
      )
      SELECT datetime(bucket_epoch, 'unixepoch') AS bucket_start_utc,
             ROUND(AVG(weight), 1) AS avg_weight
      FROM bucketed
      GROUP BY bucket_epoch
      ORDER BY bucket_epoch ASC;
    `, [process, `-${windowMin} minutes`, stepMin, stepMin]);

    const W = 960, H = 360, PAD = 40;
    const ys = aggr.map(r => (r.avg_weight ?? 0));
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxY = ys.length ? Math.max(...ys) : 1;
    const padY = ((maxY - minY) * 0.1) || 1;
    const yMin = minY - padY;
    const yMax = maxY + padY;
    let path_d = "";
    const n = ys.length || 1;
    ys.forEach((v, i) => {
      const x = PAD + (i / (n - 1)) * (W - 2 * PAD);
      const ratio = (v - yMin) / ((yMax - yMin) || 1);
      const y = H - PAD - ratio * (H - 2 * PAD);
      path_d += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1) + " ";
    });

    let title = (process === 'packaging') ? 'Packaging — avg' : 'Molding — avg';
    if (lang === 'ja') title = (process === 'packaging') ? '包装 平均' : '成型 平均';

    let gridLines = "";
    for (let i = 0; i <= 5; i++) {
      const y = PAD + i * ((H - 2 * PAD) / 5);
      gridLines += `<line class="grid" x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>
    .bg { fill: #0f141b; }
    .grid { stroke: #1c2430; stroke-width:1; }
    .axis { stroke: #98a6b3; stroke-width:1; }
    .line { fill: none; stroke: #4da3ff; stroke-width:2; }
    .text { fill: #e6eef7; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial; font-size: 12px; }
  </style>
  <rect class="bg" x="0" y="0" width="${W}" height="${H}" rx="12" ry="12"/>
  ${gridLines}
  <text class="text" x="${PAD}" y="${PAD - 12}">${title}</text>
  <line class="axis" x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}"/>
  <line class="axis" x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}"/>
  <path class="line" d="${path_d.strip()}" />
</svg>`;

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.send(svg);
  } catch (e) {
    console.error('SVG export error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
