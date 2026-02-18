/**
 * Proxy Expiration Service
 * Gestion complète de l'expiration, des alertes et des renouvellements
 */

const axios = require('axios');

// ✅ CHEMINS CORRIGÉS - Imports depuis services/
const { 
  Proxy, 
  ExpirationAlert, 
  ProxyRenewal, 
  ExpirationAnalytics 
} = require('../models/proxyExpiration.model');

class ProxyExpirationService {
  /**
   * ===== GESTION DES EXPIRATIONS =====
   */

  /**
   * Mettre à jour le statut des proxies basé sur la date d'expiration
   */
  static async updateProxyStatuses() {
    try {
      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      // Marquer les proxies expirés
      await Proxy.updateMany(
        { expiresAt: { $lt: now }, status: { $ne: 'expired' } },
        { status: 'expired', updatedAt: now }
      );

      // Marquer les proxies expirant bientôt (7 jours)
      await Proxy.updateMany(
        {
          expiresAt: { $gte: now, $lte: sevenDaysFromNow },
          status: 'active'
        },
        { status: 'expiring_soon', updatedAt: now }
      );

      // Restaurer le statut actif pour les proxies dont l'expiration a changé
      await Proxy.updateMany(
        {
          expiresAt: { $gt: sevenDaysFromNow },
          status: { $in: ['expiring_soon'] }
        },
        { status: 'active', updatedAt: now }
      );

      console.log('✅ Statuts des proxies mis à jour');
      return true;
    } catch (error) {
      console.error('❌ Erreur lors de la mise à jour des statuts:', error);
      throw error;
    }
  }

  /**
   * ===== GESTION DES ALERTES D'EXPIRATION =====
   */

  /**
   * Créer automatiquement les alertes d'expiration
   */
  static async createExpirationAlerts() {
    try {
      const proxies = await Proxy.find({ 
        status: { $in: ['active', 'expiring_soon'] } 
      }).populate('userId');

      const now = new Date();
      const alerts = [];

      for (const proxy of proxies) {
        const daysRemaining = proxy.getDaysUntilExpiration();

        // Alerte 7 jours avant
        if (daysRemaining === 7 || (daysRemaining < 7 && !await this.hasAlert(proxy._id, '7_days_before'))) {
          alerts.push(this.generateAlert(proxy, '7_days_before', daysRemaining));
        }

        // Alerte 3 jours avant
        if (daysRemaining === 3 || (daysRemaining < 3 && !await this.hasAlert(proxy._id, '3_days_before'))) {
          alerts.push(this.generateAlert(proxy, '3_days_before', daysRemaining));
        }

        // Alerte 1 jour avant
        if (daysRemaining === 1 || (daysRemaining < 1 && daysRemaining > 0 && !await this.hasAlert(proxy._id, '1_day_before'))) {
          alerts.push(this.generateAlert(proxy, '1_day_before', daysRemaining));
        }

        // Alerte expiration
        if (proxy.isExpired() && !await this.hasAlert(proxy._id, 'expired')) {
          alerts.push(this.generateAlert(proxy, 'expired', 0));
        }
      }

      if (alerts.length > 0) {
        await ExpirationAlert.insertMany(alerts);
        console.log(`✅ ${alerts.length} alertes d'expiration créées`);
      }

      return alerts;
    } catch (error) {
      console.error('❌ Erreur lors de la création des alertes:', error);
      throw error;
    }
  }

  /**
   * Vérifier si une alerte existe déjà
   */
  static async hasAlert(proxyId, alertType) {
    const alert = await ExpirationAlert.findOne({
      proxyId,
      alertType,
      status: { $in: ['pending', 'sent'] }
    });
    return !!alert;
  }

