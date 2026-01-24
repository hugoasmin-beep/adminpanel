# Proxy Shop Backend

Backend API pour Proxy Shop - Gestion de proxies avec authentification et paiements

## 🚀 Démarrage Local
```bash
npm install
npm start
```

Serveur: http://localhost:5000
Panel Admin: http://localhost:5000/admin.html

## 🔐 Compte Admin

Email: admin@proxyshop.com
Password: admin123

## 📡 Routes API

### Auth
- POST /api/auth/register
- POST /api/auth/login
- GET /api/auth/me

### Admin
- GET /api/admin/users
- POST /api/admin/add-credit
- GET /api/admin/stats

### Proxies
- GET /api/prices
- POST /api/create-proxy
- GET /api/my-proxies
- GET /api/transactions

## ⚙️ Variables d'environnement

Copie `.env.example` vers `.env` et configure tes valeurs.
