const { TYPES } = require('./format');
const { pickupEnabled } = require('./orders');

const COUNTRY_NAMES = {
  ES: 'España',
  PT: 'Portugal',
  FR: 'Francia',
  DE: 'Alemania',
  IT: 'Italia',
  AD: 'Andorra',
  NL: 'Países Bajos',
  BE: 'Bélgica',
};

function allowedCountries() {
  const list = (process.env.SHIPPING_COUNTRIES || 'ES')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => COUNTRY_NAMES[c]);
  return list.length ? list : ['ES'];
}

// Texto de una linea: recorta, quita caracteres de control y limita longitud.
function text(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// Texto multilinea (descripciones): conserva saltos de linea.
function multiline(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

function validateCheckout(body) {
  const countries = allowedCountries();
  const method = body.method === 'pickup' && pickupEnabled() ? 'pickup' : 'ship';
  const values = {
    method,
    notes: multiline(body.notes, 300),
    name: text(body.name, 80),
    email: text(body.email, 120).toLowerCase(),
    phone: text(body.phone, 20),
    address: text(body.address, 120),
    city: text(body.city, 60),
    postal_code: text(body.postal_code, 10).toUpperCase(),
    country: text(body.country, 2).toUpperCase() || countries[0],
  };
  const errors = {};

  if (values.name.length < 2) errors.name = 'Escribe tu nombre completo.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email)) errors.email = 'Escribe un email válido.';
  if (values.phone && !/^[0-9+() .-]{6,20}$/.test(values.phone)) errors.phone = 'Teléfono no válido.';
  if (method === 'ship') {
    if (values.address.length < 5) errors.address = 'Escribe tu dirección completa.';
    if (values.city.length < 2) errors.city = 'Escribe tu ciudad.';
    if (!countries.includes(values.country)) {
      errors.country = 'País no disponible.';
    } else if (values.country === 'ES' ? !/^\d{5}$/.test(values.postal_code) : !/^[A-Z0-9][A-Z0-9 -]{2,9}$/.test(values.postal_code)) {
      errors.postal_code = 'Código postal no válido.';
    }
  } else if (!values.phone) {
    errors.phone = 'Indica un teléfono para coordinar la recogida.';
  }
  if (body.accept !== '1') errors.accept = 'Debes aceptar las condiciones de compra.';

  return { values, errors, ok: Object.keys(errors).length === 0 };
}

function validateProduct(body) {
  const priceStr = text(body.price, 12).replace(',', '.');
  const price = Number(priceStr);
  const stock = Number(text(body.stock, 6));
  const values = {
    title: text(body.title, 80),
    description: multiline(body.description, 1500),
    price: priceStr,
    stock: text(body.stock, 6),
    type: TYPES.includes(body.type) ? body.type : 'sticker',
  };
  const errors = {};

  if (values.title.length < 2) errors.title = 'El título es obligatorio (mínimo 2 caracteres).';
  if (!/^\d+(\.\d{1,2})?$/.test(priceStr) || price <= 0 || price > 10000) {
    errors.price = 'Precio no válido (entre 0,01 y 10000).';
  }
  if (!Number.isInteger(stock) || stock < 0 || stock > 9999) errors.stock = 'Stock no válido (0-9999).';

  return {
    values,
    errors,
    ok: Object.keys(errors).length === 0,
    price_cents: Math.round(price * 100),
    stock,
  };
}

module.exports = { text, multiline, validateCheckout, validateProduct, allowedCountries, COUNTRY_NAMES };
