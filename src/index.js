// KME Apps: one private dashboard for every app Kollin builds.
//
//   /            the dashboard (login required for its data)
//   /kme.js      the tracker each app loads: counts visits and reports errors
//   /t           where the tracker sends them (public, write-only)
//   /api/*       dashboard data (login required)
//
// Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
//   KME_USER, KME_PASSWORD         your login
//   FIREBASE_SERVICE_ACCOUNT       Sports Hub sign-ups (Firebase service account JSON)
//   ASC_KEY_ID, ASC_ISSUER_ID,     App Store downloads (App Store Connect API key,
//   ASC_PRIVATE_KEY, ASC_VENDOR      Sales role or higher, and your vendor number)
import APP_HTML from './app.html';
import TRACKER from './kme.txt';

const DAY_MS = 86400000;
const SESSION_DAYS = 30;
const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor|curl|wget|python|axios|node-fetch/i;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/kme.js') return tracker(req);
      if (url.pathname === '/t') return await collect(req, env, ctx);
      if (url.pathname.startsWith('/api/')) return await api(req, env, url, ctx);
      if (url.pathname === '/' || url.pathname === '/index.html') return page();
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      return new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil((async () => {
      await ensure(env);
      if (ascReady(env)) await ascSync(env, 3).catch(() => {});
      await env.DB.prepare('DELETE FROM events WHERE ts < ?').bind(Date.now() - 400 * DAY_MS).run();
      await env.DB.prepare('DELETE FROM logins WHERE ts < ?').bind(Date.now() - 30 * DAY_MS).run();
    })());
  },
};

// ---------- helpers ----------
function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), { status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra) });
}
const dayOf = (ts, env) => new Intl.DateTimeFormat('en-CA', { timeZone: (env && env.TZ) || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
let ENSURED = false;
async function ensure(env) {
  if (ENSURED) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, app TEXT NOT NULL, kind TEXT NOT NULL, path TEXT, dev TEXT, country TEXT, ref TEXT, msg TEXT, src TEXT, plat TEXT)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ev_app_day ON events(app, day)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ev_kind_ts ON events(kind, ts)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS downloads (day TEXT NOT NULL, title TEXT, sku TEXT, parent TEXT, apple_id TEXT, ptype TEXT, units INTEGER, country TEXT, proceeds REAL, currency TEXT)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS dl_day ON downloads(day)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS logins (ts INTEGER NOT NULL, ok INTEGER NOT NULL, who TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, ts INTEGER)'),
  ]);
  ENSURED = true;
}
async function kvGet(env, k, maxAge) {
  const r = await env.DB.prepare('SELECT v, ts FROM kv WHERE k = ?').bind(k).first();
  if (!r || (maxAge && Date.now() - r.ts > maxAge)) return null;
  try { return JSON.parse(r.v); } catch { return null; }
}
const kvSet = (env, k, v) => env.DB.prepare('INSERT INTO kv (k, v, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts').bind(k, JSON.stringify(v), Date.now()).run();

function page() {
  return new Response(APP_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}

// ---------- tracker ----------
function tracker() {
  return new Response(TRACKER, { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' } });
}
const RATE = new Map(); // device → [windowStart, count]  (per isolate; good enough to stop floods)
async function collect(req, env, ctx) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: cors });
  const ok = () => new Response(null, { status: 204, headers: cors });
  if (BOT.test(req.headers.get('user-agent') || '')) return ok();
  const raw = await req.text();
  if (raw.length > 4000) return ok();
  let d; try { d = JSON.parse(raw); } catch { return ok(); }
  const app = String(d.app || '').toLowerCase();
  const kind = ['view', 'error', 'event'].includes(d.kind) ? d.kind : '';
  if (!SLUG.test(app) || !kind) return ok();
  const dev = clip(d.dev, 40).replace(/[^a-z0-9]/gi, '');
  const key = dev || req.headers.get('cf-connecting-ip') || 'x', now = Date.now();
  const w = RATE.get(key);
  if (w && now - w[0] < 60000) { if (++w[1] > 30) return ok(); } else RATE.set(key, [now, 1]);
  if (RATE.size > 5000) RATE.clear();
  if (kind === 'error' && /^Script error\.?$/i.test(String(d.msg || ''))) return ok();
  await ensure(env);
  ctx.waitUntil(env.DB.prepare('INSERT INTO events (ts, day, app, kind, path, dev, country, ref, msg, src, plat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(now, dayOf(now, env), app, kind, clip(d.path, 120), dev, clip((req.cf && req.cf.country) || '', 2), clip(d.ref, 80), kind === 'view' ? '' : clip(d.msg, 300), kind === 'error' ? clip(d.src, 200) : '', clip(d.plat, 16)).run());
  return ok();
}

// ---------- login ----------
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = (s) => b64u(enc.encode(s));
const unb64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return atob(s); };
async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode('kme-session|' + (env.KME_SECRET || '') + '|' + env.KME_USER + '|' + env.KME_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function sameText(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a))), crypto.subtle.digest('SHA-256', enc.encode(String(b)))]);
  const p = new Uint8Array(x), q = new Uint8Array(y); let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}
