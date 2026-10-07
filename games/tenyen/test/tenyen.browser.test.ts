import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { boot, until, sleep } from '../../../bots/harness.ts';
import { Bot, joinBots } from '../../../bots/Bot.ts';

test('browser: real TV + real phone, HTML question is plain text, piles show, screenshots', async () => {
  const srv = await boot();
  const browser = await chromium.launch();
  try {
    const tvCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const tv = await tvCtx.newPage();
    await tv.goto(`${srv.url}/host`);
    await tv.waitForSelector('#room-code:not(:empty)');
    const code = (await tv.textContent('#room-code'))!.trim();

    const phCtx = await browser.newContext({ viewport: { width: 390, height: 780 } });
    const ph = await phCtx.newPage();
    await ph.goto(`${srv.url}/play`);
    await ph.fill('#room-input', code);
    await ph.fill('#name-input', 'Lead');
    await ph.click('#join-btn');
    await ph.waitForSelector('#picker button[data-game="tenyen"]');
    const bots = await joinBots(srv.url, code, 5, 'Bot');
    await ph.click('#picker button[data-game="tenyen"]');
    await ph.waitForSelector('#ty-next');

    // Leader adds HTML questions through the real input.
    const html = '<img src=x onerror="window.__pwn=1"> <b>bold</b> ok?';
    for (let i = 0; i < 5; i++) {
      await ph.fill('#ty-addq-text', i === 0 ? html : `${html} ${i}`);
      await ph.click('#ty-addq');
      await ph.waitForFunction((n) => document.body.textContent!.includes(`You added ${n} of 5`), i + 1);
    }
    await ph.click('#ty-toggle-double');
    await ph.click('#ty-next');
    // Draw rounds until an HTML question shows on the phone.
    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      await ph.waitForSelector('#ty-reveal');
      const t = await ph.textContent('#ty-question');
      if (t!.includes('<img')) {
        found = true;
        assert.equal(await ph.locator('#ty-question img').count(), 0, 'no img element on phone');
        assert.equal(await ph.locator('#ty-question b').count(), 0, 'no b element on phone');
        assert.equal(await tv.locator('.ty .q img').count(), 0, 'no img element on TV');
        assert.ok((await tv.textContent('.ty .q'))!.includes('<img'), 'TV shows the tag as text');
        break;
      }
      await ph.click('#ty-reveal');
      await ph.click('#ty-next');
      await ph.waitForFunction((q) => document.querySelector('#ty-question')?.textContent !== q, t);
    }
    assert.ok(found, 'HTML question drawn');
    assert.equal(await ph.evaluate(() => (window as any).__pwn), undefined, 'no script ran on phone');
    assert.equal(await tv.evaluate(() => (window as any).__pwn), undefined, 'no script ran on TV');

    // Vote: lead + bots, 4 yes 2 no -> NO is minority
    await tv.screenshot({ path: 'docs/evidence/tenyen/tv-voting.png' });
    await ph.screenshot({ path: 'docs/evidence/tenyen/phone-voting.png' });
    await ph.click('#ty-vote-yes');
    await ph.waitForSelector('#ty-voted');
    bots.forEach((b, i) => b.socket.emit('to-server', { type: 'vote', data: { choice: i < 3 ? 'yes' : 'no' } }));
    await tv.waitForSelector('.ty .pile.minority');
    await sleep(2500);
    const yes = await tv.textContent('.ty .pile[data-side=yes] .count');
    const no = await tv.textContent('.ty .pile[data-side=no] .count');
    assert.deepEqual([yes, no], ['4', '2']);
    assert.equal(await tv.locator('.ty .pile.minority').getAttribute('data-side'), 'no');
    assert.match((await tv.textContent('.ty .verdict'))!, /NO drinks/);
    // Phone of a minority bot got "you drink" privately; the TV page text never lists bot names or votes.
    assert.ok(bots[3].msgs.some((m) => m.type === 'state' && (m.data as any).result?.drink === true));
    assert.ok(!(await tv.textContent('.ty'))!.includes('Bot'));
    await tv.screenshot({ path: 'docs/evidence/tenyen/tv-reveal.png' });
    await ph.screenshot({ path: 'docs/evidence/tenyen/phone-reveal.png' });
    console.log('TV piles', yes, no, 'verdict:', await tv.textContent('.ty .verdict'));
    // TV reload: same state comes back.
    await tv.reload();
    await tv.waitForSelector('.ty .pile.minority', { timeout: 5000 });
    bots.forEach((b) => b.close());
  } finally {
    await browser.close();
    await srv.close();
  }
});
