
import 'dotenv/config';
import axios from 'axios';
import { SerialPort } from 'serialport';
import { ReadlineParser } from 'serialport';

const SERIAL_PORT = process.env.SERIAL_PORT || '/dev/tty.BT62-BB62';
const BAUD_RATE = parseInt(process.env.BAUD_RATE || '9600', 10);
const BACKEND_URL = `http://localhost:${process.env.PORT || 3001}`;

const port = new SerialPort({ path: SERIAL_PORT, baudRate: BAUD_RATE, dataBits: 8, parity: 'none', stopBits: 1 });
const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

parser.on('data', async (line) => {
  const raw = line.trim();
  try {
    const m = raw.match(/([+-]?\d+(?:\.\d+)?)/);
    const weight = m ? Number(parseFloat(m[1]).toFixed(1)) : null;
    const flags = (raw.match(/[A-Za-z]+/g) || []).join(' ');
    const stable = flags.toUpperCase().includes('S');
    const PROC = process.env.PROCESS || 'molding';
    await axios.post(`${BACKEND_URL}/api/ingest`, { raw, weight, unit:'g', status: flags, PROC, stable, source: SERIAL_PORT });
    console.log('[ingestor] sent', { raw, weight, PROC });
  } catch (e) { console.error('[ingestor] error', e.response?.status, e.response?.data || e.message); }
});

port.on('open', () => console.log('[ingestor] Serial port opened'));
port.on('error', (e) => console.error('[ingestor] Serial error:', e.message));
