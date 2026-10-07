// Browser proof for Task 3: pack camera, catch-up, reposition, minimap. 10 bots with a staggered field
// (one stuck at the line, one late, one slow, one steering badly). The TV page reports every kart's
// position through its real camera; the test asserts on that.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { boot, until, sleep } from '../../../tests/helpers.ts';
import { Bot, joinBots } from '../../../bots/Bot.ts';
import type { RunningServer } from '../../../server/index.ts';
import { snapshot, type Snap } from './pilot.ts';

const OUT = 'docs/evidence/task3';
const LAPS = Number(process.env.CAM_LAPS ?? 3);
const BUDGET_MS = Number(process.env.CAM_BUDGET_MS ?? 25 * 60_000);
let srv: RunningServer;
let browser: Browser;
const lines: string[] = [];
const log = (s: string) => { const l = `${new Date().toISOString().slice(11, 19)} ${s}`; lines.push(l); console.log(l); };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

const setRenderEvery = (page: Page, n: number) =>
  page.evaluate((v) => { ((document.getElementById('kart-frame') as HTMLIFrameElement).contentWindow as any).__renderEvery = v; }, n);
async function shotReal(page: Page, path: string, wait = 9000) {
  await setRenderEvery(page, 1);
  await sleep(wait);
  await page.screenshot({ path });
  await setRenderEvery(page, 100000);
}

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  srv = await boot();
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  Bot.closeAll();
  await browser.close();
  await srv.close();
  fs.writeFileSync(`${OUT}/packcam-${LAPS}laps.log`, lines.join('\n') + '\n');
});

interface Ndc { kart: number; x: number; y: number; behind: boolean; finished: boolean; leader: boolean; fromLeader: number }
const ndc = (page: Page): Promise<Ndc[]> => page.evaluate(() => (window as any).__kart.ndc());
const stats = (page: Page): Promise<any> => page.evaluate(() => (window as any).__kart.packStats());

