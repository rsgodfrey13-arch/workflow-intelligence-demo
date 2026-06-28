// lib/fmcsa_client.js
export async function fetch_fmcsa_carrier_search(dotnumber, { timeout_ms = 15000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout_ms);

  try {
    const base = process.env.fmcsa_base_url;
    const key = process.env.fmcsa_web_key;
    const url = `${base}/${encodeURIComponent(dotnumber)}?webKey=${encodeURIComponent(key)}`;

    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`fmcsa_http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
