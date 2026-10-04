const crypto = require('crypto');
const net = require('net');

// IP real del visitante. En Render todo el trafico pasa por Cloudflare, que FIJA la cabecera
// CF-Connecting-IP (sobrescribe la que mande el cliente); req.ip seria la de un proxy interno
// compartida por todos los visitantes y los limites por IP serian globales. Fuera de Render
// esa cabecera no se fia (se podria falsificar) salvo que se active TRUST_CLOUDFLARE=1.
function clientIp(req) {
  if (process.env.RENDER || process.env.TRUST_CLOUDFLARE === '1') {
    const h = req.headers['cf-connecting-ip'];
    const ip = typeof h === 'string' ? h.trim() : '';
    if (ip && net.isIP(ip)) return ip;
  }
  return req.ip;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

// Comparación en tiempo constante (hashea antes para igualar longitudes).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// CSRF "double submit" firmado: una cookie aleatoria httpOnly + token HMAC en cada
// formulario. Sin estado en servidor. Para formularios multipart el token viaja en
// la query (?_csrf=...) porque el body aún no está parseado cuando se valida.
function csrf({ secret, isProd }) {
  // En produccion: prefijo __Host- (el navegador exige Secure, Path=/ y sin Domain)
  const cookieName = isProd ? '__Host-csrf' : 'csrf';
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    let raw = cookies[cookieName];
    if (!/^[a-f0-9]{32}$/.test(raw || '')) {
      raw = crypto.randomBytes(16).toString('hex');
      res.append(
        'Set-Cookie',
        `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${isProd ? '; Secure' : ''}`
      );
    }
    const token = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    res.locals.csrfToken = token;

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    const sent = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
    if (!safeEqual(sent, token)) {
      return res.status(403).render('error', {
        status: 403,
        title: 'Formulario caducado',
        message: 'Por seguridad, el formulario ha caducado. Recarga la página e inténtalo de nuevo.',
      });
    }
    next();
  };
}

// Limitador en memoria por clave (IP). Suficiente para una sola instancia.
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  timer.unref();

  function entry(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(key, e);
    }
    return e;
  }

  return {
    blocked: (key) => entry(key).count >= max,
    hit: (key) => {
      entry(key).count += 1;
    },
    reset: (key) => hits.delete(key),
    count: (key) => entry(key).count,
    // Cuenta una peticion y dice si aun cabe dentro del maximo (true) o ya se excedio (false)
    take: (key) => {
      const e = entry(key);
      e.count += 1;
      return e.count <= max;
    },
    retryAfter: (key) => Math.max(1, Math.ceil((entry(key).reset - Date.now()) / 1000)),
    // Middleware que cuenta cada petición y bloquea al superar el máximo.
    middleware(message) {
      return (req, res, next) => {
        const e = entry(clientIp(req));
        e.count += 1;
        if (e.count > max) {
          res.set('Retry-After', String(Math.ceil((e.reset - Date.now()) / 1000)));
          return res.status(429).render('error', {
            status: 429,
            title: 'Demasiadas peticiones',
            message: message || 'Has hecho demasiadas peticiones seguidas. Espera un rato e inténtalo de nuevo.',
          });
        }
        next();
      };
    },
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { csrf, createLimiter, safeEqual, wrap, parseCookies, clientIp };
