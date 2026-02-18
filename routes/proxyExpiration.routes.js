/**
 * Proxy Expiration Routes
 * Endpoints pour la gestion des expirations, alertes et renouvellements
 */

const express = require('express');
const router = express.Router();
const ProxyExpirationService = require('./proxyExpiration.service');
const { Proxy, ExpirationAlert, ProxyRenewal } = require('./proxyExpiration.model');

/**
 * ===== MIDDLEWARE =====
 */

// Middleware d'authentification (à adapter à votre système)
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    // Vérifier le token et récupérer l'utilisateur
    req.userId = req.user?.id; // À adapter selon votre implémentation
    next();
  } catch (error) {
    res.status(401).json({ error: 'Non authentifié' });
  }
};

/**
 * ===== ENDPOINTS DE GESTION DES PROXIES =====
 */

/**
 * GET /api/proxies/expiring-soon
 * Obtenir les proxies expirant bientôt
 */
router.get('/proxies/expiring-soon', authMiddleware, async (req, res) => {
  try {
    const daysFromNow = parseInt(req.query.days) || 7;
    const proxies = await Proxy.findExpiringProxies(daysFromNow)
      .populate('userId', 'email')
      .sort({ expiresAt: 1 });

    res.json({
      success: true,
      count: proxies.length,
      daysFromNow,
      proxies: proxies.map(p => ({
        id: p._id,
        type: p.type,
        expiresAt: p.expiresAt,
        daysRemaining: p.getDaysUntilExpiration(),
        status: p.status,
        statusLabel: p.getStatusLabel(),
        packageName: p.packageDetails?.name,
        username: p.credentials?.username,
        host: p.credentials?.host,
        port: p.credentials?.port
      }))
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/proxies/expired
 * Obtenir les proxies expirés
 */
router.get('/proxies/expired', authMiddleware, async (req, res) => {
  try {
    const proxies = await Proxy.findExpiredProxies()
      .populate('userId', 'email')
      .sort({ expiresAt: -1 });

    res.json({
      success: true,
      count: proxies.length,
      proxies: proxies.map(p => ({
        id: p._id,
        type: p.type,
        expiresAt: p.expiresAt,
        expiredSince: Math.ceil((Date.now() - p.expiresAt) / (1000 * 60 * 60 * 24)) + ' days',
        status: p.status,
        packageName: p.packageDetails?.name,
        userId: p.userId?._id
      }))
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/proxies/:proxyId
 * Obtenir les détails d'un proxy
 */
router.get('/proxies/:proxyId', authMiddleware, async (req, res) => {
  try {
    const proxy = await Proxy.findById(req.params.proxyId);
    if (!proxy) return res.status(404).json({ error: 'Proxy non trouvé' });

    const daysRemaining = proxy.getDaysUntilExpiration();
    
    res.json({
      success: true,
      proxy: {
        id: proxy._id,
        type: proxy.type,
        status: proxy.status,
        statusLabel: proxy.getStatusLabel(),
        purchaseDate: proxy.purchaseDate,
        expiresAt: proxy.expiresAt,
        daysRemaining,
        isExpiring: proxy.isExpiringSoon(),
        isExpired: proxy.isExpired(),
        packageDetails: proxy.packageDetails,
        credentials: {
          username: proxy.credentials.username,
          host: proxy.credentials.host,
          port: proxy.credentials.port,
          protocol: proxy.credentials.protocol
        },
        locationInfo: proxy.locationInfo,
        stats: proxy.stats,
        renewalHistory: proxy.renewalHistory,
        renewalCost: proxy.renewalCost(7, {}) // Coût pour 7 jours
      }
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/proxies/user/:userId/summary
 * Obtenir le résumé d'expiration pour un utilisateur
 */
router.get('/proxies/user/:userId/summary', authMiddleware, async (req, res) => {
  try {
    const summary = await ProxyExpirationService.getUserExpirationSummary(req.params.userId);
    res.json({ success: true, summary });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/proxies/stats/by-type
 * Obtenir les statistiques par type de proxy
 */
router.get('/proxies/stats/by-type', authMiddleware, async (req, res) => {
  try {
    const stats = await Proxy.getStatsByType();
    
    const formatted = {
      isp: stats.find(s => s._id === 'isp') || { _id: 'isp', total: 0, active: 0, expiring_soon: 0, expired: 0 },
      residential: stats.find(s => s._id === 'residential') || { _id: 'residential', total: 0, active: 0, expiring_soon: 0, expired: 0 },
      datacenter: stats.find(s => s._id === 'datacenter') || { _id: 'datacenter', total: 0, active: 0, expiring_soon: 0, expired: 0 }
    };

    res.json({ success: true, stats: formatted });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * ===== ENDPOINTS DE GESTION DES ALERTES =====
 */

/**
 * GET /api/alerts
 * Obtenir toutes les alertes
 */
router.get('/alerts', authMiddleware, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const alerts = await ExpirationAlert.find({ status })
      .populate('userId', 'email')
      .populate('proxyId')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: alerts.length,
      alerts: alerts.map(a => ({
        id: a._id,
        type: a.alertType,
        status: a.status,
        userId: a.userId?._id,
        userEmail: a.userId?.email,
        proxyId: a.proxyId?._id,
        proxyType: a.proxyDetails?.type,
        daysRemaining: a.proxyDetails?.daysRemaining,
        expiresAt: a.proxyDetails?.expiresAt,
        createdAt: a.createdAt,
        sentAt: a.sentAt
      }))
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/alerts/user/:userId
 * Obtenir les alertes d'un utilisateur
 */
router.get('/alerts/user/:userId', authMiddleware, async (req, res) => {
  try {
    const alerts = await ExpirationAlert.find({ userId: req.params.userId })
      .populate('proxyId')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: alerts.length,
      alerts: alerts.map(a => ({
        id: a._id,
        type: a.alertType,
        status: a.status,
        message: `Proxy ${a.proxyDetails?.type?.toUpperCase()} expire dans ${a.proxyDetails?.daysRemaining} jours`,
        daysRemaining: a.proxyDetails?.daysRemaining,
        expiresAt: a.proxyDetails?.expiresAt,
        createdAt: a.createdAt
      }))
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerts/create
 * Créer les alertes d'expiration
 * Admin only
 */
router.post('/alerts/create', authMiddleware, async (req, res) => {
  try {
    const alerts = await ProxyExpirationService.createExpirationAlerts();
    res.json({
      success: true,
      message: `${alerts.length} alertes créées`,
      count: alerts.length
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/alerts/send
 * Envoyer les alertes en attente
 * Admin only
 */
router.post('/alerts/send', authMiddleware, async (req, res) => {
  try {
    const count = await ProxyExpirationService.sendPendingAlerts();
    res.json({
      success: true,
      message: `${count} alertes envoyées`,
      count
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/alerts/:alertId/acknowledge
 * Marquer une alerte comme lue
 */
router.patch('/alerts/:alertId/acknowledge', authMiddleware, async (req, res) => {
  try {
    const alert = await ExpirationAlert.findByIdAndUpdate(
      req.params.alertId,
      {
        status: 'acknowledged',
        acknowledgedAt: new Date()
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'Alerte marquée comme lue',
      alert
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * ===== ENDPOINTS DE GESTION DES RENOUVELLEMENTS =====
 */

/**
 * POST /api/renewals/create
 * Créer une demande de renouvellement
 */
router.post('/renewals/create', authMiddleware, async (req, res) => {
  try {
    const { proxyId, durationDays, autoRenewal } = req.body;

    if (!proxyId || !durationDays) {
      return res.status(400).json({ error: 'proxyId et durationDays requis' });
    }

    const renewal = await ProxyExpirationService.createRenewalRequest(
      proxyId,
      req.userId,
      durationDays,
      autoRenewal || false
    );

    res.json({
      success: true,
      message: 'Demande de renouvellement créée',
      renewal: {
        id: renewal._id,
        status: renewal.status,
        cost: renewal.cost,
        durationDays: durationDays,
        autoRenewal: autoRenewal || false
      }
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/renewals/:renewalId/process
 * Traiter un renouvellement (après paiement)
 */
router.post('/renewals/:renewalId/process', authMiddleware, async (req, res) => {
  try {
    const { paymentSuccessful } = req.body;
    
    const renewal = await ProxyExpirationService.processRenewal(
      req.params.renewalId,
      paymentSuccessful !== false
    );

    res.json({
      success: true,
      message: renewal.status === 'completed' ? 'Renouvellement complété' : 'Renouvellement échoué',
      renewal: {
        id: renewal._id,
        status: renewal.status,
        completedAt: renewal.completedAt,
        paymentStatus: renewal.paymentStatus
      }
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/renewals/:proxyId/auto-renew
 * Activer le renouvellement automatique
 */
router.post('/renewals/:proxyId/auto-renew', authMiddleware, async (req, res) => {
  try {
    const { durationDays, daysBeforeExpiry } = req.body;

    const renewal = await ProxyExpirationService.enableAutoRenewal(
      req.params.proxyId,
      durationDays || 7,
      daysBeforeExpiry || 3
    );

    res.json({
      success: true,
      message: 'Renouvellement automatique activé',
      renewal: {
        id: renewal._id,
        autoRenewal: renewal.autoRenewal
      }
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/renewals/user/:userId
 * Obtenir les renouvellements d'un utilisateur
 */
router.get('/renewals/user/:userId', authMiddleware, async (req, res) => {
  try {
    const renewals = await ProxyRenewal.find({ userId: req.params.userId })
      .populate('proxyId', 'type expiresAt')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: renewals.length,
      renewals: renewals.map(r => ({
        id: r._id,
        proxyId: r.proxyId?._id,
        proxyType: r.proxyId?.type,
        status: r.status,
        renewalType: r.renewalType,
        cost: r.cost,
        durationDays: r.autoRenewal?.renewalDuration,
        autoRenewal: r.autoRenewal?.enabled,
        createdAt: r.createdAt,
        completedAt: r.completedAt
      }))
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * ===== ENDPOINTS ADMIN =====
 */

/**
 * POST /api/admin/update-statuses
 * Mettre à jour les statuts des proxies
 * Admin only
 */
router.post('/admin/update-statuses', authMiddleware, async (req, res) => {
  try {
    await ProxyExpirationService.updateProxyStatuses();
    res.json({
      success: true,
      message: 'Statuts des proxies mis à jour'
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/process-auto-renewals
 * Traiter les renouvellements automatiques
 * Admin only
 */
router.post('/admin/process-auto-renewals', authMiddleware, async (req, res) => {
  try {
    const count = await ProxyExpirationService.processScheduledAutoRenewals();
    res.json({
      success: true,
      message: `${count} renouvellements automatiques traités`,
      count
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/analytics
 * Obtenir les analytics d'expiration
 * Admin only
 */
router.get('/admin/analytics', authMiddleware, async (req, res) => {
  try {
    const analytics = await ProxyExpirationService.generateExpirationAnalytics();
    res.json({
      success: true,
      analytics
    });
  } catch (error) {
    console.error('❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
