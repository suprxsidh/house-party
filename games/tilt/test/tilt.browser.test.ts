import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { boot, until, sleep } from '../../../bots/harness.ts';
import { joinBots, Bot } from '../../../bots/Bot.ts';

// Real /host page, real three.js, 10 bots. A bot steers the marble into one goal hole.
test('browser: TV draws the board, bots steer the marble, the owner scores, TV shows no owner', async () => {
  process.env.HP_TILT_COUNTDOWN_MS = '0';
  process.env.HP_TILT_ROUND_MS = '40000';
  process.env.HP_TILT_STALE_MS = '10000';
  const srv = await boot();
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 480, height: 270 } })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${srv.url}/host`);
    await page.waitForSelector('#room-code:not(:empty)');
    const code = (await page.textContent('#room-code'))!.trim();
    const bots = await joinBots(srv.url, code, 10, 'Bot');
    await page.waitForFunction(() => document.querySelectorAll('#players li').length === 10);
    await bots[0].socket.timeout(3000).emitWithAck('leader:pick', { gameId: 'tilt' });
    await page.waitForSelector('#tilt-canvas');
    await page.waitForFunction(() => (window as any).__tilt?.holes.length >= 10, null, { timeout: 5000 });
    await until(() => bots.every((b) => b.msgs.some((m) => m.type === 'goal')), 3000, 'all goals');
    // Pick bot 4 as the target and steer using the TV's own marble state.
    const goal = (bots[4].msgs.find((m) => m.type === 'goal')!.data as any).hole as number;
    await page.screenshot({ path: 'docs/evidence/tilt/tv-start.png' });
    const end = Date.now() + 30000;
    while (Date.now() < end && !bots[4].msgs.some((m) => m.type === 'score')) {
      const s = await page.evaluate(() => {
        const t = (window as any).__tilt;
        return { m: { ...t.marble }, holes: t.holes };
      });
      const h = s.holes[goal];
      const x = Math.max(-1, Math.min(1, (h.x - s.m.x) * 0.5 - s.m.vx * 0.3));
      const z = Math.max(-1, Math.min(1, (h.z - s.m.z) * 0.5 - s.m.vz * 0.3));
      // All ten bots add their share: the sum is what the board uses.
      for (const b of bots) b.socket.emit('to-server', { type: 'tilt', data: { x: x / 10, z: z / 10 } });
      await sleep(50);
      if (process.env.TILT_DEBUG) console.log(JSON.stringify([s.m.x.toFixed(2), s.m.z.toFixed(2), h.x, h.z, x.toFixed(2), z.toFixed(2)]));
    }
    const sc = bots[4].msgs.find((m) => m.type === 'score');
    assert.ok(sc, 'owner of the hole scored');
    assert.equal((sc!.data as any).points, 10);
    for (const i of [0, 1, 2, 3, 5, 6, 7, 8, 9]) assert.ok(!bots[i].msgs.some((m) => m.type === 'score'), `bot ${i} did not score`);
    await page.screenshot({ path: 'docs/evidence/tilt/tv-fell.png' });
    const html = await page.content();
    assert.ok(!/goal|owner/i.test(await page.evaluate(() => document.getElementById('game')!.textContent!)), 'no goal text on TV');
    assert.deepEqual(errors, []);
    console.log('goal hole', goal, 'bot 5 score', JSON.stringify(sc!.data));
    void html;
  } finally {
    Bot.closeAll();
    await browser.close();
    await srv.close();
  }
});
