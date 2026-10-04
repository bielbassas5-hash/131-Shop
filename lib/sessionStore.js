const session = require('express-session');
const db = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;

function expiryOf(sess) {
  const exp = sess && sess.cookie && sess.cookie.expires;
  const ts = exp ? new Date(exp).getTime() : NaN;
  return Number.isFinite(ts) ? ts : Date.now() + 7 * DAY_MS;
}

// Sesiones guardadas en la misma base de datos (Turso en produccion), de modo que
// sobreviven a los reinicios del servidor gratuito.
class DbStore extends session.Store {
  constructor() {
    super();
    const timer = setInterval(() => {
      db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()]).catch(() => {});
    }, 60 * 60 * 1000);
    timer.unref();
  }

  get(sid, cb) {
    db.get('SELECT data, expires FROM sessions WHERE sid = ?', [sid])
      .then((row) => {
        if (!row || Number(row.expires) < Date.now()) return cb(null, null);
        cb(null, JSON.parse(row.data));
      })
      .catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    db.run(
      `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
      [sid, JSON.stringify(sess), expiryOf(sess)]
    )
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [expiryOf(sess), sid])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    db.run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb && cb(null))
      .catch((err) => cb && cb(err));
  }
}

module.exports = DbStore;
