// Pruebas de humo + seguridad. Uso: npm test
// Levanta el servidor con una base de datos temporal y lo ataca por HTTP.
const { spawn } = require('child_process');
const http = require('http');
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
  constructor(base = BASE) {
    this.base = base;
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
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
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

function productForm(fields, file, extras = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of [].concat(v)) fd.append(k, item);
  }
  if (file) fd.append('image', new Blob([file.data], { type: file.type }), file.name);
  for (const x of extras) fd.append('extra', new Blob([x.data], { type: x.type }), x.name);
  return fd;
}

async function waitForServer(base = BASE) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return;
    } catch (_) { /* aun no */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('El servidor no arranco');
}

const MAIL_PORT = 3057;
const AI_PORT = 3059;
const aiCalls = [];
// Imita POST /v1/messages: responde segun el titulo que reciba en el prompt
function startAiServer() {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(b); } catch (_) { /* ignorado */ }
      aiCalls.push({ url: req.url, headers: req.headers, body });
      const userText = JSON.stringify(body.messages || []);
      if (userText.includes('IA-ERROR')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }));
      }
      let temas = ['Abstracto'];
      if (userText.includes('Hostil')) temas = ['Montañas', '<img src=x onerror=alert(1)>', 'Gatos de la calle', 'Montañas'];
      else if (userText.includes('Pico nevado')) temas = ['Montañas'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ temas }) }],
        stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 },
      }));
    });
  });
  return new Promise((r) => srv.listen(AI_PORT, '127.0.0.1', () => r(srv)));
}
const mails = [];
function startMailServer() {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try { mails.push({ key: req.headers['api-key'], ...JSON.parse(b) }); } catch (_) { /* ignorado */ }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((r) => srv.listen(MAIL_PORT, '127.0.0.1', () => r(srv)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mailTo = (to, re) => mails.filter((m) => m.to[0].email === to && re.test(m.subject));

const baseEnv = () => ({
  ...process.env,
  TURSO_AUTH_TOKEN: '',
  CLOUDINARY_CLOUD_NAME: '',
  CLOUDINARY_API_KEY: '',
  CLOUDINARY_API_SECRET: '',
  ADMIN_PASSWORD,
  SESSION_SECRET: 'test-session-secret-0123456789',
  BREVO_API_KEY: 'test-key',
  MAIL_FROM: 'tienda@example.com',
  OWNER_EMAIL: 'owner@example.com',
  MAIL_API_URL: `http://127.0.0.1:${MAIL_PORT}/send`,
  SITE_URL: 'https://tienda.test',
  TRACK_STOCK: '1', // las suites generales cubren el modo opcional con stock
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${AI_PORT}`,
});

// Segunda instancia con Stripe configurado: webhook firmado y fallos del proveedor.
async function suiteStripe() {
  console.log('\n# Stripe: webhook firmado y fallos de pago');
  const stripeLib = require('stripe')('sk_test_dummy');
  const { createClient } = require('@libsql/client');
  const port = 3056;
  const base = `http://127.0.0.1:${port}`;
  const dbFile = path.join(os.tmpdir(), `tienda131-test2-${Date.now()}.db`);
  const dbUrl = 'file:' + dbFile.replace(/\\/g, '/');
  const secret = 'whsec_testsecret';
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...baseEnv(),
      PORT: String(port),
      TURSO_DATABASE_URL: dbUrl,
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log2 = '';
  srv.stdout.on('data', (d) => (log2 += d));
  srv.stderr.on('data', (d) => (log2 += d));
  let c;
  try {
    await waitForServer(base);
    c = createClient({ url: dbUrl });
    await c.execute("INSERT INTO products (title, price_cents, image_path, type, stock) VALUES ('Print test', 4000, '/x.png', 'print', 3)");

    const mkOrder = async (tokenChar, session) => {
      await c.execute({
        sql: "INSERT INTO orders (token, customer_email, customer_name, shipping_address, total_cents, shipping_cents, status, stripe_session_id) VALUES (?, 'cli@example.com', 'Cli', '{\"name\":\"Cli\"}', 4350, 350, 'pending', ?)",
        args: [tokenChar.repeat(32), session],
      });
      const o = await c.execute({ sql: 'SELECT id FROM orders WHERE stripe_session_id = ?', args: [session] });
      const id = Number(o.rows[0].id);
      await c.execute({ sql: "INSERT INTO order_items (order_id, product_id, title, price_cents, quantity) VALUES (?, 1, 'Print test', 4000, 1)", args: [id] });
      await c.execute('UPDATE products SET stock = stock - 1 WHERE id = 1');
      return id;
    };
    const statusOf = async (id) => (await c.execute({ sql: 'SELECT status FROM orders WHERE id = ?', args: [id] })).rows[0].status;
    const stockOf = async () => Number((await c.execute('SELECT stock FROM products WHERE id = 1')).rows[0].stock);
    const hook = async (event, { sign = true } = {}) => {
      const payload = JSON.stringify(event);
      const header = sign ? stripeLib.webhooks.generateTestHeaderString({ payload, secret }) : 'invalid';
      const r = await fetch(base + '/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': header },
        body: payload,
      });
      return r.status;
    };
    const completed = (session, over = {}) => ({
      id: 'evt_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: session, object: 'checkout.session', payment_status: 'paid', amount_total: 4350, currency: 'eur',
          metadata: { order_id: '1' }, ...over,
        },
      },
    });

    const id1 = await mkOrder('a', 'cs_test_1');
    check('webhook con firma falsa -> 400', (await hook(completed('cs_test_1'), { sign: false })) === 400);
    check('firma falsa no cambia el pedido', (await statusOf(id1)) === 'pending');
    check('webhook con importe manipulado se ignora', (await hook(completed('cs_test_1', { amount_total: 100 }))) === 200 && (await statusOf(id1)) === 'pending');
    check('webhook con pedido que no coincide se ignora', (await hook(completed('cs_test_1', { metadata: { order_id: '99' } }))) === 200 && (await statusOf(id1)) === 'pending');
    check('webhook de sesion sin pagar se ignora', (await hook(completed('cs_test_1', { payment_status: 'unpaid' }))) === 200 && (await statusOf(id1)) === 'pending');
    check('webhook valido marca el pedido como pagado', (await hook(completed('cs_test_1'))) === 200 && (await statusOf(id1)) === 'paid');
    await sleep(500);
    check('email de pago al cliente (webhook)', mailTo('cli@example.com', /Pago recibido/).length === 1);
    check('email de pago al propietario (webhook)', mailTo('owner@example.com', /Pago confirmado/).length === 1);
    await hook(completed('cs_test_1'));
    await sleep(300);
    check('webhook repetido es idempotente (sin emails dobles)', mailTo('cli@example.com', /Pago recibido/).length === 1);

    const id2 = await mkOrder('b', 'cs_test_2');
    const before = await stockOf();
    const expired = (session) => ({ id: 'evt_2', object: 'event', type: 'checkout.session.expired', data: { object: { id: session } } });
    check('sesion caducada cancela el pedido', (await hook(expired('cs_test_2'))) === 200 && (await statusOf(id2)) === 'cancelled');
    check('sesion caducada devuelve el stock', (await stockOf()) === before + 1);
    check('caducar un pedido ya pagado no lo cancela', (await hook(expired('cs_test_1'))) === 200 && (await statusOf(id1)) === 'paid');

    // Si Stripe falla al crear la sesion, el pedido se cancela y el stock se libera
    const buyer = new Client(base);
    const tk = await buyer.csrf('/producto/1');
    await buyer.post('/agregar/1', { _csrf: tk, back: '/' });
    const stockBefore = await stockOf();
    const res = await buyer.post('/checkout/crear', {
      _csrf: tk, name: 'Eva Ruiz', email: 'eva@example.com', address: 'Calle Sol 5', city: 'Sevilla',
      postal_code: '41001', country: 'ES', accept: '1',
    });
    check('si Stripe falla vuelve al carrito', res.status === 302 && res.location === '/carrito', res.location);
    check('si Stripe falla se libera el stock', (await stockOf()) === stockBefore);
    check('sin errores no controlados (Stripe)', !/unhandledRejection|uncaughtException/.test(log2), log2.slice(-500));
  } finally {
    if (c) c.close();
    srv.kill();
    await sleep(300);
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (_) { /* archivo aun bloqueado en Windows: queda en la carpeta temporal */ } }
  }
}

