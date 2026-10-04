function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// Las paginas de administracion nunca se indexan ni se guardan en cache.
function adminHeaders(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
}

module.exports = { requireAdmin, adminHeaders };
