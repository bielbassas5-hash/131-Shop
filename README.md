# Tienda 131

Tienda online para vender dibujos, prints y stickers hechos a mano. Node.js + Express + EJS, base de datos SQLite/libSQL (Turso en producción) e imágenes en Cloudinary. Pensada para funcionar **gratis** en Render.

## Arrancar en local

```bash
npm install
cp .env.example .env     # y edita los valores
npm run dev              # http://localhost:3001
npm test                 # 128 pruebas automáticas (seguridad, pedidos, pagos, emails...)
```

Sin `TURSO_*` ni `CLOUDINARY_*` usa un archivo SQLite local (`data/store.db`) y guarda las imágenes en `public/uploads`. Para rellenar la tienda local con productos de ejemplo: `node scripts/seed-demo.js` (con el servidor en marcha).

## Qué incluye

**Tienda:** catálogo con filtros, búsqueda y orden · ficha con galería de hasta 6 imágenes · carrito con control de stock · envío fijo o gratis desde un importe · recogida en mano opcional · notas del pedido · seguimiento del pedido por enlace privado · páginas legales (privacidad, condiciones/devoluciones, aviso legal) · SEO (sitemap, Open Graph, datos estructurados).

**Panel (`/admin`):** estadísticas, lista de puesta en marcha, productos (subir, editar, ocultar, borrar), pedidos con filtros, número de seguimiento, exportación CSV y aviso al cliente por email.

**Cobro:** por defecto **Bizum / transferencia** (sin comisiones; confirmas el pago a mano en el panel). Si defines `STRIPE_SECRET_KEY` se cobra con tarjeta vía Stripe Checkout.

## Variables de entorno

Todas se configuran en Render → tu servicio → **Environment**. Las que faltan se ven en la lista "Puesta en marcha" del panel.

| Variable | Para qué |
|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel (usa 12+ caracteres) |
| `SESSION_SECRET` | Clave de sesiones (texto largo aleatorio) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Base de datos en producción |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Imágenes en producción |
| `BIZUM_PHONE`, `BANK_IBAN` | Datos de cobro que ve el cliente (un IBAN de ejemplo `ES00…` nunca se muestra) |
| `SHIPPING_COST_CENTS` | Envío en céntimos (350 = 3,50 €) |
| `FREE_SHIPPING_THRESHOLD_CENTS` | Envío gratis desde este importe (0 = desactivado) |
| `PICKUP_ENABLED`, `PICKUP_NOTE` | Recogida en mano (`1` para activarla) |
| `SHIPPING_COUNTRIES` | Países de envío, p. ej. `ES,PT` |
| `CONTACT_EMAIL`, `INSTAGRAM` | Se muestran en el pie |
| `LEGAL_NAME`, `LEGAL_NIF`, `LEGAL_ADDRESS` | Datos del titular en el aviso legal y la privacidad |
| `SITE_URL` | URL pública (`https://one31-shop.onrender.com`): enlaces de emails, sitemap, SEO |
| `BREVO_API_KEY`, `MAIL_FROM`, `OWNER_EMAIL` | Avisos por email (ver abajo) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Solo si cobras con tarjeta |
| `PENDING_EXPIRY_DAYS` | Días que se reserva el stock de un pedido sin pagar (5) |

### Avisos por email (opcional, gratis)

Render gratis bloquea el SMTP, así que se usa la API HTTP de [Brevo](https://www.brevo.com) (300 emails/día gratis): crea cuenta, verifica un remitente (`MAIL_FROM`), genera una clave API (`BREVO_API_KEY`) y pon tu correo en `OWNER_EMAIL`. Recibirás un email por cada pedido nuevo y el cliente recibirá confirmación, pago recibido y envío.

### Stripe (opcional)

Define `STRIPE_SECRET_KEY` y crea en Stripe un webhook a `https://TU-WEB/webhooks/stripe` con los eventos `checkout.session.completed` y `checkout.session.expired`; su secreto va en `STRIPE_WEBHOOK_SECRET`.

## Seguridad (resumen)

CSRF firmado en todos los formularios · CSP estricta sin scripts en línea, HSTS y resto de cabeceras (helmet) · login con límite de intentos, comparación en tiempo constante y sesión regenerada · cookies `HttpOnly`/`SameSite`/`Secure` · pedidos accesibles solo con enlace privado de 128 bits (sin enumeración) · el servidor recalcula siempre precios, envío y totales · stock reservado de forma atómica al pedir (sin sobreventa) · imágenes validadas por su contenido real · plantillas con escape automático · webhook de Stripe con firma, importe y pedido verificados · límite de emails por destinatario · errores sin trazas hacia el visitante · 0 vulnerabilidades conocidas en dependencias (`npm audit`).

## Despliegue en Render

El repositorio se despliega solo con cada `git push` a `main`. Servicio web Node, comando de arranque `npm start`, plan gratuito. La primera visita tras un rato de inactividad tarda 30-60 s (el plan gratis "duerme" el servicio); los datos están a salvo en Turso y Cloudinary.

## Notas legales

Las páginas legales son plantillas generales, **no asesoramiento jurídico**: revísalas con tu gestoría. Si vendes de forma habitual en España necesitarás alta como autónomo y facturación con IVA.
