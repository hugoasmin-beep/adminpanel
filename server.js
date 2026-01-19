const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const axios = require('axios');

const app = express();

// --- CONFIGURATION ---
const MONGO_URI = process.env.MONGO_URI;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- CONNEXION BDD ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Admin Dashboard connecté à MongoDB"))
    .catch(err => console.error("❌ Erreur de connexion MongoDB:", err));

// --- MODÈLES ---
const User = mongoose.model('User', new mongoose.Schema({
    psid: String, email: String, balance: { type: Number, default: 0 }
}));

const Order = mongoose.model('Order', new mongoose.Schema({
    psid: String, orderId: String, provider: String, price: Number,
    status: { type: String, default: 'PENDING' }, proxyData: String, date: { type: Date, default: Date.now }
}));

const Settings = mongoose.model('Settings', new mongoose.Schema({
    key: String, value: String
}));

// --- ROUTES ---

// 1. PAGE PRINCIPALE
app.get('/admin/panel', async (req, res) => {
    try {
        const users = await User.find({ email: { $exists: true } }).sort({ balance: -1 });
        const rawOrders = await Order.find({ status: { $regex: /PENDING|EN ATTENTE/i } }).sort({ date: -1 });
        const deliveredOrders = await Order.find({ status: /LIVRÉ|DELIVERED/i });

        const pending = await Promise.all(rawOrders.map(async (order) => {
            const user = await User.findOne({ psid: order.psid });
            return {
                ...order._doc,
                customerEmail: user ? user.email : "Guest/Unknown"
            };
        }));

        const earnings = deliveredOrders.reduce((acc, o) => acc + (o.price || 0), 0);

        res.render('admin', { 
            pending, 
            users, 
            stats: { 
                u: users.length, 
                s: deliveredOrders.length, 
                g: earnings.toFixed(2) 
            } 
        });
    } catch (err) {
        res.status(500).send("Server Error: " + err.message);
    }
});

// 2. LIVRAISON DE LA COMMANDE
app.post('/admin/deliver', async (req, res) => {
    const { orderId, proxyData } = req.body;
    try {
        const order = await Order.findOneAndUpdate(
            { orderId }, 
            { status: 'DELIVERED', proxyData }, 
            { new: true }
        );

        if (order) {
            await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                recipient: { id: order.psid },
                message: { 
                    text: `✅ ORDER DELIVERED !\n\nProduct: ${order.provider}\nYour Proxies (0 Fraud Score):\n${proxyData}\n\nThank you for choosing ProxyFlow!` 
                }
            });
        }
        res.redirect('/admin/panel');
    } catch (err) {
        res.status(500).send("Erreur lors de la livraison.");
    }
});

// 3. REFUSER LA COMMANDE (Nouveau)
app.post('/admin/refuse', async (req, res) => {
    const { orderId } = req.body;
    try {
        const order = await Order.findOne({ orderId });
        
        if (order) {
            // Envoyer un message au client pour expliquer le refus
            await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
                recipient: { id: order.psid },
                message: { 
                    text: `❌ ORDER REFUSED\n\nYour order ${order.orderId} has been declined.\nReason: Payment not received or invalid data.\n\nPlease contact support if you think this is an error.` 
                }
            });

            // Supprimer la commande de la liste des attentes
            await Order.deleteOne({ orderId });
        }
        res.redirect('/admin/panel');
    } catch (err) {
        res.status(500).send("Erreur lors du refus.");
    }
});

// 4. AJOUTER DU SOLDE
app.post('/admin/add-balance', async (req, res) => {
    const { psid, amount } = req.body;
    try {
        await User.findOneAndUpdate({ psid }, { $inc: { balance: parseFloat(amount) } });
        res.redirect('/admin/panel');
    } catch (err) {
        res.status(500).send("Erreur solde.");
    }
});

// 5. FREE PROXIES
app.post('/admin/update-free', async (req, res) => {
    const { freeContent } = req.body;
    try {
        await Settings.findOneAndUpdate({ key: 'free_proxies' }, { value: freeContent }, { upsert: true });
        res.redirect('/admin/panel');
    } catch (err) {
        res.status(500).send("Erreur free proxies.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Admin Dashboard Live` ));
