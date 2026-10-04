// Envio de emails por API HTTP (Brevo). Render gratis bloquea el SMTP saliente,
// asi que no se usa SMTP. Todo es opcional: sin BREVO_API_KEY y MAIL_FROM no hace nada.
const API_URL = () => process.env.MAIL_API_URL || 'https://api.brevo.com/v3/smtp/email';

const configured = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Nunca lanza ni bloquea la peticion: un fallo de email no debe romper un pedido.
async function send({ to, subject, text, html, replyTo }) {
  if (!configured() || !to) return false;
  try {
    const payload = {
      sender: { name: process.env.MAIL_FROM_NAME || '131', email: process.env.MAIL_FROM },
      to: [{ email: to }],
      subject: String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200),
      textContent: text,
      htmlContent: html,
    };
    if (replyTo) payload.replyTo = { email: replyTo };
    const res = await fetch(API_URL(), {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('Email rechazado por el proveedor:', res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Email no enviado:', err.message);
    return false;
  }
}

module.exports = { send, configured, esc };
