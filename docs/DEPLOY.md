# Deploy to Render (free)

Suprasidh does this once.

1. Go to render.com. Sign up with GitHub. No card needed.
2. Give Render access to the repo `suprxsidh/house-party`.
3. Click New, then Blueprint. Pick the repo. Render reads `render.yaml`.
4. Confirm the plan is Free, region Singapore. Click Apply.
5. Wait for the build. Open the `.onrender.com` URL plus `/host`.
6. Check `/healthz` shows `{"ok":true}`.
7. Test it: `npm run smoke -- https://<name>.onrender.com`.

Free services sleep after 15 minutes idle. The first load takes about 50 seconds.
