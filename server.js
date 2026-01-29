require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { RouterOSAPI } = require('node-routeros');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());

/* =========================================================
   CONFIG MIKROTIK (ROBUSTE)
========================================================= */
let mikrotik = null;
let mikrotikReady = false;
let reconnecting = false;

function createMikrotik() {
  return new RouterOSAPI({
    host: process.env.MIKROTIK_HOST,
    user: process.env.MIKROTIK_USER,
    password: process.env.MIKROTIK_PASSWORD,
    timeout: Number(process.env.MIKROTIK_TIMEOUT || 10000)
  });
}

async function connectMikrotik() {
  if (mikrotikReady || reconnecting) return;

  reconnecting = true;

  try {
    if (mikrotik) {
      try { mikrotik.close(); } catch {}
    }

    mikrotik = createMikrotik();

    mikrotik.on('error', onMikrotikError);

    await mikrotik.connect();
    mikrotikReady = true;

    console.log('✅ Connecté au MikroTik');
  } catch (err) {
    console.error('❌ MikroTik indisponible:', err.message);
  } finally {
    reconnecting = false;
  }
}

function onMikrotikError(err) {
  console.error('⚠️ MikroTik error:', err?.message || err);
  mikrotikReady = false;

  try { mikrotik?.close(); } catch {}

  if (!reconnecting) {
    console.log('ℹ️ Reconnexion MikroTik dans 5s...');
    setTimeout(connectMikrotik, 5000);
  }
}

/* =========================================================
   GÉNÉRATION VOUCHER (FIABLE)
========================================================= */
async function generateVoucher(profileName, retry = true) {
  if (!mikrotik || !mikrotikReady) {
    throw new Error('MikroTik non disponible');
  }

  const username = 'SD-' + Math.random().toString(36).substring(2, 7);
  const password = Math.random().toString(36).slice(-6);

  try {
    await mikrotik.write('/ip/hotspot/user/add', [
      `=name=${username}`,
      `=password=${password}`,
      `=profile=${profileName}`
    ]);

    console.log(`🎟️ Voucher créé: ${username}/${password}`);
    return { username, password };

  } catch (err) {
    mikrotikReady = false;

    if (retry) {
      console.log('🔁 Retry création voucher après reconnexion...');
      await connectMikrotik();
      return generateVoucher(profileName, false);
    }

    throw err;
  }
}

/* =========================================================
   UTILS
========================================================= */
function normalizePhone(phone) {
  return phone.replace(/\D/g, '').slice(-9);
}

function generateRef() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/* =========================================================
   STOCKAGE TEMPORAIRE (RAM)
========================================================= */
const pendingPayments = {};
const vouchers = {};

/* =========================================================
   INIT USSD
========================================================= */
app.post('/ussd/init', (req, res) => {
  const { phone, amount, offer } = req.body;
  if (!phone || !amount || !offer) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  const sessionId = uuidv4();
  const ref = generateRef();

  pendingPayments[sessionId] = {
    phone: normalizePhone(phone),
    amount: Number(amount),
    offer,
    ref,
    status: 'PENDING',
    createdAt: Date.now()
  };

  console.log('🟡 USSD INIT:', { sessionId, ...pendingPayments[sessionId] });
  res.json({ success: true, sessionId, ref });
});

/* =========================================================
   SMS ENTRANT (MVOLA)
========================================================= */
app.post('/sms/incoming', async (req, res) => {
  const { sender, message } = req.body;
  if (!sender || !message) return res.sendStatus(200);
  if (!/mvola/i.test(sender)) return res.sendStatus(200);

  console.log('📩 SMS MVola reçu:', message);

  const amountMatch = message.match(/(\d+)\s?Ar/i);
  if (!amountMatch) return res.sendStatus(200);
  const amount = Number(amountMatch[1]);

  const phoneMatch = message.match(/\((0\d{9,10})\)/);
  if (!phoneMatch) return res.sendStatus(200);
  const smsPhone = normalizePhone(phoneMatch[1]);

  const sessionId = Object.keys(pendingPayments).find(id => {
    const p = pendingPayments[id];
    return p.status === 'PENDING' && p.amount === amount && p.phone === smsPhone;
  });

  if (!sessionId) return res.sendStatus(200);

  const payment = pendingPayments[sessionId];
  payment.status = 'CONFIRMED';

  const profileMap = {
    '1h': '1Heure',
    '5h': '5Heures',
    '24h': '24Heures'
  };

  try {
    const voucher = await generateVoucher(profileMap[payment.offer]);
    vouchers[sessionId] = voucher;
    console.log('🎉 Voucher prêt:', voucher);
  } catch (err) {
    console.error('❌ Voucher non créé:', err.message);
  } finally {
    delete pendingPayments[sessionId];
  }

  res.sendStatus(200);
});

/* =========================================================
   POLLING VOUCHER
========================================================= */
app.get('/voucher/status/:sessionId', (req, res) => {
  const voucher = vouchers[req.params.sessionId];
  res.json(voucher ? { success: true, voucher } : { success: false });
});

/* =========================================================
   CLEANUP
========================================================= */
setInterval(() => {
  const now = Date.now();
  for (const id in pendingPayments) {
    if (now - pendingPayments[id].createdAt > 7 * 60 * 1000) {
      delete pendingPayments[id];
    }
  }
}, 60 * 1000);

/* =========================================================
   SERVER
========================================================= */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend USSD + SMS prêt sur le port ${PORT}`);
  connectMikrotik();
});
