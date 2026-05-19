/**
 * apiKeyAuth — guards INBOUND requests to /api/sync/* admin endpoints.
 *
 * The sync endpoints expose queue internals and a manual drain button. On a
 * networked POS box that's a privilege surface, so we gate them with a local
 * admin token. If LOCAL_ADMIN_TOKEN is not set, we allow loopback connections
 * only (so the on-device admin UI keeps working out of the box).
 */
module.exports = function apiKeyAuth(req, res, next) {
  const expected = process.env.LOCAL_ADMIN_TOKEN || '';
  if (!expected) {
    // No token configured → allow loopback / LAN-private only.
    const ip = (req.ip || '').replace('::ffff:', '');
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.');
    if (isLocal) return next();
    return res.status(401).json({ error: 'admin-token-required' });
  }
  const given = req.header('X-Admin-Token') || req.query.token;
  if (given && given === expected) return next();
  return res.status(401).json({ error: 'invalid-admin-token' });
};