// Modo por defecto: produccion bajo demanda (sin stock, sin "agotado", sin "ultimas unidades").
async function suiteMadeToOrder() {
  console.log('\n# Produccion bajo demanda (sin stock)');
  const port = 3060;
  const base = `http://127.0.0.1:${port}`;
  const dbFile = path.join(os.tmpdir(), `tienda131-test4-${Date.now()}.db`);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...baseEnv(), PORT: String(port), TURSO_DATABASE_URL: 'file:' + dbFile.replace(/\\/g, '/'),
      STRIPE_SECRET_KEY: '', TRACK_STOCK: '', LEAD_TIME: '5-7 días laborables', ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log4 = '';
  srv.stdout.on('data', (d) => (log4 += d));
  srv.stderr.on('data', (d) => (log4 += d));
  const uploadsBefore = fs.readdirSync(uploadsDir).length;
  try {
    await waitForServer(base);
    const admin = new Client(base);
    const lt = (await admin.get('/admin/login')).text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
    await admin.post('/admin/login', { _csrf: lt, password: ADMIN_PASSWORD });
    const tok = (await admin.get('/admin')).text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];

    const form = (await admin.get('/admin/productos/nuevo')).text;
    check('el formulario no pide unidades', !/Unidades disponibles/.test(form) && !/name="stock"/.test(form));
    const dash = (await admin.get('/admin')).text;
    check('el panel no muestra stock ni agotados', !/Productos agotados|Con poco stock|<th>Stock<\/th>/.test(dash));

    const create = (fields) => admin.req('POST', `/admin/productos/nuevo?_csrf=${tok}`, {
      multipart: productForm(fields, { data: PNG, type: 'image/png', name: 'a.png' }),
    });
    check('crear producto sin campo de stock', (await create({ title: 'Bajo demanda', description: 'x', price: '25', type: 'print' })).status === 302);
    check('un stock manipulado en el formulario se ignora', (await create({ title: 'Otro', price: '5', type: 'sticker', stock: '-5' })).status === 302);

    const anon = new Client(base);
    const home = (await anon.get('/')).text;
    check('ambos productos visibles', home.includes('Bajo demanda') && home.includes('Otro'));
    check('sin "Agotado" ni "Ultimas unidades"', !/Agotado|Últimas unidades|Ultimas unidades/.test(home));
    const prod = (await anon.get('/producto/1')).text;
    check('la ficha no muestra unidades', !/Solo quedan|unidades|Agotado/.test(prod) && /Añadir al carrito/.test(prod));
    check('la ficha indica elaboracion bajo pedido y plazo', /Se elabora bajo pedido/.test(prod) && prod.includes('5-7 días laborables'));
    check('JSON-LD siempre disponible', /schema.org\/InStock/.test(prod) && !/OutOfStock/.test(prod));
    check('condiciones mencionan elaboracion bajo pedido', /se elaboran bajo pedido/.test((await anon.get('/legal/condiciones')).text));

    // Sin limite de unidades: el unico tope es el de 10 por linea
    const buyer = new Client(base);
    const bt = await buyer.csrf('/producto/1');
    for (let i = 0; i < 12; i++) await buyer.post('/agregar/1', { _csrf: bt, back: '/' });
    const cart = (await buyer.get('/carrito')).text;
    check('se pueden pedir hasta 10 por linea', /<option value="10" selected>/.test(cart) && !/<option value="11"/.test(cart));
    const bt2 = await buyer.csrf('/checkout');
    const data = { _csrf: bt2, name: 'Eva Ruiz', email: 'eva@example.com', address: 'Calle Sol 5', city: 'Sevilla', postal_code: '41001', country: 'ES', accept: '1' };
    const o1 = await buyer.post('/checkout/crear', data);
    check('pedido de 10 unidades aceptado', o1.status === 302 && /^\/pedido\//.test(o1.location || ''));
    const again = new Client(base);
    const at = await again.csrf('/producto/1');
    for (let i = 0; i < 10; i++) await again.post('/agregar/1', { _csrf: at, back: '/' });
    const at2 = await again.csrf('/checkout');
    check('el mismo producto se puede volver a pedir (no se agota)', (await again.post('/checkout/crear', { ...data, _csrf: at2 })).status === 302);
    check('el producto sigue disponible tras los pedidos', /Añadir al carrito/.test((await anon.get('/producto/1')).text));

    // Cancelar un pedido no toca ningun stock
    const orderPage = await buyer.get(o1.location);
    check('la pagina del pedido no habla de unidades', !/unidades volver/.test(orderPage.text));
    check('sin errores en el log (bajo demanda)', !/\[error\]|unhandledRejection|uncaughtException/.test(log4), log4.slice(-500));
  } finally {
    srv.kill();
    await sleep(300);
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (_) { /* bloqueado en Windows */ } }
    for (const f of fs.readdirSync(uploadsDir)) {
      const full = path.join(uploadsDir, f);
      if (f !== '.gitkeep' && fs.statSync(full).mtimeMs >= startedAt - 1000) { try { fs.rmSync(full, { force: true }); } catch (_) { /* ignorado */ } }
    }
    void uploadsBefore;
  }
}

