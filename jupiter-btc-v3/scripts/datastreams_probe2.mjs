import crypto from 'node:crypto';
const BASE = process.env.DS_BASE ?? 'https://api.dataengine.chain.link';
const CLIENT_ID = process.env.DS_CLIENT_ID;
const SECRET = process.env.DS_HMAC_SECRET;

function hmacHeaders(method, path, body = '') {
  const ts = Date.now();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const toSign = `${method} ${path} ${bodyHash} ${CLIENT_ID} ${ts}`;
  const sig = crypto.createHmac('sha256', SECRET).update(toSign).digest('hex');
  return { Authorization: CLIENT_ID, 'X-Authorization-Timestamp': String(ts), 'X-Authorization-Signature-SHA256': sig };
}
async function get(path) {
  const res = await fetch(BASE + path, { headers: hmacHeaders('GET', path), signal: AbortSignal.timeout(15000) });
  return { status: res.status, text: await res.text() };
}

const KNOWN = {
  'BTC/USD (mainnet v3)': '0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439',
  'ETH/USD (mainnet v3)': '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782',
};

(async () => {
  console.log('=== RAW /api/v1/feeds ===');
  const f = await get('/api/v1/feeds');
  console.log('status', f.status);
  console.log(f.text.slice(0, 1500));

  for (const [name, id] of Object.entries(KNOWN)) {
    const p = `/api/v1/reports/latest?feedID=${id}`;
    const r = await get(p);
    console.log(`\n=== latest ${name} ===`);
    console.log('status', r.status);
    console.log(r.text.slice(0, 600));
  }
})();
