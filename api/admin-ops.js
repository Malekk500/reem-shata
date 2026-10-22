// Vercel Function — /api/admin-ops. Thin adapter over the existing Netlify handler so the
// privileged-ops logic lives in ONE place (netlify/functions/admin-ops.js) and both platforms
// stay identical. Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE, SITE_URL, (optional) EXTRA_ORIGINS
const { handler } = require('../netlify/functions/admin-ops.js');

module.exports = async (req, res) => {
  const event = {
    httpMethod: req.method,
    headers: req.headers, // Node lowercases header names; the handler already checks both cases
    body: typeof req.body === 'string' ? req.body : (req.body ? JSON.stringify(req.body) : ''),
    queryStringParameters: req.query || {},
  };
  const result = await handler(event);
  const headers = result.headers || {};
  for (const k in headers) res.setHeader(k, headers[k]);
  res.statusCode = result.statusCode || 200;
  res.end(result.body || '');
};
