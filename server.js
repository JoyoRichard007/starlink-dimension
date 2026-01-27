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
   CONFIG MIKROTIK
========================================================= */
const mikrotik = new RouterOSAPI({
  host: process.env.MIKROTIK_HOST,
  user: process.env.MIKROTIK_USER,
  password: process.env.MIKROTIK_PASSWORD,
  timeout: Number(process.env.MIKROTIK_TIMEOUT || 10000)
});

async function connectMikrotik() {
  if (!mikrotik.connected) {
    await mikrotik.connect();
    console.log('✅ Connecté au MikroTik');
  }
}

/* =========================================================
   GÉNÉRATION VOUCHER
========================================================= */
async function generateVoucher(profileName) {
  const username = 'SD-' + Math.random().toString(36).substring(2, 7);
  const password = Math.random().toString(36).slice(-6);

  await connectMikrotik();

  await mikrotik.write('/ip/hotspot/user/add', [
    `=name=${username}`,
    `=password=${password}`,
    `=profile=${profileName}`
  ]);

  console.log(`🎟️ Voucher créé: ${username}/${password}`);
  return { username, password };
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
   STOCKAGE TEMPORAIRE
========================================================= */
const pendingPayments = {}; // sessionId -> paiement pending
const vouchers = {};        // sessionId -> voucher

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

  res.json({
    success: true,
    sessionId,
    ref
  });
});

/* =========================================================
   SMS ENTRANT (SEULEMENT MVOLA)
========================================================= */
app.post('/sms/incoming', async (req, res) => {
  const { sender, message } = req.body;

  if (!message || !sender) return res.sendStatus(200);
  if (!/mvola/i.test(sender)) return res.sendStatus(200);

  console.log('📩 SMS MVola reçu:', message);

  // Extraction montant depuis le message (avec ou sans espace)
  const amountMatch = message.match(/(\d{1,3}(?:[ ,]\d{3})*|\d+)\s?Ar/i);
  if (!amountMatch) return res.sendStatus(200);
  const amount = Number(amountMatch[1].replace(/[ ,\.]/g, ''));

  // Extraction du numéro téléphone
  const phoneMatch = message.match(/\((0\d{9,10})\)/);
  if (!phoneMatch) return res.sendStatus(200);

  const smsPhone = normalizePhone(phoneMatch[1]);


  // Matching sur pendingPayments par montant seulement
  const sessionId = Object.keys(pendingPayments).find(id => {
    const p = pendingPayments[id];
    // return p.status === 'PENDING' && p.amount === amount;
    return (
      p.status === 'PENDING' &&
      p.amount === amount &&
      p.phone === smsPhone
    );
  });

  if (!sessionId) {
    console.log('❌ Aucun paiement correspondant pour ce montant');
    return res.sendStatus(200);
  }

  const payment = pendingPayments[sessionId];
  payment.status = 'CONFIRMED';
  console.log('✅ Paiement validé:', payment);

  // Création voucher
  const profileMap = { '1h':'1Heure','5h':'5Heures','24h':'24Heures' };
  const profile = profileMap[payment.offer];
  if (!profile) return res.sendStatus(200);

  try {
    const voucher = await generateVoucher(profile);
    vouchers[sessionId] = voucher; // stock pour polling
    console.log('🎉 Voucher créé:', voucher);
  } catch (err) {
    console.error('❌ Erreur MikroTik:', err.message);
  } finally {
    delete pendingPayments[sessionId]; // on supprime le pending
  }

  res.sendStatus(200);
});

/* =========================================================
   ENDPOINT POUR POLLING VOUCHER
========================================================= */
app.get('/voucher/status/:sessionId', (req,res)=>{
  const { sessionId } = req.params;

  if(vouchers[sessionId]){
    const voucher = vouchers[sessionId];
    // On renvoie mais on garde en mémoire pour bouton "Afficher mes vouchers"
    return res.json({ success:true, voucher });
  } else {
    return res.json({ success:false });
  }
});

/* =========================================================
   ENDPOINT POUR RECUPERER TOUS LES VOUCHERS D'UNE SESSION
========================================================= */
app.get('/voucher/all/:sessionId', (req,res)=>{
  const { sessionId } = req.params;
  if(vouchers[sessionId]){
    return res.json({ success:true, voucher:vouchers[sessionId] });
  } else {
    return res.json({ success:false });
  }
});

/* =========================================================
   EXPIRATION AUTOMATIQUE
========================================================= */
setInterval(() => {
  const now = Date.now();
  for (const id in pendingPayments) {
    if (now - pendingPayments[id].createdAt > 7 * 60 * 1000) {
      console.log('🧹 Session expirée:', pendingPayments[id].ref);
      delete pendingPayments[id];
    }
  }
}, 60 * 1000);

/* =========================================================
   SERVER
========================================================= */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend USSD + SMS sécurisé sur le port ${PORT}`);
});
  
