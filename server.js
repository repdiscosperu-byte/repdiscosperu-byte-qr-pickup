require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const QRCode = require('qrcode');
const sgMail = require('@sendgrid/mail');

const app = express();
app.use(express.json());

(function () {
  const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
  const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
  const APP_URL = process.env.APP_URL;
  const NOTIFY_EMAIL = 'hola@repdiscosperu.com';
  const QR_PIN = process.env.QR_PIN || '220400';
  const QR_SESSION_SECRET = process.env.QR_SESSION_SECRET || 'cambia-este-secreto';
  const DB_PATH = process.env.QR_DB_PATH || path.join(__dirname, 'data', 'qr-pickup.json');
  const PICKUP_TAG = 'Listo-Recoger';

  // Asegura que exista la carpeta de datos
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ pickups: {} }, null, 2));

  const shopifyQR = axios.create({
    baseURL: `https://${SHOPIFY_STORE}/admin/api/2026-04`,
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
  });

  function loadDB() {
    try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch { return { pickups: {} }; }
  }
  function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  }

  function sign(value) {
    return crypto.createHmac('sha256', QR_SESSION_SECRET).update(value).digest('hex');
  }

  function getCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
    return match ? decodeURIComponent(match.split('=')[1]) : null;
  }

  function isAuthenticated(req) {
    const token = getCookie(req, 'qr_session');
    if (!token) return false;
    return token === sign('vendedor-autenticado');
  }

  function requireAuth(req, res, next) {
    if (isAuthenticated(req)) return next();
    return res.redirect('/qr-pickup');
  }

  async function sendPickupEmail(order, code) {
    if (!process.env.SENDGRID_API_KEY) return;
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const qrImageUrl = `${APP_URL}/qr-pickup/image/${code}`;
    const itemsHtml = (order.line_items || []).map(i => `${i.quantity}x ${i.title}`).join('<br>');

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color:#111;">RepDiscosPeru</h2>
        <p>¡Tu pedido <strong>#${order.order_number}</strong> ya está listo para que lo recojas en tienda!</p>
        <p><strong>Productos:</strong><br>${itemsHtml}</p>
        <p>Por seguridad, muestra este código QR al momento de recoger tu pedido. Así validamos que el pedido te corresponde a ti.</p>
        <div style="text-align:center; margin:24px 0;">
          <img src="${qrImageUrl}" alt="Código QR" style="width:220px;height:220px;" />
        </div>
        <p style="color:#b00;">⚠️ No compartas este código QR con nadie. Es único para tu pedido y solo debe usarse al momento del recojo.</p>
        <p>Cualquier duda, escríbenos a hola@repdiscosperu.com.</p>
        <p>¡Gracias por tu compra!<br><strong>RepDiscosPeru</strong></p>
      </div>
    `;

    try {
      await sgMail.send({ from: { email: 'hola@repdiscosperu.com', name: 'RepDiscosPeru' }, to: order.email, subject: 'Tu pedido está listo para recoger 🎶', html });
      console.log(`📧 QR enviado al cliente: ${order.email}`);
    } catch (err) {
      console.error('❌ Error enviando QR al cliente:', err.message);
    }

    try {
      await sgMail.send({ from: { email: 'hola@repdiscosperu.com', name: 'RepDiscosPeru' }, to: NOTIFY_EMAIL, subject: `[Copia] Pedido #${order.order_number} listo — QR enviado`, html });
      console.log(`📧 Copia enviada a ${NOTIFY_EMAIL}`);
    } catch (err) {
      console.error('❌ Error enviando copia de QR:', err.message);
    }
  }

  // ─── WEBHOOK: pedido actualizado (detecta etiqueta Listo-Recoger) ──────────
  app.post('/webhook/qr-pickup', async (req, res) => {
    res.sendStatus(200);
    const order = req.body;
    try {
      const tags = (order.tags || '').split(',').map(t => t.trim());
      if (!tags.includes(PICKUP_TAG)) return;

      const db = loadDB();
      const yaExiste = Object.values(db.pickups).some(p => p.order_id === order.id);
      if (yaExiste) return;

      const code = crypto.randomBytes(16).toString('hex');
      db.pickups[code] = {
        order_id: order.id,
        order_number: order.order_number,
        customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || order.email || 'Cliente',
        items: (order.line_items || []).map(i => `${i.quantity}x ${i.title}`),
        status: 'pendiente',
        created_at: new Date().toISOString(),
        delivered_at: null,
        delivered_by: null,
      };
      saveDB(db);

      await sendPickupEmail(order, code);
      console.log(`✅ QR generado para pedido #${order.order_number}`);
    } catch (err) {
      console.error('❌ Error generando QR:', err.message);
    }
  });

  // ─── IMAGEN DEL QR ──────────────────────────────────────────────────────────
  app.get('/qr-pickup/image/:code', async (req, res) => {
    try {
      const buffer = await QRCode.toBuffer(req.params.code, { width: 300 });
      res.set('Content-Type', 'image/png');
      res.send(buffer);
    } catch (err) {
      res.status(500).send('Error generando imagen QR');
    }
  });

  // ─── LOGIN VENDEDOR (PIN) ───────────────────────────────────────────────────
  app.get('/qr-pickup', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/qr-pickup/scanner');
    res.send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>RepDiscosPeru - Acceso</title></head>
      <body style="font-family:Arial;text-align:center;padding-top:60px;background:#111;color:#fff;">
        <h2>RepDiscosPeru</h2>
        <p>Ingresa el PIN para validar pedidos</p>
        <form method="POST" action="/qr-pickup/login">
          <input type="password" name="pin" inputmode="numeric" maxlength="6"
            style="font-size:24px;text-align:center;padding:10px;border-radius:8px;border:none;width:160px;" />
          <br><br>
          <button type="submit" style="font-size:18px;padding:10px 24px;border-radius:8px;border:none;background:#1db954;color:#fff;">Entrar</button>
        </form>
      </body></html>
    `);
  });

  app.post('/qr-pickup/login', express.urlencoded({ extended: true }), (req, res) => {
    if (req.body.pin === QR_PIN) {
      const token = sign('vendedor-autenticado');
      res.setHeader('Set-Cookie', `qr_session=${token}; HttpOnly; Max-Age=43200; Path=/`);
      return res.redirect('/qr-pickup/scanner');
    }
    res.send('<p style="font-family:Arial;text-align:center;margin-top:60px;">❌ PIN incorrecto. <a href="/qr-pickup">Volver</a></p>');
  });

  // ─── PANTALLA DE ESCANEO ────────────────────────────────────────────────────
  app.get('/qr-pickup/scanner', requireAuth, (req, res) => {
    res.send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Validar pedido</title>
      <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
      </head>
      <body style="font-family:Arial;text-align:center;background:#111;color:#fff;padding:20px;">
        <h2>RepDiscosPeru — Validar recojo</h2>
        <div id="reader" style="width:320px;margin:0 auto;"></div>
        <div id="resultado" style="margin-top:20px;font-size:18px;"></div>
        <p><a href="/qr-pickup/historial" style="color:#1db954;">Ver historial</a></p>
        <script>
          const resultadoDiv = document.getElementById('resultado');
          let procesando = false;

          function html5QrcodeScanCallback(decodedText) {
            if (procesando) return;
            procesando = true;
            fetch('/qr-pickup/validate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: decodedText })
            })
            .then(r => r.json())
            .then(data => mostrarResultado(data))
            .catch(() => { resultadoDiv.innerHTML = '❌ Error de conexión'; procesando = false; });
          }

          function mostrarResultado(data) {
            if (data.error) {
              resultadoDiv.innerHTML = '❌ ' + data.error;
              procesando = false;
              return;
            }
            if (data.status === 'entregado') {
              resultadoDiv.innerHTML =
                '⚠️ Este pedido ya fue entregado<br>Fecha: ' + new Date(data.delivered_at).toLocaleString('es-PE');
              procesando = false;
              return;
            }
            resultadoDiv.innerHTML =
              '<strong>Pedido #' + data.order_number + '</strong><br>' +
              'Cliente: ' + data.customer_name + '<br>' +
              'Productos:<br>' + data.items.join('<br>') +
              '<br><br><button id="btnConfirmar" style="font-size:18px;padding:10px 24px;border-radius:8px;border:none;background:#1db954;color:#fff;">Confirmar entrega</button>';
            document.getElementById('btnConfirmar').onclick = () => confirmar(data.code);
          }

          function confirmar(code) {
            fetch('/qr-pickup/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code })
            })
            .then(r => r.json())
            .then(data => {
              resultadoDiv.innerHTML = data.ok
                ? '✅ Pedido marcado como entregado'
                : '❌ ' + (data.error || 'Error al confirmar');
              procesando = false;
            });
          }

          const qr = new Html5Qrcode('reader');
          qr.start({ facingMode: 'environment' }, { fps: 10, qrbox: 250 }, html5QrcodeScanCallback)
            .catch(() => { resultadoDiv.innerHTML = '❌ No se pudo acceder a la cámara'; });
        </script>
      </body></html>
    `);
  });

  // ─── VALIDAR CÓDIGO ─────────────────────────────────────────────────────────
  app.post('/qr-pickup/validate', requireAuth, (req, res) => {
    const { code } = req.body;
    const db = loadDB();
    const pickup = db.pickups[code];
    if (!pickup) return res.json({ error: 'Código no encontrado o inválido' });

    if (pickup.status === 'entregado') {
      return res.json({ status: 'entregado', delivered_at: pickup.delivered_at });
    }
    res.json({
      code,
      status: 'pendiente',
      order_number: pickup.order_number,
      customer_name: pickup.customer_name,
      items: pickup.items,
    });
  });

  // ─── CONFIRMAR ENTREGA ──────────────────────────────────────────────────────
  app.post('/qr-pickup/confirm', requireAuth, async (req, res) => {
    const { code } = req.body;
    const db = loadDB();
    const pickup = db.pickups[code];
    if (!pickup) return res.json({ ok: false, error: 'Código no encontrado' });
    if (pickup.status === 'entregado') return res.json({ ok: false, error: 'Ya fue entregado antes' });

    try {
      const foRes = await shopifyQR.get(`/orders/${pickup.order_id}/fulfillment_orders.json`);
      const fulfillmentOrders = foRes.data.fulfillment_orders || [];
      const openFO = fulfillmentOrders.find(fo => fo.status === 'open' || fo.status === 'in_progress') || fulfillmentOrders[0];

      if (!openFO) {
        throw new Error('No se encontró una fulfillment order disponible para este pedido');
      }

      await shopifyQR.post('/fulfillments.json', {
        fulfillment: {
          line_items_by_fulfillment_order: [{ fulfillment_order_id: openFO.id }],
          notify_customer: false,
        },
      });

      pickup.status = 'entregado';
      pickup.delivered_at = new Date().toISOString();
      pickup.delivered_by = 'vendedor';
      saveDB(db);

      res.json({ ok: true });
    } catch (err) {
      console.error('❌ Error marcando fulfillment:', JSON.stringify(err.response?.data || err.message));
      res.json({ ok: false, error: 'Error al actualizar Shopify' });
    }
  });

  // ─── HISTORIAL (auditoría) ──────────────────────────────────────────────────
  app.get('/qr-pickup/historial', requireAuth, (req, res) => {
    const db = loadDB();
    const rows = Object.values(db.pickups)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(p => `<tr><td>#${p.order_number}</td><td>${p.customer_name}</td><td>${p.status}</td><td>${p.delivered_at ? new Date(p.delivered_at).toLocaleString('es-PE') : '-'}</td></tr>`)
      .join('');
    res.send(`
      <html><body style="font-family:Arial;padding:20px;">
        <h2>Historial de recojos</h2>
        <table border="1" cellpadding="8" style="border-collapse:collapse;">
          <tr><th>Pedido</th><th>Cliente</th><th>Estado</th><th>Entregado</th></tr>
          ${rows}
        </table>
        <p><a href="/qr-pickup/scanner">← Volver al escáner</a></p>
      </body></html>
    `);
  });

  console.log('✅ Rutas QR-Pickup registradas');
})();

app.get('/', (req, res) => res.json({ status: '✅ Servicio QR-Pickup activo (independiente de Bsale)' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 QR-Pickup escuchando en puerto ${PORT}`));
