// Read-only probe for Chainlink Data Streams REST API.
// Creds come from env (DS_CLIENT_ID, DS_HMAC_SECRET) - never hardcoded.
import crypto from 'node:crypto';

const BASE = process.env.DS_BASE ?? 'https://api.dataengine.chain.link';
const CLIENT_ID = process.env.DS_CLIENT_ID;
const SECRET = process.env.DS_HMAC_SECRET;

if (!CLIENT_ID || !SECRET) {
  console.error('Missing DS_CLIENT_ID / DS_HMAC_SECRET');
  process.exit(1);
}

function hmacHeaders(method, path, body = '') {
  const ts = Date.now();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const toSign = `${method} ${path} ${bodyHash} ${CLIENT_ID} ${ts}`;
  const sig = crypto.createHmac('sha256', SECRET).update(toSign).digest('hex');
  return {
    Authorization: CLIENT_ID,
    'X-Authorization-Timestamp': String(ts),
    'X-Authorization-Signature-SHA256': sig,
  };
}

async function get(path) {
  const url = BASE + path;
  const res = await fetch(url, { headers: hmacHeaders('GET', path), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  return { status: res.status, text };
}

(async () => {
  console.log('=== /api/v1/feeds ===');
  const feeds = await get('/api/v1/feeds');
  console.log('status', feeds.status);
  if (feeds.status !== 200) {
    console.log(feeds.text.slice(0, 500));
    process.exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(feeds.text); } catch { console.log(feeds.text.slice(0, 500)); process.exit(1); }
  const list = parsed.feeds ?? parsed;
  console.log('feed count:', Array.isArray(list) ? list.length : 'n/a');
  // Find BTC/USD feeds
  const btc = (Array.isArray(list) ? list : []).filter(f => {
    const s = JSON.stringify(f).toLowerCase();
    return s.includes('btc') ;
  });
  console.log('BTC-related feed entries:', btc.length);
  for (const f of btc.slice(0, 12)) console.log(' ', JSON.stringify(f));

  // Try latest report on first BTC feed id we can find
  const firstId = btc.map(f => f.feedID || f.feedId || f.id).find(Boolean);
  if (firstId) {
    const p = `/api/v1/reports/latest?feedID=${firstId}`;
    console.log('\n=== latest report for', firstId, '===');
    const rep = await get(p);
    console.log('status', rep.status);
    console.log(rep.text.slice(0, 800));
  } else {
    console.log('\nNo BTC feedID field found; dumping first 3 raw feed entries:');
    (Array.isArray(list) ? list : []).slice(0, 3).forEach(f => console.log(JSON.stringify(f)));
  }
})();
