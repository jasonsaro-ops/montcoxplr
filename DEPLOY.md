# Deploying the MONTCOXPLR Cloudflare Worker

The dashboard itself (`index.html` + `app.js`) is already static and just
works on GitHub Pages. The Worker is a small optional upgrade: it replaces
the public CORS proxies with your own fast, reliable relay for the two
county pages that don't send CORS headers (the RSS feed and the OOS units
page). The dashboard still falls back to the public proxies automatically
if the Worker isn't set up yet, so nothing breaks either way.

## One-time setup (about 5 minutes)

1. **Create a free Cloudflare account** at cloudflare.com if you don't
   have one. You do not need a domain on Cloudflare — Workers get a free
   `*.workers.dev` subdomain automatically.

2. **Get an API token:**
   Cloudflare dashboard → your profile icon → *My Profile* → *API Tokens*
   → *Create Token* → use the **"Edit Cloudflare Workers"** template →
   create it → copy the token (you'll only see it once).

3. **Get your Account ID:**
   Cloudflare dashboard → *Workers & Pages* → it's listed in the right
   sidebar on that page.

4. **Add both as GitHub repo secrets:**
   In `jasonsaro-ops/montcoxplr` on GitHub → *Settings* → *Secrets and
   variables* → *Actions* → *New repository secret* → add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

5. **Push this repo to `main`.** The `.github/workflows/deploy-worker.yml`
   workflow runs automatically and deploys the Worker. Check the *Actions*
   tab for the run — when it's green, your Worker is live at:

   ```
   https://montcoxplr-proxy.<your-cloudflare-subdomain>.workers.dev
   ```

   (Cloudflare picks `<your-cloudflare-subdomain>` the first time you
   deploy anything — you'll see the exact URL in the Actions log, or in
   the Cloudflare dashboard under *Workers & Pages*.)

6. **Wire it into the dashboard:** open `app.js`, find
   `CONFIG.sources.worker.baseUrl` near the top, and set it to that URL:

   ```js
   worker: {
     baseUrl: 'https://montcoxplr-proxy.your-subdomain.workers.dev'
   },
   ```

   Commit and push. The dashboard will now try the Worker first for the
   RSS and OOS feeds, and only fall back to the public CORS proxies if
   the Worker is unreachable.

## Re-deploying after changes

Any push that touches `worker/**` or `wrangler.toml` on `main` re-runs the
workflow automatically — no manual steps needed.

## Testing the Worker directly

Once deployed, visiting these in a browser should return raw feed data:

- `https://montcoxplr-proxy.your-subdomain.workers.dev/rss`
- `https://montcoxplr-proxy.your-subdomain.workers.dev/oos`
- `https://montcoxplr-proxy.your-subdomain.workers.dev/health` → `{"ok":true,...}`

## Changing the allowed origin

`wrangler.toml` restricts the Worker's CORS header to
`https://jasonsaro-ops.github.io`. If you ever serve the dashboard from
somewhere else too (a custom domain, local dev, etc.), add it there.
