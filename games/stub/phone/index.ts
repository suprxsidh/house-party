import { registerPhone } from '../../../shared/registry.ts';
import type { PhoneGame } from '../../../shared/games.ts';
import { info } from '../info.ts';

registerPhone(info, (): PhoneGame => {
  let root: HTMLElement;
  return {
    mount(ctx) {
      root = ctx.root;
      root.textContent = '';
      const b = document.createElement('button');
      b.id = 'stub-ping';
      b.textContent = 'Ping';
      b.onclick = () => ctx.toTv('ping', { at: Date.now() });
      root.append(b);
    },
    onMessage(type, data) {
      const p = document.createElement('p');
      p.className = 'stub-msg';
      p.textContent = `${type} ${JSON.stringify(data)}`;
      root.append(p);
    },
    destroy() {
      root?.replaceChildren();
    },
  };
});
