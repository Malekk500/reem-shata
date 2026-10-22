# Migration kit — RETIRED (superseded by the shared multi-tenant consolidation)

This document used to be the build kit for migrating the app from a localStorage demo onto a
**dedicated single-tenant Supabase project** (its own `users`/`videos`/`homework`/… tables, its
own RLS, its own storage bucket, its own Netlify functions).

**That approach has been retired.** The app was consolidated onto a **shared multi-tenant
Supabase project** (combined with other client apps to cut cost), so the standalone schema, RLS,
storage, and migrations described here no longer apply and have been removed to avoid confusion.

## Current reality — read these instead
- **`README.md`** — what the app is and how it's wired.
- **`supabase/README.md`** — the shared multi-tenant database: tenant `client_id='shata'`, the
  mapping layer, the shared tables, storage (`hw-throwaway`), retention, and the login gate.
  Schema / RLS / storage / retention are managed **centrally** on the shared project — don't run
  DDL from this app.
- **`DEPLOY_RUNBOOK.md`** — how to deploy to Netlify (env vars, CORS via `SITE_URL`, smoke test).

## One-line architecture
Single `index.html` (with a `mapColName`/`mapRowIn`/`mapRowOut`/`mapConflict` mapping layer that
stamps and filters `client_id='shata'`) → shared Supabase project
`https://mrapuyqbnbgntljpctzm.supabase.co` → two server-side Netlify functions (`ai.js`,
`admin-ops.js`) that re-check the tenant before doing anything privileged.
