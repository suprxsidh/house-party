// Usage: npm run smoke -- <baseUrl> [botCount]
// Checks /healthz, /host, /play serve; creates a room as a TV; joins N bots.
import { io } from 'socket.io-client';
import type { TvCreateReply } from '../shared/protocol.ts';
import { Bot, joinBots } from './Bot.ts';

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
const n = Number(process.argv[3] ?? 4);
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: npm run smoke -- <baseUrl> [botCount]');
  process.exit(2);
}

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed++;
};

async function get(path: string) {
  // Free Render servers sleep: allow a long first response.
  const r = await fetch(base + path, { signal: AbortSignal.timeout(90_000) });
  return { status: r.status, text: await r.text() };
}

try {
  const h = await get('/healthz');
  check(h.status === 200 && h.text.includes('"ok":true'), `/healthz 200 ${h.text.trim()}`);
  for (const p of ['/host', '/play']) {
    const r = await get(p);
    check(r.status === 200 && /<html/i.test(r.text), `${p} serves HTML (${r.status})`);
  }

  const tv = io(base, { transports: ['websocket'] });
  await new Promise<void>((res, rej) => {
    tv.once('connect', () => res());
    tv.once('connect_error', rej);
  });
  const reply: TvCreateReply = await tv.timeout(5000).emitWithAck('tv:create', {});
  check(reply.ok === true, `room created${reply.ok ? ' ' + reply.code : ''}`);
  if (reply.ok) {
    const bots = await joinBots(base, reply.code, n);
    await new Promise((r) => setTimeout(r, 500));
    const seen = bots.filter((b) => b.state?.players.length === n).length;
    check(bots.every((b) => b.lastReply?.ok), `${n} bots joined`);
    console.log(`info  bots that saw all ${n} players: ${seen}`);
  }
  tv.close();
} catch (e) {
  check(false, `error: ${(e as Error).message}`);
} finally {
  Bot.closeAll();
}
console.log(failed ? `SMOKE FAILED (${failed})` : 'SMOKE OK');
process.exit(failed ? 1 : 0);
