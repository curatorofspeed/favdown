// Offline tests for favdown parse + alert engine. Run: node test.js
const assert = require('assert');
const { parseEvent, decide, cents } = require('./favdown');

let n = 0;
const t = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };

// --- fixtures ---------------------------------------------------------------
const mkEvent = (o = {}) => ({
  id: o.id || '401001',
  status: { type: { state: o.state || 'in', shortDetail: o.detail || 'Bot 6th' } },
  competitions: [{
    competitors: [
      { homeAway: 'home', score: String(o.homeRuns ?? 0), team: { abbreviation: o.homeAb || 'SEA' } },
      { homeAway: 'away', score: String(o.awayRuns ?? 0), team: { abbreviation: o.awayAb || 'NYY' } }
    ],
    odds: o.odds
  }]
});

// --- odds parsing -----------------------------------------------------------
t('cents conversion', () => {
  assert.strictEqual(cents(-150), 60);
  assert.strictEqual(cents(+130), 43);
  assert.strictEqual(cents(null), null);
});

t('favorite via favorite flag', () => {
  const g = parseEvent(mkEvent({ odds: [{ homeTeamOdds: { favorite: true, moneyLine: -145 }, awayTeamOdds: {} }] }), null);
  assert.strictEqual(g.fav, 'home');
  assert.strictEqual(g.ml, -145);
});

t('favorite via moneyline comparison', () => {
  const g = parseEvent(mkEvent({ odds: [{ homeTeamOdds: { moneyLine: 120 }, awayTeamOdds: { moneyLine: -140 } }] }), null);
  assert.strictEqual(g.fav, 'away');
  assert.strictEqual(g.ml, -140);
});

t('favorite via details string', () => {
  const g = parseEvent(mkEvent({ odds: [{ details: 'NYY -180' }] }), null);
  assert.strictEqual(g.fav, 'away');
  assert.strictEqual(g.ml, -180);
});

t('cached fav wins when live odds absent', () => {
  const g = parseEvent(mkEvent({ odds: undefined }), { side: 'home', ml: -160 });
  assert.strictEqual(g.fav, 'home');
  assert.strictEqual(g.ml, -160);
});

t('no odds, no cache -> no fav, no status', () => {
  const g = parseEvent(mkEvent({}), null);
  assert.strictEqual(g.fav, null);
  assert.strictEqual(g.favStatus, undefined);
});

t('favStatus math', () => {
  const g = parseEvent(mkEvent({ homeRuns: 2, awayRuns: 5 }), { side: 'home', ml: -150 });
  assert.strictEqual(g.favStatus, 'down');
  assert.strictEqual(g.diff, -3);
});

// --- alert engine -----------------------------------------------------------
const live = (favStatus, diff) => ({ state: 'in', favStatus, diff, fav: 'home', ml: -150 });
const game = (homeRuns, awayRuns) =>
  parseEvent(mkEvent({ homeRuns, awayRuns }), { side: 'home', ml: -150 });
const O = { reping: true, recovery: true };

t('up -> down fires FAV DOWN', () => {
  const p = decide(live('up', 1), game(2, 4), O);
  assert.strictEqual(p.length, 1);
  assert.ok(p[0][0].includes('FAV DOWN: SEA'));
  assert.ok(p[0][1].includes('-150') && p[0][1].includes('60¢'));
});

t('first live sighting already down fires', () => {
  const p = decide({ state: 'pre', favStatus: null }, game(1, 3), O);
  assert.strictEqual(p.length, 1);
});

t('down unchanged -> silent (dedupe)', () => {
  assert.strictEqual(decide(live('down', -2), game(2, 4), O).length, 0);
});

t('deficit grows -> re-ping', () => {
  const p = decide(live('down', -1), game(2, 4), O);
  assert.strictEqual(p.length, 1);
  assert.ok(p[0][0].includes('down 2'));
});

t('deficit grows with reping off -> silent', () => {
  assert.strictEqual(decide(live('down', -1), game(2, 4), { reping: false, recovery: true }).length, 0);
});

t('deficit shrinks but still down -> silent', () => {
  assert.strictEqual(decide(live('down', -3), game(2, 4), O).length, 0);
});

t('down -> tied fires recovery', () => {
  const p = decide(live('down', -2), game(4, 4), O);
  assert.strictEqual(p.length, 1);
  assert.ok(p[0][0].includes('back'));
});

t('down -> up with recovery off -> silent', () => {
  assert.strictEqual(decide(live('down', -2), game(5, 4), { reping: true, recovery: false }).length, 0);
});

t('no fav -> never fires', () => {
  const g = parseEvent(mkEvent({ homeRuns: 0, awayRuns: 6 }), null);
  assert.strictEqual(decide(live('up', 1), g, O).length, 0);
});

t('final game -> never fires', () => {
  const g = parseEvent(mkEvent({ state: 'post', homeRuns: 2, awayRuns: 4 }), { side: 'home', ml: -150 });
  assert.strictEqual(decide(live('down', -2), g, O).length, 0);
});

console.log(`\nall ${n} tests passed`);