test(`staggered 10-bot run, ${LAPS} laps: pack camera keeps the pack in frame, stragglers move, laps stay right`, { timeout: BUDGET_MS + 180_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  // count the dots the minimap draws per frame (one arc per kart marker, in the .kr-well canvas)
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__mapArcs = { cur: 0, last: 0 };
    const arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.arc = function (...a: [number, number, number, number, number]) {
      if (this.canvas.parentElement?.classList.contains('kr-well')) w.__mapArcs.cur++;
      return arc.apply(this, a);
    };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...a: [number, number, number, number]) {
      if (this.canvas.parentElement?.classList.contains('kr-well')) { w.__mapArcs.last = w.__mapArcs.cur; w.__mapArcs.cur = 0; }
      return clear.apply(this, a);
    };
  });
  const page = await ctx.newPage();
  const kartFrame = () => page.frames().find((f) => /\/kart\//.test(f.url()))!;
  page.on('pageerror', (e) => log(`PAGE ERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && log(`CONSOLE ERROR ${m.text().slice(0, 160)}`));
  await page.goto(`${srv.url}/host?quality=low&scale=0.4&laps=${LAPS}&renderevery=100000`);
  await page.waitForSelector('#room-code:not(:empty)');
  const code = (await page.textContent('#room-code'))!.trim();
  const bots = await joinBots(srv.url, code, 10, 'Bot');
  await page.waitForFunction(() => document.querySelectorAll('#players li').length === 10);
  assert.equal((await bots[0].socket.timeout(3000).emitWithAck('leader:pick', { gameId: 'kart' })).ok, true);
  await page.waitForFunction(() => (window as any).__kart?.snapshot().phase === 'racing', null, { timeout: 300_000, polling: 500 });
  await page.waitForFunction(() => (window as any).__hp.socket.connected, null, { timeout: 60_000 });
  log(`room ${code}: race running, ${LAPS} laps, iframe ${await page.getAttribute('#kart-frame', 'src')}`);

  // Driver profiles by kart index. Everyone steers along the racing line (aim); they differ in gas and start.
  const profile = (i: number, t: number, aim: number, speed: number, target: number) => {
    let s = clamp(aim * 1.8, -1, 1);
    let g = speed < target ? 1 : 0.15;
    if (i === 9 && t < 30) g = 0;            // stuck at the line for 30 s
    if (i === 7 && t < 14) g = 0;            // late start
    if (i === 6) g *= 0.5;                   // slow
    if (i === 8) s = clamp(s + 0.35, -1, 1); // pulls right all the time
    return { s: Math.round(s * 100) / 100, g };
  };

  let memberSamples = 0, memberOut = 0, maxCatch = 0, leaderCatch = 0, sampleTicks = 0, maxSpeedHelped = 0, maxSpeedPlain = 0;
  const lapsSeen: number[][] = Array.from({ length: 10 }, () => []);
  const shots = { grid: false, spread: false, moved: false };
  let snap: Snap = await snapshot(page);
  const t0 = Date.now();
  let nextLog = 0;
  while (Date.now() - t0 < BUDGET_MS) {
    snap = await snapshot(page);
    if (snap.phase === 'results') break;
    for (const r of snap.rows) {
      const bot = bots.find((b) => b.id === r.seat);
      if (!bot) continue;
      const c = profile(r.kart, snap.raceTime, r.aim, r.speed, r.targetSpeed);
      bot.sendToTv('input', { s: c.s, g: c.g, i: 0 });
      const ls = lapsSeen[r.kart];
      if (ls[ls.length - 1] !== r.lap) ls.push(r.lap);
      if (r.kart === snap.leaderKart) leaderCatch = Math.max(leaderCatch, r.catchUp);
      maxCatch = Math.max(maxCatch, r.catchUp);
      if (r.catchUp >= 0.15) maxSpeedHelped = Math.max(maxSpeedHelped, r.speed);
      else if (r.catchUp < 0.01) maxSpeedPlain = Math.max(maxSpeedPlain, r.speed);
    }
    if (snap.phase === 'racing') {
      // independent on-screen check: every kart within 40 m of the leader must be inside the real viewport
      const all = await ndc(page);
      sampleTicks++;
      for (const k of all) {
        if (k.finished || k.fromLeader > 39.9) continue;
        memberSamples++;
        if (k.behind || Math.abs(k.x) > 1 || Math.abs(k.y) > 1) {
          memberOut++;
          if (memberOut <= 5) log(`OUT OF FRAME kart ${k.kart} ndc (${k.x}, ${k.y}) behind ${k.behind} ${k.fromLeader} m from leader at t=${snap.raceTime}`);
        }
      }
    }
    if (!shots.grid && snap.phase === 'racing' && snap.raceTime > 2) {
      shots.grid = true;
      await shotReal(page, `${OUT}/pack-start.png`, 25000);
    }
    if (!shots.spread && snap.raceTime > 22) {
      shots.spread = true;
      await shotReal(page, `${OUT}/pack-spread.png`);
      await kartFrame().locator('.kr-map').screenshot({ path: `${OUT}/minimap.png` });
      log(`spread shot at t=${snap.raceTime}: gaps to leader ${(await ndc(page)).map((k) => `${k.kart}:${k.fromLeader}`).join(' ')}`);
    }
    if (!shots.moved && (await stats(page)).moved.length > 0) {
      shots.moved = true;
      await shotReal(page, `${OUT}/pack-after-reposition.png`, 3000);
    }
    if (Date.now() >= nextLog) {
      nextLog = Date.now() + 20_000;
      const st = await stats(page);
      log(`t=${snap.raceTime}s laps ${snap.rows.map((x) => x.lap).join(',')} fin ${snap.rows.filter((x) => x.finished).length}/10 catchUp ${snap.rows.map((x) => x.catchUp).join(',')} moved ${st.moved.length} zoom ${st.minDist?.toFixed(0)}-${st.maxDist.toFixed(0)}m`);
    }
    await sleep(80);
  }
  const st = await stats(page);
  log(`final phase ${snap.phase} t=${snap.raceTime}s wall ${Math.round((Date.now() - t0) / 1000)}s`);
  log(`lap counts: ${snap.rows.map((x) => `${x.name}:${x.lap}${x.finished ? 'F' : ''}`).join(' ')}`);
  log(`CAMERA (test side, ${sampleTicks} polls): ${memberSamples} kart-in-pack samples, ${memberOut} outside the viewport`);
  log(`CAMERA (page side): ${st.memberChecks} pack checks, ${st.memberOut} out, worst |NDC| ${st.worstMemberNdc}, ${st.allIn}/${st.allChecks} of all kart checks in frame (${((100 * st.allIn) / Math.max(1, st.allChecks)).toFixed(1)}%), zoom ${st.minDist.toFixed(1)}-${st.maxDist.toFixed(1)} m, longest off-screen ${st.maxOffscreenSec.toFixed(2)} s`);
  for (const m of st.moved) log(`REPOSITION t=${m.t.toFixed(1)} kart ${m.kart}: ${m.gap.toFixed(0)} m behind, off screen ${m.offSec.toFixed(1)} s, lapIndex ${m.lapBefore}->${m.lapIndex}, cp ${m.cpBefore}->${m.cp}, raceDistance expected ${m.expectDist.toFixed(1)} got ${m.afterDist?.toFixed(1)}`);
  log(`CATCH-UP: max bonus seen ${maxCatch} (cap 0.25), max bonus on the leader ${leaderCatch}; top speed with bonus >=15%: ${maxSpeedHelped} m/s, with none: ${maxSpeedPlain} m/s`);
  const mapArcs = await kartFrame().evaluate(() => (window as any).__mapArcs.last as number);
  log(`MINIMAP: ${mapArcs} markers drawn in the last frame, ${st.karts ?? 10} karts`);
  await shotReal(page, `${OUT}/pack-results.png`, 5000);

  assert.ok(mapArcs >= 10, `minimap draws every kart (${mapArcs} markers)`);
  // camera
  assert.ok(memberSamples > 100, 'enough pack samples');
  assert.equal(memberOut, 0, 'every kart within 40 m of the leader was inside the viewport (test-side projection)');
  assert.equal(st.memberOut, 0, 'same, page-side counters');
  assert.ok(st.maxOffscreenSec <= 5.5, `no kart stayed off screen past the limit (${st.maxOffscreenSec})`);
  // catch-up
  assert.ok(maxCatch > 0.1 && maxCatch <= 0.25 + 1e-9, `catch-up grew with the gap (${maxCatch})`);
  assert.equal(leaderCatch, 0, 'the leader gets no catch-up');
  // reposition
  assert.ok(st.moved.length >= 1, 'a straggler was moved');
  for (const m of st.moved) assert.ok(m.afterDist !== null && Math.abs(m.afterDist - m.expectDist) < 5, `kart ${m.kart}: cp and lapIndex consistent after the move (${m.afterDist} vs ${m.expectDist})`);
  // laps
  assert.equal(snap.phase, 'results', 'race reached results');
  for (const r of snap.rows) {
    assert.equal(r.finished, true, `${r.name} finished`);
    assert.equal(r.lap, LAPS, `${r.name} completed ${LAPS} laps`);
    const seen = lapsSeen[r.kart];
    assert.deepEqual([...seen].sort((a, b) => a - b), seen, `${r.name}: lap counter never went backwards (${seen.join('>')})`);
  }
  assert.ok(st.moved.some((m) => m.kart === 9), 'the stuck kart was moved');
  log('PASS');
  await ctx.close();
});