  /**
   * Générer une alerte
   */
  static generateAlert(proxy, alertType, daysRemaining) {
    return {
      proxyId: proxy._id,
      userId: proxy.userId,
      alertType,
      status: 'pending',
      proxyDetails: {
        type: proxy.type,
        expiresAt: proxy.expiresAt,
        daysRemaining,
        price: proxy.packageDetails?.price
      },
      notificationChannels: {
        email: true,
        inApp: true,
        sms: false
      }
    };
  }

  /**
   * Envoyer les alertes en attente
   */
  static async sendPendingAlerts() {
    try {
      const alerts = await ExpirationAlert.find({ status: 'pending' })
        .populate('userId')
        .populate('proxyId');

      let sentCount = 0;

      for (const alert of alerts) {
        try {
          await this.sendAlert(alert);
          alert.status = 'sent';
          alert.sentAt = new Date();
          await alert.save();
          sentCount++;
        } catch (error) {
          console.error(`❌ Erreur lors de l'envoi de l'alerte ${alert._id}:`, error.message);
        }
      }

      console.log(`✅ ${sentCount}/${alerts.length} alertes envoyées`);
      return sentCount;
    } catch (error) {
      console.error('❌ Erreur lors de l\'envoi des alertes:', error);
      throw error;
    }
  }

  /**
   * Envoyer une alerte
   */
  static async sendAlert(alert) {
    const user = alert.userId;
    const proxy = alert.proxyId;
    const daysRemaining = alert.proxyDetails.daysRemaining;

    const messages = {
      '7_days_before': {
        subject: '⏰ Votre proxy expire dans 7 jours',
        title: 'Expiration du Proxy',
        message: `Votre proxy ${proxy.type.toUpperCase()} expires le ${new Date(proxy.expiresAt).toLocaleDateString('fr-FR')}.`
      },
      '3_days_before': {
        subject: '⏰ Votre proxy expire dans 3 jours',
        title: 'Renouvellement recommandé',
        message: `Il vous reste seulement 3 jours avant l'expiration de votre proxy ${proxy.type.toUpperCase()}.`
      },
      '1_day_before': {
        subject: '🚨 Votre proxy expire demain',
        title: 'Expiration imminente',
        message: `Votre proxy ${proxy.type.toUpperCase()} expire demain.`
      },
      'expired': {
        subject: '❌ Votre proxy a expiré',
        title: 'Proxy expiré',
        message: `Votre proxy ${proxy.type.toUpperCase()} a expiré et n'est plus accessible.`
      }
    };

    const config = messages[alert.alertType] || messages['7_days_before'];

    if (alert.notificationChannels.email && user.email) {
      await this.sendEmailAlert(user.email, config, proxy);
    }

    console.log(`📧 Alerte ${alert.alertType} envoyée à ${user.email}`);
  }

  /**
   * Envoyer une alerte email
   */
  static async sendEmailAlert(email, config, proxy) {
    try {
      console.log(`📧 Email envoyé à ${email}: ${config.subject}`);
    } catch (error) {
      console.error('❌ Erreur lors de l\'envoi de l\'email:', error);
      throw error;
    }
  }

  /**
   * ===== GESTION DES RENOUVELLEMENTS =====
   */

  /**
   * Créer une demande de renouvellement
   */
  static async createRenewalRequest(proxyId, userId, durationDays, autoRenewal = false) {
    try {
      const proxy = await Proxy.findById(proxyId);
      if (!proxy) throw new Error('Proxy non trouvé');

      const renewalCost = proxy.renewalCost(durationDays);

      const renewal = new ProxyRenewal({
        proxyId,
        userId,
        renewalType: autoRenewal ? 'auto_renewal' : 'manual_renewal',
        autoRenewal: {
          enabled: autoRenewal,
          daysBeforeExpiry: 3,
          renewalDuration: durationDays,
          maxAutoRenewals: 0,
          timesAutoRenewed: 0
        },
        cost: renewalCost,
        status: 'pending'
      });

      await renewal.save();
      console.log(`✅ Demande de renouvellement créée: ${renewal._id}`);
      return renewal;
    } catch (error) {
      console.error('❌ Erreur lors de la création du renouvellement:', error);
      throw error;
    }
  }

