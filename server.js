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
const JWT_SECRET = process.env.JWT_SECRET || 'proxy-secret-key-2024';

// Configuration CORS
const corsOptions = {
  origin: [process.env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5000'].filter(Boolean),
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static('public'));

// Connexion MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connecté');
    createDefaultAdmin();
  })
  .catch(err => console.error('❌ Erreur MongoDB:', err));

// --- MODÈLES ---

const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  isAdmin: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const RechargeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userEmail: String,
  amount: Number,
  faucetpayUsername: String,
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['credit', 'debit', 'purchase'] },
  amount: Number,
  description: String,
  balanceBefore: Number,
  balanceAfter: Number,
  createdAt: { type: Date, default: Date.now }
});

const ProxyPurchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  proxyDetails: Object,
  expiresAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Recharge = mongoose.model('Recharge', RechargeSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const ProxyPurchase = mongoose.model('ProxyPurchase', ProxyPurchaseSchema);

// --- MIDDLEWARES ---

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Accès refusé' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.userId);
    if (!req.user) throw new Error();
    next();
  } catch (err) { res.status(401).json({ error: 'Session expirée' }); }
};

const adminOnly = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Admin requis' });
  next();
};

// --- ROUTES AUTH ---

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const user = await new User({ email, password: hashed }).save();
    const token = jwt.sign({ userId: user._id }, JWT_SECRET);
    res.json({ token, user: { email: user.email, balance: 0, isAdmin: false } });
  } catch (err) { res.status(400).json({ error: 'Email déjà utilisé' }); }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  const token = jwt.sign({ userId: user._id }, JWT_SECRET);
  res.json({ token, user: { id: user._id, email: user.email, balance: user.balance, isAdmin: user.isAdmin } });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ id: req.user._id, email: req.user.email, balance: req.user.balance, isAdmin: req.user.isAdmin });
});

// --- ROUTES UTILISATEURS (RECHARGE & PROXY) ---

app.post('/api/recharge-request', auth, async (req, res) => {
  const { amount, faucetpayUsername } = req.body;
  await new Recharge({
    userId: req.user._id,
    userEmail: req.user.email,
    amount,
    faucetpayUsername
  }).save();
  res.json({ success: true });
});

app.post('/api/create-proxy', auth, async (req, res) => {
  const { package_id } = req.body;
  const price = 0.25; // Exemple pour Golden Package
  if (req.user.balance < price) return res.status(400).json({ error: 'Solde insuffisant' });

  const balanceBefore = req.user.balance;
  req.user.balance -= price;
  await req.user.save();

  await new Transaction({
    userId: req.user._id,
    type: 'purchase',
    amount: price,
    description: 'Achat Proxy Golden',
    balanceBefore,
    balanceAfter: req.user.balance
  }).save();

  res.json({ success: true, userBalance: req.user.balance });
});

app.get('/api/my-proxies', auth, async (req, res) => {
  const proxies = await ProxyPurchase.find({ userId: req.user._id });
  res.json(proxies);
});

// --- ROUTES ADMIN ---

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  const totalUsers = await User.countDocuments();
  const recharges = await Recharge.find({ status: 'approved' });
  const totalRevenue = recharges.reduce((sum, r) => sum + r.amount, 0);
  res.json({ totalUsers, totalRevenue, totalProxies: 0 });
});

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const users = await User.find().select('-password').sort({ createdAt: -1 });
  res.json(users);
});

app.get('/api/admin/recharges', auth, adminOnly, async (req, res) => {
  const requests = await Recharge.find().sort({ createdAt: -1 });
  res.json(requests);
});

app.post('/api/admin/recharges/validate', auth, adminOnly, async (req, res) => {
  const { id } = req.body;
  const recharge = await Recharge.findById(id);
  if (!recharge || recharge.status !== 'pending') return res.status(400).json({ error: 'Invalide' });

  recharge.status = 'approved';
  await recharge.save();

  const user = await User.findById(recharge.userId);
  const balanceBefore = user.balance;
  user.balance += recharge.amount;
  await user.save();

  await new Transaction({
    userId: user._id,
    type: 'credit',
    amount: recharge.amount,
    description: 'Recharge FaucetPay validée',
    balanceBefore,
    balanceAfter: user.balance
  }).save();

  res.json({ success: true });
});

app.post('/api/admin/recharges/reject', auth, adminOnly, async (req, res) => {
  await Recharge.findByIdAndUpdate(req.body.id, { status: 'rejected' });
  res.json({ success: true });
});

app.post('/api/admin/add-credit', auth, adminOnly, async (req, res) => {
  const { userId, amount, description } = req.body;
  const user = await User.findById(userId);
  const balanceBefore = user.balance;
  user.balance += parseFloat(amount);
  await user.save();
  await new Transaction({ userId, type: 'credit', amount, description, balanceBefore, balanceAfter: user.balance }).save();
  res.json({ success: true });
});

// --- FONCTIONS INITIALES ---

async function createDefaultAdmin() {
  const admin = await User.findOne({ email: 'admin@proxyshop.com' });
  if (!admin) {
    const hashed = await bcrypt.hash('admin123', 10);
    await new User({ email: 'admin@proxyshop.com', password: hashed, isAdmin: true }).save();
    console.log('👑 Admin par défaut créé : admin@proxyshop.com / admin123');
  }
}

app.listen(PORT, () => console.log('🚀 Serveur démarré sur le port ${PORT}'));
