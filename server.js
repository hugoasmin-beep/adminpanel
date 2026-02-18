require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

// ========== IMPORTS PROXY EXPIRATION ==========
const proxyExpirationRoutes = require('./routes/proxyExpiration.routes');
const ProxyExpirationService = require('./services/proxyExpiration.service');
const { 
  Proxy, 
  ExpirationAlert, 
  ProxyRenewal,
  ExpirationAnalytics 
} = require('./models/proxyExpiration.model');

// ========== BREVO EMAIL ==========
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'enlignea74@gmail.com';
const BREVO_FROM_NAME = process.env.BREVO_FROM_NAME || 'ProxyFlow';

async function sendEmailViaBrevo(to, subject, htmlContent) {
  try {
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { email: BREVO_FROM_EMAIL, name: BREVO_FROM_NAME },
        to: [{ email: to }],
        subject,
        htmlContent
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-key': BREVO_API_KEY
        },
        timeout: 10000
      }
    );
    console.log(`✅ Email envoyé à ${to}`);
    return response.data;
  } catch (err) {
    console.error(`❌ Erreur Brevo: ${err.response?.status}`);
    throw err;
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

// ========== CORS ==========
const corsOptions = {
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5000'
  ].filter(Boolean),
  credentials: true
};

app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public'));

// ========== MONGODB CONNECTION ==========
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ MongoDB erreur:', err));

// ========== SCHEMAS ==========
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
  isEmailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String, default: null },
  emailVerificationExpires: { type: Date, default: null },
  passwordResetToken: { type: String, default: null },
  passwordResetExpires: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['credit', 'debit', 'purchase'], required: true },
  amount: { type: Number, required: true },
  description: { type: String },
  balanceBefore: { type: Number },
  balanceAfter: { type: Number },
  proxyDetails: { type: Object },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// ========== JWT SECRET ==========
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-this';

// ========== MIDDLEWARE AUTHENTIFICATION ==========
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User invalide' });

    req.user = user;
    req.userId = user._id;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token invalide' });
  }
};

// ========== MIDDLEWARE ADMIN ==========
const adminMiddleware = (req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Accès refusé - Admin requis' });
  }
  next();
};

// ========== ROUTES AUTHENTIFICATION ==========

