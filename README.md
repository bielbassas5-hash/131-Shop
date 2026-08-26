# Tienda 131

Tienda online para vender dibujos, stickers y prints. Node.js + Express + SQLite (sin dependencias nativas, usa `node:sqlite` incluido en Node 22+).

## Arrancar en local

```bash
npm install
npm run dev
```

Abre http://localhost:3001

## Configuracion (`.env`)

Ya hay un `.env` creado con valores de ejemplo. Cosas que deberias cambiar:

- `ADMIN_PASSWORD`: la contrasena para entrar en `/admin` (ahora mismo es `arte131`).
- `BANK_IBAN` / `BIZUM_PHONE`: donde recibiras los pagos por transferencia/Bizum (modo por defecto, sin comisiones).
- `SHIPPING_COST_CENTS`: coste de envio fijo, en centimos.

## Como funciona el pago

Por defecto **no usa Stripe**: al confirmar un pedido, el cliente ve tu IBAN y numero de Bizum con el importe exacto y el numero de pedido como referencia. Tu confirmas manualmente el pago desde `/admin/pedidos` cuando veas el ingreso, y el stock se descuenta automaticamente al marcarlo como "Pagado".

Si en el futuro quieres cobrar con tarjeta automaticamente (con comision ~1.4% + 0.25€), crea una cuenta gratis en https://stripe.com, copia tu `STRIPE_SECRET_KEY` (modo test o real) al `.env`, y el checkout cambiara solo a pago con tarjeta via Stripe.

## Panel de administracion

- `/admin` - gestionar productos (subir, editar, eliminar, marcar como oculto)
- `/admin/pedidos` - ver pedidos y cambiar su estado (pendiente / pagado / enviado / cancelado)

## Publicarla online (cuando quieras)

Esta version esta pensada para correr en tu ordenador. Para publicarla en internet necesitaras:

1. Un hosting (Railway, Render, Fly.io... todos tienen planes gratuitos/baratos para apps Node).
2. Guardar las imagenes subidas en un sitio persistente (en muchos hostings gratuitos el disco se borra en cada despliegue) - lo mas sencillo seria un bucket S3-compatible (Cloudflare R2, Backblaze B2) cuando llegue el momento.
3. Cambiar `SESSION_SECRET` y `ADMIN_PASSWORD` por valores seguros.

Avisame cuando quieras dar este paso y te ayudo a configurarlo.

## Nota legal

Si vendes de forma regular, en Espana Hacienda suele exigir estar dado de alta como autonomo (o similar). Esto no es un bloqueo tecnico, pero conviene confirmarlo con una gestoria antes de vender en serio.
