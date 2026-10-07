// Soak test. Socket-level only (no browser).
// Usage: npm run soak -- [url] [--games tenyen,tilt,pictionary,market,kart]
// No url: starts a local prod-like server on a random port. With a url: targets that server.
// One room, one FakeTv, 10 Bots. The leader (bot 0) picks each game, a scripted run asserts, then the game ends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot, joinBots } from './Bot.ts';
import { FakeTv, sleep, until } from './harness.ts';
import type { RunningServer } from '../server/index.ts';

const argv = process.argv.slice(2);
let url = '';
let gamesArg = 'tenyen,tilt,pictionary,market,kart';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--games') gamesArg = argv[++i] ?? gamesArg;
  else if (argv[i].startsWith('--games=')) gamesArg = argv[i].slice(8);
  else if (!argv[i].startsWith('-')) url = argv[i].replace(/\/+$/, '');
}
const games = gamesArg.split(',').map((s) => s.trim()).filter(Boolean);
const remote = !!url;
const N = 10;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const logLines: string[] = [];
const log = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  logLines.push(line);
  console.log(line);
};

type Msg = { from?: string; type: string; data: unknown };
interface Ctx {
  tv: FakeTv;
  bots: Bot[];
  code: string;
  srv?: RunningServer;
  pick(gameId: string): Promise<{ ok: boolean; message?: string }>;
  end(): Promise<void>;
  sendServer(i: number, type: string, data?: unknown): void;
  clear(): void;
}

const lastOf = (msgs: { type: string; data: unknown }[], type: string) =>
  [...msgs].reverse().find((m) => m.type === type)?.data as any;
const count = (msgs: { type: string }[], type: string) => msgs.filter((m) => m.type === type).length;

// ---------- Ten-Yen ----------
async function tenyen(c: Ctx) {
  const { tv, bots } = c;
  const tvState = () => lastOf(tv.msgs, 'state');
  const ph = (i: number) => lastOf(bots[i].msgs, 'state');
  const vote = (i: number, choice: string) => c.sendServer(i, 'vote', { choice });
  const ids = bots.map((b) => b.id!);
  tv.socket.emit('to-server', { type: 'tv-ready' });
  await until(() => !!ph(N - 1), 15000, 'phone states');
  c.sendServer(0, 'start');
  await until(() => ph(0)?.phase === 'voting' && tvState()?.phase === 'voting', 15000, 'voting');
  assert.equal(tvState().voted, 0);
  assert.equal(tvState().result, null, 'totals before reveal');
  // Round 1: 6 yes, 4 no. Minority = no, 4 drinkers.
  bots.forEach((_, i) => vote(i, i < 6 ? 'yes' : 'no'));
  await until(() => tvState()?.phase === 'reveal', 15000, 'reveal 1');
  let t = tvState();
  assert.deepEqual([t.result.yes, t.result.no, t.result.minority, t.result.drinkers], [6, 4, 'no', 4]);
  for (let i = 0; i < N; i++) await until(() => ph(i)?.result, 15000, `bot ${i} result`);
  for (let i = 0; i < N; i++) assert.equal(ph(i).result.sips, i >= 6 ? 1 : 0, `bot ${i} sips`);
  // Round 2: 5-5 tie, nobody drinks.
  c.sendServer(0, 'next');
  await until(() => tvState()?.round === 2 && tvState()?.phase === 'voting', 15000, 'round 2');
  bots.forEach((_, i) => vote(i, i < 5 ? 'yes' : 'no'));
  await until(() => tvState()?.round === 2 && tvState()?.phase === 'reveal', 15000, 'reveal 2');
  t = tvState();
  assert.deepEqual([t.result.yes, t.result.no, t.result.minority, t.result.drinkers], [5, 5, null, 0]);
  // Round 3: 9-1 lone dissenter (no double mode on): 1 drinker.
  c.sendServer(0, 'next');
  await until(() => tvState()?.round === 3 && tvState()?.phase === 'voting', 15000, 'round 3');
  bots.forEach((_, i) => vote(i, i === 9 ? 'no' : 'yes'));
  await until(() => tvState()?.round === 3 && tvState()?.phase === 'reveal', 15000, 'reveal 3');
  t = tvState();
  assert.deepEqual([t.result.yes, t.result.no, t.result.minority, t.result.drinkers], [9, 1, 'no', 1]);
  // Privacy: TV gets only whitelisted keys, never a phone message, never a player id or vote.
  const TV_KEYS = new Set(['phase', 'round', 'question', 'config', 'voted', 'total', 'result']);
  const RES_KEYS = new Set(['yes', 'no', 'minority', 'lone', 'drinkers']);
  for (const m of tv.msgs) {
    assert.equal(m.from, undefined, 'TV got a phone message');
    if (m.type !== 'state') continue;
    const d = m.data as any;
    for (const k of Object.keys(d)) assert.ok(TV_KEYS.has(k), `unexpected TV key ${k}`);
    if (d.phase !== 'reveal') assert.equal(d.result, null, 'totals before reveal');
    if (d.result) for (const k of Object.keys(d.result)) assert.ok(RES_KEYS.has(k), `unexpected TV result key ${k}`);
    const s = JSON.stringify(d);
    for (const id of ids) assert.ok(!s.includes(`"${id}"`), `player id ${id} on TV`);
    assert.ok(!/"choice"|"guess"|"you"/.test(s), 'per-player vote field on TV');
  }
  return `3 rounds ok (6-4, 5-5 tie, 9-1); ${count(tv.msgs, 'state')} TV state msgs clean`;
}