// Inscription
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'Email déjà utilisé' });

    const crypto = require('crypto');
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ 
      email, 
      password: hashedPassword,
      balance: 0,
      isEmailVerified: false,
      emailVerificationToken: verificationToken,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h
    });

    await user.save();

    // Envoyer l'email de vérification
    const verifyUrl = `${FRONTEND_URL}/verify-email.html?token=${verificationToken}`;
    try {
      await sendEmailViaBrevo(email, '📧 Confirmez votre email - ProxyFlow', `
        <h2>Bienvenue sur ProxyFlow !</h2>
        <p>Merci de vous être inscrit. Cliquez sur le lien ci-dessous pour activer votre compte :</p>
        <a href="${verifyUrl}" style="background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:16px 0;">Activer mon compte</a>
        <p>Ce lien expire dans 24 heures.</p>
      `);
    } catch (emailErr) {
      console.error('⚠️ Email de vérification non envoyé:', emailErr.message);
    }

    res.json({
      success: true,
      message: 'Inscription réussie ! Vérifiez votre email pour activer votre compte.',
      user: { id: user._id, email: user.email }
      // Pas de token : l'utilisateur doit d'abord vérifier son email
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Connexion
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    // Vérifier si l'email est confirmé
    if (!user.isEmailVerified) {
      return res.status(403).json({
        error: 'Veuillez vérifier votre email avant de vous connecter.',
        emailNotVerified: true
      });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      success: true,
      message: 'Connexion réussie',
      user: { id: user._id, email: user.email, isAdmin: user.isAdmin },
      token
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Vérification email via token
app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() }
    });

    if (!user) return res.status(400).json({ error: 'Token invalide ou expiré' });

    user.isEmailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    res.json({ success: true, message: 'Email vérifié avec succès ! Vous pouvez maintenant vous connecter.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Renvoyer l'email de vérification
app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (user.isEmailVerified) return res.status(400).json({ error: 'Email déjà vérifié' });

    const crypto = require('crypto');
    const verificationToken = crypto.randomBytes(32).toString('hex');
    user.emailVerificationToken = verificationToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    await user.save();

    const verifyUrl = `${FRONTEND_URL}/verify-email.html?token=${verificationToken}`;
    await sendEmailViaBrevo(email, '📧 Vérifiez votre email - ProxyFlow', `
      <h2>Vérification de votre email</h2>
      <p>Cliquez sur le lien ci-dessous pour vérifier votre adresse email :</p>
      <a href="${verifyUrl}" style="background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:16px 0;">Vérifier mon email</a>
      <p>Ce lien expire dans 24 heures.</p>
    `);

    res.json({ success: true, message: 'Email de vérification envoyé !' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mot de passe oublié
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const user = await User.findOne({ email });
    // On répond toujours "ok" pour ne pas révéler si l'email existe
    if (!user) return res.json({ success: true, message: 'Si cet email existe, un lien vous a été envoyé.' });

    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1h
    await user.save();

    const resetUrl = `${FRONTEND_URL}/forgot-password.html?token=${resetToken}`;
    await sendEmailViaBrevo(email, '🔐 Réinitialisation de votre mot de passe - ProxyFlow', `
      <h2>Réinitialisation du mot de passe</h2>
      <p>Vous avez demandé une réinitialisation de votre mot de passe.</p>
      <a href="${resetUrl}" style="background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:16px 0;">Réinitialiser mon mot de passe</a>
      <p>Ce lien expire dans 1 heure. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
    `);

    res.json({ success: true, message: 'Si cet email existe, un lien vous a été envoyé.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Réinitialiser le mot de passe
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token et mot de passe requis' });
    if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });

    const user = await User.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() }
    });

    if (!user) return res.status(400).json({ error: 'Token invalide ou expiré' });

    user.password = await bcrypt.hash(password, 10);
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await user.save();

    res.json({ success: true, message: 'Mot de passe réinitialisé avec succès !' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ROUTES UTILISATEUR ==========

// Profil
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        id: req.user._id,
        email: req.user.email,
        balance: req.user.balance,
        isAdmin: req.user.isAdmin,
        createdAt: req.user.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dashboard Utilisateur
app.get('/api/user/dashboard', authMiddleware, async (req, res) => {
  try {
    const now = new Date();

    // Récupérer tous les achats de proxies de l'utilisateur
    const proxyPurchases = await Transaction.find({
      userId: req.userId,
      type: 'purchase',
      proxyDetails: { $exists: true, $ne: null }
    }).sort({ createdAt: -1 });

    // Construire la liste des proxies avec leur statut d'expiration
    const proxiesList = proxyPurchases.map(t => {
      const pd = t.proxyDetails || {};
      const expiresAt = pd.expiresAt ? new Date(pd.expiresAt) : null;
      const daysRemaining = expiresAt
        ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24))
        : null;

      let status = 'active';
      if (expiresAt) {
        if (expiresAt < now) status = 'expired';
        else if (daysRemaining <= 7) status = 'expiring_soon';
      }

      return {
        id: t._id,
        type: pd.type || 'residential',
        packageName: pd.packageName || pd.name || t.description || 'Proxy',
        host: pd.host || null,
        port: pd.port || null,
        username: pd.username || null,
        password: pd.password || null,
        protocol: pd.protocol || 'http',
        country: pd.country || null,
        purchaseDate: t.createdAt,
        expiresAt: expiresAt,
        daysRemaining: daysRemaining,
        status,
        amount: t.amount
      };
    });

    // Calculer les stats
    const proxySummary = {
      totalProxies: proxiesList.length,
      active: proxiesList.filter(p => p.status === 'active').length,
      expiringSoon: proxiesList.filter(p => p.status === 'expiring_soon').length,
      expired: proxiesList.filter(p => p.status === 'expired').length
    };

    // Récupérer les alertes
    const recentAlerts = await ExpirationAlert.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(5);

    // Transactions récentes (toutes, pas que les achats)
    const recentTransactions = await Transaction.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      user: {
        email: req.user.email,
        balance: req.user.balance,
        createdAt: req.user.createdAt
      },
      proxies: proxySummary,
      proxiesList,
      alerts: recentAlerts.map(a => ({
        id: a._id,
        type: a.alertType,
        message: `Proxy ${a.proxyDetails?.type || ''} expire dans ${a.proxyDetails?.daysRemaining ?? '?'} jours`,
        createdAt: a.createdAt
      })),
      transactions: recentTransactions.map(t => ({
        type: t.type,
        amount: t.amount,
        description: t.description,
        createdAt: t.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ROUTES PROXY EXPIRATION ==========
app.use('/api', proxyExpirationRoutes);

// ========== CRON JOBS POUR L'EXPIRATION ==========

// Mettre à jour les statuts (toutes les heures)
cron.schedule('0 * * * *', async () => {
  console.log('📅 Mise à jour automatique des statuts des proxies...');
  try {
    await ProxyExpirationService.updateProxyStatuses();
  } catch (error) {
    console.error('❌ Erreur lors de la mise à jour:', error);
  }
});

// Créer les alertes (8h et 14h)
cron.schedule('0 8,14 * * *', async () => {
  console.log('🔔 Création des alertes d\'expiration...');
  try {
    await ProxyExpirationService.createExpirationAlerts();
  } catch (error) {
    console.error('❌ Erreur lors de la création des alertes:', error);
  }
});

// Envoyer les alertes (9h, 15h, 21h)
cron.schedule('0 9,15,21 * * *', async () => {
  console.log('📧 Envoi des alertes en attente...');
  try {
    await ProxyExpirationService.sendPendingAlerts();
  } catch (error) {
    console.error('❌ Erreur lors de l\'envoi des alertes:', error);
  }
});

// Traiter les auto-renewals (6h et 18h)
cron.schedule('0 6,18 * * *', async () => {
  console.log('🔄 Traitement des renouvellements automatiques...');
  try {
    const count = await ProxyExpirationService.processScheduledAutoRenewals();
    console.log(`✅ ${count} renouvellements automatiques traités`);
  } catch (error) {
    console.error('❌ Erreur lors du traitement des renouvellements:', error);
  }
});

// Analytics (23h)
cron.schedule('0 23 * * *', async () => {
  console.log('📊 Génération des analytics d\'expiration...');
  try {
    await ProxyExpirationService.generateExpirationAnalytics();
  } catch (error) {
    console.error('❌ Erreur lors de la génération des analytics:', error);
  }
});

console.log('✅ Cron jobs initialisés');

// ========== ROUTE SANTÉ ==========
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API en ligne',
    timestamp: new Date(),
    uptime: process.uptime()
  });
});

// ========== GESTION ERREURS ==========
app.use((err, req, res, next) => {
  console.error('❌ Erreur:', err);
  res.status(500).json({
    error: 'Erreur serveur interne',
    message: err.message
  });
});

// ========== DÉMARRAGE ==========
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                   🚀 PROXYFLOW API DÉMARRÉE                   ║
╠════════════════════════════════════════════════════════════════╣
║  Port:                  ${PORT}                                   ║
║  Environnement:         ${process.env.NODE_ENV || 'development'}        ║
║  MongoDB:               ✅ Connectée                           ║
║  Cron Jobs:             ✅ 5 tâches actives                   ║
║  Email (Brevo):         ✅ Configuré                          ║
╠════════════════════════════════════════════════════════════════╣
║  Dashboard:             http://localhost:${PORT}/dashboard.html  ║
║  API Docs:              http://localhost:${PORT}/api/health   ║
╚════════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
