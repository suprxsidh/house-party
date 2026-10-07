// Browser proof: the real /host page runs the race, 10 bots are the phones.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { boot, until, sleep } from '../../../tests/helpers.ts';
import { Bot, joinBots } from '../../../bots/Bot.ts';
import type { RunningServer } from '../../../server/index.ts';
import { Pilot, snapshot, type Snap } from './pilot.ts';

const OUT = 'docs/evidence/task2';
const LAPS = Number(process.env.KART_LAPS ?? 3);
const BUDGET_MS = Number(process.env.KART_BUDGET_MS ?? 20 * 60_000);
let srv: RunningServer;
let browser: Browser;
const lines: string[] = [];
/** Draw a few real frames, then capture. Software GL needs seconds per frame. */
const setRenderEvery = (page: Page, n: number) =>
  page.evaluate((v) => { ((document.getElementById('kart-frame') as HTMLIFrameElement).contentWindow as any).__renderEvery = v; }, n);
async function shotReal(page: Page, path: string) {
  await setRenderEvery(page, 1);
  await sleep(9000);
  await page.screenshot({ path });
  await setRenderEvery(page, 100000);
}
const log = (s: string) => { const l = `${new Date().toISOString()} ${s}`; lines.push(l); console.log(l); };

before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  srv = await boot();
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  Bot.closeAll();
  await browser.close();
  await srv.close();
  fs.writeFileSync(`${OUT}/run-${LAPS}laps.log`, lines.join('\n') + '\n');
});

test(`proof: 10 bots drive ${LAPS} laps in the TV page, race finishes, results return to lobby`, { timeout: BUDGET_MS + 120_000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`PAGE ERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && log(`CONSOLE ERROR ${m.text().slice(0, 160)}`));
  await page.goto(`${srv.url}/host?quality=low&scale=0.4&laps=${LAPS}&renderevery=${process.env.KART_RENDER_EVERY ?? 100000}`);
  await page.waitForSelector('#room-code:not(:empty)');
  const code = (await page.textContent('#room-code'))!.trim();
  const bots = await joinBots(srv.url, code, 10, 'Bot');
  await page.waitForFunction(() => document.querySelectorAll('#players li').length === 10);
  log(`room ${code}: 10 bots joined`);

  const r = await bots[0].socket.timeout(3000).emitWithAck('leader:pick', { gameId: 'kart' });
  assert.equal(r.ok, true);
  await page.waitForFunction(() => (window as any).__kart?.snapshot().phase, null, { timeout: 180_000 });
  const first = await snapshot(page);
  assert.equal(first.karts, 10);
  assert.equal(first.rows.filter((x) => x.human).length, 10);
  log(`kart page up: ${first.karts} karts, phase ${first.phase}, laps ${first.laps}`);
  await shotReal(page, `${OUT}/tv-grid-${LAPS}laps.png`);

  const pilot = new Pilot(bots);
  const t0 = Date.now();
  let snap: Snap = first;
  let shot = false;
  let nextLog = 0;
  while (Date.now() - t0 < BUDGET_MS) {
    snap = await pilot.tick(page, { tapItemEvery: 40 });
    if (snap.phase === 'results') break;
    if (!shot && snap.phase === 'racing' && snap.raceTime > 12) {
      shot = true;
      await shotReal(page, `${OUT}/tv-racing-${LAPS}laps.png`);
    }
    if (Date.now() >= nextLog) {
      nextLog = Date.now() + 15_000;
      log(`phase ${snap.phase} t=${snap.raceTime}s laps(done) ${snap.rows.map((x) => x.lap).join(',')} finished ${snap.rows.filter((x) => x.finished).length}/10 remote ${snap.rows.filter((x) => x.remote).length}`);
    }
    await sleep(80);
  }
  log(`final phase ${snap.phase} t=${snap.raceTime}s after ${Math.round((Date.now() - t0) / 1000)}s wall, ${pilot.sent} inputs sent`);
  log(`lap counts per kart: ${snap.rows.map((x) => `${x.name}:${x.lap}${x.finished ? 'F' : ''}`).join(' ')}`);
  await shotReal(page, `${OUT}/tv-results-${LAPS}laps.png`);

  assert.equal(snap.phase, 'results', 'race reached results');
  for (const row of snap.rows) {
    assert.equal(row.finished, true, `${row.name} finished`);
    assert.equal(row.lap, LAPS, `${row.name} completed ${LAPS} laps`);
  }
  assert.equal(new Set(snap.order).size, 10);

  // results reach every phone and the room returns to the lobby
  await until(() => bots.every((b) => b.msgs.some((m) => m.type === 'results')), 5000, 'results on every phone');
  const res = bots[3].msgs.find((m) => m.type === 'results')!.data as { order: { place: number; name: string }[] };
  assert.equal(res.order.length, 10);
  log(`results on all 10 phones: ${res.order.map((o) => `${o.place}.${o.name}`).join(' ')}`);
  assert.equal((await bots[0].socket.emitWithAck('leader:end', {})).ok, true);
  await page.waitForFunction(() => !document.querySelector('#kart-frame'), null, { timeout: 5000 });
  assert.equal(await page.locator('#lobby').isVisible(), true);
  await page.screenshot({ path: `${OUT}/tv-lobby-after-${LAPS}laps.png` });
  log('PASS');
  await ctx.close();
});