// Arranque contra una base de datos con el esquema ANTIGUO (el que ya hay en produccion)
// y en modo produccion detras de un proxy (Render): cookies Secure, HSTS, migracion.
async function suiteProdAndMigration() {
  console.log('\n# Modo produccion y migracion desde el esquema antiguo');
  const { createClient } = require('@libsql/client');
  const port = 3058;
  const base = `http://127.0.0.1:${port}`;
  const dbFile = path.join(os.tmpdir(), `tienda131-test3-${Date.now()}.db`);
  const dbUrl = 'file:' + dbFile.replace(/\\/g, '/');

  // Esquema de la primera version desplegada (sin token, envio ni sesiones)
  const old = createClient({ url: dbUrl });
  await old.executeMultiple(`
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL, image_path TEXT, type TEXT NOT NULL DEFAULT 'sticker', stock INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, stripe_session_id TEXT UNIQUE, customer_email TEXT, customer_name TEXT, shipping_address TEXT, total_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, title TEXT NOT NULL, price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1);
    INSERT INTO products (title, price_cents, image_path, stock) VALUES ('Antiguo', 450, '/old.png', 3);
    INSERT INTO orders (customer_email, customer_name, shipping_address, total_cents, status) VALUES ('old@example.com', 'Cliente Antiguo', '{"name":"Cliente Antiguo","address":"Calle 1","city":"Madrid","postal_code":"28001","country":"ES"}', 800, 'paid');
    INSERT INTO order_items (order_id, product_id, title, price_cents, quantity) VALUES (1, 1, 'Antiguo', 450, 1);
    INSERT INTO orders (customer_email, customer_name, shipping_address, total_cents, status) VALUES ('pend@example.com', 'Pendiente', '{"name":"Pendiente"}', 500, 'pending');
    INSERT INTO order_items (order_id, product_id, title, price_cents, quantity) VALUES (2, 1, 'Antiguo', 450, 1);
    INSERT INTO orders (customer_email, customer_name, shipping_address, total_cents, status, created_at) VALUES ('viejo@example.com', 'Pedido Viejo', '{"name":"Pedido Viejo"}', 450, 'pending', '2020-01-01 10:00:00');
    INSERT INTO order_items (order_id, product_id, title, price_cents, quantity) VALUES (3, 1, 'Antiguo', 450, 1);
  `);
  old.close();

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...baseEnv(), PORT: String(port), TURSO_DATABASE_URL: dbUrl, STRIPE_SECRET_KEY: '', RENDER: 'true', BANK_IBAN: 'ES00 0000 0000 0000 0000 0000', BIZUM_PHONE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log3 = '';
  srv.stdout.on('data', (d) => (log3 += d));
  srv.stderr.on('data', (d) => (log3 += d));
  try {
    await waitForServer(base);
    const proxied = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7' };
    const anon = new Client(base);
    const home = await anon.get('/', { headers: proxied });
    check('arranca con la base de datos antigua', home.status === 200 && home.text.includes('Antiguo'));
    check('HSTS en produccion', /max-age=\d+/.test(home.headers.get('strict-transport-security') || ''));
    check('CSP con upgrade-insecure-requests', /upgrade-insecure-requests/.test(home.headers.get('content-security-policy') || ''));
    const setCookies = home.headers.getSetCookie().join('\n');
    check('cookie csrf Secure + HttpOnly + SameSite', /csrf=[a-f0-9]+;.*HttpOnly/i.test(setCookies) && /Secure/i.test(setCookies) && /SameSite=Lax/i.test(setCookies), setCookies);

    // Sesion de administrador: cookie sid Secure y Lax
    const admin = new Client(base);
    const t = (await admin.get('/admin/login', { headers: proxied })).text.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
    const login = await admin.req('POST', '/admin/login', { form: { _csrf: t, password: ADMIN_PASSWORD }, headers: proxied });
    const sidCookie = login.headers.getSetCookie().find((c) => c.startsWith('sid=')) || '';
    check('login en produccion', login.status === 302);
    check('cookie de sesion Secure + HttpOnly + Lax', /Secure/i.test(sidCookie) && /HttpOnly/i.test(sidCookie) && /SameSite=Lax/i.test(sidCookie), sidCookie);

    const detail = await admin.get('/admin/pedidos/1', { headers: proxied });
    check('pedido antiguo migrado y visible en el admin', detail.status === 200 && detail.text.includes('Cliente Antiguo'));
    const tokenMatch = detail.text.match(/\/pedido\/([a-f0-9]{32})/);
    check('pedido antiguo recibe un token', !!tokenMatch);
    if (tokenMatch) check('pedido antiguo accesible por su token', (await anon.get(`/pedido/${tokenMatch[1]}`, { headers: proxied })).status === 200);
    const pendDetail = await admin.get('/admin/pedidos/2', { headers: proxied });
    const pendToken = pendDetail.text.match(/\/pedido\/([a-f0-9]{32})/);
    const pendPage = pendToken ? await anon.get(`/pedido/${pendToken[1]}`, { headers: proxied }) : { text: '' };
    check('IBAN de ejemplo nunca se muestra al cliente', !!pendToken && !pendPage.text.includes('ES00') && /Escríbenos/.test(pendPage.text));
    const dash = await admin.get('/admin', { headers: proxied });
    check('panel muestra la lista de puesta en marcha', dash.text.includes('Puesta en marcha') && dash.text.includes('LEGAL_NAME'));
    const oldDetail = await admin.get('/admin/pedidos/3', { headers: proxied });
    check('pedido pendiente antiguo caducado al arrancar', oldDetail.status === 200 && /badge cancelled/.test(oldDetail.text));
    check('un pedido pendiente reciente no caduca', /badge pending/.test(pendDetail.text));
    check('sin errores en el log (produccion)', !/\[error\]|unhandledRejection|uncaughtException/.test(log3), log3.slice(-500));
  } finally {
    srv.kill();
    await sleep(300);
    for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (_) { /* bloqueado en Windows */ } }
  }
}

