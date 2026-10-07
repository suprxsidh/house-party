import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { boot, until, sleep } from './helpers.ts';
import { Bot, joinBots } from '../bots/Bot.ts';
import type { RunningServer } from '../server/index.ts';

let srv: RunningServer;
let browser: Browser;
before(async () => {
  srv = await boot();
  browser = await chromium.launch();
});
after(async () => {
  Bot.closeAll();
  await browser.close();
  await srv.close();
});

async function openTv(): Promise<{ page: Page; code: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/host`);
  await page.waitForSelector('#room-code:not(:empty)');
  const code = (await page.textContent('#room-code'))!.trim();
  return { page, code };
}

async function phoneJoin(code: string, name: string, typedCode = code): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/play`);
  await page.fill('#room-input', typedCode);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  return page;
}

const tvNames = (p: Page) => p.$$eval('#players li .name', (els) => els.map((e) => e.textContent));

test('proof: 10 bots join, TV page lists them', async () => {
  const { page, code } = await openTv();
  assert.match(code, /^[A-Z]{4}$/);
  const qrSrc = await page.getAttribute('#qr img', 'src');
  assert.match(qrSrc ?? '', /^data:image\/png/);
  assert.match((await page.textContent('#join-link'))!, new RegExp(`/play\\?room=${code}$`));
  const bots = await joinBots(srv.url, code, 10, 'Bot');
  await page.waitForFunction(() => document.querySelectorAll('#players li').length === 10);
  const names = await tvNames(page);
  assert.deepEqual(names, bots.map((b) => b.name));
  assert.equal(await page.locator('#players li.leader').count(), 1);
  assert.equal(await page.locator('#players li.leader .name').textContent(), 'Bot1');
  await page.screenshot({ path: 'docs/evidence/task1/tv-10-bots.png' });
  console.log('TV lists:', names.join(', '));
  bots.forEach((b) => b.close());
  await page.context().close();
});

test('review 1 (browser): wrong code shows error, lowercase works', async () => {
  const { page: tv, code } = await openTv();
  const wrong = code === 'QQQQ' ? 'WWWW' : 'QQQQ';
  const p = await phoneJoin(wrong, 'Ann');
  await p.waitForSelector('#error:not(:empty)');
  assert.match((await p.textContent('#error'))!, /no room/i);
  await p.screenshot({ path: 'docs/evidence/task1/phone-wrong-code.png' });
  await p.fill('#room-input', '12');
  await p.click('#join-btn');
  assert.match((await p.textContent('#error'))!, /4 letters/i);
  await p.fill('#room-input', code.toLowerCase());
  await p.click('#join-btn');
  await p.waitForSelector('#status.connected');
  await until(async () => (await tvNames(tv)).includes('Ann'), 3000, 'Ann on TV');
  await p.context().close();
  await tv.context().close();
});

test('review 2 (browser): phone drops and reloads, same seat and leader', async () => {
  const { page: tv, code } = await openTv();
  const p = await phoneJoin(code, 'Zed');
  await p.waitForSelector('#status.connected');
  const seat = await p.getAttribute('body', 'data-seat');
  assert.ok(seat);
  assert.equal(await p.locator('#role').textContent(), 'Leader');
  assert.ok(await p.locator('#picker').isVisible(), 'leader sees picker');
  // socket drop and auto reconnect
  await p.evaluate(() => (window as any).__hp.socket.disconnect());
  await tv.waitForSelector('#players li.offline');
  await p.evaluate(() => (window as any).__hp.socket.connect());
  await tv.waitForFunction(() => !document.querySelector('#players li.offline'));
  assert.equal(await p.getAttribute('body', 'data-seat'), seat);
  // full page reload: token comes from localStorage
  await p.reload();
  await p.waitForSelector('#status.connected');
  assert.equal(await p.getAttribute('body', 'data-seat'), seat);
  assert.equal(await p.locator('#role').textContent(), 'Leader');
  assert.deepEqual(await tvNames(tv), ['Zed']);
  assert.equal(await tv.locator('#players li').getAttribute('data-player-id'), seat);
  await p.screenshot({ path: 'docs/evidence/task1/phone-rejoined.png' });
  await p.context().close();
  await tv.context().close();
});

test('review 4 (browser): TV reload returns same code, phones stay', async () => {
  const { page: tv, code } = await openTv();
  const p1 = await phoneJoin(code, 'Ivy');
  const p2 = await phoneJoin(code, 'Joe');
  await p2.waitForSelector('#status.connected');
  await tv.waitForFunction(() => document.querySelectorAll('#players li').length === 2);
  await tv.reload();
  await tv.waitForFunction(() => document.querySelectorAll('#players li').length === 2);
  assert.equal((await tv.textContent('#room-code'))!.trim(), code);
  assert.deepEqual(await tvNames(tv), ['Ivy', 'Joe']);
  // server wipe + TV reload: phones come back on their own
  srv.wipe();
  await tv.reload();
  await tv.waitForFunction(() => document.querySelectorAll('#players li').length === 2, null, { timeout: 8000 });
  assert.equal((await tv.textContent('#room-code'))!.trim(), code);
  assert.deepEqual((await tvNames(tv)).sort(), ['Ivy', 'Joe']); // join order may change after a restart
  await tv.screenshot({ path: 'docs/evidence/task1/tv-after-wipe-reload.png' });
  await p1.context().close();
  await p2.context().close();
  await tv.context().close();
});

test('review 5 (browser): HTML name is plain text on TV and phone', async () => {
  const { page: tv, code } = await openTv();
  const evil = '<img src=x onerror=alert(1)>';
  const dialogs: string[] = [];
  tv.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  const p = await phoneJoin(code, evil);
  p.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await p.waitForSelector('#status.connected');
  await tv.waitForFunction(() => document.querySelectorAll('#players li').length === 1);
  assert.deepEqual(await tvNames(tv), [evil]);
  assert.equal(await tv.locator('#players img').count(), 0);
  assert.equal(await p.locator('img').count(), 0);
  assert.equal(await p.locator('#you-name').textContent(), evil);
  assert.equal(await p.locator('#players-list img').count(), 0);
  await sleep(300);
  assert.deepEqual(dialogs, [], 'no alert fired');
  await tv.screenshot({ path: 'docs/evidence/task1/tv-html-name.png' });
  await p.screenshot({ path: 'docs/evidence/task1/phone-html-name.png' });
  await p.context().close();
  await tv.context().close();
});
