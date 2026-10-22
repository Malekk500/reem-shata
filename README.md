# Mrs Reem Shata — Physics Portal

A production teaching portal for IGCSE & A-Level Physics: a public landing page plus a private
student/staff portal (recordings, homework, attendance, marks, class wall, AI tutor).

- **Front end:** a single `index.html` (HTML + CSS + ES-module JS, no build step).
- **Backend:** a **shared multi-tenant Supabase** project (Postgres + Auth + Storage), consolidated
  with other client apps to cut cost. This app is tenant **`client_id = 'shata'`**.
- **Serverless:** two Netlify Functions — `ai.js` (Groq physics-tutor proxy) and `admin-ops.js`
  (privileged account operations). Both run server-side with the service-role key.

## Roles
- **student** — own recordings, homework, attendance, marks, class wall, AI helper.
- **assist** — manage videos / homework / marks / attendance / announcements / students.
- **admin** (owner, Mrs Reem) — everything `assist` can do **plus** Settings: create/delete
  assistants, change passwords, danger zone, audit log.

Login is `username@reemshata.app` (the domain isn't real — Supabase Auth just needs an email).
Accounts are created in-app (Admin → Accounts / Settings), never self-signup.

## How it talks to the shared database
`index.html` has a **mapping layer** (`TABLE_MAP` / `mapColName` / `mapRowIn` / `mapRowOut` /
`mapConflict`) that renames this app's logical tables/columns onto the shared schema and
**stamps/filters `client_id='shata'` on every read and write**, so the app can only ever touch
its own tenant. A login gate in `onAuthStateChange` also refuses any account whose
`profiles.client_id` isn't `'shata'`. Full detail: **`supabase/README.md`**.

## Project layout
```
index.html               the whole app (landing + portal + mapping/data layer)
assets/                   logo, teacher portrait, team/achievers/reviews/moments images
netlify/functions/ai.js          authenticated, server-prompted Groq tutor proxy
netlify/functions/admin-ops.js   service-role account ops, tenant- + role-scoped
netlify.toml             security headers (HSTS, CSP, …) + caching
supabase/README.md       the shared multi-tenant DB (schema/RLS/storage/retention live there)
DEPLOY_RUNBOOK.md        how to deploy to Netlify (env vars, CORS, smoke test)
```

## Run locally
`python3 -m http.server 999` in this folder, then open `http://localhost:999`.
Login + all data flows + homework photo/PDF upload work locally against Supabase.
The **AI helper** and **account creation** need the Netlify functions, so they only work once
deployed (or via `netlify dev`).

## Deploy
See **`DEPLOY_RUNBOOK.md`**. In short: drag the folder to Netlify, set env vars
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, `GROQ_API_KEY`, `SITE_URL`), redeploy. The
`service_role` key is server-only — never in the client or git.

## Security posture
RLS + central tenant scoping on every table; role pinned (no self-escalation); service-role
server-only; AI endpoint authenticated, server-set prompt, rate-limited, tenant-gated; private
storage bucket with short-lived signed URLs; 2-device session limit; CSP/HSTS/security headers.
Homework images are compressed client-side (2000px / q0.82 / 0.6MB); PDFs upload untouched.
