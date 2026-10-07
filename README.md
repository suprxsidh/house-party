# House Party

A web party platform. A TV laptop shows a QR code. Friends scan it and their phones become controllers.

- Live: https://house-party-2pdd.onrender.com (free tier sleeps after 15 min; open it 2 min early).
- `npm run dev` starts one server with Vite on http://localhost:3000. Open `/host` on the TV and `/play` on phones.
- `npm run build`, then `npm start`, serves the production build.
- `npm test` runs the bot tests. `npm test -- <game>` runs one game. `npm run bots` runs the 10-bot browser check.
- Protocol and game plug-in guide: `docs/PROTOCOL.md`. Design: `docs/specs/`.

## Credits

The kart game in `kart/` is a copy of [kart-royale](https://github.com/ryancampbell/kart-royale) by Ryan Campbell, under the MIT license (`LICENSE-kart-royale`). We changed its `index.html` (relative script path, no Vercel analytics) and keep the rest as is. Later tasks add an adapter folder for remote phone control.
