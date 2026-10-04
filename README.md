# Tienda 131

Tienda online para vender dibujos, prints y stickers hechos a mano. Node.js + Express + EJS, base de datos SQLite/libSQL (Turso en producción) e imágenes en Cloudinary. Pensada para funcionar **gratis** en Render.

## Arrancar en local

```bash
npm install
cp .env.example .env     # y edita los valores
npm run dev              # http://localhost:3001
npm test                 # ~190 pruebas automáticas (seguridad, pedidos, pagos, emails, temas...)
```

Sin `TURSO_*` ni `CLOUDINARY_*` usa un archivo SQLite local (`data/store.db`) y guarda las imágenes en `public/uploads`. Para rellenar la tienda local con productos de ejemplo: `node scripts/seed-demo.js` (con el servidor en marcha).

## Qué incluye

**Tienda:** catálogo con filtros, búsqueda y orden · **temas** (montañas, retratos, animales…) con páginas propias y vista agrupada · ficha con galería de hasta 6 imágenes · producción **bajo demanda** (sin stock) con plazo de elaboración · envío fijo o gratis desde un importe · recogida en mano opcional · notas del pedido · seguimiento del pedido por enlace privado (y recuperable con número + email en `/pedido`) · páginas legales (privacidad, condiciones/devoluciones, aviso legal) · SEO (sitemap, Open Graph, datos estructurados).

**Panel (`/admin`):** estadísticas (las tarjetas llevan a los pedidos), buscador de pedidos, historial de estados con fechas, copia de seguridad en JSON, lista de puesta en marcha, productos (subir, editar, ocultar, borrar), gestión de temas, pedidos con filtros y estados (pendiente → pagado → en producción → enviado), número de seguimiento, exportación CSV y aviso al cliente por email.

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
| `PENDING_EXPIRY_DAYS` | Días tras los que se cancela un pedido sin pagar (5) |
| `LEAD_TIME` | Plazo de elaboración que ven los clientes (p. ej. `5-7 días laborables`) |
| `TRACK_STOCK` | `1` para limitar unidades por producto. Por defecto **desactivado** (bajo demanda) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Detección de temas con IA a partir de la imagen (opcional) |

### Avisos por email (opcional, gratis)