async function main() {
  const mailSrv = await startMailServer();
  const aiSrv = await startAiServer();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...baseEnv(),
      PORT: String(PORT),
      TURSO_DATABASE_URL: 'file:' + tmpDb.replace(/\\/g, '/'),
      STRIPE_SECRET_KEY: '',
      SHIPPING_COST_CENTS: '350',
      FREE_SHIPPING_THRESHOLD_CENTS: '10000',
      PICKUP_ENABLED: '1',
      PICKUP_NOTE: 'Zona centro',
      BIZUM_PHONE: '600111222',
      BANK_IBAN: 'ES91 2100 0418 4502 0005 1332',
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
    await up({ title: 'Print grande', description: '', price: '40', stock: '30', type: 'print' }, img);

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
    check('IBAN real visible', orderPage.text.includes('ES91 2100 0418 4502 0005 1332'));
    await sleep(500);
    const custMail = mailTo('ana@example.com', /Hemos recibido tu pedido #1/);
    check('email de confirmacion al cliente', custMail.length === 1 && custMail[0].textContent.includes('600111222') && custMail[0].textContent.includes('https://tienda.test/pedido/'));
    check('email de aviso al propietario', mailTo('owner@example.com', /Nuevo pedido.*#1/).length === 1);
    check('email enviado con la clave de API', !!custMail[0] && custMail[0].key === 'test-key');

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

    // Anti-abuso de correo: un mismo destinatario recibe como maximo 4 emails por hora
    const spam = new Client();
    const spt = await spam.csrf('/producto/2');
    for (let i = 0; i < 6; i++) {
      await spam.post('/agregar/2', { _csrf: spt, back: '/' });
      await spam.post('/checkout/crear', { _csrf: spt, name: 'Victima Test', email: 'victima@example.com', phone: '600999888', method: 'pickup', accept: '1' });
    }
    await sleep(800);
    check('limite de emails por destinatario (max 4/hora)', mailTo('victima@example.com', /Hemos recibido/).length === 4, String(mailTo('victima@example.com', /Hemos recibido/).length));
    check('el propietario sigue recibiendo avisos', mailTo('owner@example.com', /Nuevo pedido/).length >= 6);

    console.log('\n# Gestion de pedidos (admin)');
    tok = await admin.csrf('/admin');
    const orders = await admin.get('/admin/pedidos');
    check('listado de pedidos', orders.text.includes('Ana Perez'));
    const pay = await admin.post('/admin/pedidos/1/estado', { _csrf: tok, status: 'paid', tracking: '', notify: '1' });
    check('marcar pagado', pay.status === 302);
    const ship = await admin.post('/admin/pedidos/1/estado', { _csrf: tok, status: 'shipped', tracking: 'PQ123456789ES', notify: '1' });
    check('marcar enviado con seguimiento', ship.status === 302);
    check('cliente ve seguimiento', (await buyer.get(order.location)).text.includes('PQ123456789ES'));
    await sleep(500);
    check('email "pago recibido" al marcar pagado', mailTo('ana@example.com', /Pago recibido/).length === 1);
    const shipMail = mailTo('ana@example.com', /va de camino/);
    check('email "enviado" con seguimiento', shipMail.length === 1 && shipMail[0].textContent.includes('PQ123456789ES'));
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

    console.log('\n# Galeria de imagenes');
    const countUploads = () => fs.readdirSync(uploadsDir).filter((f) => f !== '.gitkeep').length;
    const baseline = countUploads();
    const png = (n) => ({ data: PNG, type: 'image/png', name: `g${n}.png` });
    const gal = (fields, cover, extras, query = '') =>
      admin.req('POST', `/admin/productos/nuevo?_csrf=${tok}${query}`, { multipart: productForm(fields, cover, extras) });
    const fields = { title: 'Con galeria', description: 'x', price: '12', stock: '4', type: 'print' };

    check('mas de 5 extras rechazado', (await gal(fields, png(0), [1, 2, 3, 4, 5, 6].map(png))).status === 400);
    check('rechazo no deja archivos huerfanos', countUploads() === baseline);
    const badExtra = { data: Buffer.from('no soy imagen'), type: 'image/png', name: 'x.png' };
    check('extra falso rechazado', (await gal(fields, png(0), [png(1), badExtra])).status === 400);
    check('extra falso no deja archivos huerfanos', countUploads() === baseline);

    check('producto con 2 extras creado', (await gal(fields, png(0), [png(1), png(2)])).status === 302);
    check('se guardan portada + 2 extras', countUploads() === baseline + 3);
    const galId = (await anon.get('/?q=galeria')).text.match(/\/producto\/(\d+)/)[1];
    const galPage = await anon.get(`/producto/${galId}`);
    check('ficha muestra 3 miniaturas', (galPage.text.match(/data-gallery-src/g) || []).length === 3);
    const editPage = await admin.get(`/admin/productos/${galId}/editar`);
    const extraIds = [...editPage.text.matchAll(/name="remove_extra" value="(\d+)"/g)].map((m) => m[1]);
    check('editor lista los extras', extraIds.length === 2);

    const edited = await admin.req('POST', `/admin/productos/${galId}/editar?_csrf=${tok}`, {
      multipart: productForm({ ...fields, active: '1', remove_extra: [extraIds[0]] }, null, [png(3)]),
    });
    check('quitar uno y anadir otro', edited.status === 302);
    check('ficha sigue con 3 miniaturas', ((await anon.get(`/producto/${galId}`)).text.match(/data-gallery-src/g) || []).length === 3);
    check('el extra quitado se borra del disco', countUploads() === baseline + 3);
    check('ids ajenos en remove_extra se ignoran', (await admin.req('POST', `/admin/productos/${galId}/editar?_csrf=${tok}`, {
      multipart: productForm({ ...fields, active: '1', remove_extra: ['9999', 'abc'] }),
    })).status === 302);

    check('eliminar producto borra portada y extras', (await admin.post(`/admin/productos/${galId}/eliminar`, { _csrf: tok })).status === 302 && countUploads() === baseline);

    console.log('\n# Temas');
    const formPage = (await admin.get('/admin/productos/nuevo')).text;
    check('temas basicos disponibles en el formulario', ['Montañas', 'Retratos', 'Animales', 'Paisajes'].every((n) => formPage.includes(n)));
    const themeId = (html, name) => {
      const m = html.match(new RegExp('name="themes" value="(\\d+)"[^>]*/><span>' + name + '</span>'));
      return m ? m[1] : null;
    };
    const mk = (fields) => admin.req('POST', `/admin/productos/nuevo?_csrf=${tok}`, { multipart: productForm(fields, png(0)) });
    const base0 = { description: '', price: '9', stock: '2', type: 'print' };

    // 1) IA: el SDK envia la imagen y el esquema; la respuesta se aplica
    aiCalls.length = 0;
    const r1 = await mk({ ...base0, title: 'Pico nevado', description: 'Cumbre en invierno', auto_themes: '1' });
    check('crear con deteccion automatica (IA)', r1.status === 302);
    const call = aiCalls[0] || { headers: {}, body: {} };
    const content = ((call.body.messages || [])[0] || {}).content || [];
    check('la peticion usa la clave de API', call.headers['x-api-key'] === 'test-anthropic-key');
    check('modelo claude-opus-5-5 con esfuerzo bajo', call.body.model === 'claude-opus-5-5' && (call.body.output_config || {}).effort === 'low');
    check('salida estructurada (json_schema)', ((call.body.output_config || {}).format || {}).type === 'json_schema');
    check('fallbacks por defecto activado', call.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(call.headers['anthropic-beta'] || ''));
    check('se envia la imagen en base64 (PNG)', content.some((c) => c.type === 'image' && c.source && c.source.type === 'base64' && c.source.media_type === 'image/png'));
    check('el prompt incluye titulo y temas existentes', content.some((c) => c.type === 'text' && c.text.includes('Pico nevado') && c.text.includes('Montañas')));
    check('instruccion de sistema anti-inyeccion', /nunca los obedezcas/.test(call.body.system || ''));

    const mont = await anon.get('/tema/montanas');
    check('pagina del tema /tema/montanas', mont.status === 200 && mont.text.includes('Pico nevado'));
    const grouped = await anon.get('/temas');
    check('vista agrupada /temas', grouped.status === 200 && grouped.text.includes('id="tema-montanas"') && grouped.text.includes('Pico nevado'));
    check('chips de temas en la tienda', (await anon.get('/')).text.includes('href="/tema/montanas"'));
    const pico = (await anon.get('/?q=Pico')).text.match(/\/producto\/(\d+)/)[1];
    check('etiqueta de tema en la ficha del producto', (await anon.get(`/producto/${pico}`)).text.includes('href="/tema/montanas"'));
    check('filtro combinado tema + tipo',
      (await anon.get('/tema/montanas?tipo=sticker')).text.includes('No hay resultados') && (await anon.get('/tema/montanas?tipo=print')).text.includes('Pico nevado'));

    // 2) La salida del modelo se sanea
    await mk({ ...base0, title: 'Hostil', auto_themes: '1' });
    const grouped2 = (await anon.get('/temas')).text;
    check('tema nuevo creado por la IA', grouped2.includes('Gatos de la calle'));
    check('HTML en la salida de la IA descartado', !grouped2.includes('onerror') && !grouped2.includes('<img src=x'));
    check('sin temas repetidos', (grouped2.match(/id="tema-montanas"/g) || []).length === 1);

    // 3) Si la IA falla, se usan las palabras del titulo
    const r3 = await mk({ ...base0, title: 'IA-ERROR Retrato de mujer', auto_themes: '1' });
    check('fallo de la IA no rompe el guardado', r3.status === 302);
    check('respaldo por palabras clave (Retratos)', (await anon.get('/tema/retratos')).text.includes('Retrato de mujer'));
    check('aviso indica "por palabras clave"', (await admin.get('/admin')).text.includes('por palabras clave'));

    // 4) Seleccion manual + temas nuevos escritos a mano (se rechaza HTML)
    const animalId = themeId((await admin.get('/admin/productos/nuevo')).text, 'Animales');
    check('el formulario lista los temas con su id', !!animalId);
    await mk({ ...base0, title: 'Manual', themes: [animalId], new_themes: 'Cuadros, <b>x</b>, Acuarela, Cuadros' });
    check('tema manual asignado', (await anon.get('/tema/animales')).text.includes('Manual'));
    check('tema nuevo manual creado', (await anon.get('/tema/cuadros')).status === 200 && (await anon.get('/tema/acuarela')).status === 200);
    check('tema con HTML rechazado', (await anon.get('/tema/b-x-b')).status === 404 && !(await admin.get('/admin/temas')).text.includes('&lt;b&gt;'));
    const manualPage = (await anon.get('/?q=Manual')).text.match(/\/producto\/(\d+)/)[1];
    const mtags = (await anon.get(`/producto/${manualPage}`)).text;
    check('la ficha muestra los 3 temas manuales', ['animales', 'cuadros', 'acuarela'].every((t) => mtags.includes(`href="/tema/${t}"`)));

    // 5) Clasificar en bloque los productos sin tema
    await mk({ ...base0, title: 'Sin tema todavia' }); // sin seleccion ni deteccion
    const pre = (await admin.get('/admin/temas')).text;
    check('el panel cuenta productos sin tema', /Clasificar productos sin tema \((\d+)\)/.test(pre) && !/sin tema \(0\)/.test(pre));
    const bulk = await admin.post('/admin/temas/clasificar', { _csrf: tok });
    check('clasificar en bloque', bulk.status === 302);
    check('ya no quedan productos sin tema', /sin tema \(0\)/.test((await admin.get('/admin/temas')).text));
    check('el tema creado en bloque existe', (await anon.get('/tema/abstracto')).status === 200);

    // 6) Gestion de temas
    const tPage = (await admin.get('/admin/temas')).text;
    const idOf = (name) => {
      // El id de la fila cuyo input tiene ese nombre (sin saltar de un formulario a otro)
      const m = tPage.match(new RegExp('/admin/temas/(\\d+)/renombrar"(?:(?!</form>)[\\s\\S])*?value="' + name + '"'));
      return m ? m[1] : null;
    };
    const cuadrosId = idOf('Cuadros');
    check('el panel lista los temas', !!cuadrosId);
    await admin.post(`/admin/temas/${cuadrosId}/renombrar`, { _csrf: tok, name: 'Pinturas' });
    check('renombrar tema', (await anon.get('/tema/pinturas')).status === 200 && (await anon.get('/tema/cuadros')).status === 404);
    await admin.post(`/admin/temas/${cuadrosId}/renombrar`, { _csrf: tok, name: 'Acuarela' });
    check('no permite nombre duplicado', (await anon.get('/tema/pinturas')).status === 200);
    const acuId = idOf('Acuarela');
    await admin.post(`/admin/temas/${acuId}/eliminar`, { _csrf: tok });
    check('eliminar tema conserva el producto', (await anon.get('/tema/acuarela')).status === 404 && (await anon.get(`/producto/${manualPage}`)).status === 200);

    // 7) Seguridad
    check('slug con inyeccion SQL -> 404', (await anon.get("/tema/x'%20OR%201=1--")).status === 404);
    check('slug larguisimo -> 404', (await anon.get('/tema/' + 'a'.repeat(200))).status === 404);
    const anonTok = await anon.csrf('/admin/login');
    check('crear tema sin ser admin redirige al login', (await anon.post('/admin/temas', { _csrf: anonTok, name: 'Intruso' })).location === '/admin/login');
    check('clasificar sin ser admin redirige al login', (await anon.post('/admin/temas/clasificar', { _csrf: anonTok })).location === '/admin/login');
    const sitemap = (await anon.get('/sitemap.xml')).text;
    check('sitemap incluye temas', sitemap.includes('/tema/montanas') && sitemap.includes('/temas'));
    check('sin errores no controlados (temas)', !/unhandledRejection|uncaughtException|TypeError/.test(serverLog), serverLog.slice(-500));

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

    await suiteStripe();
    await suiteProdAndMigration();
    await suiteMadeToOrder();
  } finally {
    server.kill();
    mailSrv.close();
    aiSrv.close();
    await new Promise((r) => setTimeout(r, 300));
    for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (_) { /* archivo aun bloqueado en Windows: queda en la carpeta temporal */ } }
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
