const path = require('path');
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'data', 'store.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const client = createClient({ url, authToken });

function wrap(exec) {
  return {
    async get(sql, args = []) {
      const res = await exec({ sql, args });
      return res.rows[0];
    },
    async all(sql, args = []) {
      const res = await exec({ sql, args });
      return res.rows;
    },
    async run(sql, args = []) {
      const res = await exec({ sql, args });
      return {
        lastInsertRowid: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : null,
        changes: Number(res.rowsAffected),
      };
    },
  };
}

const base = wrap((stmt) => client.execute(stmt));

// Ejecuta fn dentro de una transaccion de escritura; si lanza, se revierte todo.
async function transaction(fn) {
  const tx = await client.transaction('write');
  try {
    const out = await fn(wrap((stmt) => tx.execute(stmt)));
    await tx.commit();
    return out;
  } catch (err) {
    try {
      await tx.rollback();
    } catch (_) {
      /* ya revertida */
    }
    throw err;
  } finally {
    tx.close();
  }
}

async function ensureColumn(table, column, ddl) {
  const cols = await base.all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

async function migrate() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL,
      image_path TEXT,
      type TEXT NOT NULL DEFAULT 'sticker',
      stock INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT,
      stripe_session_id TEXT UNIQUE,
      customer_email TEXT,
      customer_name TEXT,
      shipping_address TEXT,
      total_cents INTEGER NOT NULL DEFAULT 0,
      shipping_cents INTEGER NOT NULL DEFAULT 0,
      shipping_method TEXT NOT NULL DEFAULT 'ship',
      status TEXT NOT NULL DEFAULT 'pending',
      tracking_number TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS themes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_themes (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
      PRIMARY KEY (product_id, theme_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);

  // Bases de datos creadas con versiones anteriores
  await ensureColumn('orders', 'token', 'TEXT');
  await ensureColumn('orders', 'shipping_cents', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('orders', 'tracking_number', 'TEXT');
  await ensureColumn('orders', 'shipping_method', "TEXT NOT NULL DEFAULT 'ship'");
  await client.execute(
    "UPDATE orders SET token = lower(hex(randomblob(16))) WHERE token IS NULL OR token = ''"
  );

  // Pedidos anteriores al historial: un evento inicial con su estado actual
  await client.execute(
    `INSERT INTO order_events (order_id, status, created_at)
     SELECT id, status, created_at FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id)`
  );

  await client.executeMultiple(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_token ON orders(token);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id, position);
    CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id, id);
    CREATE INDEX IF NOT EXISTS idx_product_themes_theme ON product_themes(theme_id);
  `);
}

// Temas basicos: se siembran una sola vez (si luego los borras, no vuelven a aparecer).
const DEFAULT_THEMES = [
  'Montañas', 'Retratos', 'Animales', 'Paisajes', 'Flores y plantas', 'Ciudad',
  'Mar', 'Espacio', 'Fantasía', 'Personajes', 'Comida', 'Letras',
];
const slugOf = (name) =>
  String(name)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

async function seedThemes() {
  const done = await base.get("SELECT value FROM settings WHERE key = 'themes_seeded'");
  if (done) return;
  for (const name of DEFAULT_THEMES) {
    await base.run('INSERT OR IGNORE INTO themes (name, slug) VALUES (?, ?)', [name, slugOf(name)]);
  }
  await base.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('themes_seeded', '1')");
}

module.exports = { ...base, migrate: async () => { await migrate(); await seedThemes(); }, transaction, slugOf, DEFAULT_THEMES };
