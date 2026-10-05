// Preguntas frecuentes: las respuestas se construyen con la configuracion real de la tienda,
// asi nunca prometen un plazo, un coste o un medio de pago que no existan.
const { euro } = require('./format');
const { allowedCountries, COUNTRY_NAMES } = require('./validate');
const { paymentInfo, trackStock, pickupEnabled } = require('./orders');
const { stripeConfigured } = require('./payments');

function buildFaq(shop) {
  const countries = allowedCountries().map((c) => COUNTRY_NAMES[c]).join(', ');
  const pay = paymentInfo();
  const methods = [];
  if (pay.bizum) methods.push('Bizum');
  if (pay.iban) methods.push('transferencia bancaria');
  if (stripeConfigured) methods.push('tarjeta');
  const contact = shop.contactEmail ? ` escribiéndonos a ${shop.contactEmail}` : ' desde la página de contacto';

  const items = [];
  items.push({
    q: '¿Cuánto tarda en llegar mi pedido?',
    a: trackStock()
      ? 'Preparamos el pedido en cuanto confirmamos el pago y lo enviamos. El tiempo de entrega depende del transportista.'
      : `Cada pieza se elabora bajo pedido${shop.leadTime ? `, con un plazo de elaboración de ${shop.leadTime}` : ''}. Cuando está lista se envía y te avisamos con el número de seguimiento si lo hay. El tiempo de entrega depende después del transportista.`,
  });
  items.push({
    q: '¿Cuánto cuesta el envío y a dónde enviáis?',
    a: `El envío cuesta ${euro(shop.shippingCents)} por pedido${shop.freeFrom ? ` y es gratis a partir de ${euro(shop.freeFrom)}` : ''}. Enviamos a: ${countries}.`,
  });
  items.push({
    q: '¿Qué formas de pago aceptáis?',
    a: methods.length
      ? `Puedes pagar por ${methods.join(', ')}. ${stripeConfigured ? '' : 'Al confirmar el pedido verás los datos para pagar y el número de pedido que debes indicar en el concepto. '}Prepararemos tu pedido cuando confirmemos el pago.`
      : 'Al confirmar el pedido te explicamos cómo pagar.',
  });
  items.push({
    q: '¿Cómo sigo mi pedido?',
    a: 'Cada pedido tiene su propia página con el estado y el historial. Te enviamos el enlace por email y también puedes recuperarlo en "Consultar mi pedido" con el número de pedido y tu email.',
  });
  items.push({
    q: '¿Por qué no todas las obras están en todos los formatos?',
    a: 'Cada obra se ofrece solo en los formatos en los que su resolución permite una impresión de buena calidad. Si una pieza no tiene un formato grande es para que el resultado se vea bien.',
  });
  if (pickupEnabled()) {
    items.push({
      q: '¿Puedo recoger el pedido en mano?',
      a: `Sí, al hacer el pedido puedes elegir "Recogida en mano" (gratis)${shop.pickupNote ? `: ${shop.pickupNote}` : ''}. Nos pondremos en contacto contigo para quedar.`,
    });
  }
  items.push({
    q: '¿Puedo añadir una dedicatoria o una indicación al pedido?',
    a: 'Sí, en el formulario del pedido hay un campo de notas donde puedes escribir una dedicatoria o cualquier indicación.',
  });
  items.push({
    q: '¿Qué hago si el pedido llega dañado o con un error?',
    a: 'Escríbenos con una foto en las 48 horas siguientes a la recepción y lo resolvemos.',
    link: { href: '/legal/condiciones', text: 'Ver condiciones de compra' },
  });
  items.push({
    q: '¿Cómo puedo contactar?',
    a: `Puedes hacerlo${contact}.`,
    link: { href: '/contacto', text: 'Ir a contacto' },
  });
  return items;
}

module.exports = { buildFaq };
