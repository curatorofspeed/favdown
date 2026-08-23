#!/usr/bin/env node
// FAV DOWN worker — polls ESPN MLB scoreboard, pushes an ntfy alert when a
// pregame favorite falls behind. Zero deps. State lives in state.json,
// committed back to the repo by the workflow.

const fs = require('fs');

const NTFY_SERVER = process.env.NTFY_SERVER || 'https://ntfy.sh';
const TOPIC = process.env.NTFY_TOPIC;
const REPING = (process.env.FAVDOWN_REPING ?? '1') === '1';     // ping again when deficit grows
const RECOVERY = (process.env.FAVDOWN_RECOVERY ?? '1') === '1'; // ping when fav ties/retakes lead
const STATE_FILE = 'state.json';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (favdown watcher)', 'Accept': 'application/json' };

const etNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const ymd = d => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
const cents = ml => (typeof ml === 'number' && isFinite(ml))
  ? Math.round((ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100)) * 100) : null;
const fmtMl = ml => typeof ml === 'number' ? (ml > 0 ? `+${ml}` : `${ml}`) : '';

async function fetchBoard(dateStr) {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${dateStr}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return (await r.json()).events || [];
}

function parseEvent(ev, cachedFav) {
  const comp = ev.competitions?.[0]; if (!comp) return null;
  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;
  const g = {
    id: String(ev.id),
    state: ev.status?.type?.state || 'pre',
    detail: ev.status?.type?.shortDetail || '',
    home: { ab: home.team?.abbreviation || 'HOM', runs: +(home.score || 0) },
    away: { ab: away.team?.abbreviation || 'AWY', runs: +(away.score || 0) },
    fav: cachedFav?.side || null, ml: cachedFav?.ml ?? null
  };
  // Pregame odds vanish once live, so the fav gets cached on morning runs.
  if (!g.fav) {
    const o = comp.odds?.[0];
    if (o) {
      const hm = o.homeTeamOdds || {}, aw = o.awayTeamOdds || {};
      if (hm.favorite) { g.fav = 'home'; g.ml = hm.moneyLine ?? null; }
      else if (aw.favorite) { g.fav = 'away'; g.ml = aw.moneyLine ?? null; }
      else if (typeof hm.moneyLine === 'number' && typeof aw.moneyLine === 'number') {
        g.fav = hm.moneyLine < aw.moneyLine ? 'home' : 'away';
        g.ml = g.fav === 'home' ? hm.moneyLine : aw.moneyLine;
      } else if (typeof o.details === 'string') {
        const m = o.details.match(/([A-Z]{2,4})\s*(-\d+)/);
        if (m) {
          if (m[1] === g.home.ab) g.fav = 'home';
          else if (m[1] === g.away.ab) g.fav = 'away';
          if (g.fav) g.ml = parseInt(m[2], 10);
        }
      }
    }
  }
  if (g.fav && g.state === 'in') {
    const f = g[g.fav], opp = g[g.fav === 'home' ? 'away' : 'home'];
    g.diff = f.runs - opp.runs;
    g.favStatus = g.diff < 0 ? 'down' : g.diff === 0 ? 'tied' : 'up';
  }
  return g;
}

// Pure alert engine: previous snapshot + current game -> pings to send.
function decide(prev, g, opts = { reping: REPING, recovery: RECOVERY }) {
  if (g.state !== 'in' || !g.fav || !g.favStatus) return [];
  const f = g[g.fav], opp = g[g.fav === 'home' ? 'away' : 'home'];
  const c = cents(g.ml);
  const line = g.ml != null ? ` (${fmtMl(g.ml)}${c != null ? ` · ${c}¢` : ''})` : '';
  const wasLive = !!(prev && prev.state === 'in' && prev.favStatus);

  if (g.favStatus === 'down' && (!wasLive || prev.favStatus !== 'down'))
    return [[`🔻 FAV DOWN: ${f.ab}`, `${f.ab}${line} trails ${opp.ab} ${f.runs}–${opp.runs} · ${g.detail}`, 'baseball,small_red_triangle_down']];
  if (g.favStatus === 'down' && wasLive && prev.favStatus === 'down' && typeof prev.diff === 'number' && g.diff < prev.diff && opts.reping)
    return [[`🔻 ${f.ab} down ${-g.diff}`, `Deficit grew: ${f.runs}–${opp.runs} vs ${opp.ab} · ${g.detail}`, 'baseball,chart_with_downwards_trend']];
  if (g.favStatus !== 'down' && wasLive && prev.favStatus === 'down' && opts.recovery)
    return [[`🟢 ${f.ab} back`, `${f.ab}${line} ${g.diff > 0 ? 'leads' : 'ties'} ${opp.ab} ${f.runs}–${opp.runs} · ${g.detail}`, 'baseball,white_check_mark', 'default']];
  return [];
}

async function push(title, message, tags, priority = 'high') {
  const r = await fetch(`${NTFY_SERVER}/${TOPIC}`, {
    method: 'POST', body: message,
    headers: { ...HEADERS, Title: title, Priority: priority, Tags: tags }
  });
  if (!r.ok) console.error('ntfy failed', r.status);
}

async function main() {
  if (!TOPIC) { console.error('NTFY_TOPIC not set'); process.exit(1); }

  if (process.env.FAVDOWN_TEST === '1') {
    await push('🔻 FAV DOWN: TEST', 'Pipeline live. FAV (-150 · 60¢) trails OPP 2–4 · Bot 6th', 'baseball,rotating_light');
    console.log('test ping sent'); return;
  }

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}

  // Query today (ET); before 3 AM ET also pull yesterday so late West Coast games stay tracked.
  const now = etNow();
  const dates = [ymd(now)];
  if (now.getHours() < 3) { const y = new Date(now); y.setDate(y.getDate() - 1); dates.push(ymd(y)); }

  const seen = new Map();
  for (const d of dates) {
    try { for (const ev of await fetchBoard(d)) seen.set(String(ev.id), ev); }
    catch (e) { console.error('fetch fail', d, e.message); }
  }
  if (!seen.size) { console.log('no games'); return; }

  const next = {};
  const pings = [];
  for (const [id, ev] of seen) {
    const prev = state[id];
    const g = parseEvent(ev, prev?.fav ? { side: prev.fav, ml: prev.ml } : null);
    if (!g) continue;
    next[id] = { fav: g.fav, ml: g.ml, state: g.state, favStatus: g.favStatus || null, diff: g.diff ?? null };
    pings.push(...decide(prev, g));
  }

  for (const p of pings) await push(...p);
  fs.writeFileSync(STATE_FILE, JSON.stringify(next));
  console.log(`games=${seen.size} pings=${pings.length}`);
}

module.exports = { parseEvent, decide, cents, fmtMl, main };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
