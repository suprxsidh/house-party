import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';
import { boot } from '../../../bots/harness.ts';
import { FakeTv } from '../../../bots/harness.ts';
import { joinBots, Bot } from '../../../bots/Bot.ts';
import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';
import type { RoleMsg } from '../types.ts';

const EV = 'docs/evidence/spy-phone';
const role = (o: Partial<RoleMsg> = {}): RoleMsg => ({ role: 'assassin', round: 1, rounds: 3, cooldownMs: 0, arrestsLeft: 0, out: false, points: 0, ...o });

// S1's real server is not in this branch. This stub server records spy:drinks and resends the last role on rejoin.
const fromPhone: { id: string; type: string; data: unknown }[] = [];
let lastRole: RoleMsg = role();
registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  return {
    onStart(c) { ctx = c; },
    onPhoneMessage(id, type, data) { fromPhone.push({ id, type, data }); },
    onPlayerConnected(id) { ctx.toPhone(id, 'spy:role', lastRole); },
  };
});

const bodyText = (p: Page) => p.evaluate(() => (document.getElementById('spy-pad')?.textContent ?? '') + '|' + (document.getElementById('spy-pad')?.innerText ?? ''));
const hasRole = async (p: Page) => /ASSASSIN|CIVILIAN/i.test(await bodyText(p));
const box = async (p: Page, sel: string) => (await p.locator(sel).boundingBox())!;