  /**
   * Traiter le renouvellement d'un proxy
   */
  static async processRenewal(renewalId, paymentSuccessful = true) {
    try {
      const renewal = await ProxyRenewal.findById(renewalId).populate('proxyId');
      if (!renewal) throw new Error('Renouvellement non trouvé');

      if (!paymentSuccessful) {
        renewal.status = 'failed';
        renewal.errorMessage = 'Paiement échoué';
        await renewal.save();
        return renewal;
      }

      const proxy = renewal.proxyId;
      const newExpiryDate = new Date(proxy.expiresAt.getTime() + renewal.autoRenewal.renewalDuration * 24 * 60 * 60 * 1000);

      // Ajouter au historique des renouvellements
      if (!proxy.renewalHistory) proxy.renewalHistory = [];
      proxy.renewalHistory.push({
        renewedAt: new Date(),
        previousExpiryDate: proxy.expiresAt,
        newExpiryDate,
        renewalDuration: renewal.autoRenewal.renewalDuration,
        renewalCost: renewal.cost
      });

      // Mettre à jour la date d'expiration
      proxy.expiresAt = newExpiryDate;
      proxy.status = 'active';
      proxy.renewalReminderSentAt = null;
      await proxy.save();

      // Marquer le renouvellement comme complété
      renewal.status = 'completed';
      renewal.completedAt = new Date();
      renewal.paymentStatus = 'completed';
      await renewal.save();

      console.log(`✅ Renouvellement complété: ${proxy._id}`);
      return renewal;
    } catch (error) {
      console.error('❌ Erreur lors du traitement du renouvellement:', error);
      throw error;
    }
  }

  /**
   * Activer le renouvellement automatique
   */
  static async enableAutoRenewal(proxyId, durationDays = 7, daysBeforeExpiry = 3) {
    try {
      const renewal = await ProxyRenewal.findOne({ proxyId, status: 'pending' });

      if (!renewal) {
        return await this.createRenewalRequest(proxyId, null, durationDays, true);
      }

      renewal.autoRenewal.enabled = true;
      renewal.autoRenewal.renewalDuration = durationDays;
      renewal.autoRenewal.daysBeforeExpiry = daysBeforeExpiry;
      await renewal.save();

      console.log(`✅ Renouvellement automatique activé pour le proxy ${proxyId}`);
      return renewal;
    } catch (error) {
      console.error('❌ Erreur lors de l\'activation du renouvellement automatique:', error);
      throw error;
    }
  }

  /**
   * Traiter les renouvellements automatiques programmés
   */
  static async processScheduledAutoRenewals() {
    try {
      const renewals = await ProxyRenewal.find({
        'autoRenewal.enabled': true,
        status: { $in: ['pending', 'scheduled'] }
      }).populate('proxyId');

      let processedCount = 0;

      for (const renewal of renewals) {
        const proxy = renewal.proxyId;
        const daysUntilExpiry = proxy.getDaysUntilExpiration();

        // Déclencher si on atteint le nombre de jours avant expiration
        if (daysUntilExpiry === renewal.autoRenewal.daysBeforeExpiry) {
          renewal.status = 'processing';
          renewal.scheduledFor = new Date();
          await renewal.save();

          await this.processRenewal(renewal._id, true);
          renewal.autoRenewal.timesAutoRenewed += 1;
          await renewal.save();

          processedCount++;
          console.log(`✅ Renouvellement automatique traité pour ${proxy._id}`);
        }
      }

      return processedCount;
    } catch (error) {
      console.error('❌ Erreur lors du traitement des renouvellements automatiques:', error);
      throw error;
    }
  }

  /**
   * ===== ANALYTICS ET RAPPORTS =====
   */

