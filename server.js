require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
// ========== BREVO (ex-Sendinblue) EMAIL ==========
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

    console.log(`✅ Email Brevo envoyé à ${to} | messageId: ${response.data.messageId}`);
    return response.data;

  } catch (err) {
    const status = err.response?.status;
    const body = JSON.stringify(err.response?.data);
    console.error(`❌ Brevo erreur [${status}] → ${body}`);
    console.error(`   → From: ${BREVO_FROM_EMAIL} | To: ${to} | Subject: ${subject}`);
    console.error(`   → API Key définie: ${!!BREVO_API_KEY} (commence par: ${(BREVO_API_KEY || '').slice(0, 8)}...)`);
    throw new Error(`Brevo [${status}]: ${body}`);
  }
}

// Vérifie et incrémente le rate limit email (3 emails / 10 min par user)
async function checkEmailRateLimit(user) {
  const now = new Date();
  const windowMs = 10 * 60 * 1000; // 10 minutes

  // Réinitialiser la fenêtre si expirée
  if (!user.emailSentWindowStart || (now - user.emailSentWindowStart) > windowMs) {
    user.emailSentCount = 0;
    user.emailSentWindowStart = now;
  }

  if (user.emailSentCount >= 3) {
    const waitMs = windowMs - (now - user.emailSentWindowStart);
    const waitMin = Math.ceil(waitMs / 60000);
    throw new Error(`RATE_LIMIT:${waitMin}`);
  }

  user.emailSentCount += 1;
  await user.save();
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${FRONTEND_URL}/verify-email.html?token=${token}`;
  await sendEmailViaBrevo(
    email,
    '✅ Vérifiez votre adresse email - ProxyFlow',
    `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;"><div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 10px rgba(0,0,0,0.1);"><div style="text-align:center;margin-bottom:30px;"><h1 style="color:#6366f1;font-size:28px;margin:0;">🌐 ProxyFlow</h1></div><h2 style="color:#1f2937;margin-bottom:10px;">Vérifiez votre email</h2><p style="color:#6b7280;line-height:1.6;">Merci de vous être inscrit ! Cliquez sur le bouton ci-dessous pour activer votre compte.</p><div style="text-align:center;margin:35px 0;"><a href="${verifyUrl}" style="background:#6366f1;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block;">✅ Vérifier mon email</a></div><p style="color:#9ca3af;font-size:13px;text-align:center;">Ce lien expire dans 24 heures.</p><hr style="border:none;border-top:1px solid #e5e7eb;margin:25px 0;"><p style="color:#9ca3af;font-size:12px;text-align:center;">Si vous n'avez pas créé de compte, ignorez cet email.</p></div></body></html>`
  );
}

async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${FRONTEND_URL}/forgot-password.html?token=${token}`;
  await sendEmailViaBrevo(
    email,
    '🔐 Réinitialisation de votre mot de passe - ProxyFlow',
    `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f4f4f4;padding:30px;"><div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 10px rgba(0,0,0,0.1);"><div style="text-align:center;margin-bottom:30px;"><h1 style="color:#6366f1;font-size:28px;margin:0;">🌐 ProxyFlow</h1></div><h2 style="color:#1f2937;margin-bottom:10px;">Réinitialiser votre mot de passe</h2><p style="color:#6b7280;line-height:1.6;">Vous avez demandé à réinitialiser votre mot de passe. Cliquez sur le bouton ci-dessous pour en choisir un nouveau.</p><div style="text-align:center;margin:35px 0;"><a href="${resetUrl}" style="background:#ef4444;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block;">🔐 Réinitialiser le mot de passe</a></div><p style="color:#9ca3af;font-size:13px;text-align:center;">Ce lien expire dans 1 heure.</p><hr style="border:none;border-top:1px solid #e5e7eb;margin:25px 0;"><p style="color:#9ca3af;font-size:12px;text-align:center;">Si vous n'avez pas fait cette demande, ignorez cet email. Votre mot de passe reste inchangé.</p></div></body></html>`
  );
}

const app = express();
const PORT = process.env.PORT || 5000;

// CORS Configuration
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

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ MongoDB erreur:', err));

// Models
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
  emailSentCount: { type: Number, default: 0 },
  emailSentWindowStart: { type: Date, default: null },
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

const ProxyPurchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  proxyId: { type: Number },
  packageType: { type: String },
  duration: { type: Number },
  price: { type: Number },
  username: { type: String },
  password: { type: String },
  host: { type: String },
  port: { type: Number },
  protocol: { type: String },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const ProxyPurchase = mongoose.model('ProxyPurchase', ProxyPurchaseSchema);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-this';

// Middleware d'authentification
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User invalide' });

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token invalide' });
  }
};

// Middleware admin
const adminMiddleware = (req, res, next) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Accès refusé - Admin requis' });
  }
  next();
};

// Variables globales API
const API_BASE_URL = process.env.API_BASE_URL;
let authToken = null;
let tokenExpireAt = 0;

const PRICES = {
  golden: {
    name: "Golden Package",
    package_id: parseInt(process.env.GOLDEN_PACKAGE_ID) || 1,
    description: "Possibilité de changer de pays",
    prices: [
      { duration: 0.02, label: "2 heures", price: 0.30 },
      { duration: 0.12, label: "12 heures", price: 0.60 },
      { duration: 3, label: "3 jours", price: 2.5 },
      { duration: 7, label: "7 jours", price: 4.5 },
      { duration: 15, label: "15 jours", price: 10 },
      { duration: 30, label: "30 jours", price: 18 }
    ]
  },
  silver: {
    name: "Silver Package",
    package_id: parseInt(process.env.SILVER_PACKAGE_ID) || 2,
    description: "Pays fixe",
    prices: [
      { duration: 2, label: "2 jours", price: 1.5 },
      { duration: 7, label: "7 jours", price: 4 },
      { duration: 30, label: "30 jours", price: 12 }
    ]
  }
};

