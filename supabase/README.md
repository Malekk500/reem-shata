# Database — shared multi-tenant Supabase project

This app does **not** own its database. It runs on a **shared multi-tenant Supabase
project** consolidated with other client apps to cut cost.

- **Project URL:** `https://mrapuyqbnbgntljpctzm.supabase.co`
- **Tenant id:** `client_id = 'shata'` (every row this app reads/writes carries it)
- **Login email domain:** `username@reemshata.app`
- **Roles:** `student` · `assist` · `admin`

## Schema / RLS / storage / retention are managed CENTRALLY
Do **not** run DDL here or recreate tables. The shared schema, Row-Level Security,
the private storage bucket, and the retention cron are all owned by the consolidated
project. (The old single-tenant migrations that used to live in this folder —
`01_schema.sql … 04_audit.sql` — described a standalone project this app no longer
uses and have been removed to avoid confusion.)

## How this app talks to the shared schema
`index.html` contains a **mapping layer** (`TABLE_MAP`, `mapColName`, `mapRowIn`,
`mapRowOut`, `mapConflict`, `pkCol`) that:
- renames the app's logical tables/columns onto the shared ones, e.g.
  `users→profiles`, `submissions→homework_submissions`, `sessions→device_sessions`,
  `audit_log→activity_log`; `name↔full_name`, `id↔user_id`, `due_date↔due`,
  videos `school↔track`, announcements `text↔body`, attendance `lesson_date↔date`/`lesson↔note`.
- **stamps `client_id='shata'` on every write** and **filters by it on every read**,
  so this app can only ever touch its own tenant's rows.

## Shared tables (all carry `client_id`)
`profiles` (+`parent_phone`) · `homework` · `homework_submissions`
(`photos` jsonb = `[{path}]`) · `marks` (unique `client_id,user_id,exam`) ·
`videos` (`url` external) · `announcements` · `attendance`
(unique `client_id,user_id,date` — one row per student per day) ·
`device_sessions` (2-device limit + heartbeat) · `activity_log` (login events).

## Storage
Private bucket **`hw-throwaway`**, homework files at `shata/{uid}/{homework_id}/{idx}`,
served via short-lived **signed URLs**. Homework images are compressed client-side
(2000px / q0.82 / 0.6MB); PDFs upload untouched.

## Retention
A central daily cron deletes homework + submissions **14 days** after posting.
This app adds **no** cleanup of its own.

## Login gate (in `onAuthStateChange`)
After sign-in and before routing, the app fetches `profiles.client_id`; if it's
missing or `!= 'shata'`, it signs out and shows "This account isn't for this site."
The two Netlify functions apply the same tenant gate server-side.
