/**
 * SlickBooks Web - Authentication Middleware
 * Same pattern as Apex CRM auth.js
 */

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { requireAuth };