// ---------- Tilt ----------
async function tilt(c: Ctx) {
  const { tv, bots } = c;
  const layoutMsg = (await tv.waitFor('layout', { ms: 20000 })).data as { holes: unknown[]; startsAt: number; endsAt: number; now: number };
  const rxAt = Date.now();
  const goals: number[] = [];
  for (let i = 0; i < N; i++) {
    await until(() => !!bots[i].msgs.find((m) => m.type === 'goal'), 20000, `bot ${i} goal`);
    goals.push((bots[i].msgs.find((m) => m.type === 'goal')!.data as any).hole);
  }
  assert.ok(layoutMsg.holes.length >= N + 2 || layoutMsg.holes.length >= 8, 'holes laid out');
  // Wait for the countdown to end (server clock: startsAt - now was the remaining time at send).
  const wait = layoutMsg.startsAt - layoutMsg.now - (Date.now() - rxAt) + 400;
  if (wait > 0) await sleep(wait);
  // Ten bots tilt at once: the board gets their (clamped) sum.
  const mark = tv.msgs.length;
  for (let i = 0; i < N; i++) c.sendServer(i, 'tilt', { x: 0.04, z: -0.03 });
  await until(() => {
    const b = lastOf(tv.msgs.slice(mark), 'board');
    return b && Math.abs(b.x - 0.4) < 1e-9 && Math.abs(b.z + 0.3) < 1e-9;
  }, 10000, 'board = sum of 10 tilts');
  // TV reports falls, as the TV would. Each hit on a hole scores 10 for each owner of that hole.
  const free = layoutMsg.holes.findIndex((_, i) => !goals.includes(i));
  const falls = [goals[0], goals[1], goals[0], goals[7], free, goals[0]];
  const expected = new Array(N).fill(0);
  for (const h of falls) goals.forEach((g, i) => g === h && (expected[i] += 10));
  for (const h of falls) {
    tv.toServer('fell', { hole: h });
    await sleep(360); // server ignores falls less than 300 ms apart
  }
  // A phone cannot report a fall, and bad holes score nobody.
  c.sendServer(2, 'fell', { hole: goals[2] });
  for (const bad of [-1, 999, 1.5, '3', null]) tv.toServer('fell', { hole: bad });
  await sleep(500);
  for (let i = 0; i < N; i++) {
    const pts = lastOf(bots[i].msgs.filter((m) => m.type === 'score'), 'score')?.points ?? 0;
    assert.equal(pts, expected[i], `bot ${i} live score`);
  }
  // Round end: results go to TV and phones with the same totals.
  const left = layoutMsg.endsAt - layoutMsg.now - (Date.now() - rxAt);
  const res = (await tv.waitFor('results', { ms: Math.max(5000, left + 15000) })).data as { scores: { id: string; name: string; points: number }[] };
  assert.equal(res.scores.length, N);
  for (let i = 0; i < N; i++) assert.equal(res.scores.find((s) => s.id === bots[i].id)!.points, expected[i], `bot ${i} final points`);
  assert.equal(res.scores.reduce((a, s) => a + s.points, 0), expected.reduce((a, b) => a + b, 0));
  await until(() => bots.every((b) => b.msgs.some((m) => m.type === 'results')), 10000, 'phones got results');
  // No hole owners to the TV.
  for (const m of tv.msgs) {
    const s = JSON.stringify(m);
    assert.ok(!/goal|owner/i.test(s), `owner info on TV: ${s.slice(0, 80)}`);
    if (m.type !== 'results') for (const b of bots) assert.ok(!s.includes(`"${b.id}"`), `player id in TV ${m.type}`);
  }
  assert.deepEqual(Object.keys(lastOf(tv.msgs, 'scored')), ['hole']);
  return `falls ${falls.length}, total points ${expected.reduce((a, b) => a + b, 0)}, results on TV+phones, TV clean`;
}

