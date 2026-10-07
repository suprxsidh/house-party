// Three registries, one per side. A game file calls the matching register fn.
// The registry files in games/*.registry.ts hold one import line per game.
import type { GameInfo, PhoneGame, ServerGame, TvGame } from './games.ts';

export const hostGames = new Map<string, { info: GameInfo; create: () => TvGame }>();
export const phoneGames = new Map<string, { info: GameInfo; create: () => PhoneGame }>();
export const serverGames = new Map<string, { info: GameInfo; create?: () => ServerGame }>();

export const registerHost = (info: GameInfo, create: () => TvGame) => void hostGames.set(info.id, { info, create });
export const registerPhone = (info: GameInfo, create: () => PhoneGame) => void phoneGames.set(info.id, { info, create });
/** `create` is optional: a game with no secrets needs no server part, but must still register. */
export const registerServer = (info: GameInfo, create?: () => ServerGame) => void serverGames.set(info.id, { info, create });
