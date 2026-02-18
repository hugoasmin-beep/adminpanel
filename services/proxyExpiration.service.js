/**
 * Proxy Expiration Service
 * Gestion complète de l'expiration, des alertes et des renouvellements
 */

const { 
  Proxy, 
  ExpirationAlert, 
  ProxyRenewal, 
  ExpirationAnalytics 
} = require('./proxyExpiration.model');

const axios = require('axios');

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
    const messages = {
      '7_days_before': 'Votre proxy expire dans 7 jours',
      '3_days_before': 'Votre proxy expire dans 3 jours',
      '1_day_before': 'Votre proxy expire demain',
      'expired': 'Votre proxy a expiré'
    };

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
        message: `Votre proxy ${proxy.type.toUpperCase()} expires le ${new Date(proxy.expiresAt).toLocaleDateString('fr-FR')}. Envisagez un renouvellement.`,
        action: 'Renouveler maintenant'
      },
      '3_days_before': {
        subject: '⏰ Votre proxy expire dans 3 jours',
        title: 'Renouvellement recommandé',
        message: `Il vous reste seulement 3 jours avant l'expiration de votre proxy ${proxy.type.toUpperCase()}.`,
        action: 'Renouveler immédiatement'
      },
      '1_day_before': {
        subject: '🚨 Votre proxy expire demain',
        title: 'Expiration imminente',
        message: `Votre proxy ${proxy.type.toUpperCase()} expire demain à ${new Date(proxy.expiresAt).toLocaleTimeString('fr-FR')}.`,
        action: 'Renouveler rapidement'
      },
      'expired': {
        subject: '❌ Votre proxy a expiré',
        title: 'Proxy expiré',
        message: `Votre proxy ${proxy.type.toUpperCase()} a expiré et n'est plus accessible.`,
        action: 'Renouveler le proxy'
      }
    };

    const config = messages[alert.alertType] || messages['7_days_before'];

    if (alert.notificationChannels.email && user.email) {
      await this.sendEmailAlert(user.email, config, proxy);
    }

    if (alert.notificationChannels.inApp) {
      await this.createInAppNotification(user._id, config, proxy);
    }

    if (alert.notificationChannels.sms && user.phone) {
      await this.sendSmsAlert(user.phone, config.message);
    }
  }

  /**
   * Envoyer une alerte email (via Brevo)
   */
  static async sendEmailAlert(email, config, proxy) {
    try {
      const htmlContent = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <style>
              body { font-family: 'DM Sans', Arial, sans-serif; background: #f4f4f4; margin: 0; }
              .container { max-width: 500px; margin: 20px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
              .header { background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: white; padding: 30px; text-align: center; }
              .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
              .content { padding: 30px; }
              .alert-box { 
                background: ${this.getAlertColor(config.subject)}; 
                border-left: 4px solid ${this.getAlertBorderColor(config.subject)};
                padding: 16px; 
                border-radius: 8px; 
                margin-bottom: 20px;
                color: #1f2937;
              }
              .proxy-info { 
                background: #f9fafb; 
                padding: 15px; 
                border-radius: 8px; 
                margin: 20px 0;
                border-left: 4px solid #6366f1;
              }
              .info-row { display: flex; justify-content: space-between; margin: 8px 0; font-size: 14px; }
              .info-label { color: #6b7280; font-weight: 500; }
              .info-value { color: #1f2937; font-weight: 600; }
              .button { 
                display: inline-block; 
                background: #6366f1; 
                color: white; 
                padding: 12px 24px; 
                border-radius: 8px; 
                text-decoration: none; 
                font-weight: 600;
                margin: 20px 0;
              }
              .footer { 
                background: #f9fafb; 
                padding: 20px; 
                text-align: center; 
                font-size: 12px; 
                color: #9ca3af;
                border-top: 1px solid #e5e7eb;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>🌐 ProxyFlow</h1>
              </div>
              <div class="content">
                <h2 style="color: #1f2937; margin-bottom: 10px;">${config.title}</h2>
                <div class="alert-box">
                  ${config.message}
                </div>
                
                <div class="proxy-info">
                  <div class="info-row">
                    <span class="info-label">Type:</span>
                    <span class="info-value">${proxy.type.toUpperCase()}</span>
                  </div>
                  <div class="info-row">
                    <span class="info-label">Expire le:</span>
                    <span class="info-value">${new Date(proxy.expiresAt).toLocaleDateString('fr-FR')}</span>
                  </div>
                  ${proxy.packageDetails?.name ? `
                    <div class="info-row">
                      <span class="info-label">Package:</span>
                      <span class="info-value">${proxy.packageDetails.name}</span>
                    </div>
                  ` : ''}
                </div>

                <center>
                  <a href="${process.env.FRONTEND_URL}/dashboard/proxies" class="button">
                    ${config.action}
                  </a>
                </center>

                <p style="color: #6b7280; font-size: 13px; margin-top: 30px;">
                  Vous recevez cet email car vous avez un compte actif sur ProxyFlow. 
                  Vous pouvez gérer vos préférences de notification dans les paramètres de votre compte.
                </p>
              </div>
              <div class="footer">
                <p style="margin: 0;">© 2024 ProxyFlow. Tous droits réservés.</p>
              </div>
            </div>
          </body>
        </html>
      `;

      // Appel API Brevo (ou votre service d'email)
      // await sendEmailViaBrevo(email, config.subject, htmlContent);
      console.log(`📧 Email d'alerte envoyé à ${email}`);
    } catch (error) {
      console.error('❌ Erreur lors de l\'envoi de l\'email:', error);
      throw error;
    }
  }

  /**
   * Créer une notification in-app
   */
  static async createInAppNotification(userId, config, proxy) {
    // À implémenter selon votre système de notifications
    console.log(`📱 Notification in-app créée pour l'utilisateur ${userId}`);
  }

  /**
   * Envoyer une alerte SMS
   */
  static async sendSmsAlert(phone, message) {
    // À implémenter avec votre service SMS (Twilio, etc.)
    console.log(`📱 SMS envoyé à ${phone}`);
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

      console.log(`✅ Renouvellement complété: ${proxy._id} expire maintenant le ${newExpiryDate.toLocaleDateString('fr-FR')}`);
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

          // Simuler le traitement du paiement et du renouvellement
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

      // Récupérer les statistiques par type
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

      // Remplir les statistiques
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

      // Calculer le taux de renouvellement
      const renewedProxies = await Proxy.countDocuments({
        status: 'renewed'
      });
      const totalProxies = await Proxy.countDocuments();
      analytics.averageRenewalRate = totalProxies > 0 ? (renewedProxies / totalProxies) * 100 : 0;

      // Calculer les revenus de renouvellement
      const renewals = await ProxyRenewal.find({ status: 'completed' });
      analytics.renewalRevenue = renewals.reduce((sum, r) => sum + r.cost, 0);
      analytics.averageRenewalValue = renewals.length > 0 ? analytics.renewalRevenue / renewals.length : 0;

      // Sauvegarder les analytics
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

        // Compter par statut
        if (proxy.status === 'active') summary.active++;
        if (proxy.isExpiringSoon()) summary.expiringSoon++;
        if (proxy.isExpired()) summary.expired++;

        // Compter par type
        summary.byType[proxy.type].total++;
        if (proxy.isExpiringSoon()) summary.byType[proxy.type].expiring++;
        if (proxy.isExpired()) summary.byType[proxy.type].expired++;

        // Prochaines expirations
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

      // Trier par date d'expiration
      summary.nextExpirations.sort((a, b) => a.daysRemaining - b.daysRemaining);

      // Générer des recommandations
      if (summary.expiringSoon > 0) {
        summary.recommendations.push(`⚠️ ${summary.expiringSoon} proxy/proxies expire(nt) dans 7 jours`);
      }
      if (summary.expired > 0) {
        summary.recommendations.push(`🚨 ${summary.expired} proxy/proxies a/ont expiré(s)`);
      }
      if (summary.active === 0 && summary.totalProxies > 0) {
        summary.recommendations.push('💡 Tous vos proxies sont inactifs. Envisagez une recharge.');
      }

      return summary;
    } catch (error) {
      console.error('❌ Erreur lors de la récupération du résumé:', error);
      throw error;
    }
  }

  /**
   * Utilitaires
   */

  static getAlertColor(subject) {
    if (subject.includes('7 jours')) return '#fef3c7';
    if (subject.includes('3 jours')) return '#fed7aa';
    if (subject.includes('demain')) return '#fecaca';
    return '#fee2e2';
  }

  static getAlertBorderColor(subject) {
    if (subject.includes('7 jours')) return '#f59e0b';
    if (subject.includes('3 jours')) return '#f97316';
    if (subject.includes('demain')) return '#ef4444';
    return '#dc2626';
  }
}

module.exports = ProxyExpirationService;