// ---------- Pictionary ----------
const WORD_RE = (w: string) => new RegExp(`\\b${w.replace(/[^a-z ]/gi, '')}\\b`, 'i');
async function pictionary(c: Ctx) {
  const { tv, bots } = c;
  const states = () => tv.msgs.filter((m) => m.type === 'state').map((m) => m.data as any);
  const words: string[] = [];
  const drawers: string[] = [];
  const owed = new Map<string, number>();
  for (let round = 1; round <= 3; round++) {
    await until(() => states().some((s) => s.round === round && s.phase === 'drawing'), 30000, `round ${round} drawing`);
    const s = states().find((x) => x.round === round && x.phase === 'drawing');
    const d = bots.findIndex((b) => b.id === s.drawerId);
    assert.ok(d >= 0, 'drawer is a bot');
    drawers.push(s.drawerId);
    let word = '';
    await until(() => {
      const sec = lastOf(bots[d].msgs, 'secret');
      word = sec?.word ?? '';
      return !!word && !words.includes(word);
    }, 15000, 'drawer secret');
    words.push(word);
    for (let i = 0; i < N; i++) if (i !== d) assert.ok(!bots[i].msgs.some((m) => m.type === 'secret' && (m.data as any).word === word), `bot ${i} got the secret`);
    // Drawer places blocks.
    const item = (o = {}) => ({ shape: 'cube', color: '#e53935', x: 1, y: 0, z: 1, size: 1, ...o });
    c.sendServer(d, 'place', item());
    c.sendServer(d, 'place', item({ shape: 'sphere', x: 3, y: 1, color: '#1e88e5', size: 2 }));
    c.sendServer(d, 'place', item({ shape: 'cylinder', x: 7, y: 7, z: 2 }));
    c.sendServer(d, 'undo');
    await until(() => lastOf(tv.msgs.filter((m) => m.type === 'scene'), 'scene')?.items.length === 2, 15000, 'scene of 2');
    // Wrong guesses and the drawer's own guess do not win.
    const g = (d + 1) % N;
    c.sendServer((d + 2) % N, 'guess', { text: 'definitely wrong' });
    c.sendServer(d, 'guess', { text: word });
    await sleep(150);
    assert.equal(count(tv.msgs, 'correct'), round - 1, 'a wrong guess won');
    const before = count(tv.msgs, 'correct');
    c.sendServer(g, 'guess', { text: ` ${word.toUpperCase()} ` });
    await until(() => count(tv.msgs, 'correct') === before + 1, 15000, 'correct guess');
    const cd = lastOf(tv.msgs, 'correct') as { playerId: string; points: number; drawerId: string; drawerPoints: number };
    assert.equal(cd.playerId, bots[g].id);
    assert.equal(cd.drawerId, s.drawerId);
    assert.ok(cd.points >= 100 && cd.points <= 200, `points ${cd.points}`);
    owed.set(cd.playerId, (owed.get(cd.playerId) ?? 0) + cd.points);
    owed.set(cd.drawerId, (owed.get(cd.drawerId) ?? 0) + cd.drawerPoints);
    await until(() => states().some((x) => x.round === round && x.phase !== 'drawing'), 15000, `round ${round} reveal`);
  }
  assert.equal(new Set(drawers).size, 3, 'drawers rotate');
  assert.equal(new Set(words).size, 3, 'no repeated word');
  const rev = states().find((x) => x.round === 3 && x.phase !== 'drawing');
  for (const sc of rev.scores) assert.equal(sc.score, owed.get(sc.id) ?? 0, `score of ${sc.name}`);
  assert.equal(rev.scores.reduce((a: number, x: any) => a + x.score, 0), [...owed.values()].reduce((a, b) => a + b, 0));
  // Phones agree with the TV.
  for (let i = 0; i < N; i++) await until(() => lastOf(bots[i].msgs.filter((m) => m.type === 'state'), 'state')?.round >= 3, 15000, `bot ${i} state`);
  // The word never reaches the TV before that round's reveal.
  words.forEach((w, k) => {
    const end = tv.msgs.findIndex((m) => m.type === 'state' && (m.data as any).round === k + 1 && (m.data as any).phase !== 'drawing');
    assert.ok(end > 0, `reveal of round ${k + 1} on TV`);
    for (const m of tv.msgs.slice(0, end)) {
      const s = JSON.stringify(m);
      const hit = m.type === 'scene' ? s.toLowerCase().includes(`"${w}"`) : WORD_RE(w).test(s);
      assert.ok(!hit, `word "${w}" leaked to TV before reveal: ${s.slice(0, 100)}`);
    }
  });
  assert.ok(states().some((x) => x.phase !== 'drawing' && x.word === words[0]), 'reveal shows the word');
  return `3 rounds, drawers ${drawers.join(',')}, words ${words.join(',')}, scores ${[...owed.values()].join('+')}`;
}