async function makeSession(env) {
  const body = b64uStr(JSON.stringify({ u: env.KME_USER, exp: Date.now() + SESSION_DAYS * DAY_MS }));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return body + '.' + b64u(sig);
}
async function signedIn(req, env) {
  if (!env.KME_USER || !env.KME_PASSWORD) return false;
  const m = /(?:^|;\s*)kme=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!m) return false;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return false;
  const good = await crypto.subtle.verify('HMAC', await hmacKey(env), Uint8Array.from(unb64u(sig), (c) => c.charCodeAt(0)), enc.encode(body)).catch(() => false);
  if (!good) return false;
  try { const s = JSON.parse(unb64u(body)); return s.u === env.KME_USER && s.exp > Date.now(); } catch { return false; }
}
const cookie = (v, age) => `kme=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
async function login(req, env) {
  if (!env.KME_USER || !env.KME_PASSWORD) return json({ error: 'setup', message: 'Add KME_USER and KME_PASSWORD in Cloudflare first.' }, 400);
  await ensure(env);
  const since = Date.now() - 15 * 60000;
  const fails = await env.DB.prepare('SELECT COUNT(*) AS n FROM logins WHERE ok = 0 AND ts > ?').bind(since).first();
  if (fails && fails.n >= 8) return json({ error: 'locked', message: 'Too many wrong tries. Wait 15 minutes.' }, 429);
  let d = {}; try { d = await req.json(); } catch {}
  const okUser = await sameText(String(d.user || '').trim().toLowerCase(), String(env.KME_USER).trim().toLowerCase());
  const okPass = await sameText(String(d.pass || ''), String(env.KME_PASSWORD));
  const ok = okUser && okPass;
  const ip = req.headers.get('cf-connecting-ip') || '';
  const ipHash = b64u(await crypto.subtle.digest('SHA-256', enc.encode('kme|' + ip))).slice(0, 12);
  await env.DB.prepare('INSERT INTO logins (ts, ok, who) VALUES (?, ?, ?)').bind(Date.now(), ok ? 1 : 0, ipHash).run();
  if (!ok) return json({ error: 'bad', message: 'Wrong username or password.' }, 401);
  return json({ ok: true }, 200, { 'set-cookie': cookie(await makeSession(env), SESSION_DAYS * 86400) });
}

// ---------- API ----------
async function api(req, env, url, ctx) {
  const p = url.pathname;
  if (req.method === 'POST' && req.headers.get('x-kme') !== '1') return json({ error: 'bad request' }, 400);
  if (p === '/api/login' && req.method === 'POST') return login(req, env);
  if (p === '/api/logout' && req.method === 'POST') return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
  if (p === '/api/me') return json({ signedIn: await signedIn(req, env), setup: !!(env.KME_USER && env.KME_PASSWORD) });
  if (!(await signedIn(req, env))) return json({ error: 'signin' }, 401);
  await ensure(env);
  const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days'), 10) || 30));
  if (p === '/api/overview') return json(await overview(env, days));
  if (p === '/api/app') return json(await appDetail(env, String(url.searchParams.get('app') || ''), days));
  if (p === '/api/errors') return json(await errors(env, days));
  if (p === '/api/sportshub') return json(await sportsHub(env, url.searchParams.get('fresh') === '1'));
  if (p === '/api/appstore') return json(await appStore(env, days));
  if (p === '/api/appstore/sync' && req.method === 'POST') {
    if (!ascReady(env)) return json({ error: 'App Store keys aren’t set up yet.' }, 400);
    const r = await ascSync(env, Math.min(days, 60));
    return json(r);
  }
  if (p === '/api/setup') return json({
    origin: url.origin,
    login: true,
    sportsHub: !!env.FIREBASE_SERVICE_ACCOUNT,
    appStore: ascReady(env),
    appStoreMissing: ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_VENDOR'].filter((k) => !env[k]),
    tz: env.TZ || 'America/New_York',
  });
  return json({ error: 'not found' }, 404);
}

function dayList(env, days) {
  const out = []; const now = Date.now();
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(now - i * DAY_MS, env));
  return [...new Set(out)];
}
async function overview(env, days) {
  const list = dayList(env, days), from = list[0], today = list[list.length - 1];
  const since = Date.now() - days * DAY_MS;
  const [daily, apps, errs] = await Promise.all([
    env.DB.prepare("SELECT app, day, COUNT(*) AS v, COUNT(DISTINCT dev) AS u FROM events WHERE kind = 'view' AND day >= ? GROUP BY app, day").bind(from).all(),
    env.DB.prepare("SELECT app, SUM(kind = 'view') AS v, COUNT(DISTINCT CASE WHEN kind = 'view' THEN dev END) AS u, MAX(ts) AS last, SUM(kind = 'error') AS e FROM events WHERE ts >= ? GROUP BY app").bind(since).all(),
    env.DB.prepare("SELECT app, COUNT(*) AS n FROM events WHERE kind = 'error' AND ts >= ? GROUP BY app").bind(Date.now() - DAY_MS).all(),
  ]);
  const totals = await env.DB.prepare("SELECT COUNT(*) AS v, COUNT(DISTINCT dev) AS u FROM events WHERE kind = 'view' AND day >= ?").bind(from).first();
  const todayRow = await env.DB.prepare("SELECT COUNT(*) AS v, COUNT(DISTINCT dev) AS u FROM events WHERE kind = 'view' AND day = ?").bind(today).first();
  const allApps = await env.DB.prepare('SELECT app, MAX(ts) AS last FROM events GROUP BY app').all();
  const series = {};
  for (const r of daily.results) (series[r.app] = series[r.app] || {})[r.day] = { v: r.v, u: r.u };
  const byApp = Object.fromEntries(apps.results.map((r) => [r.app, r]));
  const err24 = Object.fromEntries(errs.results.map((r) => [r.app, r.n]));
  const rows = allApps.results.map((a) => {
    const s = series[a.app] || {}, x = byApp[a.app] || {};
    return { app: a.app, last: a.last, views: x.v || 0, devices: x.u || 0, errors24: err24[a.app] || 0, days: list.map((d) => (s[d] ? s[d].v : 0)) };
  }).sort((a, b) => b.views - a.views || b.last - a.last);
  const teamDays = list.map((d) => rows.reduce((t, r) => t + r.days[list.indexOf(d)], 0));
  return { days: list, today: { views: (todayRow && todayRow.v) || 0, devices: (todayRow && todayRow.u) || 0 }, total: { views: (totals && totals.v) || 0, devices: (totals && totals.u) || 0 }, errors24: errs.results.reduce((t, r) => t + r.n, 0), allDays: teamDays, apps: rows };
}
async function appDetail(env, app, days) {
  if (!SLUG.test(app)) return { error: 'Unknown app' };
  const list = dayList(env, days), from = list[0];
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
  const [daily, paths, countries, plats, refs, errs, newDev] = await Promise.all([
    q("SELECT day, COUNT(*) AS v, COUNT(DISTINCT dev) AS u FROM events WHERE app = ? AND kind = 'view' AND day >= ? GROUP BY day", app, from),
    q("SELECT path, COUNT(*) AS n FROM events WHERE app = ? AND kind = 'view' AND day >= ? GROUP BY path ORDER BY n DESC LIMIT 12", app, from),
    q("SELECT country, COUNT(DISTINCT dev) AS n FROM events WHERE app = ? AND kind = 'view' AND day >= ? GROUP BY country ORDER BY n DESC LIMIT 12", app, from),
    q("SELECT plat, COUNT(DISTINCT dev) AS n FROM events WHERE app = ? AND kind = 'view' AND day >= ? GROUP BY plat ORDER BY n DESC", app, from),
    q("SELECT ref, COUNT(*) AS n FROM events WHERE app = ? AND kind = 'view' AND day >= ? AND ref != '' GROUP BY ref ORDER BY n DESC LIMIT 10", app, from),
    q("SELECT msg, src, COUNT(*) AS n, COUNT(DISTINCT dev) AS devs, MAX(ts) AS last FROM events WHERE app = ? AND kind = 'error' AND day >= ? GROUP BY msg, src ORDER BY last DESC LIMIT 30", app, from),
    q("SELECT COUNT(*) AS n FROM (SELECT dev, MIN(day) AS first FROM events WHERE app = ? AND kind = 'view' AND dev != '' GROUP BY dev) WHERE first >= ?", app, from),
  ]);
  const m = Object.fromEntries(daily.map((r) => [r.day, r]));
  const tot = await env.DB.prepare("SELECT COUNT(*) AS v, COUNT(DISTINCT dev) AS u FROM events WHERE app = ? AND kind = 'view' AND day >= ?").bind(app, from).first();
  const events = await q("SELECT msg, COUNT(*) AS n FROM events WHERE app = ? AND kind = 'event' AND day >= ? GROUP BY msg ORDER BY n DESC LIMIT 12", app, from);
  return { app, days: list, views: list.map((d) => (m[d] ? m[d].v : 0)), devices: list.map((d) => (m[d] ? m[d].u : 0)), total: { views: (tot && tot.v) || 0, devices: (tot && tot.u) || 0, newDevices: (newDev[0] && newDev[0].n) || 0 }, paths, countries, plats, refs, errors: errs, events };
}
async function errors(env, days) {
  const since = Date.now() - days * DAY_MS;
  const r = await env.DB.prepare("SELECT app, msg, src, plat, COUNT(*) AS n, COUNT(DISTINCT dev) AS devs, MIN(ts) AS first, MAX(ts) AS last FROM events WHERE kind = 'error' AND ts >= ? GROUP BY app, msg, src ORDER BY last DESC LIMIT 100").bind(since).all();
  return { errors: r.results };
}

// ---------- Google (Sports Hub) ----------
const GTOK = new Map();
async function googleToken(sa, scope) {
  const hit = GTOK.get(scope);
  if (hit && hit.exp > Date.now() + 60000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64uStr(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64u(sig) });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) throw new Error('Google sign-in for the service account failed. Check FIREBASE_SERVICE_ACCOUNT.');
  GTOK.set(scope, { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 });
  return d.access_token;
}
function fsVal(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('mapValue' in v) { const o = {}; for (const k in v.mapValue.fields || {}) o[k] = fsVal(v.mapValue.fields[k]); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsVal);
  return null;
}
const fsDoc = (d) => { const o = {}; for (const k in d.fields || {}) o[k] = fsVal(d.fields[k]); return o; };
async function sportsHub(env, fresh) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) return { setup: false };
  if (!fresh) { const c = await kvGet(env, 'sportshub', 10 * 60000); if (c) return c; }
  let sa; try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT isn’t valid JSON. Paste the whole file.'); }
  const tok = await googleToken(sa, 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform');
  const H = { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' };
  const root = 'https://firestore.googleapis.com/v1/projects/' + sa.project_id + '/databases/(default)/documents';
  const docBase = 'projects/' + sa.project_id + '/databases/(default)/documents/';

  // Accounts (Firebase Auth).
  const accounts = [];
  let page = '';
  for (let n = 0; n < 20; n++) {
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/projects/' + sa.project_id + '/accounts:batchGet?maxResults=1000' + (page ? '&nextPageToken=' + encodeURIComponent(page) : ''), { headers: H });
    if (!r.ok) throw new Error('Couldn’t list Sports Hub accounts (' + r.status + ').');
    const d = await r.json();
    for (const u of d.users || []) accounts.push({ uid: u.localId, email: u.email || '', name: u.displayName || '', created: Number(u.createdAt) || 0, lastLogin: Number(u.lastLoginAt) || 0, lastActive: u.lastRefreshAt ? Date.parse(u.lastRefreshAt) : Number(u.lastLoginAt) || 0, via: ((u.providerUserInfo || [])[0] || {}).providerId || (u.email ? 'password' : 'anonymous'), disabled: !!u.disabled, teams: [] });
    if (!d.nextPageToken) break;
    page = d.nextPageToken;
  }
  const byUid = Object.fromEntries(accounts.map((a) => [a.uid, a]));

  // Teams.
  const teams = [];
  page = '';
  for (let n = 0; n < 20; n++) {
    const r = await fetch(root + '/teams?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : ''), { headers: H });
    if (!r.ok) throw new Error('Couldn’t list Sports Hub teams (' + r.status + ').');
    const d = await r.json();
    for (const doc of d.documents || []) {
      const f = fsDoc(doc), id = doc.name.split('/').pop();
      teams.push({ id, name: f.name || f.teamName || id, plan: f.plan || 'free', season: [f.season, f.year].filter(Boolean).join(' '), sport: f.sport || '', created: Date.parse(doc.createTime) || 0, updated: Date.parse(doc.updateTime) || 0, owner: '', ownerEmail: '', members: 0 });
    }
    if (!d.nextPageToken) break;
    page = d.nextPageToken;
  }
  // Owners from teams/{id}/config/setup.
  for (let i = 0; i < teams.length; i += 100) {
    const chunk = teams.slice(i, i + 100);
    const r = await fetch(root + ':batchGet', { method: 'POST', headers: H, body: JSON.stringify({ documents: chunk.map((t) => docBase + 'teams/' + t.id + '/config/setup'), mask: { fieldPaths: ['owner'] } }) });
    if (!r.ok) break;
    for (const x of await r.json()) {
      if (!x.found) continue;
      const tid = x.found.name.split('/teams/')[1].split('/')[0], t = teams.find((y) => y.id === tid), owner = fsDoc(x.found).owner;
      if (t && owner) { t.owner = owner; t.ownerEmail = (byUid[owner] || {}).email || ''; }
    }
  }
  // Who belongs to which team: users/{uid}/teams/{teamId}.
  const r = await fetch(root + ':runQuery', { method: 'POST', headers: H, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'teams', allDescendants: true }], select: { fields: [{ fieldPath: '__name__' }] }, limit: 5000 } }) });
  if (r.ok) {
    for (const row of await r.json()) {
      const name = row.document && row.document.name; if (!name) continue;
      const m = /\/users\/([^/]+)\/teams\/([^/]+)$/.exec(name); if (!m) continue;
      if (byUid[m[1]]) byUid[m[1]].teams.push(m[2]);
      const t = teams.find((y) => y.id === m[2]); if (t) t.members++;
    }
  }
  const now = Date.now();
  const out = {
    setup: true, at: now,
    totals: {
      accounts: accounts.length,
      new7: accounts.filter((a) => now - a.created < 7 * DAY_MS).length,
      new30: accounts.filter((a) => now - a.created < 30 * DAY_MS).length,
      active7: accounts.filter((a) => now - a.lastActive < 7 * DAY_MS).length,
      teams: teams.length,
      plans: teams.reduce((o, t) => ((o[t.plan] = (o[t.plan] || 0) + 1), o), {}),
    },
    accounts: accounts.sort((a, b) => b.created - a.created).slice(0, 500),
    teams: teams.sort((a, b) => b.created - a.created),
  };
  await kvSet(env, 'sportshub', out);
  return out;
}

// ---------- App Store Connect ----------
const ascReady = (env) => !!(env.ASC_KEY_ID && env.ASC_ISSUER_ID && env.ASC_PRIVATE_KEY && env.ASC_VENDOR);
async function ascToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64uStr(JSON.stringify({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' })) + '.' + b64uStr(JSON.stringify({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' }));
  const der = Uint8Array.from(atob(String(env.ASC_PRIVATE_KEY).replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return unsigned + '.' + b64u(sig);
}
// Apple's daily reports use Pacific time and show up the next morning.
const pacificDay = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
async function ascReport(env, tok, day) {
  for (const version of ['1_1', '1_0']) {
    const qs = new URLSearchParams({ 'filter[frequency]': 'DAILY', 'filter[reportType]': 'SALES', 'filter[reportSubType]': 'SUMMARY', 'filter[vendorNumber]': String(env.ASC_VENDOR).trim(), 'filter[reportDate]': day, 'filter[version]': version });
    const r = await fetch('https://api.appstoreconnect.apple.com/v1/salesReports?' + qs, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/a-gzip' } });
    if (r.status === 404) { const t = await r.text(); if (/version/i.test(t) && version === '1_1') continue; return []; }
    if (r.status === 400 && version === '1_1') continue;
    if (!r.ok) throw new Error('App Store Connect said ' + r.status + ': ' + clip(await r.text(), 200));
    const text = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const lines = text.split('\n').filter(Boolean);
    const head = lines.shift().split('\t');
    const col = (n) => head.indexOf(n);
    const C = { title: col('Title'), sku: col('SKU'), parent: col('Parent Identifier'), ptype: col('Product Type Identifier'), units: col('Units'), proceeds: col('Developer Proceeds'), country: col('Country Code'), cur: col('Currency of Proceeds'), apple: col('Apple Identifier') };
    return lines.map((l) => l.split('\t')).map((c) => ({ title: c[C.title] || '', sku: c[C.sku] || '', parent: c[C.parent] || '', ptype: c[C.ptype] || '', units: Number(c[C.units]) || 0, proceeds: (Number(c[C.proceeds]) || 0) * (Number(c[C.units]) || 0), country: c[C.country] || '', currency: c[C.cur] || '', apple: c[C.apple] || '' }));
  }
  return [];
}
async function ascSync(env, days) {
  const tok = await ascToken(env);
  let rows = 0, fetched = 0;
  for (let i = 1; i <= days; i++) {
    const day = pacificDay(Date.now() - i * DAY_MS);
    const list = await ascReport(env, tok, day);
    fetched++;
    const stmts = [env.DB.prepare('DELETE FROM downloads WHERE day = ?').bind(day)];
    for (const x of list) stmts.push(env.DB.prepare('INSERT INTO downloads (day, title, sku, parent, apple_id, ptype, units, country, proceeds, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(day, x.title, x.sku, x.parent, x.apple, x.ptype, x.units, x.country, x.proceeds, x.currency));
    await env.DB.batch(stmts);
    rows += list.length;
  }
  await kvSet(env, 'ascSync', { at: Date.now(), days: fetched, rows });
  return { ok: true, days: fetched, rows };
}
// Product types: 1* = new download, 3* = redownload, 7* = update, IA*/FI1 = in-app purchase.
const ptKind = (t) => (/^(1|F1)/.test(t) ? 'new' : /^(3|F3)/.test(t) ? 're' : /^(7|F7)/.test(t) ? 'update' : /^(IA|FI)/.test(t) ? 'iap' : 'other');
async function appStore(env, days) {
  if (!ascReady(env)) return { setup: false, missing: ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_VENDOR'].filter((k) => !env[k]) };
  const list = []; for (let i = days; i >= 1; i--) list.push(pacificDay(Date.now() - i * DAY_MS));
  const rows = (await env.DB.prepare('SELECT * FROM downloads WHERE day >= ?').bind(list[0]).all()).results;
  const skuTitle = {}; for (const r of rows) if (ptKind(r.ptype) !== 'iap') skuTitle[r.sku] = r.title;
  const apps = {}, countries = {};
  for (const r of rows) {
    const k = ptKind(r.ptype), name = k === 'iap' ? (skuTitle[r.parent] || r.parent || 'In-app purchases') : r.title;
    const a = apps[name] = apps[name] || { name, new: 0, re: 0, update: 0, iap: 0, proceeds: {}, daily: Object.fromEntries(list.map((d) => [d, 0])) };
    a[k === 'other' ? 'update' : k] += r.units;
    if (k === 'new' && a.daily[r.day] != null) a.daily[r.day] += r.units;
    if (r.proceeds) a.proceeds[r.currency || 'USD'] = (a.proceeds[r.currency || 'USD'] || 0) + r.proceeds;
    if (k === 'new') countries[r.country] = (countries[r.country] || 0) + r.units;
  }
  const sync = await kvGet(env, 'ascSync');
  return { setup: true, days: list, lastSync: sync, apps: Object.values(apps).map((a) => Object.assign(a, { daily: list.map((d) => a.daily[d]) })).sort((x, y) => y.new - x.new), countries: Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 12) };
}
