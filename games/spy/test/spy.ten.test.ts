// Proof run: the real /host page (Chromium) shows the plaza, 10 bots are the phones, 3 full rounds.
// Local: npm test -- spy-ten.  Remote: HP_REMOTE_URL=https://... npm test -- spy-ten
// Spec asserts: TV gets no roles before spy:end; scores match the rules engine; a joystick moves a walker;
// a reconnecting bot gets its role back; no bot walker is stuck for 10 s.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { boot, sleep } from '../../../bots/harness.ts';
import { Bot, joinBots } from '../../../bots/Bot.ts';
import type { RunningServer } from '../../../server/index.ts';
import { ROUNDS, type EndMsg, type ResultMsg, type RoleMsg, type RoundMsg, type Role } from '../types.ts';
import { act, endReason, finishRound, newRound } from '../rules.ts';

const REMOTE = !!process.env.HP_REMOTE_URL;
const OUT = REMOTE ? 'docs/evidence/spy-remote' : 'docs/evidence/spy-local';
const BUDGET_MS = Number(process.env.SPY_BUDGET_MS ?? 8 * 60_000);
// Local server reads these when it starts the round. A remote server keeps its own values.
if (!REMOTE) {
  process.env.HP_SPY_CARD_MS ??= '1500';
  process.env.HP_SPY_ROUND_MS ??= '30000';
}
let srv: RunningServer;
let browser: Browser;
const lines: string[] = [];
const log = (s: string) => {
  const l = `${new Date().toISOString()} ${s}`;
  lines.push(l);
  console.log(l);
};
const t0 = Date.now();
const left = () => BUDGET_MS - (Date.now() - t0);
const over = () => left() <= 0;

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  srv = REMOTE ? ({ url: process.env.HP_REMOTE_URL!.replace(/\/+$/, ''), close: async () => {} } as unknown as RunningServer) : await boot();
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  Bot.closeAll();
  await browser?.close();
  await srv?.close();
  fs.writeFileSync(`${OUT}/ten-bots.log`, lines.join('\n') + '\n');
});

interface Cap { type: string; from?: string; data: any; json: string }
interface Walker { id: string; human: boolean; x: number; z: number; fallen: boolean }

