import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { boot } from '../../../bots/harness.ts';

process.env.HP_PICTIONARY_ROUNDS = '1';
process.env.HP_PICTIONARY_ROUND_MS = '30000';
process.env.HP_PICTIONARY_REVEAL_MS = '3000';
const EV = 'docs/evidence/pictionary';

test('browser: TV shows turning scene, drawer phone places blocks, HTML guess stays text', async () => {
  const srv = await boot();
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const tv = await tvCtx.newPage();
    const errors: string[] = [];
    tv.on('pageerror', (e) => errors.push(String(e)));
    await tv.goto(`${srv.url}/host`);
    await tv.waitForSelector('#room-code:not(:empty)');
    const code = (await tv.textContent('#room-code'))!.trim();
    const phones: Page[] = [];
    for (const name of ['Ann', 'Ben', 'Cy']) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.goto(`${srv.url}/play`);
      await p.fill('#room-input', code);
      await p.fill('#name-input', name);
      await p.click('#join-btn');
      await p.waitForSelector('#players-list li');
      phones.push(p);
    }
    await phones[0].click('[data-game=pictionary]');
    // Ann is the first drawer
    await phones[0].waitForSelector('#pp-grid', { timeout: 4000 }).catch(async (e) => { console.log(await phones[0].locator('body').innerText(), errors); throw e; });
    const word = (await phones[0].textContent('#pp-word'))!.replace('Draw: ', '');
    assert.ok(word.length > 2);
    await tv.waitForSelector('#pic-hint:not(:empty)');
    const hint = await tv.textContent('#pic-hint');
    assert.equal(hint!.replace(/\s/g, '').length, word.replace(/ /g, '').length);
    // draw: cube, then a big blue sphere, then a cylinder
    const cell = (x: number, y: number) => phones[0].click(`#pp-grid [data-x="${x}"][data-y="${y}"]`);
    await cell(2, 0);
    await phones[0].click('[data-shape=sphere]');
    await phones[0].click('[data-size="2"]');
    await phones[0].click('[data-color="#1e88e5"]');
    await cell(3, 1);
    await phones[0].click('[data-shape=cylinder]');
    await phones[0].click('[data-size="1"]');
    await phones[0].click('[data-z="2"]');
    await cell(5, 0);
    await cell(5, 1);
    await phones[0].click('#pp-undo');
    await tv.waitForFunction(() => document.querySelector('#game canvas')?.getAttribute('data-items') === '3');
    // the TV scene turns: two screenshots differ
    await tv.screenshot({ path: `${EV}/tv-scene-a.png` });
    await tv.waitForTimeout(1500);
    await tv.screenshot({ path: `${EV}/tv-scene-b.png` });
    await phones[0].screenshot({ path: `${EV}/phone-drawer.png` });
    // guesser sends HTML
    const evil = '<img src=x onerror="window.__pwn=1">';
    await phones[1].fill('#pp-guess', evil);
    await phones[1].click('#pp-send');
    await tv.waitForSelector('#pic-feed li');
    assert.equal(await tv.textContent('#pic-feed li .text'), evil);
    assert.equal(await tv.locator('#pic-feed img').count(), 0);
    assert.equal(await tv.evaluate(() => (window as any).__pwn), undefined);
    assert.equal(await phones[2].locator('.feed img').count(), 0);
    assert.ok((await phones[2].textContent('.feed'))!.includes(evil));
    // the TV page never had the word before the reveal
    assert.ok(!(await tv.content()).toLowerCase().includes(`>${word}<`), 'word not in TV DOM');
    await phones[1].screenshot({ path: `${EV}/phone-guesser.png` });
    // correct guess ends the round, TV reveals
    await phones[2].fill('#pp-guess', word.toUpperCase());
    await phones[2].click('#pp-send');
    await tv.waitForSelector('#pic-overlay .big');
    assert.equal((await tv.textContent('#pic-overlay .big'))!.toLowerCase(), word);
    await tv.screenshot({ path: `${EV}/tv-reveal.png` });
    await tv.waitForFunction(() => document.querySelector('#pic-overlay')?.textContent?.includes('Final scores'), null, { timeout: 8000 });
    await tv.screenshot({ path: `${EV}/tv-final.png` });
    await phones[0].screenshot({ path: `${EV}/phone-final.png` });
    // leader ends the game: back to the lobby
    await phones[0].click('#end-game');
    await tv.waitForFunction(() => document.getElementById('game')?.hidden === true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await srv.close();
  }
});
