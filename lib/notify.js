const db = require('../db');
const { send, esc } = require('./mailer');
const { euro } = require('./format');

const cleanBase = (b) => String(b || process.env.SITE_URL || '').replace(/\/+$/, '');

async function load(orderId, baseHint) {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) return null;
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  let shipTo = {};
  try {
    shipTo = JSON.parse(order.shipping_address || '{}');
  } catch (_) {
    /* sin datos */
  }
  const base = cleanBase(baseHint);
  return { order, items, shipTo, link: `${base}/pedido/${order.token}`, adminLink: `${base}/admin/pedidos/${order.id}` };
}

function itemsHtml(items) {
  return `<table style="border-collapse:collapse;width:100%">${items
    .map(
      (i) =>
        `<tr><td style="padding:4px 0">${esc(i.title)} &times; ${i.quantity}</td><td style="text-align:right">${esc(euro(i.price_cents * i.quantity))}</td></tr>`
    )
    .join('')}</table>`;
}

const itemsText = (items) => items.map((i) => `- ${i.title} x${i.quantity}: ${euro(i.price_cents * i.quantity)}`).join('\n');

function wrapHtml(body) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:auto;color:#111;line-height:1.5">${body}<p style="color:#666;font-size:12px;margin-top:28px">131 · Arte hecho a mano</p></div>`;
}

// Pedido recibido (pago manual): instrucciones de pago incluidas. Tambien avisa al propietario.
async function orderCreated(orderId, { manualPayment, base }) {
  const d = await load(orderId, base);
  if (!d) return;
  const { order, items, shipTo, link, adminLink } = d;
  const pay = manualPayment
    ? [process.env.BIZUM_PHONE && `Bizum: ${process.env.BIZUM_PHONE}`, process.env.BANK_IBAN && `Transferencia: ${process.env.BANK_IBAN}`]
        .filter(Boolean)
        .join('\n') + `\nConcepto: Pedido #${order.id}\nImporte: ${euro(order.total_cents)}`
    : '';

  await send({
    to: order.customer_email,
    subject: `Hemos recibido tu pedido #${order.id}`,
    text: `Hola ${shipTo.name || ''},\n\nGracias por tu pedido #${order.id}.\n\n${itemsText(items)}\n\nTotal: ${euro(order.total_cents)}\n\n${
      pay ? `Para completar el pago:\n${pay}\n\n` : ''
    }Sigue el estado de tu pedido aquí: ${link}\n\n131`,
    html: wrapHtml(
      `<h2>Gracias por tu pedido #${order.id}</h2>${itemsHtml(items)}<p><b>Total: ${esc(euro(order.total_cents))}</b></p>${
        pay ? `<p><b>Para completar el pago</b> (indica &laquo;Pedido #${order.id}&raquo; en el concepto):</p><pre style="background:#f4f4f4;padding:12px;border-radius:8px">${esc(pay)}</pre>` : ''
      }<p><a href="${esc(link)}">Ver el estado de mi pedido</a></p>`
    ),
  });

  await ownerAlert(d, manualPayment ? 'Nuevo pedido (pendiente de pago)' : 'Nuevo pedido');
}

async function ownerAlert(d, title) {
  const owner = process.env.OWNER_EMAIL;
  if (!owner) return;
  const { order, items, shipTo, adminLink } = d;
  const where = order.shipping_method === 'pickup' ? 'Recogida en mano' : `${shipTo.address || ''}, ${shipTo.postal_code || ''} ${shipTo.city || ''}`;
  await send({
    to: owner,
    subject: `${title} #${order.id} - ${euro(order.total_cents)}`,
    text: `${title} #${order.id}\n\nCliente: ${shipTo.name} <${order.customer_email}> ${shipTo.phone || ''}\nEntrega: ${where}\n${shipTo.notes ? `Notas: ${shipTo.notes}\n` : ''}\n${itemsText(items)}\n\nTotal: ${euro(order.total_cents)}\n\nGestionar: ${adminLink}`,
    html: wrapHtml(
      `<h2>${esc(title)} #${order.id}</h2><p><b>${esc(shipTo.name)}</b> &lt;${esc(order.customer_email)}&gt; ${esc(shipTo.phone || '')}<br>${esc(where)}</p>${
        shipTo.notes ? `<p><i>${esc(shipTo.notes)}</i></p>` : ''
      }${itemsHtml(items)}<p><b>Total: ${esc(euro(order.total_cents))}</b></p><p><a href="${esc(adminLink)}">Gestionar pedido</a></p>`
    ),
  });
}

async function paid(orderId, base) {
  const d = await load(orderId, base);
  if (!d) return;
  const { order, shipTo, link } = d;
  await send({
    to: order.customer_email,
    subject: `Pago recibido - pedido #${order.id}`,
    text: `Hola ${shipTo.name || ''},\n\nHemos recibido el pago de tu pedido #${order.id}. Lo estamos preparando.\n\nEstado del pedido: ${link}\n\n131`,
    html: wrapHtml(`<h2>Pago recibido</h2><p>Hemos recibido el pago de tu pedido <b>#${order.id}</b>. Lo estamos preparando.</p><p><a href="${esc(link)}">Ver el estado de mi pedido</a></p>`),
  });
}

async function shipped(orderId, base) {
  const d = await load(orderId, base);
  if (!d) return;
  const { order, shipTo, link } = d;
  const track = order.tracking_number ? `Número de seguimiento: ${order.tracking_number}\n` : '';
  await send({
    to: order.customer_email,
    subject: `Tu pedido #${order.id} va de camino`,
    text: `Hola ${shipTo.name || ''},\n\nTu pedido #${order.id} ya está en camino.\n${track}\nEstado del pedido: ${link}\n\n¡Gracias por tu compra!\n131`,
    html: wrapHtml(
      `<h2>Tu pedido va de camino</h2><p>El pedido <b>#${order.id}</b> ya está en camino.</p>${
        order.tracking_number ? `<p>Número de seguimiento: <b>${esc(order.tracking_number)}</b></p>` : ''
      }<p><a href="${esc(link)}">Ver el estado de mi pedido</a></p>`
    ),
  });
}

// Dispara sin esperar: nunca retrasa ni rompe la respuesta al usuario.
const fire = (promise) => promise.catch((err) => console.error('Notificacion fallida:', err.message));

module.exports = {
  orderCreated: (id, opts) => fire(orderCreated(id, opts)),
  paid: (id, base) => fire(paid(id, base)),
  shipped: (id, base) => fire(shipped(id, base)),
  ownerPaid: (id, base) => fire(load(id, base).then((d) => d && ownerAlert(d, 'Pago confirmado'))),
};
