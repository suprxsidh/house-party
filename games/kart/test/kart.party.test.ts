// Browser tests for the kart game inside the party flow (real /host and /play pages).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { boot, until, sleep } from '../../../tests/helpers.ts';
import { Bot, joinBots } from '../../../bots/Bot.ts';
import type { RunningServer } from '../../../server/index.ts';
import { Pilot, snapshot } from './pilot.ts';

const OUT = 'docs/evidence/task2';
let srv: RunningServer;
let browser: Browser;
before(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  srv = await boot();
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  Bot.closeAll();
  await browser.close();
  await srv.close();
});

const FAST = 'quality=low&scale=0.3&renderevery=100000';
async function openTv(extra = ''): Promise<{ page: Page; code: string }> {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/host?${FAST}${extra}`);
  await page.waitForSelector('#room-code:not(:empty)');
  return { page, code: (await page.textContent('#room-code'))!.trim() };
}
/**
 * The race page boots inside the TV page and can starve its socket heartbeat for a while under software GL
 * (the TV socket drops and re-attaches by itself). Wait until the race is really running and the socket is back.
 */
const ready = async (page: Page) => {
  await page.waitForFunction(() => (window as any).__kart?.snapshot().phase === 'racing', null, { timeout: 300_000, polling: 500 });
  await page.waitForFunction(() => (window as any).__hp.socket.connected, null, { timeout: 60_000 });
  await sleep(1500);
};
const lead = (b: Bot) => b.socket.timeout(3000).emitWithAck('leader:pick', { gameId: 'kart' });

test('review 3: ten bots act at the same moment, no input or item tap is lost', { timeout: 400_000 }, async () => {
  const { page, code } = await openTv();
  const bots = await joinBots(srv.url, code, 10, 'Bot');
  assert.equal((await lead(bots[0])).ok, true);
  await ready(page);
  // everyone sends a different steer plus 3 item taps in the same tick
  await Promise.all(bots.map((b, i) => {
    const s = Math.round(((i - 4.5) / 5) * 100) / 100;
    for (let t = 1; t <= 3; t++) b.sendToTv('input', { s, g: 1, i: t });
    return Promise.resolve();
  }));
  await until(async () => (await snapshot(page)).rows.every((r) => r.taps === 3), 8000, 'all taps counted').catch(async (e) => {
    console.log('DEBUG', JSON.stringify((await snapshot(page)).rows.map((r) => [r.seat, r.steer, r.gas, r.taps, r.inputs])));
    throw e;
  });
  const snap = await snapshot(page);
  snap.rows.forEach((r, i) => {
    assert.equal(r.seat, bots[i].id);
    assert.equal(r.steer, Math.round(((i - 4.5) / 5) * 100) / 100, `${r.seat} steer kept`);
    assert.equal(r.gas, 1);
    assert.equal(r.taps, 3, `${r.seat} taps`);
  });
  console.log('10 simultaneous inputs: steer', snap.rows.map((r) => r.steer).join(','), 'taps', snap.rows.map((r) => r.taps).join(','));
  await page.context().close();
});

test('review 2: phone drops mid-race and rejoins: same seat, same kart, drives again', { timeout: 400_000 }, async () => {
  const { page, code } = await openTv();
  const bots = await joinBots(srv.url, code, 5, 'Bot');
  await lead(bots[0]);
  await ready(page);
  const pilot = new Pilot(bots);
  // AI fills to 4 only when fewer than 4 humans; with 5 humans there are exactly 5 karts
  let snap = await pilot.tick(page);
  assert.equal(snap.karts, 5);
  const victim = bots[2];
  const seat = victim.id!;
  const kart = snap.rows.find((r) => r.seat === seat)!.kart;
  for (let i = 0; i < 20; i++) { await pilot.tick(page); await sleep(100); }
  victim.drop();
  pilot.paused.add(seat);
  await until(async () => !(await pilot.tick(page)).rows.find((r) => r.seat === seat)!.remote, 15_000, 'dropped kart goes to AI');
  assert.equal((await snapshot(page)).rows.find((r) => r.seat === seat)!.kart, kart);
  victim.reconnect();
  await until(() => victim.state?.players.find((p) => p.id === seat)?.connected === true, 5000, 'seat reconnected');
  assert.equal(victim.id, seat, 'same seat id');
  pilot.paused.delete(seat);
  await until(async () => (await pilot.tick(page)).rows.find((r) => r.seat === seat)!.remote, 8000, 'kart driven by the phone again');
  snap = await snapshot(page);
  assert.equal(snap.rows.find((r) => r.seat === seat)!.kart, kart, 'same kart');
  console.log(`seat ${seat} kart ${kart}: dropped -> AI -> rejoined, remote again`);
  await page.context().close();
});

test('AI fills slots only when fewer than 4 humans', { timeout: 400_000 }, async () => {
  const { page, code } = await openTv();
  const bots = await joinBots(srv.url, code, 2, 'Bot');
  await lead(bots[0]);
  await ready(page);
  const snap = await snapshot(page);
  assert.equal(snap.karts, 4);
  assert.deepEqual(snap.rows.map((r) => r.human), [true, true, false, false]);
  await page.context().close();
});

test('real phone page: tilt steers, buttons fallback, item tap, HUD shows position and lap', { timeout: 400_000 }, async () => {
  const { page: tv, code } = await openTv();
  const pc = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const ph = await pc.newPage();
  // iPhones ask for motion permission from a tap. Fake that API so the tap flow is exercised.
  await ph.addInitScript(() => { (window as any).DeviceOrientationEvent.requestPermission = async () => 'granted'; });
  await ph.goto(`${srv.url}/play?room=${code}`);
  await ph.fill('#name-input', 'Phone1');
  await ph.click('#join-btn');
  await ph.waitForSelector('#status.connected');
  const bots = await joinBots(srv.url, code, 3, 'Bot');
  assert.equal(bots.length, 3);
  // the leader starts the game from the picker
  await ph.click('#picker button[data-game="kart"]');
  await ph.waitForSelector('#kart-pad');
  await ph.screenshot({ path: `${OUT}/phone-ios-tilt-prompt.png` });
  await ph.click('#kart-tilt'); // the iOS tap
  await ph.waitForFunction(() => !document.querySelector('#kart-pad .msg'));
  await ready(tv);
  const seat = (await ph.getAttribute('body', 'data-seat'))!;
  const row = async () => (await snapshot(tv)).rows.find((r) => r.seat === seat)!;
  // no tilt sensor yet: buttons mode. Hold RIGHT: steer +1; and GAS.
  const right = ph.locator('#kart-pad .zone.right');
  const box = (await right.boundingBox())!;
  await ph.touchscreen.tap(box.x + 5, box.y + 5); // a quick tap also sends
  await ph.evaluate(() => {
    const e = document.querySelector('#kart-pad .zone.right')!;
    e.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, bubbles: true }));
  });
  await until(async () => (await row()).steer === 1, 4000, 'RIGHT button steers right');
  await ph.evaluate(() => document.querySelector('#kart-pad .zone.right')!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true })));
  await ph.evaluate(() => document.querySelector('#kart-pad .zone.left')!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, bubbles: true })));
  await until(async () => (await row()).steer === -1, 4000, 'LEFT button steers left');
  await ph.evaluate(() => document.querySelector('#kart-pad .zone.left')!.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, bubbles: true })));
  // gas hold and item tap
  await ph.evaluate(() => document.querySelector('#kart-pad .gas-btn')!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, bubbles: true })));
  await until(async () => (await row()).gas === 1, 6000, 'GAS held').catch(async (e) => {
    console.log('DEBUG gas', JSON.stringify(await row()), await tv.evaluate(() => (window as any).__kartMsgs), await ph.evaluate(() => document.querySelector('#kart-pad .gas-btn')!.className));
    throw e;
  });
  await ph.evaluate(() => document.querySelector('#kart-pad .item-btn')!.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 10, bubbles: true })));
  await until(async () => (await row()).taps >= 1, 4000, 'item tap counted');
  // tilt: a device orientation event takes over from the buttons. Right side down = steer right.
  // Real sensors stream ~60 Hz, so the page streams fake events. Right-hand turn of the wheel, in either orientation.
  const tilt = (dir: 1 | -1) => ph.evaluate((d) => {
    clearInterval((window as any).__tiltIv);
    const ang = screen.orientation?.angle ?? 0;
    const [beta, gamma] = ang === 0 ? [50, 40 * d] : ang === 90 ? [30 * d, -90] : [-30 * d, 90];
    (window as any).__tiltIv = setInterval(() => window.dispatchEvent(Object.assign(new Event('deviceorientation'), { beta, gamma, alpha: 0 })), 16);
  }, dir);
  await tilt(1);
  await until(async () => (await row()).steer > 0.3, 6000, 'tilt steers right');
  assert.equal(await ph.locator('#kart-pad .tiltbox').isVisible(), true);
  await tilt(-1);
  await until(async () => (await row()).steer < -0.3, 6000, 'tilt steers left');
  // HUD: position and lap
  await until(async () => /Lap 1\/3/.test((await ph.textContent('#kart-pad .lap')) ?? ''), 5000, 'lap on phone');
  const pos = (await ph.textContent('#kart-pad .pos')) ?? '';
  assert.match(pos, /^\d+/);
  await ph.screenshot({ path: `${OUT}/phone-controller.png` });
  console.log('phone HUD:', pos, await ph.textContent('#kart-pad .lap'), await ph.textContent('#kart-pad .item'));
  await pc.close();
  await tv.context().close();
});