// ---------- Market (always-on layer, not pickable) ----------
async function market(c: Ctx) {
  const { tv, bots } = c;
  const mine = (i: number) => lastOf(bots[i].layerMsgs.filter((m) => m.type === 'market:state'), 'market:state');
  const tvm = () => lastOf(tv.layerMsgs.filter((m) => m.type === 'market:state'), 'market:state');
  bots.forEach((_, i) => c.sendServer(i, 'market:sync'));
  for (let i = 0; i < N; i++) await until(() => !!mine(i)?.me, 15000, `bot ${i} market state`);
  const stake = mine(0).me.balance + mine(0).me.locked;
  assert.ok(stake > 0);
  for (let i = 0; i < N; i++) assert.equal(mine(i).me.balance + mine(i).me.locked, stake, `bot ${i} start stake`);
  const total = () => bots.reduce((a, _, i) => a + mine(i).me.balance + mine(i).me.locked, 0);
  assert.equal(total(), N * stake);
  c.sendServer(3, 'market:propose', { text: 'Will the soak pass?' });
  await until(() => tvm()?.bets.some((b: any) => b.text === 'Will the soak pass?' && b.open), 15000, 'bet on TV');
  const id = tvm().bets.find((b: any) => b.text === 'Will the soak pass?').id;
  const buys: [number, string, number][] = [[0, 'yes', 100], [1, 'yes', 250], [2, 'yes', 333], [3, 'no', 400], [4, 'no', 77], [5, 'no', 1], [6, 'yes', stake]];
  for (const [i, side, amount] of buys) c.sendServer(i, 'market:buy', { betId: id, side, amount });
  c.sendServer(7, 'market:buy', { betId: id, side: 'yes', amount: stake + 1 }); // over stake: refused
  const yes = 100 + 250 + 333 + stake;
  const no = 400 + 77 + 1;
  await until(() => {
    const b = tvm()?.bets.find((x: any) => x.id === id);
    return b?.yesPool === yes && b?.noPool === no;
  }, 20000, 'pools');
  await until(() => bots[7].layerMsgs.some((m) => m.type === 'market:error' && (m.data as any).code === 'NO_CHIPS'), 15000, 'overspend refused');
  await until(() => mine(6).me.locked === stake, 15000, 'bot 6 locked');
  assert.equal(total(), N * stake, 'chips before resolve');
  // A non-leader cannot resolve.
  c.sendServer(4, 'market:resolve', { betId: id, outcome: 'no' });
  await until(() => bots[4].layerMsgs.some((m) => m.type === 'market:error' && (m.data as any).code === 'NOT_LEADER'), 15000, 'non-leader refused');
  c.sendServer(0, 'market:resolve', { betId: id, outcome: 'yes' });
  await until(() => tvm()?.bets.find((x: any) => x.id === id)?.open === false, 15000, 'resolved');
  for (let i = 0; i < N; i++) await until(() => mine(i).bets.find((x: any) => x.id === id)?.open === false, 15000, `bot ${i} sees resolve`);
  const bal = bots.map((_, i) => mine(i).me.balance);
  assert.equal(bal.reduce((a, b) => a + b, 0), N * stake, 'chips sum after resolve');
  assert.equal(bots.reduce((a, _, i) => a + mine(i).me.locked, 0), 0, 'nothing locked after resolve');
  assert.equal(bal[3], stake - 400);
  assert.equal(bal[4], stake - 77);
  assert.equal(bal[5], stake - 1);
  for (const m of tv.layerMsgs) assert.ok(!JSON.stringify(m).includes('positions'), 'private positions on TV');
  return `stake ${stake}, pools yes ${yes} / no ${no}, chips after resolve ${bal.reduce((a, b) => a + b, 0)} = ${N} x ${stake}`;
}

