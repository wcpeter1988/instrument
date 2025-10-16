// Simple seeding script to inject sample data into the datalake API
// Usage: node datalake/scripts/seed.js

const BASE_URL = process.env.DL_URL || 'http://localhost:3300';

async function postJSON(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} failed: ${res.status} ${res.statusText} ${text}`);
  }
  return res.json().catch(() => ({}));
}

async function getJSON(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

function nowMinus(ms) {
  return Date.now() - ms;
}

async function main() {
  const project = process.env.DL_PROJECT || 'demo';
  // Items to ensure multiple tagids per session, with 1:1 tagid->description mapping
  const items = [
    // Session s1: two tagids
    { tagid: 'sensor_h', description: 'humidity', session: 's1', payload: { pct: 46 }, timestamp: nowMinus(58 * 60 * 1000) },
    { tagid: 'sensor_h', description: 'humidity', session: 's1', payload: { pct: 47 }, timestamp: nowMinus(53 * 60 * 1000) },
    { tagid: 'sensor_t', description: 'temp',     session: 's1', payload: { c: 22.7 }, timestamp: nowMinus(49 * 60 * 1000) },
    { tagid: 'sensor_t', description: 'temp',     session: 's1', payload: { c: 22.9 }, timestamp: nowMinus(44 * 60 * 1000) },

    // Session s2: two tagids
    { tagid: 'sensor_h', description: 'humidity', session: 's2', payload: { pct: 50 }, timestamp: nowMinus(39 * 60 * 1000) },
    { tagid: 'sensor_h', description: 'humidity', session: 's2', payload: { pct: 52 }, timestamp: nowMinus(34 * 60 * 1000) },
    { tagid: 'sensor_t', description: 'temp',     session: 's2', payload: { c: 22.1 }, timestamp: nowMinus(29 * 60 * 1000) },
    { tagid: 'sensor_t', description: 'temp',     session: 's2', payload: { c: 22.3 }, timestamp: nowMinus(24 * 60 * 1000) },

    // Session s3: two tagids
    { tagid: 'sensor_p', description: 'pressure', session: 's3', payload: { hPa: 1012 }, timestamp: nowMinus(19 * 60 * 1000) },
    { tagid: 'sensor_h', description: 'humidity', session: 's3', payload: { pct: 45 }, timestamp: nowMinus(14 * 60 * 1000) },
  ];

  const all = items;
  console.log(`Seeding ${all.length} items into project '${project}' at ${BASE_URL}...`);

  let ok = 0;
  for (const [i, item] of all.entries()) {
    try {
  const body = { project, ...item };
      const res = await postJSON('/api/data', body);
      ok++;
      console.log(`  [${i + 1}/${all.length}] ok ->`, res?.status || 'stored');
    } catch (err) {
      console.error(`  [${i + 1}/${all.length}] fail ->`, err.message);
    }
  }

  try {
    const flat = await getJSON(`/api/data?project=${encodeURIComponent(project)}&nest=flat`);
    const cnt = Array.isArray(flat?.items) ? flat.items.length : 0;
    console.log(`Verify: project='${project}' flat items returned = ${cnt}`);
  } catch (e) {
    console.warn('Verify request failed:', e.message);
  }

  console.log(`Done. Success: ${ok}/${all.length}`);
}

main().catch((e) => {
  console.error('Seed script error:', e);
  process.exit(1);
});
