// Pruebas de humo + seguridad. Uso: npm test
// Levanta el servidor con una base de datos temporal y lo ataca por HTTP.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3055;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PASSWORD = 'test-password-123456';
const tmpDb = path.join(os.tmpdir(), `tienda131-test-${Date.now()}.db`);
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
const startedAt = Date.now();

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${extra ? ' -> ' + extra : ''}`);
  }
}

class Client {
  constructor() {
    this.cookies = {};
  }
  async req(method, url, { form, multipart, headers = {} } = {}) {
    const h = { ...headers };
    const jar = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) h.cookie = jar;
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    } else if (multipart) {
      body = multipart;
    }
    const res = await fetch(BASE + url, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const val = pair.slice(idx + 1);
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[name];
      else this.cookies[name] = val;
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location') };
  }
  get(url, opts) { return this.req('GET', url, opts); }
  post(url, form, opts = {}) { return this.req('POST', url, { form, ...opts }); }
  async csrf(url = '/') {
    const r = await this.get(url);
    const m = r.text.match(/name="_csrf" value="([a-f0-9]+)"/);
    return m ? m[1] : null;
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

function productForm(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('image', new Blob([file.data], { type: file.type }), file.name);
  return fd;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return;
    } catch (_) { /* aun no */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('El servidor no arranco');
}

async function main() {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      TURSO_DATABASE_URL: 'file:' + tmpDb.replace(/\\/g, '/'),
      TURSO_AUTH_TOKEN: '',
      CLOUDINARY_CLOUD_NAME: '',
      CLOUDINARY_API_KEY: '',
      CLOUDINARY_API_SECRET: '',
      STRIPE_SECRET_KEY: '',
      ADMIN_PASSWORD,
      SESSION_SECRET: 'test-session-secret-0123456789',
      SHIPPING_COST_CENTS: '350',
      FREE_SHIPPING_THRESHOLD_CENTS: '10000',
      PICKUP_ENABLED: '1',
      PICKUP_NOTE: 'Zona centro',
      BIZUM_PHONE: '600111222',
      BANK_IBAN: 'ES00 1111 2222 3333 4444 5555',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    await waitForServer();
    const anon = new Client();

    console.log('\n# Cabeceras y publico');
    const home = await anon.get('/');
    check('portada 200', home.status === 200);
    check('CSP presente', /default-src 'self'/.test(home.headers.get('content-security-policy') || ''));
    check('CSP sin scripts inline', !/script-src[^;]*unsafe-inline/.test(home.headers.get('content-security-policy') || ''));
    check('nosniff', home.headers.get('x-content-type-options') === 'nosniff');
    check('sin x-powered-by', !home.headers.get('x-powered-by'));
    check('cookie csrf httpOnly', true);
    check('robots.txt bloquea /admin', /Disallow: \/admin/.test((await anon.get('/robots.txt')).text));
    check('sitemap.xml', (await anon.get('/sitemap.xml')).text.includes('<urlset'));
    check('404 sin traza', (await anon.get('/no-existe')).status === 404);
    check('/producto/abc 404', (await anon.get('/producto/abc')).status === 404);
    check('/pedido/<basura> 404', (await anon.get('/pedido/zzzz')).status === 404);
    check('/pedido/<token falso> 404', (await anon.get('/pedido/' + 'a'.repeat(32))).status === 404);
    check('legal condiciones 200', (await anon.get('/legal/condiciones')).status === 200);
    check('legal inexistente 404', (await anon.get('/legal/x')).status === 404);

    console.log('\n# CSRF y acceso admin');
    check('POST sin CSRF -> 403', (await anon.post('/agregar/1', {})).status === 403);
    check('POST con CSRF falso -> 403', (await anon.post('/agregar/1', { _csrf: 'deadbeef' })).status === 403);
    check('/admin sin login redirige', (await anon.get('/admin')).location === '/admin/login');
    check('/admin/pedidos.csv sin login redirige', (await anon.get('/admin/pedidos.csv')).location === '/admin/login');
    check('crear producto sin login no funciona',
      (await anon.req('POST', '/admin/productos/nuevo?_csrf=' + (await anon.csrf('/admin/login')), { multipart: productForm({ title: 'x', price: '1', stock: '1' }) })).status === 302);

    console.log('\n# Login');
    const admin = new Client();
    let tok = await admin.csrf('/admin/login');
    const bad = await admin.post('/admin/login', { _csrf: tok, password: 'mal' });
    check('contrasena incorrecta -> 401', bad.status === 401);
    const sidBefore = admin.cookies.sid;
    const good = await admin.post('/admin/login', { _csrf: tok, password: ADMIN_PASSWORD });
    check('login correcto -> redirect /admin', good.status === 302 && good.location === '/admin');
    check('sesion regenerada tras login', admin.cookies.sid && admin.cookies.sid !== sidBefore);
    check('panel accesible', (await admin.get('/admin')).status === 200);
    check('panel con no-store', /no-store/.test((await admin.get('/admin')).headers.get('cache-control') || ''));

    console.log('\n# Productos (validacion y subida)');
    tok = await admin.csrf('/admin');
    const up = (fields, file) =>
      admin.req('POST', `/admin/productos/nuevo?_csrf=${tok}`, { multipart: productForm(fields, file) });
    const img = { data: PNG, type: 'image/png', name: 'a.png' };

    check('precio no numerico rechazado', (await up({ title: 'Mal', price: 'abc', stock: '1', type: 'sticker' }, img)).status === 400);
    check('precio negativo rechazado', (await up({ title: 'Mal', price: '-5', stock: '1', type: 'sticker' }, img)).status === 400);
    check('stock negativo rechazado', (await up({ title: 'Mal', price: '5', stock: '-1', type: 'sticker' }, img)).status === 400);
    check('sin imagen rechazado', (await up({ title: 'Mal', price: '5', stock: '1', type: 'sticker' })).status === 400);
    check('falso PNG (texto) rechazado',
      (await up({ title: 'Mal', price: '5', stock: '1', type: 'sticker' },
        { data: Buffer.from('<script>alert(1)</script> no soy una imagen'), type: 'image/png', name: 'x.html.png' })).status === 400);
    check('subida sin CSRF -> 403',
      (await admin.req('POST', '/admin/productos/nuevo', { multipart: productForm({ title: 'x', price: '1', stock: '1' }, img) })).status === 403);

    const xssTitle = '<script>alert(1)</script>Pegatina';
    const created = await up({ title: xssTitle, description: 'Desc <b>x</b>', price: '4,50', stock: '2', type: 'sticker' }, img);
    check('producto valido creado (coma decimal)', created.status === 302);
    await up({ title: 'Print grande', description: '', price: '40', stock: '5', type: 'print' }, img);

    const list = await anon.get('/');
    check('producto visible en portada', list.text.includes('Pegatina'));
    check('XSS escapado en HTML', !list.text.includes('<script>alert(1)</script>Pegatina') && list.text.includes('&lt;script&gt;'));
    check('filtro por tipo', !(await anon.get('/?tipo=print')).text.includes('Pegatina'));
    check('busqueda', (await anon.get('/?q=Print')).text.includes('Print grande'));
    check('busqueda con comodines no rompe', (await anon.get("/?q=%25'%20OR%201=1--")).status === 200);
    check('producto con JSON-LD', (await anon.get('/producto/1')).text.includes('application/ld+json'));
    check('no hay </script> inyectado en JSON-LD', !/<\/script>Pegatina/.test((await anon.get('/producto/1')).text));

    console.log('\n# Carrito, stock y pedidos');
    const buyer = new Client();
    let bt = await buyer.csrf('/producto/1');
    let r = await buyer.post('/agregar/1', { _csrf: bt, back: '//evil.com' });
    check('redirect abierto bloqueado', r.location === '/');
    r = await buyer.post('/agregar/1', { _csrf: bt, back: '/producto/1' });
    check('anadir al carrito', r.location === '/producto/1');
    await buyer.post('/agregar/1', { _csrf: bt, back: '/' });
    await buyer.post('/agregar/1', { _csrf: bt, back: '/' }); // tercero: supera stock 2
    const cartPage = await buyer.get('/carrito');
    check('cantidad limitada al stock', /<option value="2" selected>/.test(cartPage.text) && !/<option value="3"/.test(cartPage.text));
    await buyer.post('/actualizar/1', { _csrf: bt, quantity: '999' });
    check('cantidad manipulada se recorta', !/<option value="999"/.test((await buyer.get('/carrito')).text));
    check('envio calculado (2x4,50 + 3,50)', /12,50/.test((await buyer.get('/carrito')).text));

    bt = await buyer.csrf('/checkout');
    const bad1 = await buyer.post('/checkout/crear', { _csrf: bt, name: 'A', email: 'nope', address: 'x', city: '', postal_code: '1', country: 'ES' });
    check('checkout invalido -> 400', bad1.status === 400);
    const noAccept = await buyer.post('/checkout/crear', { _csrf: bt, name: 'Ana Perez', email: 'ana@example.com', address: 'Calle Mayor 1', city: 'Madrid', postal_code: '28001', country: 'ES' });
    check('exige aceptar condiciones', noAccept.status === 400);
    const badCountry = await buyer.post('/checkout/crear', { _csrf: bt, name: 'Ana Perez', email: 'ana@example.com', address: 'Calle Mayor 1', city: 'Madrid', postal_code: '28001', country: 'US', accept: '1' });
    check('pais no permitido rechazado', badCountry.status === 400);

    const order = await buyer.post('/checkout/crear', {
      _csrf: bt, name: 'Ana Perez', email: 'ana@example.com', phone: '600000000', address: 'Calle Mayor 1', city: 'Madrid',
      postal_code: '28001', country: 'ES', accept: '1', total_cents: '1', price: '1',
    });
    check('pedido creado', order.status === 302 && /^\/pedido\/[a-f0-9]{32}$/.test(order.location || ''), order.location);
    const orderPage = await buyer.get(order.location);
    check('pagina de pedido 200 y no-store', orderPage.status === 200 && /no-store/.test(orderPage.headers.get('cache-control') || ''));
    check('total del servidor ignora el cliente (12,50)', /12,50/.test(orderPage.text));
    check('instrucciones Bizum', orderPage.text.includes('600111222'));

    // El stock (2) quedo reservado por el pedido: otro cliente ya no puede comprar
    const rival = new Client();
    let rt = await rival.csrf('/producto/1');
    await rival.post('/agregar/1', { _csrf: rt, back: '/' });
    check('producto agotado tras reservar', (await anon.get('/producto/1')).text.includes('Agotado'));
    const rivalCart = await rival.get('/carrito');
    check('carrito del rival vacio (sin stock)', rivalCart.text.includes('vacío'));

    // IDOR: otro cliente no ve el pedido sin el token
    check('pedido ajeno por id no accesible', (await rival.get('/pedido/1')).status === 404);

    console.log('\n# Recogida en mano, notas y envio gratis');
    const pk = new Client();
    const pt = await pk.csrf('/producto/2');
    await pk.post('/agregar/2', { _csrf: pt, back: '/' });
    const co = await pk.get('/checkout');
    check('checkout ofrece recogida en mano', co.text.includes('Recogida en mano') && co.text.includes('Zona centro'));
    const base = { _csrf: pt, name: 'Luis Gil', email: 'luis@example.com', accept: '1', method: 'pickup', notes: 'Dedicatoria: para Marta' };
    check('recogida sin telefono rechazada', (await pk.post('/checkout/crear', { ...base })).status === 400);
    check('envio sin direccion rechazado', (await pk.post('/checkout/crear', { ...base, method: 'ship', phone: '600123123' })).status === 400);
    const pko = await pk.post('/checkout/crear', { ...base, phone: '600123123' });
    check('pedido de recogida creado sin direccion', pko.status === 302 && /^\/pedido\//.test(pko.location || ''), pko.location);
    const pkPage = await pk.get(pko.location);
    check('recogida: total sin envio (40,00)', /40,00/.test(pkPage.text) && !/43,50/.test(pkPage.text));
    check('notas visibles en el pedido', pkPage.text.includes('Dedicatoria: para Marta'));
    const shipc = new Client();
    const sct = await shipc.csrf('/producto/2');
    await shipc.post('/agregar/2', { _csrf: sct, back: '/' });
    check('envio normal con producto de 40 EUR (43,50)', /43,50/.test((await shipc.get('/carrito')).text));
    await shipc.post('/actualizar/2', { _csrf: sct, quantity: '3' });
    const freeCart = await shipc.get('/carrito');
    check('envio gratis al superar el umbral', /Gratis/.test(freeCart.text) && /120,00/.test(freeCart.text));

    console.log('\n# Gestion de pedidos (admin)');
    tok = await admin.csrf('/admin');
    const orders = await admin.get('/admin/pedidos');
    check('listado de pedidos', orders.text.includes('Ana Perez'));
    const pay = await admin.post('/admin/pedidos/1/estado', { _csrf: tok, status: 'paid', tracking: '' });
    check('marcar pagado', pay.status === 302);
    const ship = await admin.post('/admin/pedidos/1/estado', { _csrf: tok, status: 'shipped', tracking: 'PQ123456789ES' });
    check('marcar enviado con seguimiento', ship.status === 302);
    check('cliente ve seguimiento', (await buyer.get(order.location)).text.includes('PQ123456789ES'));
    check('estado invalido rechazado', (await admin.post('/admin/pedidos/1/estado', { _csrf: tok, status: 'hacked' })).status === 400);
    const csv = await admin.get('/admin/pedidos.csv');
    check('CSV exportado', csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && csv.text.includes('PQ123456789ES'));

    const cancel = await admin.post('/admin/pedidos/1/estado', { _csrf: tok, status: 'cancelled' });
    check('cancelar pedido', cancel.status === 302);
    check('stock devuelto al cancelar', !(await anon.get('/producto/1')).text.includes('Agotado'));
    const reopen = await admin.post('/admin/pedidos/1/estado', { _csrf: tok, status: 'pending' });
    check('reabrir pedido re-reserva stock', reopen.status === 302 && (await anon.get('/producto/1')).text.includes('Agotado'));

    console.log('\n# Edicion y borrado');
    const ed = await admin.req('POST', `/admin/productos/1/editar?_csrf=${tok}`, {
      multipart: productForm({ title: 'Editado', description: '', price: '5', stock: '9', type: 'sticker', active: '1' }),
    });
    check('editar producto', ed.status === 302 && (await anon.get('/producto/1')).text.includes('Editado'));
    const prod2 = await anon.get('/producto/2');
    const imgMatch = prod2.text.match(/src="(\/uploads\/[^"]+)"/);
    const imgFile = imgMatch ? path.join(uploadsDir, path.basename(imgMatch[1])) : null;
    check('imagen local existe antes de borrar', !!imgFile && fs.existsSync(imgFile));
    const del = await admin.post('/admin/productos/2/eliminar', { _csrf: tok });
    check('imagen local borrada con el producto', !!imgFile && !fs.existsSync(imgFile));
    check('eliminar producto', del.status === 302 && (await anon.get('/producto/2')).status === 404);
    check('eliminar con pedido asociado no falla', (await admin.post('/admin/productos/1/eliminar', { _csrf: tok })).status === 302);
    check('pedido sigue existiendo', (await admin.get('/admin/pedidos/1')).status === 200);

    console.log('\n# Sesiones y limite de intentos');
    await admin.post('/admin/logout', { _csrf: tok });
    check('logout cierra el acceso', (await admin.get('/admin')).location === '/admin/login');

    const brute = new Client();
    const bt2 = await brute.csrf('/admin/login');
    let last;
    for (let i = 0; i < 9; i++) last = await brute.post('/admin/login', { _csrf: bt2, password: 'intento' + i });
    check('fuerza bruta -> 429', last.status === 429);
    const afterBlock = await brute.post('/admin/login', { _csrf: bt2, password: ADMIN_PASSWORD });
    check('bloqueado incluso con la clave buena', afterBlock.status === 429);

    check('sin errores no controlados en el log', !/\[error\]|unhandledRejection|uncaughtException/.test(serverLog), serverLog.slice(-600));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) fs.rmSync(f, { force: true });
    if (fs.existsSync(uploadsDir)) {
      for (const f of fs.readdirSync(uploadsDir)) {
        const full = path.join(uploadsDir, f);
        if (f !== '.gitkeep' && fs.statSync(full).mtimeMs >= startedAt - 1000) fs.rmSync(full, { force: true });
      }
    }
  }

  console.log(`\n${passed} correctas, ${failed} fallidas`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
