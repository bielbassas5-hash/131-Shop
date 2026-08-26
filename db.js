const path = require('path');
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, 'data', 'store.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const client = createClient({ url, authToken });

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
      stripe_session_id TEXT UNIQUE,
      customer_email TEXT,
      customer_name TEXT,
      shipping_address TEXT,
      total_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
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
  `);
}

async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows[0];
}

async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

async function run(sql, args = []) {
  const res = await client.execute({ sql, args });
  return {
    lastInsertRowid: Number(res.lastInsertRowid),
    changes: Number(res.rowsAffected),
  };
}

module.exports = { migrate, get, all, run };