test('browser: spy phone on 390x844 (card, hold-to-peek, joystick, ACT, ring, minimap, drinks, out)', async () => {
  const srv = await boot();
  const browser = await chromium.launch();
  const tv = new FakeTv(srv.url);
  try {
    const made = await tv.create();
    assert.ok(made.ok);
    const code = (made as { code: string }).code;
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${srv.url}/play`);
    await p.fill('#room-input', code);
    await p.fill('#name-input', '<b>Ann</b>');
    await p.click('#join-btn');
    await p.waitForSelector('#players-list li');
    const [other] = await joinBots(srv.url, code, 1, 'Other');
    void other;
    await p.click('[data-game=spy]');
    await p.waitForSelector('#spy-pad');
    const me = (await p.evaluate(() => document.body.dataset.seat))!;
    const moves = () => tv.layerMsgs.filter((m) => m.type === 'spy:move');
    const acts = () => tv.layerMsgs.filter((m) => m.type === 'spy:act');

    // Before any role: controls exist, nothing secret.
    assert.equal(await hasRole(p), false);
    assert.equal(await p.locator('#spy-role-btn').isDisabled(), true);

    // 1. Role card at round start (6 s), then it is gone from the DOM.
    lastRole = role({ role: 'assassin', cooldownMs: 0 });
    tv.toPhone(me, 'spy:role', lastRole);
    await p.waitForSelector('#spy-pad .card');
    assert.match(await p.textContent('#spy-pad .card') ?? '', /ASSASSIN/);
    await p.screenshot({ path: `${EV}/card.png` });
    await p.waitForSelector('#spy-pad .card', { state: 'detached', timeout: 8000 });
    assert.equal(await hasRole(p), false, 'role text absent after the card');

    // 2. Hold-to-peek.
    const rb = await box(p, '#spy-role-btn');
    await p.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await p.mouse.down();
    await p.waitForFunction(() => /ASSASSIN/.test(document.getElementById('spy-peek')!.textContent ?? ''));
    assert.equal(await hasRole(p), true, 'role text present while held');
    await p.screenshot({ path: `${EV}/peek.png` });
    await p.mouse.up();
    await p.waitForFunction(() => !/ASSASSIN|CIVILIAN/i.test(document.getElementById('spy-pad')!.textContent ?? ''));
    assert.equal(await hasRole(p), false, 'role text absent after release');

    // 3. Joystick: spy:move at about 20 Hz while touched, then a zero vector.
    const st = await box(p, '#spy-stick');
    const cx = st.x + st.width / 2, cy = st.y + st.height / 2;
    const n0 = moves().length;
    await p.mouse.move(cx, cy);
    await p.mouse.down();
    await p.mouse.move(cx + 60, cy - 60, { steps: 4 });
    const t0 = Date.now();
    await p.waitForTimeout(1000);
    await p.screenshot({ path: `${EV}/joystick.png` });
    const held = moves().slice(n0);
    const rate = held.length / ((Date.now() - t0 + 100) / 1000);
    const last = held[held.length - 1].data as { x: number; y: number };
    assert.ok(held.length >= 12 && rate < 30, `about 20 Hz, got ${held.length} in ~1 s`);
    assert.ok(last.x > 0.6 && last.y < -0.6 && Math.hypot(last.x, last.y) > 0.95, `up-right pushes x+ y- : ${JSON.stringify(last)}`);
    for (const m of held) {
      const d = m.data as { x: number; y: number };
      assert.ok(Math.abs(d.x) <= 1 && Math.abs(d.y) <= 1);
      assert.equal(m.from, me);
    }
    await p.mouse.up();
    await p.waitForTimeout(300);
    const after = moves();
    assert.deepEqual(after[after.length - 1].data, { x: 0, y: 0 }, 'final zero vector');
    const nStop = after.length;
    await p.waitForTimeout(300);
    assert.equal(moves().length, nStop, 'no moves after release');

    // 4. ACT sends spy:act {}.
    const ab = await box(p, '#spy-act');
    await p.mouse.click(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await p.waitForFunction(() => true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(acts().length, 1);
    assert.deepEqual(acts()[0].data, {});
    assert.equal(acts()[0].from, me);

    // 5. Cooldown ring from RoleMsg.cooldownMs.
    tv.toPhone(me, 'spy:role', role({ cooldownMs: 1200 }));
    await p.waitForSelector('#spy-ring.on');
    await p.screenshot({ path: `${EV}/cooldown.png` });
    await p.waitForSelector('#spy-ring.on', { state: 'detached', timeout: 3000 }).catch(async () => {
      assert.equal(await p.locator('#spy-ring.on').count(), 0);
    });

    // 6. Minimap: own dot only, from spy:me.
    tv.toPhone(me, 'spy:me', { x: 0, z: 0 });
    await p.waitForFunction(() => document.getElementById('spy-dot')!.style.left === '50%');
    tv.toPhone(me, 'spy:me', { x: -30, z: 15 });
    await p.waitForFunction(() => document.getElementById('spy-dot')!.style.left === '0%');
    assert.equal(await p.evaluate(() => document.getElementById('spy-dot')!.style.top), '75%');
    assert.equal(await p.locator('#spy-map i').count(), 1);

    // 7. Civilian: peek shows arrests left.
    lastRole = role({ role: 'civilian', round: 1, arrestsLeft: 1 });
    tv.toPhone(me, 'spy:role', lastRole);
    await p.waitForFunction(() => document.getElementById('spy-pad') !== null);
    await p.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await p.mouse.down();
    await p.waitForFunction(() => /CIVILIAN/.test(document.getElementById('spy-peek')!.textContent ?? ''));
    assert.match(await p.textContent('#spy-peek') ?? '', /1 arrest left/);
    await p.mouse.up();
    assert.equal(await hasRole(p), false);

    // 8. Leader drinks toggle goes to the server.
    await p.click('#spy-drinks');
    await p.click('#spy-drinks');
    await p.waitForFunction(() => document.getElementById('spy-drinks')!.textContent === 'Drinks: off');
    await new Promise((r) => setTimeout(r, 200));
    const dr = fromPhone.filter((m) => m.type === 'spy:drinks').map((m) => m.data);
    assert.deepEqual(dr, [{ on: true }, { on: false }]);

    // 9. Rejoin: reload, the server resends spy:role, the phone renders it.
    lastRole = role({ role: 'assassin', round: 2, points: 100 });
    await p.reload();
    await p.waitForSelector('#spy-pad');
    await p.waitForSelector('#spy-pad .card');
    assert.match(await p.textContent('#spy-pad .card') ?? '', /Round 2 of 3/);
    await p.waitForSelector('#spy-pad .card', { state: 'detached', timeout: 8000 });
    assert.equal(await hasRole(p), false);

    // 10. Out screen: watch-only, controls disabled, nothing sent.
    tv.toPhone(me, 'spy:role', role({ round: 2, out: true, points: 100 }));
    await p.waitForSelector('#spy-pad .out');
    await p.screenshot({ path: `${EV}/out.png` });
    assert.equal(await p.locator('#spy-act').isDisabled(), true);
    assert.equal(await p.locator('#spy-role-btn').isDisabled(), true);
    const m1 = moves().length, a1 = acts().length;
    const st2 = await box(p, '#spy-stick');
    await p.mouse.move(st2.x + 75, st2.y + 75);
    await p.mouse.down();
    await p.mouse.move(st2.x + 120, st2.y + 75, { steps: 3 });
    await p.waitForTimeout(300);
    await p.mouse.up();
    await p.mouse.click(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await p.waitForTimeout(300);
    assert.equal(moves().length, m1, 'out player sends no move');
    assert.equal(acts().length, a1, 'out player sends no act');
    assert.equal(await hasRole(p), false);

    // Names are text, not markup.
    assert.equal(await p.locator('#players-list b').count(), 0);
    assert.deepEqual(errors, []);
    console.log('moves', moves().length, 'acts', acts().length, 'rate/s', rate.toFixed(1));
  } finally {
    Bot.closeAll();
    tv.close();
    await browser.close();
    await srv.close();
  }
});
