// Evidence run: real /host page in Chromium, N bots join, assert the TV DOM lists them.
// Usage: npm run bots -- [N] [url]   (no url: starts a local server in HP_MODE, default prod)
import fs from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from '../server/index.ts';
import { joinBots, Bot } from './harness.ts';

const n = Number(process.argv[2]) || 10;
let url = process.argv[3];
const out = 'docs/evidence/task1';
fs.mkdirSync(out, { recursive: true });
const lines: string[] = [];
const log = (s: string) => { const l = `${new Date().toISOString()} ${s}`; lines.push(l); console.log(l); };

const srv = url ? undefined : await startServer({ port: 0, mode: process.env.HP_MODE === 'dev' ? 'dev' : 'prod', quiet: true });
url ??= srv!.url;
const browser = await chromium.launch();
let ok = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => log(`PAGE ERROR ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && log(`CONSOLE ERROR ${m.text()}`));
  await page.goto(`${url}/host`);
  await page.waitForSelector('#room-code:not(:empty)');
  const code = (await page.textContent('#room-code'))!.trim();
  log(`TV room ${code} at ${url}`);
  const bots = await joinBots(url, code, n);
  log(`${bots.length} bots joined; ids ${bots.map((b) => b.id).join(',')}`);
  await page.waitForFunction((k) => document.querySelectorAll('#players li').length === k, n, { timeout: 8000 });
  const names = await page.$$eval('#players li .name', (e) => e.map((x) => x.textContent));
  const leader = await page.$eval('#players li.leader .name', (e) => e.textContent);
  log(`TV lists ${names.length}: ${names.join(', ')}; leader marker on ${leader}`);
  if (names.length !== n || leader !== bots[0].name) throw new Error('TV list mismatch');
  await page.screenshot({ path: `${out}/tv-${n}-bots.png` });
  ok = true;
  log('PASS');
  Bot.closeAll();
} catch (e) {
  log(`FAIL ${(e as Error).message}`);
} finally {
  fs.writeFileSync(`${out}/run.log`, lines.join('\n') + '\n');
  await browser.close();
  await srv?.close();
  process.exit(ok ? 0 : 1);
}
