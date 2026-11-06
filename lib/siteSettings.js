// Ajustes editables desde el panel y guardados en la base de datos: texto de "Sobre mí", obra de portada y logo.
// Se mantienen en memoria para no consultar la base en cada visita (la web corre en una sola instancia).
const db = require('../db');

let about = '';
let featuredId = 0;
let logo = { light: '', dark: '' };

const save = (key, value) => db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);

async function load() {
  const rows = await db.all("SELECT key, value FROM settings WHERE key IN ('about_text', 'featured_product', 'logo_light', 'logo_dark')");
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  about = v.about_text ? String(v.about_text) : '';
  featuredId = /^\d{1,9}$/.test(String(v.featured_product || '')) ? Number(v.featured_product) : 0;
  logo = { light: String(v.logo_light || ''), dark: String(v.logo_dark || '') };
}

const getAbout = () => about;
async function setAbout(value) {
  await save('about_text', value);
  about = value;
}

// Obra que se muestra grande en la portada (0 = ninguna elegida: se usa la ultima añadida)
const getFeaturedId = () => featuredId;
async function setFeaturedId(id) {
  featuredId = Number.isInteger(id) && id > 0 ? id : 0;
  await save('featured_product', String(featuredId));
}

// Logo de la cabecera: version para fondo claro y (opcional) para fondo oscuro. Cadena vacia = sin logo propio.
const getLogo = () => logo;
async function setLogo(next) {
  logo = { light: next.light || '', dark: next.dark || '' };
  await save('logo_light', logo.light);
  await save('logo_dark', logo.dark);
}

module.exports = { load, getAbout, setAbout, getFeaturedId, setFeaturedId, getLogo, setLogo };
