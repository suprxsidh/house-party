// npm test            -> every test
// npm test -- stub    -> only games/stub/test/*.test.ts
// npm test -- rooms   -> tests/rooms.test.ts
// npm test -- spy-ten -> games/spy/test/spy.ten.test.ts (game-topic: games/<game>/test/<game>.<topic>.test.ts)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const arg = process.argv[2];
let files = ['tests/*.test.ts', 'games/*/test/*.test.ts'];
if (arg) {
  if (existsSync(`games/${arg}`)) files = [`games/${arg}/test/*.test.ts`];
  else if (arg.includes('-') && existsSync(`games/${arg.split('-')[0]}/test/${arg.split('-')[0]}.${arg.split('-').slice(1).join('-')}.test.ts`))
    files = [`games/${arg.split('-')[0]}/test/${arg.split('-')[0]}.${arg.split('-').slice(1).join('-')}.test.ts`];
  else if (existsSync(`tests/${arg}.test.ts`)) files = [`tests/${arg}.test.ts`];
  else {
    console.error(`No game "games/${arg}" and no tests/${arg}.test.ts`);
    process.exit(2);
  }
}
const r = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-timeout=120000', '--test-force-exit', ...files],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