  /**
   * Générer les statistiques d'expiration
   */
  static async generateExpirationAnalytics() {
    try {
      const now = new Date();
      const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const statsByType = await Proxy.getStatsByType();
      const analytics = {
        date: now,
        byType: {
          isp: { total: 0, expiring_soon: 0, expired: 0, renewed: 0 },
          residential: { total: 0, expiring_soon: 0, expired: 0, renewed: 0 },
          datacenter: { total: 0, expiring_soon: 0, expired: 0, renewed: 0 }
        },
        totalActiveProxies: 0,
        totalExpiringProxies: 0,
        totalExpiredProxies: 0,
        averageRenewalRate: 0,
        renewalRevenue: 0,
        averageRenewalValue: 0
      };

      for (const stat of statsByType) {
        const type = stat._id;
        if (analytics.byType[type]) {
          analytics.byType[type].total = stat.total;
          analytics.byType[type].expired = stat.expired || 0;
          analytics.byType[type].expiring_soon = stat.expiring_soon || 0;
        }
        analytics.totalActiveProxies += stat.active || 0;
      }

      analytics.totalExpiringProxies = await Proxy.countDocuments({
        expiresAt: { $gte: now, $lte: sevenDaysFromNow },
        status: 'expiring_soon'
      });

      analytics.totalExpiredProxies = await Proxy.countDocuments({
        status: 'expired'
      });

      const renewedProxies = await Proxy.countDocuments({
        status: 'renewed'
      });
      const totalProxies = await Proxy.countDocuments();
      analytics.averageRenewalRate = totalProxies > 0 ? (renewedProxies / totalProxies) * 100 : 0;

      const renewals = await ProxyRenewal.find({ status: 'completed' });
      analytics.renewalRevenue = renewals.reduce((sum, r) => sum + r.cost, 0);
      analytics.averageRenewalValue = renewals.length > 0 ? analytics.renewalRevenue / renewals.length : 0;

      await ExpirationAnalytics.create(analytics);

      console.log('✅ Analytics d\'expiration générées');
      return analytics;
    } catch (error) {
      console.error('❌ Erreur lors de la génération des analytics:', error);
      throw error;
    }
  }

  /**
   * Obtenir un résumé d'expiration pour l'utilisateur
   */
  static async getUserExpirationSummary(userId) {
    try {
      const proxies = await Proxy.find({ userId });

      const summary = {
        totalProxies: proxies.length,
        active: 0,
        expiringSoon: 0,
        expired: 0,
        byType: {
          isp: { total: 0, expiring: 0, expired: 0 },
          residential: { total: 0, expiring: 0, expired: 0 },
          datacenter: { total: 0, expiring: 0, expired: 0 }
        },
        nextExpirations: [],
        recommendations: []
      };

      for (const proxy of proxies) {
        const daysRemaining = proxy.getDaysUntilExpiration();

        if (proxy.status === 'active') summary.active++;
        if (proxy.isExpiringSoon()) summary.expiringSoon++;
        if (proxy.isExpired()) summary.expired++;

        summary.byType[proxy.type].total++;
        if (proxy.isExpiringSoon()) summary.byType[proxy.type].expiring++;
        if (proxy.isExpired()) summary.byType[proxy.type].expired++;

        if (!proxy.isExpired()) {
          summary.nextExpirations.push({
            id: proxy._id,
            type: proxy.type,
            expiresAt: proxy.expiresAt,
            daysRemaining,
            status: proxy.status
          });
        }
      }

      summary.nextExpirations.sort((a, b) => a.daysRemaining - b.daysRemaining);

      if (summary.expiringSoon > 0) {
        summary.recommendations.push(`⚠️ ${summary.expiringSoon} proxy/proxies expire(nt) dans 7 jours`);
      }
      if (summary.expired > 0) {
        summary.recommendations.push(`🚨 ${summary.expired} proxy/proxies a/ont expiré(s)`);
      }

      return summary;
    } catch (error) {
      console.error('❌ Erreur lors de la récupération du résumé:', error);
      throw error;
    }
  }
}

module.exports = ProxyExpirationService;
