const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

const MONGO_URI = process.env.MONGO_URI;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

mongoose.connect(MONGO_URI).then(() => console.log("✅ DB Admin Connectée"));

// Modèles
const Order = mongoose.model('Order', new mongoose.Schema({
    psid: String, orderId: String, method: String, provider: String,
    paymentRef: String, status: { type: String, default: 'EN ATTENTE' },
    proxyData: String, expiresAt: Date, date: { type: Date, default: Date.now }
}));

const User = mongoose.model('User', new mongoose.Schema({
    psid: { type: String, unique: true }, email: String, balance: { type: Number, default: 0 }
}));

app.get('/', (req, res) => res.redirect('/admin/panel'));

app.get('/admin/panel', async (req, res) => {
    const pendingOrders = await Order.find({ status: 'EN ATTENTE' }).sort({ date: -1 });
    const users = await User.find().sort({ balance: -1 });
    const delivered = await Order.find({ status: 'LIVRÉ' });
    const stats = { totalUsers: users.length, totalSold: delivered.length, totalEarnings: delivered.length * 4 };
    res.render('admin', { pendingOrders, users, stats });
});

app.post('/admin/add-balance', async (req, res) => {
    await User.findOneAndUpdate({ psid: req.body.psid }, { $inc: { balance: parseFloat(req.body.amount) } });
    res.redirect('/admin/panel');
});

app.post('/admin/sub-balance', async (req, res) => {
    await User.findOneAndUpdate({ psid: req.body.psid }, { $inc: { balance: -parseFloat(req.body.amount) } });
    res.redirect('/admin/panel');
});

app.post('/admin/deliver', async (req, res) => {
    const { orderId, proxyData } = req.body;
    const expiry = new Date(); expiry.setDate(expiry.getDate() + 30);
    const order = await Order.findOneAndUpdate({ orderId }, { status: 'LIVRÉ', proxyData, expiresAt: expiry }, { new: true });
    if (order) {
        await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
            recipient: { id: order.psid }, message: { text: `✅ Validé !\n📍 ISP: ${order.provider}\n🔑 Proxy: ${proxyData}\n📅 Expire: ${expiry.toLocaleDateString()}` }
        });
    }
    res.redirect('/admin/panel');
});

app.listen(process.env.PORT || 3000);