async function waitUntil(fn: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  const end = Date.now() + Math.min(ms, Math.max(1, left()));
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${what} (budget left ${Math.round(left() / 1000)} s)`);
}

test('proof: 10 bots, 3 rounds on the real TV page', { timeout: BUDGET_MS + 90_000 }, async () => {
  const page: Page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  page.on('pageerror', (e) => log(`PAGE ERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && log(`CONSOLE ERROR ${m.text().slice(0, 160)}`));
  await page.goto(`${srv.url}/host?quality=low&endms=1500`);
  await page.waitForSelector('#room-code:not(:empty)');
  // Capture every socket event the TV receives, from now on (before the game is picked).
  await page.evaluate(`(() => { const s = window.__hp.socket; window.__cap = [];
    s.onAny((ev, ...args) => { const d = ev === 'msg' ? args[0] : { type: ev, data: args[0] };
      let json = ''; try { json = JSON.stringify(args); } catch (e) {}
      window.__cap.push({ type: d && d.type || ev, from: d && d.from, data: d && d.data, json }); }); })()`);
  const caps = async () => (await page.evaluate(() => (window as any).__cap)) as Cap[];
  const code = (await page.textContent('#room-code'))!.trim();
  const bots = await joinBots(srv.url, code, 10, 'Bot');
  await page.waitForFunction(() => document.querySelectorAll('#players li').length === 10);
  log(`${REMOTE ? 'remote ' + srv.url : 'local'} room ${code}: 10 bots joined, budget ${Math.round(BUDGET_MS / 1000)} s`);
  const idx = new Map(bots.map((b, i) => [b.id!, i]));
  const name = (id: string) => bots[idx.get(id)!].name;

  assert.equal((await bots[0].socket.timeout(5000).emitWithAck('leader:pick', { gameId: 'spy' })).ok, true);
  await page.waitForFunction(() => !!(window as any).__spy?.walkers.length || !!(window as any).__spy, null, { timeout: 60_000 });
  await waitUntil(async () => (await walkers()).length === 40, 'TV shows 40 walkers', 60_000);

  async function walkers() {
    return (await page.evaluate(() => (window as any).__spy.walkers)) as Walker[];
  }
  const roleMsgs = (b: Bot) => b.layerMsgs.filter((m) => m.type === 'spy:role').map((m) => m.data as RoleMsg);
  const roundMsg = (n: number) => bots[0].layerMsgs.map((m) => m).filter((m) => m.type === 'spy:round').map((m) => m.data as RoundMsg).find((d) => d.round === n);

  // Stuck-walker watch runs for the whole test.
  let maxStill = 0;
  let stuckSeen: string[] = [];
  let watching = true;
  const watch = (async () => {
    while (watching) {
      try {
        const r = (await page.evaluate(() => ({ s: (window as any).__spy.stuckBots(10), m: (window as any).__spy.maxStillS }))) as { s: string[]; m: number };
        maxStill = Math.max(maxStill, r.m);
        if (r.s.length) stuckSeen = [...new Set([...stuckSeen, ...r.s])];
      } catch { /* page closing */ }
      await sleep(1000);
    }
  })();

  const totals: Record<string, number> = {};
  let moved = false;
  let reconnected = false;
  const ends: EndMsg[] = [];

  for (let n = 1; n <= ROUNDS && !over(); n++) {
    // ---- wait for the round and every role ----
    await waitUntil(() => !!roundMsg(n) && bots.every((b) => roleMsgs(b).some((r) => r.round === n)), `round ${n} start and roles`, 60_000);
    const rm = roundMsg(n)!;
    const roles = new Map<string, Role>(bots.map((b) => [b.id!, roleMsgs(b).filter((r) => r.round === n).at(-1)!.role]));
    const assassins = bots.filter((b) => roles.get(b.id!) === 'assassin');
    const civilians = bots.filter((b) => roles.get(b.id!) === 'civilian');
    log(`round ${n}: assassins ${assassins.map((b) => b.name).join(',')}; ${civilians.length} civilians; bots ${rm.botCount}`);
    assert.equal(assassins.length, 2);
    // Wait until the card time is over (server clock). TV also needs a moment.
    await waitUntil(() => Date.now() >= rm.startsAt + 700, 'round start time', 30_000);

    const gone = new Set<string>(); // ids out this round
    const arrestUsed = new Set<string>();
    const baseCaps = (await caps()).filter((c) => c.type === 'spy:result').length; // results from earlier rounds
    const fresh = async () => ((await caps()).filter((c) => c.type === 'spy:result').slice(baseCaps).map((c) => c.data as ResultMsg));
    const gotEnd = async () => (await caps()).filter((c) => c.type === 'spy:end').length >= n;

    async function strike(actor: Bot, targetId: string): Promise<ResultMsg | null> {
      for (let a = 0; a < 14 && !over() && !(await gotEnd()); a++) {
        const before = (await fresh()).length;
        const w = (await walkers()).find((x) => x.id === targetId)!;
        await page.evaluate(([id, x, z]) => (window as any).__spy.place(id, x, z), [actor.id!, w.x + 0.05, w.z] as const);
        await sleep(80);
        actor.sendToTv('spy:act', {});
        try {
          await waitUntil(async () => (await fresh()).slice(before).some((r) => r.actor === actor.id), 'result', 2500);
        } catch {
          await sleep(900); // cooldown or before start: try again
          continue;
        }
        const r = (await fresh()).slice(before).find((x) => x.actor === actor.id)!;
        log(`  ${name(actor.id!)} -> ${r.target.startsWith('bot-') ? r.target : name(r.target)}: ${r.kind}`);
        return r;
      }
      return null;
    }
    const note = (r: ResultMsg | null) => {
      if (!r) return;
      for (const o of r.out) gone.add(o);
      if (r.kind === 'arrest-ok' || r.kind === 'arrest-wrong') arrestUsed.add(r.actor);
    };

    // ---- (c) joystick moves a walker (round 1) ----
    if (n === 1) {
      const b = civilians[0];
      await page.evaluate(([id]) => (window as any).__spy.place(id, -25, -25), [b.id!] as const);
      await sleep(300);
      const p0 = (await walkers()).find((w) => w.id === b.id)!;
      const tm = Date.now();
      while (Date.now() - tm < 2500) {
        b.sendToTv('spy:move', { x: 1, y: 0 });
        await sleep(50);
      }
      await sleep(200);
      const p1 = (await walkers()).find((w) => w.id === b.id)!;
      const d = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      log(`joystick: ${b.name} moved ${d.toFixed(2)} m in 2.5 s of stick input`);
      assert.ok(d >= 0.5 && d <= 2.0 * 3 + 0.5, `joystick moved the walker (${d} m)`);
      moved = true;
    }

    // ---- (d) reconnect mid-round (round 2) ----
    if (n === 2) {
      const b = bots[3];
      const before = roleMsgs(b).length;
      const want = roles.get(b.id!);
      const idBefore = b.id;
      b.drop();
      await sleep(700);
      b.reconnect();
      await waitUntil(() => roleMsgs(b).length > before, 'spy:role after reconnect', 15_000);
      const back = roleMsgs(b).at(-1)!;
      log(`reconnect: ${b.name} dropped and came back, role ${back.role} (was ${want}), round ${back.round}, same id ${b.id === idBefore}`);
      assert.equal(back.role, want, 'same role after reconnect');
      assert.equal(back.round, n);
      assert.equal(b.id, idBefore);
      reconnected = true;
    }

    // ---- play the round ----
    if (n === 2) {
      // Assassins stab. Remote: stab until all civilians are out. Local: 2 stabs, then the short timer ends it.
      const todo = REMOTE ? civilians.length : 2;
      let k = 0;
      while (k < todo && !over() && !(await gotEnd())) {
        for (const a of assassins) {
          if (k >= todo) break;
          const t = civilians.find((c) => !gone.has(c.id!));
          if (!t) break;
          const r = await strike(a, t.id!);
          note(r);
          if (r?.kind === 'kill') k++;
        }
      }
    } else {
      if (n === 3) {
        // One kill, and one wrong arrest of a crowd bot, before the arrests.
        note(await strike(assassins[0], civilians[0].id!));
        const crowd = (await walkers()).find((w) => !w.human && !w.fallen)!;
        note(await strike(civilians[1], crowd.id));
      }
      while (!over() && !(await gotEnd())) {
        const a = assassins.find((x) => !gone.has(x.id!));
        const c = civilians.find((x) => !gone.has(x.id!) && !arrestUsed.has(x.id!));
        if (!a || !c) break;
        note(await strike(c, a.id!));
      }
    }

    // ---- round end ----
    await waitUntil(async () => await gotEnd(), `spy:end for round ${n}`, n === 2 && !REMOTE ? 60_000 : 30_000);
    const all = await caps();
    const endIdx = all.map((c, i) => (c.type === 'spy:end' ? i : -1)).filter((i) => i >= 0);
    const end = all[endIdx[n - 1]].data as EndMsg;
    ends.push(end);
    log(`round ${n} ended: ${end.reason}, final=${end.final}`);

    // (a) no roles on the TV outside spy:end, in this round's stretch
    const from = n === 1 ? 0 : endIdx[n - 2] + 1;
    for (const c of all.slice(from, endIdx[n - 1])) {
      assert.ok(!/"role"|assassin|civilian/i.test(c.json), `TV message ${c.type} carries a role word: ${c.json.slice(0, 120)}`);
    }

    // (b) replay the observed results through the rules engine
    const results = (await fresh()).filter((r) => r.kind !== 'miss');
    const rr = newRound({
      n,
      players: bots.map((b) => ({ id: b.id!, name: b.name })),
      history: {},
      startsAt: 0,
      endsAt: 1e15,
      roles: Object.fromEntries(roles),
    });
    rr.botCount = rm.botCount;
    results.forEach((r, k) => {
      const o = act(rr, r.actor, r.target, 1e6 * (k + 1));
      assert.ok(o && o.result.kind === r.kind, `engine agrees on event ${k} (${r.kind})`);
    });
    const why = endReason(rr, 0) ?? 'timer';
    assert.equal(end.reason, why, 'end reason matches the engine');
    const exp = finishRound(rr, why, { drinks: false, totals });
    for (const s of exp.scores) totals[s.id] = s.total;
    const key = (x: { id: string; points: number; total: number; out: boolean; role: string }) => `${x.id}:${x.role}:${x.points}:${x.total}:${x.out}`;
    assert.deepEqual(end.scores.map(key).sort(), exp.scores.map(key).sort(), 'scores match the rules engine');
    log(`round ${n}: ${results.length} events, scores match the engine; points ${end.scores.map((s) => `${name(s.id)}=${s.points}`).join(' ')}`);
    assert.equal(end.final, n === ROUNDS);
  }

  assert.equal(ends.length, ROUNDS, 'all 3 rounds finished inside the budget');
  assert.ok(moved && reconnected);
  watching = false;
  await watch;
  log(`stuck check: longest a crowd bot stood still ${maxStill.toFixed(1)} s, bots stuck over 10 s: ${stuckSeen.length}`);
  assert.deepEqual(stuckSeen, [], 'no bot walker stuck for 10 s');
  assert.ok(maxStill < 10, `longest still ${maxStill}`);
  const reasons = ends.map((e) => e.reason).join(', ');
  log(`PASS: 3 rounds (${reasons}) in ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.context().close();
});
