# Deploy to Vercel — Mrs Reem Shata Portal

Re-hosts the exact same app on Vercel (static `index.html` + 2 functions). Playback is unchanged
(streams direct from Google Drive). Supabase is untouched.

## What changed for Vercel
- `api/ai.js` + `api/admin-ops.js` — Vercel Functions. They are **thin adapters** that call the
  existing `netlify/functions/*.js` logic, so there's ONE source of truth and both platforms behave
  identically.
- `vercel.json` — carries all the security headers + CSP + asset caching (ported from `netlify.toml`).
- `index.html` — now calls `/api/ai` and `/api/admin-ops` (was `/.netlify/functions/*`).
- `netlify.toml` — added `/api/* → /.netlify/functions/*` rewrites so the **Netlify site keeps
  working** with the new paths during the transition. Nothing on Netlify breaks.

## One-time setup
1. Install the CLI: `npm i -g vercel` (or use `npx vercel`).
2. From this folder: `vercel link` (create/link a project). Framework preset: **Other** (no build step).
3. Add environment variables (Project → Settings → Environment Variables, or CLI). Set for
   **Production** and **Preview**:

   | Var | Value | Secret? |
   |-----|-------|---------|
   | `SUPABASE_URL` | `https://mrapuyqbnbgntljpctzm.supabase.co` | no |
   | `SUPABASE_SERVICE_ROLE` | shared project service_role key | **yes** |
   | `GROQ_API_KEY` | your Groq key | **yes** |
   | `SITE_URL` | your Vercel prod URL (e.g. `https://reem-shata.vercel.app`) | no |
   | `EXTRA_ORIGINS` | *(optional)* custom domain(s), comma-separated | no |

   CLI: `vercel env add SUPABASE_SERVICE_ROLE production` (repeat per var/scope), or paste in the dashboard.

## Deploy + test (safe — Netlify stays live)
4. Preview deploy: `vercel`  → gives a `*.vercel.app` preview URL.
5. On that preview URL, smoke-test:
   - sign in as a student → recordings play, espresso opens with no request
   - ask the AI helper a question → it answers (proves `GROQ_API_KEY` + Supabase env)
   - sign in as admin → create a test student (proves `admin-ops` + `SUPABASE_SERVICE_ROLE`)
6. Promote to production: `vercel --prod`.

## Cut the domain over (last step, only after the preview passes)
7. In Vercel → Project → Domains, add `reemshata.com` (and `www`). Follow Vercel's DNS instructions
   (update the records at your registrar — moving them off Netlify).
8. Set `SITE_URL` to the final origin and add both domains to `EXTRA_ORIGINS` if you use www + apex.
9. Once Vercel is confirmed good, you can retire the Netlify site (or leave it as a warm fallback —
   the code still supports both).

## Local dev
`vercel dev` serves the site + `/api/*` on http://localhost:3000 (reads `.env` for the secrets).

## Notes
- Keep the `netlify/` folder — the Vercel functions reuse that code.
- Requests from the app to `/api/*` are same-origin, so CORS never blocks them regardless of `SITE_URL`.
- No secrets ship to the browser; `SUPABASE_SERVICE_ROLE` + `GROQ_API_KEY` are used server-side only.
