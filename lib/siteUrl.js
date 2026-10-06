// Direccion publica de la web. Nunca se confia en la cabecera Host si hay una direccion configurada:
// SITE_URL, o la que Render facilita en RENDER_EXTERNAL_URL. Asi un Host falsificado no acaba en
// enlaces, sitemap, datos estructurados ni emails.
const clean = (u) => String(u || '').replace(/\/+$/, '');

function siteUrl(req) {
  const fixed = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL;
  return clean(fixed || `${req.protocol}://${req.get('host')}`);
}

module.exports = { siteUrl };
