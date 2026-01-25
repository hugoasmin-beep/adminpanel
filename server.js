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

// ===== MODELS =====
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

const RechargeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  faucetpayUsername: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const ProxyPurchase = mongoose.model('ProxyPurchase', ProxyPurchaseSchema);
const Recharge = mongoose.model('Recharge', RechargeSchema);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-this';

// ===== MIDDLEWARES =====
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

// ===== API FUNCTIONS =====
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

// ========== AUTH ROUTES ==========
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
    const user = new User({
      email,
      password: hashedPassword,
      balance: 0
    });

    await user.save();

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

// ========== ADMIN ROUTES ==========
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

// ========== RECHARGE ROUTES ==========
app.get('/api/admin/recharges', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const recharges = await Recharge.find()
      .populate('userId', 'email balance')
      .sort({ createdAt: -1 });

    res.json(recharges);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/recharge-request', authMiddleware, async (req, res) => {
  try {
    const { amount, faucetpayUsername } = req.body;

    if (!amount || amount < 0.25) {
      return res.status(400).json({ error: 'Montant minimum: $0.25' });
    }

    if (!faucetpayUsername) {
      return res.status(400).json({ error: 'Nom FaucetPay requis' });
    }

    const recharge = new Recharge({
      userId: req.user._id,
      amount,
      faucetpayUsername,
      status: 'pending'
    });

    await recharge.save();

    res.json({
      success: true,
      message: 'Demande de recharge envoyée',
      recharge
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/recharges/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const recharge = await Recharge.findById(req.params.id);
    
    if (!recharge) {
      return res.status(404).json({ error: 'Recharge non trouvée' });
    }

    if (recharge.status !== 'pending') {
      return res.status(400).json({ error: 'Recharge déjà traitée' });
    }

    const user = await User.findById(recharge.userId);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const balanceBefore = user.balance;
    user.balance += recharge.amount;
    await user.save();

    await new Transaction({
      userId: user._id,
      type: 'credit',
      amount: recharge.amount,
      description: `Recharge FaucetPay validée (${recharge.faucetpayUsername})`,
      balanceBefore,
      balanceAfter: user.balance
    }).save();

    recharge.status = 'approved';
    await recharge.save();

    res.json({
      success: true,
      message: 'Recharge approuvée et crédit ajouté',
      userBalance: user.balance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/recharges/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const recharge = await Recharge.findById(req.params.id);
    
    if (!recharge) {
      return res.status(404).json({ error: 'Recharge non trouvée' });
    }

    if (recharge.status !== 'pending') {
      return res.status(400).json({ error: 'Recharge déjà traitée' });
    }

    recharge.status = 'rejected';
    await recharge.save();

    res.json({
      success: true,
      message: 'Recharge rejetée'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== PROXY ROUTES ==========
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
    const { offset = 0, pkg_id, service_provider_city_id } = req.query;
    const params = { offset, pkg_id };
    if (service_provider_city_id) params.service_provider_city_id = service_provider_city_id;
    
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

    let price = 0;
    for (const pkg of Object.values(PRICES)) {
      if (pkg.package_id === parseInt(package_id)) {
        const priceObj = pkg.prices.find(p => p.duration === parseFloat(duration));
        if (priceObj) price = priceObj.price;
      }
    }
    if (price === 0) return res.status(400).json({ error: 'Prix non trouvé' });

    if (req.user.balance < price) {
      return res.status(400).json({ 
        error: 'Solde insuffisant', 
        required: price, 
        balance: req.user.balance 
      });
    }

    const proxyData = { parent_proxy_id, package_id, protocol, duration };
    if (username && password) {
      proxyData.username = username;
      proxyData.password = password;
    } else if (ip_addr) {
      proxyData.ip_addr = ip_addr;
    }

    const token = await getAuthToken();
    const apiResponse = await axios.post(`${API_BASE_URL}/proxies`, proxyData, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }).then(r => r.data);

    const balanceBefore = req.user.balance;
    req.user.balance -= price;
    await req.user.save();

    await new Transaction({
      userId: req.user._id,
      type: 'purchase',
      amount: price,
      description: `Achat proxy ${protocol} - ${duration} jour(s)`,
      balanceBefore,
      balanceAfter: req.user.balance,
      proxyDetails: apiResponse
    }).save();

    await new ProxyPurchase({
      userId: req.user._id,
      proxyId: apiResponse.id,
      packageType: package_id === 1 ? 'golden' : 'silver',
      duration,
      price,
      username: apiResponse.username,
      password: apiResponse.password,
      host: apiResponse.host,
      port: apiResponse.port,
      protocol: apiResponse.protocol,
      expiresAt: apiResponse.expires_at
    }).save();

    res.json({
      success: true,
      proxy: apiResponse,
      userBalance: req.user.balance
    });

  } catch (error) {
    console.error('Erreur create-proxy:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.message || error.message });
  }
});

app.get('/api/my-proxies', authMiddleware, async (req, res) => {
  try {
    const localProxies = await ProxyPurchase.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(localProxies);
  } catch (error) {
    console.error('Erreur my-proxies:', error);
    res.json([]);
  }
});

app.get('/api/transactions', authMiddleware, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (error) {
    console.error('Erreur transactions:', error);
    res.json([]);
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

// ========== PAGES ==========
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

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

// ========== STARTUP ==========
async function createDefaultAdmin() {
  try {
    const adminExists = await User.findOne({ isAdmin: true });
    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await new User({
        email: 'admin@proxyshop.com',
        password: hashedPassword,
        balance: 0,
        isAdmin: true
      }).save();
      console.log('\n👑 Admin créé: admin@proxyshop.com / admin123');
    }
  } catch (error) {
    console.error('Erreur création admin:', error.message);
  }
}

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
