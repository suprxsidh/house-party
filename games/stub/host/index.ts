import { registerHost } from '../../../shared/registry.ts';
import type { TvGame } from '../../../shared/games.ts';
import { info } from '../info.ts';

registerHost(info, (): TvGame => {
  let log: HTMLElement;
  return {
    mount(ctx) {
      ctx.root.textContent = '';
      const h = document.createElement('h2');
      h.textContent = 'Stub game (TV)';
      log = document.createElement('ul');
      log.id = 'stub-log';
      ctx.root.append(h, log);
    },
    onPhoneMessage(playerId, type, data) {
      const li = document.createElement('li');
      li.textContent = `${playerId} ${type} ${JSON.stringify(data)}`;
      log.append(li);
    },
    destroy() {
      log?.parentElement?.replaceChildren();
    },
  };
});
