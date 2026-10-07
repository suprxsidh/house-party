import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, until } from '../../../bots/harness.ts';

test('stub game: loads via registry, server part answers privately', async () => {
  const r = await setupRoom(3);
  try {
    await r.start('stub');
    await r.tv.waitFor('started');
    await until(() => r.tv.state?.game?.id === 'stub', 2000, 'game in state');
    r.send(1, 'hello', { x: 1 });
    assert.deepEqual((await r.tv.waitFor('hello', { from: r.bots[1].id })).data, { x: 1 });
    r.sendServer(2, 'ping');
    assert.deepEqual((await r.waitFor(2, 'pong')).data, { n: 1 });
    assert.equal(r.bots[0].msgs.length, 0, 'pong was private');
    assert.equal(r.tv.msgs.filter((m) => m.type === 'pong').length, 0, 'TV never saw pong');
    // non-leader cannot end; leader can
    assert.equal((await r.bots[1].socket.emitWithAck('leader:end', {})).ok, false);
    assert.equal((await r.bots[0].socket.emitWithAck('leader:end', {})).ok, true);
    await until(() => r.tv.state?.game === null, 2000, 'game ended');
    // unknown game refused
    assert.equal((await r.bots[0].socket.emitWithAck('leader:pick', { gameId: 'nope' })).ok, false);
  } finally {
    await r.close();
  }
});
