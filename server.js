require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;

// Config CORS
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

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connecté'))
  .catch(err => console.error('❌ MongoDB erreur:', err));

// --- MODELS ---
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
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
const JWT_SECRET = process.env.JWT_SECRET || 'GodistheKing';

// --- MIDDLEWARES ---
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

const adminMiddleware = (req, res, next) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Accès refusé - Admin requis' });
  next();
};

// --- API EXTERNE CONFIG ---
const API_BASE_URL = process.env.API_BASE_URL;
let authToken = null;
let tokenExpireAt = 0;

const PRICES = {
  golden: {
    name: "Golden Package",
    package_id: parseInt(process.env.GOLDEN_PACKAGE_ID) || 1,
    description: "Possibilité de changer de pays",
    prices: [
      { duration: 0.02, label: "2 heures", price: 0.25 },
      { duration: 0.12, label: "12 heures", price: 0.45 },
      { duration: 1, label: "1 jour", price: 0.7 },
      { duration: 3, label: "3 jours", price: 2 },
      { duration: 7, label: "7 jours", price: 4 },
      { duration: 15, label: "15 jours", price: 7.5 },
      { duration: 30, label: "30 jours", price: 14.5 }
    ]
  },
  silver: {
    name: "Silver Package",
    package_id: parseInt(process.env.SILVER_PACKAGE_ID) || 2,
    description: "Pays fixe",
    prices: [
      { duration: 2, label: "2 jours", price: 1.1 },
      { duration: 7, label: "7 jours", price: 3 },
      { duration: 30, label: "30 jours", price: 10 }
    ]
  }
};

async function getAuthToken() {
  const now = Date.now() / 1000;
  if (authToken && tokenExpireAt > now + 300) return authToken;

  const response = await axios.post(`${API_BASE_URL}/login`, {
    email: process.env.API_EMAIL,
    password: process.env.API_PASSWORD
  });

  authToken = response.data.token;
  tokenExpireAt = response.data.expire_at;
  return authToken;
}

async function apiRequest(method, endpoint, data = null, params = null) {
  const token = await getAuthToken();
  const config = {
    method,
    url: `${API_BASE_URL}${endpoint}`,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
    data,
    params
  };

  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response?.status === 401) {
      authToken = null;
      return apiRequest(method, endpoint, data, params);
    }
    throw error;
  }
}

// ========== ROUTES AUTHENTIFICATION ==========

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Champs requis' });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'Email déjà utilisé' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, password: hashedPassword, balance: 0 });
    await user.save();

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email: user.email, balance: user.balance, isAdmin: user.isAdmin } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, email: user.email, balance: user.balance, isAdmin: user.isAdmin } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({ id: req.user._id, email: req.user.email, balance: req.user.balance, isAdmin: req.user.isAdmin });
});

// ========== ROUTES ADMIN ==========

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const users = await User.find().select('-password').sort({ createdAt: -1 });
  res.json(users);
});

app.post('/api/admin/add-credit', authMiddleware, adminMiddleware, async (req, res) => {
  const { userId, amount, description } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: 'User non trouvé' });

  const balanceBefore = user.balance;
  user.balance += parseFloat(amount);
  await user.save();

  await new Transaction({
    userId: user._id,
    type: 'credit',
    amount: parseFloat(amount),
    description,
    balanceBefore,
    balanceAfter: user.balance
  }).save();

  res.json({ success: true, user: { email: user.email, balance: user.balance } });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const totalUsers = await User.countDocuments();
  const totalProxies = await ProxyPurchase.countDocuments();
  const rev = await Transaction.aggregate([
    { $match: { type: 'purchase' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  res.json({ totalUsers, totalProxies, totalRevenue: rev[0]?.total || 0 });
});

// ========== ROUTES PROXIES ==========

app.get('/api/prices', (req, res) => res.json(PRICES));

app.get('/api/countries', authMiddleware, async (req, res) => {
  try {
    const pkgId = parseInt(req.query.pkg_id, 10);
    if (!pkgId) return res.status(400).json({ error: 'pkg_id invalide' });

    const data = await apiRequest('GET', '/countries', null, {
      pkg_id: pkgId,
      email: process.env.API_EMAIL
    });

    res.json(data || []);
  } catch (e) {
    console.error("Erreur /api/countries:", e.response?.data || e.message);
    res.status(500).json({ error: 'Erreur chargement pays' });
  }
});

app.get('/api/cities', authMiddleware, async (req, res) => {
  try {
    const countryId = parseInt(req.query.country_id, 10);
    const pkgId = parseInt(req.query.pkg_id, 10);

    if (!countryId || !pkgId) {
      return res.status(400).json({ error: 'Paramètres invalides' });
    }

    const data = await apiRequest('GET', '/cities', null, {
      country_id: countryId,
      pkg_id: pkgId,
      email: process.env.API_EMAIL
    });

    res.json(data || []);
  } catch (e) {
    console.error("Erreur /api/cities:", e.response?.data || e.message);
    res.status(500).json({ error: 'Erreur chargement villes' });
  }
});

app.get('/api/parent-proxies', authMiddleware, async (req, res) => {
  try {
    const data = await apiRequest('GET', '/parent-proxies', null, req.query);
    res.json(data.list || data.data || data.proxies || data);
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/create-proxy', authMiddleware, async (req, res) => {
  try {
    const { package_id, duration, protocol, parent_proxy_id } = req.body;

    let price = 0;
    for (const pkg of Object.values(PRICES)) {
      if (pkg.package_id === parseInt(package_id)) {
        const pObj = pkg.prices.find(p => p.duration === parseFloat(duration));
        if (pObj) price = pObj.price;
      }
    }

    if (price === 0 || req.user.balance < price) {
      return res.status(400).json({ error: 'Solde insuffisant ou config invalide' });
    }

    const apiResponse = await apiRequest('POST', '/proxies', req.body);

    const balanceBefore = req.user.balance;
    req.user.balance -= price;
    await req.user.save();

    await new Transaction({
      userId: req.user._id,
      type: 'purchase',
      amount: price,
      balanceBefore,
      balanceAfter: req.user.balance,
      proxyDetails: apiResponse
    }).save();

    const purchase = await new ProxyPurchase({
      userId: req.user._id,
      proxyId: apiResponse.id,
      packageType: package_id == 1 ? 'golden' : 'silver',
      ...apiResponse
    }).save();

    res.json({ success: true, proxy: apiResponse, newBalance: req.user.balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/my-proxies', authMiddleware, async (req, res) => {
  const proxies = await ProxyPurchase.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json(proxies);
});

app.get('/api/transactions', authMiddleware, async (req, res) => {
  const tx = await Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 });
  res.json(tx);
});

app.get('/health', (req, res) => res.json({ status: 'OK' }));

// --- ADMIN SETUP ---
async function setupAdmin() {
  try {
    const hashedPassword = await bcrypt.hash('admin123', 10);
    await User.findOneAndUpdate(
      { email: 'admin@proxyshop.com' },
      { password: hashedPassword, isAdmin: true },
      { upsert: true }
    );
    console.log('👑 Admin configuré : admin@proxyshop.com / admin123');
  } catch (e) {
    console.error('Erreur setup admin:', e.message);
  }
}

// START SERVER
app.listen(PORT, async () => {
  console.log(`🚀 Serveur actif sur http://localhost:${PORT}`);
  await setupAdmin();
  try {
    await getAuthToken();
    console.log('✅ API Proxy liée');
  } catch (e) {
    console.log('⚠️ Impossible de lier l’API externe');
  }
});