Render gratis bloquea el SMTP, así que se usa la API HTTP de [Brevo](https://www.brevo.com) (300 emails/día gratis): crea cuenta, verifica un remitente (`MAIL_FROM`), genera una clave API (`BREVO_API_KEY`) y pon tu correo en `OWNER_EMAIL`. Recibirás un email por cada pedido nuevo y el cliente recibirá confirmación, pago recibido y envío.

### Temas y clasificación automática

Cada producto puede tener hasta 5 temas. Aparecen como filtros en la tienda, en páginas propias (`/tema/montanas`) y agrupados en `/temas`. Vienen creados los más habituales (Montañas, Retratos, Animales, Paisajes, Flores y plantas, Ciudad, Mar, Espacio, Fantasía, Personajes, Comida, Letras) y puedes crear, renombrar o borrar los que quieras en **Panel → Temas**.

Al subir un producto, si no eliges ningún tema y dejas marcada la casilla, se detectan solos:

- **Con IA** (si defines `ANTHROPIC_API_KEY`): la API de Claude mira la imagen y devuelve 1-3 temas, reutilizando los existentes. Cuesta del orden de 0,01 € por imagen y solo se llama cuando tú guardas un producto o pulsas "Detectar temas"; nunca por visitas de clientes. Si falla, se usa el método gratuito.
- **Gratis**: por palabras del título y la descripción ("gato", "montaña", "retrato"…).

"Clasificar productos sin tema" (Panel → Temas) procesa los pendientes por lotes. La respuesta del modelo se sanea siempre: solo se aceptan nombres de 2-30 letras/números.

### Formatos con precio propio

Un producto puede tener hasta 8 formatos (por ejemplo un print en A4 y en A3), cada uno con su precio. En el formulario del producto se escribe una línea por formato, con el nombre y el precio separados por dos puntos:

```
A4: 18,00
A3: 28,00
A2: 45,00
```

Si se rellenan, el cliente elige formato en la ficha, el listado muestra "Desde 18,00 €" y el carrito y el pedido guardan el formato elegido ("Ojo de tigre · A3") con su precio, que siempre se recalcula en el servidor. Si quitas los formatos, el producto vuelve a su precio normal y los carritos que tuvieran un formato retirado se limpian solos.

### Producción bajo demanda

No hay unidades ni "agotado". El límite es de 10 por línea de pedido. La ficha, el carrito y las condiciones indican que se elabora bajo pedido (y el `LEAD_TIME` si lo defines). El estado **En producción** informa al cliente de que su pedido se está elaborando. Si algún día necesitas stock, `TRACK_STOCK=1` lo reactiva (reserva al pedir, devolución al cancelar).

### Stripe (opcional)

Define `STRIPE_SECRET_KEY` y crea en Stripe un webhook a `https://TU-WEB/webhooks/stripe` con los eventos `checkout.session.completed` y `checkout.session.expired`; su secreto va en `STRIPE_WEBHOOK_SECRET`.

## Diseño

Obra siempre **entera** sobre un paspartú (nunca recortada), tarjetas tipo cartela, segunda imagen al pasar el ratón cuando el producto tiene galería, imagen ampliable en la ficha y **tema claro / oscuro** (sigue la preferencia del sistema y se puede cambiar con el botón de la cabecera). Los dos temas cumplen contraste AA. Las tipografías (Inter y Space Grotesk, licencia OFL) se sirven desde la propia web.

## Estructura

```
server.js            configuracion de Express, cabeceras, sesion, CSRF
db.js                esquema, migraciones y acceso a datos (libSQL / Turso)
lib/                 pedidos, temas, IA de vision, emails, pagos, validacion, seguridad
routes/              tienda, carrito, checkout, webhooks
routes/admin/        auth, dashboard, products, themes, orders (un modulo por responsabilidad)
views/               plantillas EJS (publicas, legales y de administracion)
public/              CSS, JS, tipografias
test/smoke.js        ~220 pruebas automaticas contra un servidor real con base de datos temporal
```

## Seguridad (resumen)

CSRF firmado en todos los formularios · CSP estricta **sin scripts ni estilos en línea** y sin recursos de terceros, HSTS y resto de cabeceras (helmet) · login con límite de intentos **por IP real** (detrás de Cloudflare se usa `CF-Connecting-IP`), comparación en tiempo constante y sesión regenerada · cookies `HttpOnly`/`SameSite`/`Secure` con prefijo `__Host-` en producción · pedidos accesibles solo con enlace privado de 128 bits (sin enumeración) · el servidor recalcula siempre precios, envío y totales · stock reservado de forma atómica al pedir (sin sobreventa) · imágenes validadas por su contenido real · plantillas con escape automático · webhook de Stripe con firma, importe y pedido verificados · límite de emails por destinatario · errores sin trazas hacia el visitante · 0 vulnerabilidades conocidas en dependencias (`npm audit`).

## Despliegue en Render

El repositorio se despliega solo con cada `git push` a `main`. Servicio web Node, comando de arranque `npm start`, plan gratuito. La primera visita tras un rato de inactividad tarda 30-60 s (el plan gratis "duerme" el servicio); los datos están a salvo en Turso y Cloudinary.

## Notas legales

Las páginas legales son plantillas generales, **no asesoramiento jurídico**: revísalas con tu gestoría. Si vendes de forma habitual en España necesitarás alta como autónomo y facturación con IVA.

## Consejos de mantenimiento

- **Evitar el "sueño" del plan gratuito:** Render duerme la web tras 15 minutos sin visitas y la primera carga tarda ~50 s. Un monitor gratuito (por ejemplo UptimeRobot) que pida `https://TU-WEB/healthz` cada 5 minutos la mantiene despierta y te avisa si se cae.
- **Límite de peticiones:** `RATE_LIMIT_PER_MIN` (240 por IP y minuto por defecto) frena el exceso de tráfico antes de tocar la base de datos.
- **Accesos al panel:** tras 5 intentos fallidos desde una IP recibes un aviso por email (si tienes `OWNER_EMAIL` y el email configurado); a los 8 se bloquea esa IP 15 minutos.
