# house-party

Web party platform for the 2026-10-09 Bangalore party. TV laptop shows a QR code; phones are controllers. Spec: `docs/specs/`, plan: `docs/plans/`, protocol: `docs/PROTOCOL.md`, status: `docs/STATUS.md`.

## Constraints
- Free hosting only (Render free, Singapore). No trials, no card.
- Secrets in `.env` only (gitignored). Never print or commit them.
- Public repo `suprxsidh/house-party`. Run `gh auth switch --user suprxsidh` first. Never touch `suprxsidh/boredroom`.
- `kart/` is a copy of kart-royale (MIT, `LICENSE-kart-royale`). Do not run its `tools/`. Do not refactor it.
- Spy in the Crowd (game 6): `games/spy`. Contract in `games/spy/types.ts`; rules in `games/spy/rules.ts`. Roles stay on the server until `spy:end`. TV sends `spy:ready` on mount. Tests: `npm test -- spy`, `npm test -- spy-ten` (real TV, 10 bots, `HP_REMOTE_URL` for Render).

## Working knowledge
- One Node process: Express, Socket.IO, Vite. Pages: `/host` (TV), `/play` (phone), `/kart`.
- Each game lives in `games/<name>/{host,phone,server}`. One import line per game in `games/*.registry.ts` (union-merged by `.gitattributes`).
- Server-part messages reach the TV with `from = 'server'`. A TV game must ignore any other sender.
- Always-on layers (the stock market) mount beside any game. Message types start with `<id>:`.
- Secrets (votes, goals, words) stay in the server part. Tests assert the TV never sees them.
- Tests: `npm test`, `npm test -- <game>`. Headless Chrome uses software GL, so frame rates are not real.
- Tests use env overrides such as `HP_TILT_ROUND_MS` to run fast.
- Deploy: `docs/DEPLOY.md`. Backup: `npm run tunnel`. Remote check: `npm run smoke -- <url>`.
