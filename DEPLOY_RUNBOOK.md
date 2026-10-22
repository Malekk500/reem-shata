# Mrs Reem Shata — Production Deploy Runbook

Single-file front end (`index.html`) + **shared multi-tenant Supabase backend** + 2 Netlify
Functions. The database, RLS, storage, and retention live on the consolidated shared project and
are managed centrally — see `supabase/README.md`. This runbook is the remaining steps to deploy.

## Project facts
- **Shared Supabase project URL:** `https://mrapuyqbnbgntljpctzm.supabase.co`
- **Tenant id:** `client_id = 'shata'` (this app only ever sees its own tenant's rows)
- **Anon (publishable) key:** already in `index.html` (public by design; RLS + tenant scoping protect the data)
- **Login email domain:** `username@reemshata.app`
- **Roles:** `student` · `assist` · `admin`

> Accounts are created in-app (Admin → Accounts for students; Admin → Settings → Create assistant).
> The owner/admin account is provisioned on the shared project. No credentials are stored in this repo.

---

## STEP 1 — Deploy to Netlify
Drag the whole `mrs-reem-shata-physics/` folder onto https://app.netlify.com/drop
(or connect the repo). Netlify auto-detects `netlify.toml` + the `netlify/functions` folder.
Note the URL it gives you, e.g. `https://something.netlify.app`.

## STEP 2 — Set Netlify environment variables
Netlify → Site configuration → **Environment variables** → add:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | `https://mrapuyqbnbgntljpctzm.supabase.co` (the **shared** project) |
| `SUPABASE_SERVICE_ROLE` | the **shared** project's `service_role` key (Supabase → Project Settings → API) |
| `GROQ_API_KEY` | your Groq key (https://console.groq.com/keys) — for the AI tutor |
| `SITE_URL` | your live origin, e.g. `https://something.netlify.app` (used for CORS — see below) |

⚠️ `SUPABASE_SERVICE_ROLE` bypasses RLS — it is used **only** by the Netlify functions
(`ai.js`, `admin-ops.js`), server-side. **Never** put it in `index.html` or commit it.

Then **Deploys → Trigger deploy → Clear cache and deploy site** (env vars need a fresh build).

## STEP 3 — CORS origin (handled by `SITE_URL`)
Both functions read `SITE_URL` (and optional `EXTRA_ORIGINS`, comma-separated) from env and add
them to the allowed-origins list at runtime — so you **don't edit code** to whitelist your domain.
Just set `SITE_URL` to your real Netlify URL (Step 2). When you later add a custom domain
(`reemshata.com` is already pre-allowed), point DNS in Netlify and you're done; add any extra
origins via `EXTRA_ORIGINS`.

If `SITE_URL` is wrong/unset, the AI helper and account-creation calls will be CORS-blocked in
production (everything else talks straight to Supabase and is unaffected).

---

## Smoke test (every role)
1. Open the site signed-out → landing page. **Paste the URL into a private window → still landing (logged out).**
2. **Sign in as the admin** → Admin panel **with the Settings tab**. Create a test student → credentials + WhatsApp buttons appear. Upload a video (a Google Drive `/preview` link), assign homework, post an announcement.
3. **Sign in as an assistant** → same panel, **no Settings tab**, no danger zone.
4. **Sign in as a student** → recordings, homework, attendance, marks, class wall. Submit homework as **a photo AND a PDF** → both upload to the private bucket.
5. Back as admin → **Homework → Review Submissions** → the student's photos show as thumbnails and the PDF as a "📄 PDF" tile; click → lightbox (image inline, PDF in an iframe).
6. Ask the AI helper a physics question → it answers (needs `GROQ_API_KEY` + `SITE_URL` live).

## Security checklist (live)
- **Tenant gate:** an account from another tenant on the shared project is signed out at login ("This account isn't for this site"); both functions re-check `client_id` server-side.
- **Paste-URL test:** a copied logged-in URL opens logged-out in incognito.
- **RLS:** a student sees only their own rows; cannot self-promote to admin.
- **Admin route:** student/assist can't see Settings/danger zone, and `admin-ops` returns 403 for non-owners.
- **AI endpoint:** no token → 401; server-set prompt; rate-limited 12/min/user; tenant-gated.
- **Bucket privacy:** homework files are private; viewers get short-lived signed URLs.
- **Headers:** `netlify.toml` sets HSTS, CSP (allows esm.sh, jsdelivr, fonts, Supabase https+wss, Drive embeds), nosniff, Referrer-Policy, Permissions-Policy, frame options. Verify at https://securityheaders.com after deploy.

## Maintenance
- Rotate the Groq key and the shared `service_role` key on a schedule; update the Netlify env vars after.
- DB schema / RLS / storage / retention are central — don't change them from this app (see `supabase/README.md`).
- Account creation, password resets, and the danger zone all run through `admin-ops.js` (service-role, tenant-scoped).
