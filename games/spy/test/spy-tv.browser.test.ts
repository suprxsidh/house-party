import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { boot, until, sleep } from '../../../bots/harness.ts';
import { joinBots, Bot } from '../../../bots/Bot.ts';
import { registerServer } from '../../../shared/registry.ts';
import { info } from '../info.ts';

const SHOT = '/private/tmp/claude-502/-Users-Suprasidh-opencode-projects-stuff/29fefa44-a3cd-400f-b547-c4d2021823e8/scratchpad/spy-s2-40walkers.png';

// Real /host page, real three.js, 4 bot phones. The test plays the server by injecting spy:round etc.
// with playerId 'server' (the server part is built elsewhere; here it only needs to exist so the pick works).
test('browser: TV plaza with 40 walkers, move, act, result, end, fps, no stuck bots', async () => {
  if (!process.env.HP_NO_SPY_STUB) registerServer(info); // no-op if the real server part registered already
  const srv = await boot();
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${srv.url}/host?endms=800`);
    await page.waitForSelector('#room-code:not(:empty)');
    const code = (await page.textContent('#room-code'))!.trim();
    const bots = await joinBots(srv.url, code, 5, 'Bot');
    await page.waitForFunction(() => document.querySelectorAll('#players li').length === 5);
    await bots[0].socket.timeout(3000).emitWithAck('leader:pick', { gameId: 'spy' });
    await page.waitForSelector('#spy-canvas');
    await page.waitForFunction(() => !!(window as any).__spy);

    const ids = bots.slice(0, 4).map((b) => b.id!); // bots[4] is a phone that is NOT in the round
    const spy = (fn: string, ...a: unknown[]) => page.evaluate(([f, args]) => (window as any).__spy[f as string](...(args as unknown[])), [fn, a] as const);
    const now = Date.now();
    const inject = (from: string, type: string, data: unknown) => page.evaluate(([f, t, d]) => (window as any).__spy.inject(f, t, d), [from, type, data] as const);
    const round = { round: 1, rounds: 3, startsAt: now - 1000, endsAt: now + 150_000, now, playerIds: ids, botCount: 36, drinks: false, over: false };

    // A phone cannot start a round.
    await inject(ids[0], 'spy:round', round);
    assert.equal((await page.evaluate(() => (window as any).__spy.walkers.length)), 0, 'spy:round from a phone ignored');
    await inject('server', 'spy:round', round);
    const walkers = await page.evaluate(() => (window as any).__spy.walkers as { id: string; human: boolean; x: number; z: number }[]);
    assert.equal(walkers.length, 40, '40 walkers');
    assert.equal(walkers.filter((w) => w.human).length, 4);
    assert.ok(walkers.some((w) => w.id === 'bot-35') && !walkers.some((w) => w.id === 'bot-36'));

    // Unknown phone: spy:move creates nothing and moves nothing.
    bots[4].sendToTv('spy:move', { x: 1, y: 0 });
    bots[0].sendToTv('spy:move', { x: 'a', y: 0 });
    // A known phone: 1 s of full stick right = about 2 m, never more.
    await spy('place', ids[0], -20, 20);
    await spy('place', ids[1], -20, 21.2);
    const before = await page.evaluate((id) => (window as any).__spy.walkers.find((w: any) => w.id === id), ids[0]);
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
      bots[0].sendToTv('spy:move', { x: 5, y: 0 }); // over-range on purpose
      await sleep(50);
    }
    const after = await page.evaluate((id) => (window as any).__spy.walkers.find((w: any) => w.id === id), ids[0]);
    const el = (Date.now() - t0) / 1000;
    const dx = after.x - before.x;
    console.log(`human moved ${dx.toFixed(2)} m in ${el.toFixed(2)} s`);
    assert.ok(dx > 0.8, 'stick moves the walker');
    assert.ok(dx <= 2.0 * (el + 0.7) + 0.05, 'speed clamp'); // 0.6 s stale window allowance
    assert.equal(await page.evaluate(() => (window as any).__spy.walkers.length), 40, 'unknown phone added nothing');

    // spy:me goes to the phone with its own walker only.
    await until(() => bots[0].layerMsgs.some((m) => m.type === 'spy:me'), 2000, 'spy:me');
    const me = bots[0].layerMsgs.filter((m) => m.type === 'spy:me').pop()!.data as { x: number; z: number };
    assert.ok(Number.isFinite(me.x) && Number.isFinite(me.z));
    assert.ok(!bots[4].layerMsgs.some((m) => m.type === 'spy:me'), 'phone outside the round gets no spy:me');

    // ACT: put p1 1.2 m away from p0 and press.
    await sleep(700); // p0 stops walking
    const p0 = await page.evaluate((id) => (window as any).__spy.walkers.find((w: any) => w.id === id), ids[0]);
    await spy('place', ids[1], p0.x + 1.2, p0.z);
    bots[0].sendToTv('spy:act', {});
    await until(async () => (await page.evaluate(() => (window as any).__spy.sent.some((m: any) => m.type === 'spy:act'))) as boolean, 2000, 'act sent');
    const act = await page.evaluate(() => (window as any).__spy.sent.find((m: any) => m.type === 'spy:act').data);
    console.log('act ->', JSON.stringify(act));
    assert.equal(act.actor, ids[0]);
    assert.ok(act.dist <= 2.0 && act.dist > 0);
    assert.notEqual(act.target, ids[0]);
    const snap = await page.evaluate(() => (window as any).__spy.walkers as any[]);
    const a = snap.find((w) => w.id === ids[0]);
    const best = snap.filter((w) => w.id !== ids[0]).map((w) => Math.hypot(w.x - a.x, w.z - a.z)).sort((x, y) => x - y)[0];
    assert.ok(Math.abs(best - act.dist) < 0.3, `target is the nearest (best ${best.toFixed(2)}, sent ${act.dist})`);

    // Results: only from the server; kill drops the victim; duplicates ignored; killer name not shown.
    const res = { kind: 'kill', actor: ids[0], target: ids[1], actorName: 'ZZKILLER', targetName: 'VictimVic', out: [ids[1]], alive: 3, seq: 1 };
    await inject(ids[2], 'spy:result', { ...res, seq: 1, out: [ids[2]] });
    assert.equal(await page.evaluate(() => (window as any).__spy.alive), 4, 'phone cannot send a result');
    await inject('server', 'spy:result', res);
    await inject('server', 'spy:result', res);
    await page.waitForFunction((id) => (window as any).__spy.walkers.find((w: any) => w.id === id).fall === 1, ids[1]);
    const feed = await page.evaluate(() => (window as any).__spy.feed as string[]);
    assert.deepEqual(feed, ['VictimVic was stabbed']);
    assert.equal(await page.evaluate(() => (window as any).__spy.alive), 3);
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('ZZKILLER'));
    // A fallen walker ignores moves and cannot act.
    await inject('server', 'spy:result', { kind: 'arrest-wrong', actor: ids[2], target: ids[3], actorName: 'ZZCY', targetName: 'Dee', out: [ids[3]], alive: 2, seq: 2 });
    assert.ok((await page.evaluate(() => (window as any).__spy.feed as string[])).includes('Wrong arrest: an innocent was held'));
    assert.equal(await page.evaluate((id) => (window as any).__spy.walkers.find((w: any) => w.id === id).fallen, ids[3]), true);
    assert.equal(await page.evaluate((id) => (window as any).__spy.walkers.find((w: any) => w.id === id).fallen, ids[2]), false, 'the arrester stays up');
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('ZZCY'));
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('Dee'), 'wrong arrest names nobody');
    await inject('server', 'spy:result', { kind: 'miss', actor: ids[0], target: 'bot-1', actorName: 'A', targetName: '', out: [], alive: 2, seq: 3 });
    assert.equal((await page.evaluate(() => (window as any).__spy.feed as string[])).length, 2, 'miss adds no feed line');

    // No role anywhere before spy:end.
    const html = await page.content();
    assert.ok(!/assassin|civilian/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no role text before spy:end');

    // Screenshot of the plaza with 40 walkers.
    mkdirSync(SHOT.replace(/\/[^/]+$/, ''), { recursive: true });
    await sleep(1200);
    await page.screenshot({ path: SHOT });

    // fps and stuck bots: 3 readings, 8 s each, median must reach 30, bots keep walking the whole time.
    const readings: number[] = [];
    let ok = false;
    for (let i = 0; i < 3; i++) {
      const f0 = await page.evaluate(() => (window as any).__spy.frames);
      const s0 = Date.now();
      await sleep(8000);
      const f1 = await page.evaluate(() => (window as any).__spy.frames);
      const fps = ((f1 - f0) * 1000) / (Date.now() - s0);
      readings.push(Math.round(fps * 10) / 10);
    }
    ok = [...readings].sort((a, b) => a - b)[1] >= 30; // median of 3
    console.log('fps readings (960x540, swiftshader):', readings.join(', '));
    assert.ok(ok, `fps readings ${readings}`);
    const stillS = await page.evaluate(() => (window as any).__spy.maxStillS as number);
    const stuck = await page.evaluate(() => (window as any).__spy.stuckBots(10) as string[]);
    console.log(`longest bot stillness ${stillS.toFixed(1)} s, stuck(>=10 s): ${stuck.length}`);
    assert.ok(stillS < 10 && stuck.length === 0, 'no bot stuck for 10 s');

    // End screen shows roles, then the TV sends spy:next.
    const end = { round: 1, rounds: 3, reason: 'timer', final: false, drinkers: [], scores: [{ id: ids[0], name: 'Ann', role: 'assassin', points: 300, total: 300, out: false }, { id: ids[1], name: 'Ben', role: 'civilian', points: 0, total: 0, out: true }] };
    await inject(ids[0], 'spy:end', end);
    assert.ok(!(await page.evaluate(() => document.getElementById('spy-end-table'))), 'phone cannot end the round');
    await inject('server', 'spy:end', end);
    await page.waitForSelector('#spy-end-table');
    const txt = await page.evaluate(() => document.getElementById('spy-end')!.innerText);
    assert.ok(/Assassin/.test(txt) && /Ann/.test(txt) && /300/.test(txt));
    await page.screenshot({ path: SHOT.replace('40walkers', 'endscreen') });
    await until(async () => (await page.evaluate(() => (window as any).__spy.sent.some((m: any) => m.type === 'spy:next'))) as boolean, 3000, 'spy:next');
    assert.deepEqual(errors, []);
  } finally {
    Bot.closeAll();
    await browser.close();
    await srv.close();
  }
});
