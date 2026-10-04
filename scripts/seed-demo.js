// Datos de demostracion SOLO para desarrollo local (no se sube a produccion).
// Uso: node seed-demo.js   (con el servidor local en marcha en PORT)
const zlib = require('zlib');
require('dotenv').config();
const BASE = `http://127.0.0.1:${process.env.PORT || 3001}`;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, c1, c2, shape) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let r = c1[0] + (c2[0] - c1[0]) * t, g = c1[1] + (c2[1] - c1[1]) * t, b = c1[2] + (c2[2] - c1[2]) * t;
      const dx = x - size / 2, dy = y - size / 2, d = Math.sqrt(dx * dx + dy * dy);
      if (shape === 'circle' && d < size * 0.28) { r = 250; g = 245; b = 235; }
      if (shape === 'ring' && d < size * 0.3 && d > size * 0.2) { r = 20; g = 20; b = 24; }
      if (shape === 'bars' && Math.floor(x / (size / 8)) % 2 === 0 && y > size * 0.3 && y < size * 0.7) { r *= 0.55; g *= 0.55; b *= 0.55; }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const items = [
  ['Gato astronauta', 'Sticker vinilo resistente al agua, 7 cm.', '3,50', 12, 'sticker', [255, 61, 113], [255, 193, 94], 'circle'],
  ['Noche en la ciudad', 'Dibujo original en tinta y acuarela sobre papel de 300 g. Pieza unica, 21 x 29,7 cm.', '85', 1, 'dibujo', [30, 40, 90], [120, 60, 160], 'bars'],
  ['Ojo de tigre', 'Print A4 impreso en papel fotografico mate.', '18', 6, 'print', [240, 140, 40], [180, 40, 60], 'ring'],
  ['Luna de papel', 'Sticker holografico, 6 cm.', '3,00', 2, 'sticker', [60, 160, 200], [180, 120, 240], 'circle'],
  ['Marea', 'Print A3, edicion de 20 ejemplares firmados.', '28', 0, 'print', [20, 120, 140], [10, 40, 80], 'bars'],
];

(async () => {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const grab = (res) => (res.headers.getSetCookie() || []).forEach((c) => { const [p] = c.split(';'); const i = p.indexOf('='); jar[p.slice(0, i)] = p.slice(i + 1); });
  let res = await fetch(BASE + '/admin/login', { headers: { cookie: cookie() } });
  grab(res);
  const csrfTok = (await res.text()).match(/name="_csrf" value="([a-f0-9]+)"/)[1];
  res = await fetch(BASE + '/admin/login', { method: 'POST', redirect: 'manual', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrfTok, password: process.env.ADMIN_PASSWORD }) });
  grab(res);
  if (res.status !== 302) throw new Error('Login fallido: ' + res.status);
  res = await fetch(BASE + '/admin', { headers: { cookie: cookie() } });
  const tok = (await res.text()).match(/name="_csrf" value="([a-f0-9]+)"/)[1];
  for (const [title, description, price, stock, type, c1, c2, shape] of items) {
    const fd = new FormData();
    Object.entries({ title, description, price, stock: String(stock), type }).forEach(([k, v]) => fd.append(k, v));
    fd.append('image', new Blob([png(500, c1, c2, shape)], { type: 'image/png' }), 'demo.png');
    const r = await fetch(`${BASE}/admin/productos/nuevo?_csrf=${tok}`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie() }, body: fd });
    console.log(title, r.status);
  }
})().catch((e) => { console.error(e); process.exit(1); });