// Fonction pour obtenir le token API
async function getAuthToken() {
  const now = Date.now() / 1000;
  
  if (authToken && tokenExpireAt > now + 300) {
    return authToken;
  }

  try {
    const response = await axios.post(`${API_BASE_URL}/login`, {
      email: process.env.API_EMAIL,
      password: process.env.API_PASSWORD
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    authToken = response.data.token;
    tokenExpireAt = response.data.expire_at;
    return authToken;
  } catch (error) {
    throw error;
  }
}

// Requête API authentifiée
async function apiRequest(method, endpoint, data = null, params = null) {
  const token = await getAuthToken();
  
  const config = {
    method,
    url: `${API_BASE_URL}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  };

  if (data) config.data = data;
  if (params) config.params = params;

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response?.status === 401) {
      authToken = null;
      const newToken = await getAuthToken();
      config.headers.Authorization = `Bearer ${newToken}`;
      const response = await axios(config);
      return response.data;
    }
    throw error;
  }
}

// ========== ROUTES AUTHENTIFICATION ==========

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et password requis' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email déjà utilisé' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Générer un token de vérification unique
    const verificationToken = jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });

    const user = new User({
      email,
      password: hashedPassword,
      balance: 0,
      isEmailVerified: false,
      emailVerificationToken: verificationToken,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000)
    });

    await user.save();

    // Envoyer l'email de vérification
    try {
      await checkEmailRateLimit(user);
      await sendVerificationEmail(email, verificationToken);
    } catch (emailError) {
      console.error('Erreur envoi email vérification:', emailError.message);
    }

    res.json({
      message: `📧 Compte créé ! Un email de vérification a été envoyé à ${email}. Cliquez sur le lien pour activer votre compte.`,
      emailSent: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // Vérifier si l'email est confirmé (sauf pour les admins)
    if (!user.isEmailVerified && !user.isAdmin) {
      return res.status(403).json({ 
        error: 'Veuillez vérifier votre email avant de vous connecter.',
        emailNotVerified: true
      });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        balance: user.balance,
        isAdmin: user.isAdmin
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({
    id: req.user._id,
    email: req.user.email,
    balance: req.user.balance,
    isAdmin: req.user.isAdmin
  });
});

// ========== VÉRIFICATION EMAIL ==========

app.get('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token manquant' });

    // Vérifier le JWT
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'Lien expiré ou invalide. Demandez un nouvel email de vérification.' });
    }

    const user = await User.findOne({ emailVerificationToken: token });
    if (!user) {
      return res.status(400).json({ error: 'Lien déjà utilisé ou invalide.' });
    }

    if (user.isEmailVerified) {
      return res.json({ message: 'Email déjà vérifié. Vous pouvez vous connecter.' });
    }

    user.isEmailVerified = true;
    user.emailVerificationToken = null;
    user.emailVerificationExpires = null;
    await user.save();

    res.json({ message: 'Email vérifié avec succès ! Vous pouvez maintenant vous connecter.' });
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
    if (!user) return res.status(404).json({ error: 'Aucun compte trouvé avec cet email.' });
    if (user.isEmailVerified) return res.status(400).json({ error: 'Votre email est déjà vérifié. Vous pouvez vous connecter.' });

    // Rate limit
    try {
      await checkEmailRateLimit(user);
    } catch (e) {
      if (e.message.startsWith('RATE_LIMIT:')) {
        const wait = e.message.split(':')[1];
        return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${wait} minute(s).` });
      }
      throw e;
    }

    const verificationToken = jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });
    user.emailVerificationToken = verificationToken;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    await sendVerificationEmail(email, verificationToken);
    res.json({ message: `📧 Email de vérification envoyé à ${email}. Vérifiez votre boîte mail (et les spams).` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== MOT DE PASSE OUBLIÉ ==========

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const user = await User.findOne({ email });
    // Toujours répondre OK pour ne pas révéler si l'email existe
    if (!user) {
      return res.json({ message: '📧 Si cet email est associé à un compte, vous recevrez un lien de réinitialisation sous peu.' });
    }

    // Rate limit
    try {
      await checkEmailRateLimit(user);
    } catch (e) {
      if (e.message.startsWith('RATE_LIMIT:')) {
        const wait = e.message.split(':')[1];
        return res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${wait} minute(s).` });
      }
      throw e;
    }

    const resetToken = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '1h' });
    user.passwordResetToken = resetToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();

    try {
      await sendPasswordResetEmail(email, resetToken);
    } catch (emailError) {
      console.error('Erreur envoi email reset:', emailError.message);
      return res.status(500).json({ error: "Erreur lors de l'envoi de l'email. Réessayez dans quelques instants." });
    }

    res.json({ message: '📧 Un lien de réinitialisation a été envoyé à ' + email + '. Vérifiez votre boîte mail (et les spams). Ce lien expire dans 1 heure.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token et nouveau mot de passe requis' });
    if (password.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });

    // Vérifier le JWT
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'Lien expiré ou invalide. Demandez un nouveau lien.' });
    }

    const user = await User.findOne({ passwordResetToken: token });
    if (!user) {
      return res.status(400).json({ error: 'Lien déjà utilisé ou invalide.' });
    }

    if (user.passwordResetExpires < new Date()) {
      return res.status(400).json({ error: 'Lien expiré. Demandez un nouveau lien de réinitialisation.' });
    }

    user.password = await bcrypt.hash(password, 10);
    user.passwordResetToken = null;
    user.passwordResetExpires = null;
    await user.save();

    res.json({ message: 'Mot de passe réinitialisé avec succès ! Vous pouvez maintenant vous connecter.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ROUTES ADMIN ==========

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/add-credit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, amount, description } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'UserId et amount positif requis' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User non trouvé' });
    }

    const balanceBefore = user.balance;
    user.balance += parseFloat(amount);
    await user.save();

    await new Transaction({
      userId: user._id,
      type: 'credit',
      amount: parseFloat(amount),
      description: description || 'Crédit ajouté par admin',
      balanceBefore,
      balanceAfter: user.balance
    }).save();

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        balance: user.balance
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/remove-credit', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, amount, description } = req.body;

    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'UserId et amount positif requis' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User non trouvé' });
    }

    const balanceBefore = user.balance;
    user.balance -= parseFloat(amount);
    if (user.balance < 0) user.balance = 0;
    await user.save();

    await new Transaction({
      userId: user._id,
      type: 'debit',
      amount: parseFloat(amount),
      description: description || 'Crédit retiré par admin',
      balanceBefore,
      balanceAfter: user.balance
    }).save();

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        balance: user.balance
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/promote', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User non trouvé' });

    user.isAdmin = true;
    await user.save();

    res.json({ success: true, user: { id: user._id, email: user.email, isAdmin: user.isAdmin } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const totalProxies = await ProxyPurchase.countDocuments();
    const totalRevenue = await Transaction.aggregate([
      { $match: { type: 'purchase' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      totalUsers,
      totalProxies,
      totalRevenue: totalRevenue[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== ROUTES PROXIES ==========

app.get('/api/prices', (req, res) => {
  res.json(PRICES);
});

app.get('/api/countries', authMiddleware, async (req, res) => {
  try {
    const { pkg_id } = req.query;
    const data = await apiRequest('GET', '/countries', null, { pkg_id });
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/cities', authMiddleware, async (req, res) => {
  try {
    const { country_id, pkg_id } = req.query;
    const data = await apiRequest('GET', '/cities', null, { country_id, pkg_id });
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/service-providers', authMiddleware, async (req, res) => {
  try {
    const { city_id, pkg_id } = req.query;
    const data = await apiRequest('GET', '/service-providers', null, { city_id, pkg_id });
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/parent-proxies', authMiddleware, async (req, res) => {
  try {
    const { offset = 0, pkg_id, service_provider_city_id, country_id } = req.query;
    
    const params = { offset, pkg_id };
    
    // ✅ Ajoute country_id s'il existe
    if (country_id) {
      params.country_id = parseInt(country_id);
    }
    
    if (service_provider_city_id) {
      params.service_provider_city_id = service_provider_city_id;
    }
    
    const data = await apiRequest('GET', '/parent-proxies', null, params);
    
    let proxies = [];
    if (Array.isArray(data)) {
      proxies = data;
    } else if (data && data.list) {
      proxies = data.list;
    } else if (data && data.data) {
      proxies = data.data;
    } else if (data && data.proxies) {
      proxies = data.proxies;
    }
    
    res.json(proxies);
  } catch (error) {
    res.json([]);
  }
});

app.get('/api/check-username', authMiddleware, async (req, res) => {
  try {
    const { username } = req.query;
    const data = await apiRequest('GET', '/check-username', null, { username });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/create-proxy', authMiddleware, async (req, res) => {
  try {
    const { parent_proxy_id, package_id, protocol, duration, username, password, ip_addr } = req.body;

    // ✅ VALIDATION 1 : Champs obligatoires
    if (!username || !password) {
      return res.status(400).json({ error: 'Username et Password sont obligatoires pour éviter des erreurs' });
    }

    // ✅ VALIDATION 2 : Format minuscules uniquement
    const validPattern = /^[a-z0-9_-]+$/;
    
    if (!validPattern.test(username)) {
      return res.status(400).json({ 
        error: 'Username doit contenir uniquement des lettres minuscules, chiffres, _ et -' 
      });
    }
    
    if (!validPattern.test(password)) {
      return res.status(400).json({ 
        error: 'Password doit contenir uniquement des lettres minuscules, chiffres, _ et -' 
      });
    }

    // ✅ VALIDATION 3 : Vérifier si les credentials existent déjà dans notre BDD
    const existingProxy = await ProxyPurchase.findOne({
      $or: [
        { username: username },
        { password: password },
        { username: username, password: password }
      ]
    });

    if (existingProxy) {
      return res.status(409).json({ 
        error: 'Ces identifiants sont déjà utilisés. Veuillez en choisir d\'autres.' 
      });
    }

    // Calcul du prix
    let price = 0;
    for (const pkg of Object.values(PRICES)) {
      if (pkg.package_id === parseInt(package_id)) {
        const priceObj = pkg.prices.find(p => p.duration === parseFloat(duration));
        if (priceObj) price = priceObj.price;
      }
    }
    if (price === 0) return res.status(400).json({ error: 'Prix non trouvé' });

    // Vérification solde
    if (req.user.balance < price) {
      return res.status(400).json({ 
        error: 'Solde insuffisant', 
        required: price, 
        balance: req.user.balance 
      });
    }

    // Préparer les données pour l'API externe
    const proxyData = {
      parent_proxy_id,
      package_id: parseInt(package_id),
      protocol,
      duration: parseFloat(duration),
      username: username.toLowerCase(), // ✅ Force minuscules
      password: password.toLowerCase()  // ✅ Force minuscules
    };

    if (ip_addr) {
      proxyData.ip_addr = ip_addr;
    }

    // Achat via API externe
    const token = await getAuthToken();
    let apiResponse;
    
    try {
      apiResponse = await axios.post(`${API_BASE_URL}/proxies`, proxyData, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }).then(r => r.data);
    } catch (apiError) {
      // ✅ Gérer les erreurs spécifiques de l'API externe
      const errorMsg = apiError.response?.data?.message || apiError.message;
      
      // Si l'API externe dit que c'est un duplicate
      if (errorMsg.toLowerCase().includes('already') || 
          errorMsg.toLowerCase().includes('exist') ||
          errorMsg.toLowerCase().includes('duplicate')) {
        return res.status(409).json({ 
          error: 'Ces identifiants sont déjà utilisés sur le système. Veuillez en choisir d\'autres.' 
        });
      }
      
      // Autre erreur API
      throw apiError;
    }

    // Déduction du solde utilisateur
    const balanceBefore = req.user.balance;
    req.user.balance -= price;
    await req.user.save();

    // Enregistrer transaction
    await new Transaction({
      userId: req.user._id,
      type: 'purchase',
      amount: price,
      description: `Achat proxy ${protocol} - ${duration} jour(s)`,
      balanceBefore,
      balanceAfter: req.user.balance,
      proxyDetails: apiResponse
    }).save();

    // Enregistrer proxy acheté
    await new ProxyPurchase({
      userId: req.user._id,
      proxyId: apiResponse.id,
      packageType: parseInt(package_id) === 1 ? 'golden' : 'silver',
      duration: parseFloat(duration),
      price,
      username: apiResponse.username || username.toLowerCase(),
      password: apiResponse.password || password.toLowerCase(),
      host: apiResponse.ip_addr,
      port: apiResponse.port,
      protocol: apiResponse.type,
      expiresAt: apiResponse.expire_at
    }).save();

    res.json({
      success: true,
      proxy: apiResponse,
      userBalance: req.user.balance
    });

  } catch (error) {
    console.error('Erreur create-proxy:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message 
    });
  }
});

app.put('/api/proxies/:id/change-parent', authMiddleware, async (req, res) => {
  try {
    const { parent_proxy_id, protocol } = req.body;  // ✅ Extraire protocol
    
    const proxy = await ProxyPurchase.findOne({ 
      _id: req.params.id,
      userId: req.user._id 
    });

    if (!proxy) {
      return res.status(404).json({ error: 'Proxy non trouvé' });
    }

    if ((proxy.packageType || '').toLowerCase() !== 'golden') {
      return res.status(403).json({ error: 'Seuls les Golden Packages peuvent changer de pays' });
    }

    if (!parent_proxy_id) {
      return res.status(400).json({ error: 'Parent proxy requis' });
    }

    // ✅ Normaliser le protocol pour l'API externe : "http" ou "socks" (pas "SOCKS5")
    let apiProtocol = (protocol || proxy.protocol || 'http').toLowerCase();
    if (apiProtocol.includes('socks')) apiProtocol = 'socks';  // socks5 → socks
    if (apiProtocol.includes('http')) apiProtocol = 'http';

    const token = await getAuthToken();
    const apiResponse = await axios.put(
      `${API_BASE_URL}/proxies/${proxy.proxyId}`,
      { 
        parent_proxy_id: parseInt(parent_proxy_id),
        protocol: apiProtocol   // ✅ AJOUTÉ !
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    ).then(r => r.data);

    // Mettre à jour dans notre BDD
    proxy.host = apiResponse.ip_addr || proxy.host;
    proxy.port = apiResponse.port || proxy.port;
    proxy.username = apiResponse.username || proxy.username;
    proxy.password = apiResponse.password || proxy.password;
    proxy.protocol = apiResponse.type || proxy.protocol;
    proxy.expiresAt = apiResponse.expire_at || proxy.expiresAt;
    
    await proxy.save();

    res.json({
      success: true,
      message: '🌍 Localisation changée avec succès!',
      proxy: apiResponse
    });

  } catch (error) {
    console.error('❌ Erreur:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    
    res.status(error.response?.status || 500).json({ 
      error: error.response?.data?.message || error.message
    });
  }
});

// Mes proxies - retourne les proxies de la BDD locale ET de l'API
app.get('/api/my-proxies', authMiddleware, async (req, res) => {
  try {
    // Récupérer les proxies de la base de données locale
    const localProxies = await ProxyPurchase.find({ userId: req.user._id }).sort({ createdAt: -1 });
    
    // Essayer de récupérer aussi depuis l'API externe (si disponible)
    try {
      const apiProxies = await apiRequest('GET', '/all-proxies', null, { offset: 0 });
      // Combiner les deux sources si nécessaire
      // Pour l'instant on retourne juste les locaux car l'API externe nécessite un compte différent
    } catch (apiError) {
      console.log('API externe non disponible, utilisation BDD locale uniquement');
    }
    
    res.json(localProxies);
  } catch (error) {
    console.error('Erreur my-proxies:', error);
    res.json([]);
  }
});

// Transactions - retourne les transactions de la BDD locale
app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (error) {
    console.error('Erreur transactions:', error);
    res.json([]);
  }
});

// ========== DASHBOARD UTILISATEUR ==========
app.get('/api/user/dashboard', authMiddleware, async (req, res) => {
  try {
    const user = req.user;

    // Récupérer les proxies de l'utilisateur
    const proxiesList = await ProxyPurchase.find({ userId: user._id }).sort({ createdAt: -1 });

    // Calculer les stats en fonction de la date d'expiration
    const now = new Date();
    let active = 0, expiringSoon = 0, expired = 0;

    const formattedProxies = proxiesList.map(p => {
      const expiresAt = p.expiresAt ? new Date(p.expiresAt) : null;
      let status = 'active';
      let daysRemaining = null;

      if (expiresAt) {
        const diffMs = expiresAt - now;
        daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        if (daysRemaining <= 0) {
          status = 'expired';
          expired++;
        } else if (daysRemaining <= 7) {
          status = 'expiring_soon';
          expiringSoon++;
        } else {
          status = 'active';
          active++;
        }
      } else {
        active++;
      }

      return {
        id: p._id,
        proxyId: p.proxyId,
        type: (p.protocol || 'HTTP').toUpperCase(),
        packageName: p.packageType || '—',
        host: p.host,
        port: p.port,
        username: p.username,
        password: p.password,
        protocol: p.protocol,
        purchaseDate: p.createdAt,
        expiresAt: p.expiresAt,
        daysRemaining,
        status
      };
    });

    // Générer les alertes pour proxies qui expirent bientôt
    const alerts = formattedProxies
      .filter(p => p.status === 'expiring_soon' || p.status === 'expired')
      .map(p => ({
        message: p.status === 'expired'
          ? `⚠️ Proxy ${p.type} expiré depuis ${Math.abs(p.daysRemaining)} jour(s)`
          : `🔔 Proxy ${p.type} expire dans ${p.daysRemaining} jour(s)`,
        createdAt: new Date()
      }));

    // Récupérer les dernières transactions
    const transactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      user: {
        id: user._id,
        email: user.email,
        balance: user.balance,
        isAdmin: user.isAdmin
      },
      proxies: {
        active,
        expiringSoon,
        expired,
        totalProxies: proxiesList.length
      },
      proxiesList: formattedProxies,
      alerts,
      transactions
    });

  } catch (error) {
    console.error('Erreur dashboard:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const data = await apiRequest('GET', '/service-stats');
    res.json(data);
  } catch (error) {
    res.json({ countries: 0, cities: 0, proxies: 0, service_providers: 0 });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Page d'accueil
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Proxy Shop API</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
          }
          .container {
            text-align: center;
            background: rgba(255,255,255,0.1);
            padding: 50px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
          }
          h1 { font-size: 48px; margin-bottom: 10px; }
          p { font-size: 18px; opacity: 0.9; margin-bottom: 30px; }
          .links { display: flex; gap: 15px; justify-content: center; flex-wrap: wrap; }
          a {
            display: inline-block;
            background: white;
            color: #667eea;
            padding: 15px 30px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: bold;
            transition: all 0.3s;
          }
          a:hover {
            transform: translateY(-3px);
            box-shadow: 0 5px 15px rgba(255,255,255,0.3);
          }
          .status {
            background: rgba(76, 175, 80, 0.3);
            padding: 10px 20px;
            border-radius: 20px;
            display: inline-block;
            margin-top: 20px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🌐 Proxy Shop API</h1>
          <p>Backend opérationnel et prêt</p>
          <div class="links">
            <a href="/admin.html">👑 Panel Admin</a>
            <a href="/health">🏥 Health Check</a>
          </div>
          <div class="status">✅ Système actif</div>
        </div>
      </body>
    </html>
  `);
});

// Créer le premier admin
async function createDefaultAdmin() {
  try {
    const adminExists = await User.findOne({ isAdmin: true });
    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await new User({
        email: 'admin@proxyshop.com',
        password: hashedPassword,
        balance: 0,
        isAdmin: true,
        isEmailVerified: true
      }).save();
      console.log('\n👑 Admin créé: admin@proxyshop.com / admin123');
    }
  } catch (error) {
    console.error('Erreur création admin:', error.message);
  }
}
// Modèle Recharge
const RechargeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  faucetpayUsername: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const Recharge = mongoose.model('Recharge', RechargeSchema);

