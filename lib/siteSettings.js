// Ajustes editables desde el panel y guardados en la base de datos (texto de "Sobre mí").
// Se mantienen en memoria para que el pie de pagina sepa si debe enlazar la pagina sin consultar la base en cada visita.
const db = require('../db');

let about = '';

async function load() {
  const row = await db.get("SELECT value FROM settings WHERE key = 'about_text'");
  about = row && row.value ? String(row.value) : '';
}

const getAbout = () => about;

async function setAbout(value) {
  await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('about_text', ?)", [value]);
  about = value;
}

module.exports = { load, getAbout, setAbout };