// ---------- Kart (stub: the orchestrator fills this in after the kart merge) ----------
async function kart(c: Ctx) {
  await until(() => (c.tv.state?.game as { id: string } | null)?.id === 'kart', 15000, 'room game = kart');
  return 'STUB: picked, room game = kart (no gameplay asserts yet)';
}

const SCENARIOS: Record<string, { run: (c: Ctx) => Promise<string>; pick: boolean; env?: Record<string, string> }> = {
  tenyen: { run: tenyen, pick: true },
  tilt: { run: tilt, pick: true },
  pictionary: { run: pictionary, pick: true },
  market: { run: market, pick: false },
  kart: { run: kart, pick: true },
};

interface Row { game: string; status: 'PASS' | 'FAIL' | 'SKIP'; ms: number; note: string }

async function warm(base: string) {
  // Free Render servers sleep. The first request can take about 50 s. Allow 90 s.
  const t0 = Date.now();
  log(`warming ${base} (up to 90 s)`);
  let lastErr = '';
  while (Date.now() - t0 < 90_000) {
    try {
      const r = await fetch(base + '/healthz', { signal: AbortSignal.timeout(Math.max(1000, 90_000 - (Date.now() - t0))) });
      if (r.ok) {
        log(`healthz ${r.status} after ${Date.now() - t0} ms: ${(await r.text()).trim()}`);
        return;
      }
      lastErr = `status ${r.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await sleep(2000);
  }
  throw new Error(`server did not wake in 90 s: ${lastErr}`);
}

async function main(): Promise<number> {
  let srv: RunningServer | undefined;
  const rows: Row[] = [];
  let base = url;
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let localKartRegistered = false;
  try {
    if (!remote) {
      // Short timers keep the local run fast; remote keeps the real defaults.
      process.env.HP_TILT_ROUND_MS ??= '9000';
      process.env.HP_PICTIONARY_REVEAL_MS ??= '400';
      process.env.HP_PICTIONARY_ROUNDS ??= '3';
      process.env.HP_PICTIONARY_ROUND_MS ??= '30000';
      const { startServer } = await import('../server/index.ts');
      const { serverGames } = await import('../shared/registry.ts');
      srv = await startServer({ port: 0, mode: 'prod', quiet: true });
      localKartRegistered = serverGames.has('kart');
      base = srv.url;
      log(`local prod-like server on ${base}`);
    } else await warm(base);

    const tv = new FakeTv(base);
    const made = await tv.create();
    if (!made.ok) throw new Error(`tv:create failed: ${made.message}`);
    log(`room ${made.code} created`);
    const bots = await joinBots(base, made.code, N);
    assert.ok(bots.every((b) => b.lastReply?.ok), 'all bots joined');
    await until(() => bots.every((b) => b.state?.players.length === N), 15000, 'all bots see 10 players');
    assert.equal(bots[0].state?.leaderId, bots[0].id, 'bot 0 leads');
    log(`${N} bots joined, leader ${bots[0].id}`);

    const ctx: Ctx = {
      tv, bots, code: made.code, srv,
      async pick(gameId) {
        const r = await bots[0].socket.timeout(15000).emitWithAck('leader:pick', { gameId });
        return r;
      },
      async end() {
        const r = await bots[0].socket.timeout(15000).emitWithAck('leader:end', {});
        if (r.ok) await until(() => tv.state?.game === null, 15000, 'back to lobby');
      },
      sendServer: (i, type, data) => bots[i].socket.emit('to-server', { type, data }),
      clear() {
        tv.msgs.length = 0;
        tv.layerMsgs.length = 0;
        for (const b of bots) { b.msgs.length = 0; b.layerMsgs.length = 0; }
      },
    };

    for (const g of games) {
      const sc = SCENARIOS[g];
      const t0 = Date.now();
      if (!sc) { rows.push({ game: g, status: 'FAIL', ms: 0, note: 'unknown game name' }); continue; }
      log(`--- ${g} ---`);
      try {
        if (g === 'kart' && !remote && !localKartRegistered) {
          rows.push({ game: g, status: 'SKIP', ms: 0, note: 'games/kart not registered in games/server.registry.ts' });
          log('kart skipped: games/kart not registered');
          continue;
        }
        ctx.clear();
        if (sc.pick) {
          const r = await ctx.pick(g);
          if (!r.ok) {
            const msg = r.message ?? 'pick refused';
            if (g === 'kart' && remote) {
              rows.push({ game: g, status: 'SKIP', ms: Date.now() - t0, note: `kart not registered on the server (${msg})` });
              log(`kart skipped: ${msg}`);
              continue;
            }
            throw new Error(`leader:pick ${g} refused: ${msg}${remote ? ' (game not deployed on this server?)' : ''}`);
          }
          await until(() => (tv.state?.game as { id: string } | null)?.id === g, 15000, `room.game = ${g}`);
        }
        const note = await sc.run(ctx);
        rows.push({ game: g, status: 'PASS', ms: Date.now() - t0, note });
        log(`PASS ${g}: ${note}`);
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0];
        rows.push({ game: g, status: 'FAIL', ms: Date.now() - t0, note: msg });
        log(`FAIL ${g}: ${(e as Error).stack?.split('\n').slice(0, 4).join(' | ')}`);
      } finally {
        if (sc.pick) await ctx.end().catch((e) => log(`end after ${g} failed: ${(e as Error).message}`));
      }
    }
  } catch (e) {
    rows.push({ game: '(setup)', status: 'FAIL', ms: Date.now() - started, note: (e as Error).message.split('\n')[0] });
    log(`SETUP FAIL: ${(e as Error).stack}`);
  } finally {
    Bot.closeAll();
    FakeTv.closeAll();
    await srv?.close().catch(() => {});
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  const lines = [
    `soak ${remote ? 'remote ' + url : 'local'}  ${new Date().toISOString()}  total ${((Date.now() - started) / 1000).toFixed(1)} s`,
    `${pad('game', 12)}${pad('result', 8)}${pad('time', 10)}note`,
    ...rows.map((r) => `${pad(r.game, 12)}${pad(r.status, 8)}${pad((r.ms / 1000).toFixed(1) + ' s', 10)}${r.note}`),
  ];
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  lines.push(failed ? `SOAK FAILED (${failed})` : 'SOAK OK');
  console.log('\n' + lines.join('\n'));
  const dir = path.join(ROOT, 'docs', 'evidence', 'soak');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${remote ? 'remote' : 'local'}-${stamp}.txt`);
  fs.writeFileSync(file, lines.join('\n') + '\n\n--- log ---\n' + logLines.join('\n') + '\n');
  console.log(`written ${path.relative(ROOT, file)}`);
  return failed ? 1 : 0;
}

const watchdog = setTimeout(() => {
  console.error('soak watchdog: 6 min cap hit');
  process.exit(3);
}, 6 * 60_000);
watchdog.unref();
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
