// Shared server-only helpers for the Bunny Stream endpoints.
// BUNNY_API_KEY and BUNNY_TOKEN_KEY are read from env here and NEVER returned to the browser.
const crypto = require('crypto');

const SITE_CLIENT_ID = 'shata';
const ORIGINS = [
  'https://reemshataphysics.com',
  'https://www.reemshataphysics.com',
  'https://mrs-reem-shata-physics.vercel.app',
  'http://localhost:8888',
  'http://localhost:3000',
  'http://localhost:8124', // local preview server
];

function corsOrigin(req) {
  const o = String((req.headers && req.headers.origin) || '');
  if (ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(o)) return o;
  return ORIGINS[0];
}
function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin(req));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
}
function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function bunnyEnv() {
  return {
    libraryId: process.env.BUNNY_LIBRARY_ID || '',
    apiKey: process.env.BUNNY_API_KEY || '',
    tokenKey: process.env.BUNNY_TOKEN_KEY || '',
    supabaseUrl: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE || '',
  };
}
function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
}

// Verify the caller's Supabase JWT and load role + tenant. Throws { status, error } if not allowed.
// Server-side enforcement: a student calling a staff/admin endpoint is rejected here, never in the UI only.
async function requireRole(req, allowedRoles) {
  const { supabaseUrl, serviceKey } = bunnyEnv();
  if (!supabaseUrl || !serviceKey) throw { status: 500, error: 'Server misconfigured' };
  const jwt = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw { status: 401, error: 'Sign in required' };

  let userId = '';
  try {
    const u = await fetch(supabaseUrl + '/auth/v1/user', { headers: { apikey: serviceKey, Authorization: 'Bearer ' + jwt } });
    if (!u.ok) throw 0;
    const uj = await u.json();
    userId = uj && uj.id;
  } catch (_) { throw { status: 401, error: 'Invalid session' }; }
  if (!userId) throw { status: 401, error: 'Invalid session' };

  let role = '', clientId = '';
  try {
    const p = await fetch(supabaseUrl + '/rest/v1/profiles?user_id=eq.' + encodeURIComponent(userId) + '&select=role,client_id',
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } });
    const rows = p.ok ? await p.json() : [];
    role = rows[0] && rows[0].role;
    clientId = rows[0] && rows[0].client_id;
  } catch (_) { throw { status: 500, error: 'Could not verify your account' }; }

  if (clientId !== SITE_CLIENT_ID) throw { status: 403, error: "This account isn't for this site." };
  if (!allowedRoles.includes(role)) throw { status: 403, error: 'Not allowed' };
  return { userId, role };
}

module.exports = { SITE_CLIENT_ID, ORIGINS, setCors, corsOrigin, json, sha256hex, bunnyEnv, parseBody, requireRole };