// Route pour récupérer l'historique des recharges de l'utilisateur
app.get('/api/my-recharges', authMiddleware, async (req, res) => {
  try {
    const recharges = await Recharge.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(recharges);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route pour créer une demande de recharge
app.post('/api/recharge-request', authMiddleware, async (req, res) => {
  try {
    const { amount, faucetpayUsername } = req.body;

    if (!amount || amount < 0.5) {
      return res.status(400).json({ error: 'Montant minimum : 0.50$' });
    }
    if (!faucetpayUsername) {
      return res.status(400).json({ error: 'Nom d’utilisateur FaucetPay requis' });
    }

    const recharge = new Recharge({
      userId: req.user._id,
      amount,
      faucetpayUsername
    });

    await recharge.save();

    res.json({ success: true, message: 'Demande envoyée. En attente de validation admin.' });

  } catch (error) {
    console.error('Erreur recharge-request:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route admin pour voir les demandes
app.get('/api/admin/recharges', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const recharges = await Recharge.find()
      .populate('userId', 'email balance')
      .sort({ createdAt: -1 });

    // Transformer pour le frontend
    const formatted = recharges.map(r => ({
      ...r._doc,
      userEmail: r.userId?.email || 'N/A'
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route admin pour valider une recharge
app.post('/api/admin/recharges/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const recharge = await Recharge.findById(req.params.id);
    if (!recharge) return res.status(404).json({ error: 'Demande non trouvée' });

    if (recharge.status !== 'pending') {
      return res.status(400).json({ error: 'Demande déjà traitée' });
    }

    const user = await User.findById(recharge.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const balanceBefore = user.balance;
    user.balance += recharge.amount;
    await user.save();

    recharge.status = 'approved';
    await recharge.save();

    // Enregistrer la transaction
    await new Transaction({
      userId: user._id,
      type: 'credit',
      amount: recharge.amount,
      description: `Recharge validée par admin (${recharge.faucetpayUsername})`,
      balanceBefore,
      balanceAfter: user.balance
    }).save();

    res.json({ success: true, message: 'Recharge approuvée', newBalance: user.balance });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Route admin pour rejeter une recharge
app.post('/api/admin/recharges/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const recharge = await Recharge.findById(req.params.id);
    if (!recharge) return res.status(404).json({ error: 'Demande non trouvée' });

    if (recharge.status !== 'pending') {
      return res.status(400).json({ error: 'Demande déjà traitée' });
    }

    recharge.status = 'rejected';
    await recharge.save();

    res.json({ success: true, message: 'Recharge rejetée' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ========== COMMANDES MANUELLES (Datacenter, Residential, Static ISP) ==========

const ManualOrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, required: true }, // datacenter | residential | residential_pro | static_isp
  typeLabel: { type: String, required: true },
  volume: { type: String, required: true }, // ex: "10 GB" ou "5 IPs"
  totalPrice: { type: Number, required: true },
  notes: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'processing', 'delivered', 'cancelled'], default: 'pending' },
  deliveryNotes: { type: String, default: '' }, // notes admin lors de la livraison
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const ManualOrder = mongoose.model('ManualOrder', ManualOrderSchema);

// Passer une commande manuelle (côté client)
app.post('/api/manual-order', authMiddleware, async (req, res) => {
  try {
    const { type, typeLabel, volume, totalPrice, notes } = req.body;

    if (!type || !typeLabel || !volume || !totalPrice) {
      return res.status(400).json({ error: 'Données de commande incomplètes' });
    }

    if (totalPrice <= 0) {
      return res.status(400).json({ error: 'Prix invalide' });
    }

    // Vérification solde
    if (req.user.balance < totalPrice) {
      return res.status(400).json({
        error: `Solde insuffisant. Il vous faut $${totalPrice.toFixed(2)}, vous avez $${req.user.balance.toFixed(2)}.`,
        required: totalPrice,
        balance: req.user.balance
      });
    }

    // Débiter le solde
    const balanceBefore = req.user.balance;
    req.user.balance = parseFloat((req.user.balance - totalPrice).toFixed(2));
    await req.user.save();

    // Créer la commande
    const order = new ManualOrder({
      userId: req.user._id,
      type,
      typeLabel,
      volume,
      totalPrice,
      notes: notes || ''
    });
    await order.save();

    // Enregistrer transaction
    await new Transaction({
      userId: req.user._id,
      type: 'purchase',
      amount: totalPrice,
      description: `Commande ${typeLabel} - ${volume}`,
      balanceBefore,
      balanceAfter: req.user.balance,
      proxyDetails: { orderId: order._id, type, volume }
    }).save();

    res.json({
      success: true,
      message: `Commande envoyée ! Notre équipe va vous livrer vos proxies ${typeLabel} sous peu.`,
      orderId: order._id,
      userBalance: req.user.balance
    });

  } catch (error) {
    console.error('Erreur manual-order:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mes commandes manuelles (côté client)
app.get('/api/my-manual-orders', authMiddleware, async (req, res) => {
  try {
    const orders = await ManualOrder.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ========== ROUTES ADMIN - COMMANDES MANUELLES ==========

// Lister toutes les commandes manuelles
app.get('/api/admin/manual-orders', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const orders = await ManualOrder.find()
      .populate('userId', 'email balance')
      .sort({ createdAt: -1 });

    const formatted = orders.map(o => ({
      ...o._doc,
      userEmail: o.userId?.email || 'N/A'
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Marquer comme "en cours"
app.post('/api/admin/manual-orders/:id/processing', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const order = await ManualOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée' });

    order.status = 'processing';
    order.updatedAt = new Date();
    await order.save();

    res.json({ success: true, message: 'Commande marquée en traitement' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Livrer une commande (marquer delivered + ajouter notes)
app.post('/api/admin/manual-orders/:id/deliver', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { deliveryNotes } = req.body;
    const order = await ManualOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée' });

    if (order.status === 'delivered') {
      return res.status(400).json({ error: 'Commande déjà livrée' });
    }

    order.status = 'delivered';
    order.deliveryNotes = deliveryNotes || '';
    order.updatedAt = new Date();
    await order.save();

    // Enregistrer un proxy manuel dans ProxyPurchase pour que le client le voit dans "Mes proxies"
    if (deliveryNotes) {
      await new ProxyPurchase({
        userId: order.userId,
        packageType: order.type,
        price: order.totalPrice,
        host: deliveryNotes, // les credentials/infos de connexion dans le champ host
        port: 0,
        username: '',
        password: '',
        protocol: 'http',
        expiresAt: null
      }).save();
    }

    res.json({ success: true, message: 'Commande livrée avec succès' });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Annuler une commande + rembourser
app.post('/api/admin/manual-orders/:id/cancel', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const order = await ManualOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée' });

    if (['delivered', 'cancelled'].includes(order.status)) {
      return res.status(400).json({ error: 'Commande déjà traitée ou annulée' });
    }

    const user = await User.findById(order.userId);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    // Rembourser
    const balanceBefore = user.balance;
    user.balance = parseFloat((user.balance + order.totalPrice).toFixed(2));
    await user.save();

    order.status = 'cancelled';
    order.updatedAt = new Date();
    await order.save();

    // Transaction remboursement
    await new Transaction({
      userId: user._id,
      type: 'credit',
      amount: order.totalPrice,
      description: `Remboursement commande annulée - ${order.typeLabel} ${order.volume}`,
      balanceBefore,
      balanceAfter: user.balance
    }).save();

    res.json({ success: true, message: 'Commande annulée et remboursée', newBalance: user.balance });
  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// Démarrage
app.listen(PORT, async () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║    PROXY SHOP API - SERVEUR ACTIF      ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n🌐 Backend URL: http://localhost:${PORT}`);
  console.log(`📋 Panel Admin: http://localhost:${PORT}/admin.html`);
  console.log(`🔗 Frontend autorisé: ${process.env.FRONTEND_URL || 'localhost'}`);
  
  try {
    await getAuthToken();
    await createDefaultAdmin();
    console.log('\n✅ Système prêt!\n');
  } catch (error) {
    console.log('\n⚠️  Vérifiez le .env\n');
  }
});
