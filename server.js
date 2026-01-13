require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const { RouterOSAPI } = require('node-routeros');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json());

/* ==================== CONFIG MIKROTIK ==================== */
const connection = new RouterOSAPI({
  host: process.env.MIKROTIK_HOST,
  user: process.env.MIKROTIK_USER,
  password: process.env.MIKROTIK_PASSWORD,
  timeout: Number(process.env.MIKROTIK_TIMEOUT || 10000)
});

// Retry MikroTik toutes les 5s si offline
connection.on('error', async (err) => {
  console.error('⚠️ MikroTik error:', err.message || err);

  if (!connection.connected) {
    console.log('ℹ️ Tentative de reconnexion MikroTik dans 5s...');
    setTimeout(async () => {
      try {
        await connection.connect();
        console.log('✅ Reconnecté au MikroTik');
      } catch (e) {
        console.error('❌ Reconnexion échouée:', e.message);
      }
    }, 5000);
  }
});

async function connectMikrotik() {
  try {
    await connection.connect();
    console.log('✅ Connecté au MikroTik');
  } catch (err) {
    console.error('❌ MikroTik indisponible au démarrage');
  }
}
connectMikrotik();

/* ==================== VOUCHER ==================== */
async function generateVoucher(profileName) {
  const username = 'SD-' + Math.random().toString(36).substring(2, 7);
  const password = Math.random().toString(36).slice(-6);

  try {
    if (!connection.connected) {
      console.log('ℹ️ Reconnexion MikroTik avant création voucher...');
      await connection.connect();
    }

    await connection.write('/ip/hotspot/user/add', [
      `=name=${username}`,
      `=password=${password}`,
      `=profile=${profileName}`
    ]);

    console.log(`✅ Voucher créé: ${username} / ${password}`);
    return { username, password };
  } catch (err) {
    console.error('❌ Erreur création voucher:', err.message || err);
    throw new Error('MikroTik indisponible');
  }
}

/* ==================== MVOLA ==================== */
const IS_SANDBOX = process.env.IS_SANDBOX === 'true';

const CONFIG = {
  sandbox: {
    TOKEN: process.env.MVOLA_SANDBOX_TOKEN,
    PAYMENT: process.env.MVOLA_SANDBOX_PAYMENT,
    MERCHANT: process.env.MVOLA_SANDBOX_MERCHANT,
    CLIENT_ID: process.env.MVOLA_SANDBOX_CLIENT_ID,
    CLIENT_SECRET: process.env.MVOLA_SANDBOX_CLIENT_SECRET
  },
  prod: {
    TOKEN: process.env.MVOLA_PROD_TOKEN,
    PAYMENT: process.env.MVOLA_PROD_PAYMENT,
    MERCHANT: process.env.MVOLA_PROD_MERCHANT,
    CLIENT_ID: process.env.MVOLA_PROD_CLIENT_ID,
    CLIENT_SECRET: process.env.MVOLA_PROD_CLIENT_SECRET
  }
};

const CURRENT = IS_SANDBOX ? CONFIG.sandbox : CONFIG.prod;

let accessToken = null;
let tokenExpiresAt = 0;

async function getMvToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpiresAt) return accessToken;

  try {
    const basicAuth = Buffer.from(
      `${CURRENT.CLIENT_ID}:${CURRENT.CLIENT_SECRET}`
    ).toString('base64');

    const resp = await axios.post(
      CURRENT.TOKEN,
      'grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basicAuth}`
        }
      }
    );

    accessToken = resp.data.access_token;
    tokenExpiresAt = now + resp.data.expires_in * 1000 - 5000;
    console.log('✅ Nouveau token MVola obtenu');
    return accessToken;
  } catch (err) {
    console.error('❌ Impossible d’obtenir le token MVola', err.response?.data || err.message);
    throw err;
  }
}

/* ==================== ROUTES ==================== */

// Génération directe (sans paiement)
app.post('/voucher', async (req, res) => {
  const { offer } = req.body;
  const map = { '1h': '1Heure', '5h': '5Heures', '24h': '24Heures' };
  const profile = map[offer];

  if (!profile) return res.status(400).json({ error: 'Offre invalide' });

  try {
    const voucher = await generateVoucher(profile);
    res.json({ success: true, voucher });
  } catch (e) {
    res.status(503).json({ error: 'MikroTik hors ligne' });
  }
});

// Init paiement
app.post('/pay', async (req, res) => {
  const { amount, phone, offer } = req.body;
  if (!amount || !phone || !offer)
    return res.status(400).json({ error: 'Paramètres manquants' });

  const correlationId = uuidv4();

  try {
    const token = await getMvToken();

    const payload = {
      amount: amount.toString(),
      currency: 'Ar',
      descriptionText: `Paiement Wifi ${offer}`,
      requestingOrganisationTransactionReference: correlationId,
      sendingOrganisationTransactionReference: correlationId,
      requestDate: new Date().toISOString(),
      transactionChannel: 'MERCHANT',
      debitParty: [{ key: 'msisdn', value: phone }],
      creditParty: [{ key: 'msisdn', value: CURRENT.MERCHANT }]
    };

    await axios.post(CURRENT.PAYMENT, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-CorrelationID': correlationId,
        UserLanguage: 'fr',
        UserAccountIdentifier: `msisdn:${CURRENT.MERCHANT}`,
        partnerName: 'Wifi-Hotspot',
        'Content-Type': 'application/json'
      }
    });

    res.json({ success: true, correlationId });
  } catch (err) {
    console.error('❌ Erreur MVola:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur MVola' });
  }
});

// Vérification paiement
app.get('/pay/status/:id/:offer', async (req, res) => {
  const { id, offer } = req.params;
  const map = { '1h': '1Heure', '5h': '5Heures', '24h': '24Heures' };
  const profile = map[offer];

  try {
    const token = await getMvToken();
    const statusRes = await axios.get(`${CURRENT.PAYMENT}/status/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (statusRes.data.status === 'SUCCESS') {
      const voucher = await generateVoucher(profile);
      return res.json({ success: true, voucher });
    }

    res.json({ success: false, status: statusRes.data.status });
  } catch (err) {
    console.error('❌ Erreur statut paiement:', err.message || err);
    res.status(500).json({ error: 'Erreur statut paiement' });
  }
});

/* ==================== SERVER ==================== */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
