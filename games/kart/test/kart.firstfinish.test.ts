// Task 3 review fixes: the TV's ?laps/?quality/?scale reach the kart iframe, and the race keeps running
// (camera, catch-up, phone control) after kart 0 finishes first.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { boot, until, sleep } from '../../../tests/helpers.ts';
import { Bot, joinBots } from '../../../bots/Bot.ts';
import type { RunningServer } from '../../../server/index.ts';
import { snapshot } from './pilot.ts';

const OUT = 'docs/evidence/task3';
let srv: RunningServer;
let browser: Browser;
const lines: string[] = [];
const log = (s: string) => { lines.push(s); console.log(s); };
before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  srv = await boot();
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  Bot.closeAll();
  await browser.close();
  await srv.close();
  fs.writeFileSync(`${OUT}/firstfinish.log`, lines.join('\n') + '\n');
});

test('kart 0 finishes first: race keeps running for the others; URL flags reach the iframe', { timeout: 900_000 }, async () => {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  await page.goto(`${srv.url}/host?quality=low&scale=0.3&laps=1&renderevery=100000`);
  await page.waitForSelector('#room-code:not(:empty)');
  const code = (await page.textContent('#room-code'))!.trim();
  const bots = await joinBots(srv.url, code, 4, 'Bot');
  await bots[0].socket.timeout(3000).emitWithAck('leader:pick', { gameId: 'kart' });
  await page.waitForSelector('#kart-frame');
  const src = (await page.getAttribute('#kart-frame', 'src'))!;
  log(`iframe src: ${src}`);
  const q = new URL(src, 'http://x').searchParams;
  assert.equal(q.get('laps'), '1');
  assert.equal(q.get('quality'), 'low');
  assert.equal(q.get('scale'), '0.3');
  assert.equal(q.get('renderevery'), '100000');
  await page.waitForFunction(() => (window as any).__kart?.snapshot().phase === 'racing', null, { timeout: 300_000, polling: 500 });

  log('racing');
  let finishedAt = -1, framesAtFinish = 0, checksAtFinish = 0, snap = await snapshot(page);
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    snap = await snapshot(page);
    for (const r of snap.rows) {
      const bot = bots.find((b) => b.id === r.seat);
      if (!bot) continue;
      const g = (r.speed < r.targetSpeed ? 1 : 0.15) * (r.kart === 0 ? 1 : 0.3); // kart 0 is the fast one
      bot.sendToTv('input', { s: Math.max(-1, Math.min(1, r.aim * 1.8)), g, i: 0 });
    }
    if (snap.rows[0].finished && finishedAt < 0) {
      finishedAt = snap.raceTime;
      const st = await page.evaluate(() => (window as any).__kart.packStats());
      framesAtFinish = st.frames; checksAtFinish = st.checks;
      log(`kart 0 finished at t=${finishedAt}, phase ${snap.phase}, others finished: ${snap.rows.filter((r) => r.finished).length - 1}`);
    }
    if (finishedAt >= 0 && snap.raceTime > finishedAt + 0.5) {
      // just after kart 0 finished (longer than RESULTS_DELAY): still racing, phones still drive
      const others = snap.rows.slice(1).filter((r) => !r.finished);
      if (others.length) {
        assert.equal(snap.phase, 'racing', 'race still running after kart 0 finished');
        assert.ok(others.every((r) => r.remote), 'phones of unfinished karts still drive');
        const st = await page.evaluate(() => (window as any).__kart.packStats());
        assert.ok(st.frames > framesAtFinish + 100 && st.checks > checksAtFinish, 'camera still running');
        log(`t=${snap.raceTime}: phase ${snap.phase}, ${others.length} unfinished karts still remote-driven, camera frames ${st.frames - framesAtFinish} since, catchUp ${snap.rows.map((r) => r.catchUp).join(',')}`);
        finishedAt = Infinity;
        break;
      }
    }
    if (finishedAt < 0 && Math.floor(snap.raceTime / 10) !== (globalThis as any).__pt) { (globalThis as any).__pt = Math.floor(snap.raceTime / 10); log(`  pre t=${snap.raceTime} ${snap.phase} ` + snap.rows.map((r) => `${r.lap}:${r.speed}:${r.place}`).join(' ')); }
    if (finishedAt >= 0 && Math.floor(snap.raceTime) !== (globalThis as any).__lt) { (globalThis as any).__lt = Math.floor(snap.raceTime); log(`  t=${snap.raceTime} ${snap.phase} fin ${snap.rows.map((r) => (r.finished ? 'F' : r.lap) + (r.remote ? 'r' : '-')).join(',')}`); }
    if (snap.phase === 'results') break;
    await sleep(80);
  }
  log(`loop exit: ${snap.phase} t=${snap.raceTime} wall ${Math.round((Date.now() - t0) / 1000)}s fin ${snap.rows.map((r) => r.finished + ':' + r.lap).join(',')}`);
  assert.ok(finishedAt === Infinity, 'checked the state just after kart 0 finished while others still raced');
  await until(async () => (await snapshot(page)).phase === 'results', 300_000, 'results');
  snap = await snapshot(page);
  log(`results: ${snap.rows.map((r) => `${r.name}:${r.lap}${r.finished ? 'F' : ''}`).join(' ')}`);
  for (const r of snap.rows) { assert.equal(r.finished, true); assert.equal(r.lap, 1); }
});
