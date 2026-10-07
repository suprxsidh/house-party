import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { boot, until, type RunningServer } from '../../../bots/harness.ts';
import { Bot } from '../../../bots/Bot.ts';

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

const shots = 'docs/evidence/task8';

async function phone(code: string, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 780 } })).newPage();
  await page.goto(`${srv.url}/play`);
  await page.fill('#room-input', code);
  await page.fill('#name-input', name);
  await page.click('#join-btn');
  await page.waitForSelector('#layer-market .mk-row');
  return page;
}

test('browser: ticker on TV, side panel on phones, HTML stays text, only leader sees resolve', async () => {
  fs.mkdirSync(shots, { recursive: true });
  const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await tv.goto(`${srv.url}/host`);
  await tv.waitForSelector('#room-code:not(:empty)');
  const code = (await tv.textContent('#room-code'))!.trim();
  const p1 = await phone(code, 'Asha');
  const p2 = await phone(code, 'Raj');

  // The picker never lists the market (it is a layer, not a game).
  assert.equal(await p1.locator('#picker-list button[data-game="market"]').count(), 0);

  const html = '<img src=x onerror="window.pwned=1"><b>bold?</b>';
  await p2.fill('#market-q', html);
  await p2.click('#layer-market button:has-text("Propose")');
  await p1.waitForSelector('#layer-market .mk-bet');
  await tv.waitForSelector('#layer-market .mk-bet');

  // buy from phone 1 (YES 200) and phone 2 (NO 100)
  await p1.locator('#layer-market .mk-bet input').fill('200');
  await p1.click('#layer-market button:has-text("Buy YES")');
  await p2.locator('#layer-market .mk-bet input').fill('100');
  await p2.click('#layer-market button:has-text("Buy NO")');
  await tv.waitForFunction(() => document.querySelector('#layer-market .mk-odds')?.textContent?.includes('YES 67%'));

  // HTML is text everywhere: no <img>/<b> inside the bet text, no pwned flag.
  for (const page of [tv, p1, p2]) {
    assert.equal(await page.locator('#layer-market .mk-q img, #layer-market .mk-q b').count(), 0);
    assert.equal(await page.locator('#layer-market .mk-q').first().textContent(), html);
    assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
  }
  // Only the leader (Asha) sees resolve buttons.
  assert.equal(await p1.locator('button:has-text("Resolve YES")').count(), 1);
  assert.equal(await p2.locator('button:has-text("Resolve YES")').count(), 0);
  await p1.waitForFunction(() => document.querySelector('#layer-market summary')?.textContent?.includes('Chips 800'));
  await p2.waitForFunction(() => document.querySelector('#layer-market summary')?.textContent?.includes('Chips 900'));
  await tv.screenshot({ path: `${shots}/tv-ticker.png` });
  await p1.screenshot({ path: `${shots}/phone-leader.png` });

  // The market runs beside a game: start the stub, ticker stays.
  await p1.click('#picker-list button[data-game="stub"]');
  await tv.waitForSelector('#game:not([hidden])');
  assert.equal(await tv.locator('#layer-market .mk-bet').count(), 1);
  await p1.click('#layer-market button:has-text("Resolve YES")');
  await tv.waitForSelector('#layer-market .mk-bet.done');
  await p2.waitForSelector('#layer-market .mk-bet .no, #layer-market .mk-bet .yes');
  await p1.waitForFunction(() => document.querySelector('#layer-market summary')?.textContent?.includes('Chips 1100'));
  await p2.waitForFunction(() => document.querySelector('#layer-market summary')?.textContent?.includes('Chips 900'));
  await tv.screenshot({ path: `${shots}/tv-resolved-beside-game.png` });

  // Phone reload: rejoins, chips come back from the server.
  await p2.reload();
  await p2.waitForFunction(() => document.querySelector('#layer-market summary')?.textContent?.includes('Chips 900'));
  // TV reload: same room, ticker back.
  await tv.reload();
  await tv.waitForSelector('#layer-market .mk-bet.done');
  assert.equal((await tv.textContent('#room-code'))!.trim(), code);
  await until(() => true);
});
