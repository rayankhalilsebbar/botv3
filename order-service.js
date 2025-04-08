const axios = require('axios');
const crypto = require('crypto');

// Énumération des statuts possibles pour les ordres
const ORDER_STATUS = {
  PENDING: 'pending',   // Initial, juste après placement
  NEW: 'new',          // Reçu par l'exchange (status 1)
  FILLED: 'filled',    // Exécuté (status 2)
  CANCELLED: 'cancelled', // Annulé (status 4)
  REJECTED: 'rejected'  // Rejeté par l'exchange
};

class OrderService {
  static ORDER_STATUS = ORDER_STATUS;  // Exposer l'énumération comme propriété statique

  constructor(config, wsClient) {
    this.config = config;
    this.wsClient = wsClient;
    
    // Suivi des ordres actifs
    this.activeBuyOrders = new Map(); // clientId -> order details
    this.activeSellOrders = new Map(); // clientId -> order details
    
    // Map pour stocker les tailles totales des ordres d'achat
    this.orderTotalSizes = new Map(); // clientOrderId -> totalSize
    
    // NOUVELLE PROPRIÉTÉ: Map pour suivre les ordres en attente de confirmation
    this.pendingConfirmations = new Map(); // clientOrderId -> {timestamp, side, price, size}
    
    // NOUVELLE PROPRIÉTÉ: Intervalle pour nettoyer les ordres non confirmés
    this.cleanupInterval = null;
    
    // Configurer les écouteurs d'événements
    this.setupEventListeners();
    
    // NOUVEAU: Démarrer l'intervalle de nettoyage
    this.startCleanupInterval();
  }
  
  setupEventListeners() {
    // Écouteur pour les ordres d'achat remplis
    this.wsClient.on('buy_order_filled', (data) => {
      this.handleBuyOrderFilled(data);
    });
    
    // Écouteur pour les ordres de vente remplis
    this.wsClient.on('sell_order_filled', (data) => {
      this.handleSellOrderFilled(data);
    });
    
    // Écouteur pour les ordres annulés
    this.wsClient.on('order_cancelled', (data) => {
      this.handleOrderCancelled(data);
    });
  }
  
  // Génère une signature HMAC pour l'API MEXC
  generateSignature(queryString) {
    return crypto
      .createHmac('sha256', this.config.apiKeys.secretKey)
      .update(queryString)
      .digest('hex');
  }
  
  // Construit une URL signée pour les appels API MEXC
  buildSignedURL(endpoint, paramsObj) {
    const queryString = Object.entries(paramsObj)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
      
    const signature = this.generateSignature(queryString);
    return `${this.config.restEndpoints.baseUrl}${endpoint}?${queryString}&signature=${signature}`;
  }
  
  // Formatage du clientOrderId pour MEXC
  generateClientOrderId(side, price) {
    // Timestamp unique pour chaque ordre
    const timestamp = Date.now();
    
    // Partie qui indique le prix (pour faciliter le débogage)
    const pricePart = price.toFixed(this.config.pricePrecision).replace('.', '');
    
    // Format: side_price_timestamp
    return `${side}_${pricePart}_${timestamp}`;
  }
  
  // Placement d'un seul ordre via API REST
  async placeOrder(side, price, size) {
    // Générer l'identifiant client de l'ordre
    const clientOrderId = this.generateClientOrderId(side, price);
    
    // Préparer les paramètres de l'ordre
    const orderParams = {
      symbol: this.config.symbol,
      side: side.toUpperCase(),
      type: this.config.orderTypes.limit,
      price: price.toFixed(this.config.pricePrecision),
      quantity: size.toFixed(this.config.sizePrecision),
      newClientOrderId: clientOrderId,
      timestamp: Date.now()
    };
    
    try {
      // Construire l'URL signée
      const url = this.buildSignedURL('/order', orderParams);
      
      // Faire la requête API
      const response = await axios.post(url, {}, {
        headers: {
          'X-MEXC-APIKEY': this.config.apiKeys.apiKey,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.data && response.data.orderId) {
        console.log(`📝 Ordre ${side} placé: ${clientOrderId} à ${price}$ pour ${size} BTC`);
        
        // Ajouter l'ordre à notre suivi local
        const orderDetails = {
          clientOid: clientOrderId, // Garder clientOid pour compatibilité
          price,
          size,
          side,
          status: 'new',
          timestamp: Date.now(),
          orderId: response.data.orderId
        };
        
        if (side === 'buy') {
          this.activeBuyOrders.set(clientOrderId, orderDetails);
          // Stocker la taille totale pour les ordres d'achat
          this.orderTotalSizes.set(clientOrderId, size);
        } else if (side === 'sell') {
          this.activeSellOrders.set(clientOrderId, orderDetails);
        }
        
        // NOUVEAU: Ajouter à la liste des ordres en attente de confirmation
        this.pendingConfirmations.set(clientOrderId, {
          timestamp: Date.now(),
          side,
          price,
          size,
          status: ORDER_STATUS.PENDING  // Statut initial
        });
        
        // NOUVEAU: Log détaillé pour l'ajout à pendingConfirmations
        console.log(`📝 Ordre ${clientOrderId} ajouté à pendingConfirmations avec statut PENDING`);
        
        return clientOrderId;
      } else {
        console.error('❌ Erreur lors du placement de l\'ordre:', response.data);
        return null;
      }
    } catch (error) {
      console.error('❌ Erreur lors du placement de l\'ordre:', error.response?.data || error.message);
      return null;
    }
  }
  
  // Annulation d'un seul ordre via API REST
  async cancelOrder(clientOrderId) {
    try {
      // Préparer les paramètres d'annulation
      const cancelParams = {
        symbol: this.config.symbol,
        origClientOrderId: clientOrderId,
        timestamp: Date.now()
      };
      
      // Construire l'URL signée
      const url = this.buildSignedURL('/order', cancelParams);
      
      // Faire la requête API
      const response = await axios.delete(url, {
        headers: {
          'X-MEXC-APIKEY': this.config.apiKeys.apiKey,
          'Content-Type': 'application/json'
        }
      });
      
      if (response.data && response.data.origClientOrderId) {
        console.log(`❌ Ordre ${clientOrderId} annulé avec succès`);
        return true;
      } else {
        console.error('❌ Erreur lors de l\'annulation de l\'ordre:', response.data);
        return false;
      }
    } catch (error) {
      console.error('❌ Erreur lors de l\'annulation de l\'ordre:', error.response?.data || error.message);
      return false;
    }
  }
  
  // Placement de plusieurs ordres
  async placeBulkOrders(ordersData, side) {
    if (!ordersData || ordersData.length === 0) {
      console.log(`⚠️ Aucun ordre à placer pour ${side}`);
      return [];
    }
    
    console.log(`📦 Traitement de ${ordersData.length} ordres ${side}...`);
    
    // Diviser les ordres en lots selon la taille maximale de lot configurée
    const batchSize = this.config.batchProcessing.maxBatchSize;
    const batches = [];
    
    for (let i = 0; i < ordersData.length; i += batchSize) {
      batches.push(ordersData.slice(i, i + batchSize));
    }
    
    console.log(`📦 Divisé en ${batches.length} lots de ${batchSize} ordres maximum`);
    
    const batchResults = [];
    
    // Traiter chaque lot séquentiellement
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`📦 Traitement du lot ${i + 1}: ${batch.length} ordres ${side}`);
      
      // Préparer les ordres pour ce lot
      const batchOrders = batch.map(({ price, size }) => {
        const clientOrderId = this.generateClientOrderId(side, price);
        
        // Ajouter à notre suivi local maintenant (sera mis à jour avec les réponses WebSocket)
        const orderDetails = {
          clientOid: clientOrderId, // Garder clientOid pour compatibilité
          price,
          size,
          side,
          status: 'new',
          timestamp: Date.now()
        };
        
        if (side === 'buy') {
          this.activeBuyOrders.set(clientOrderId, orderDetails);
          // Stocker la taille totale pour les ordres d'achat
          this.orderTotalSizes.set(clientOrderId, size);
        } else if (side === 'sell') {
          this.activeSellOrders.set(clientOrderId, orderDetails);
        }
        
        // NOUVEAU: Ajouter à la liste des ordres en attente de confirmation
        this.pendingConfirmations.set(clientOrderId, {
          timestamp: Date.now(),
          side,
          price,
          size,
          status: ORDER_STATUS.PENDING  // Statut initial
        });
        
        // NOUVEAU: Log détaillé pour l'ajout à pendingConfirmations
        console.log(`📝 Ordre ${clientOrderId} ajouté à pendingConfirmations avec statut PENDING (bulk)`);
        
        // Format pour l'API batchOrders
        return {
          symbol: this.config.symbol,
          side: side.toUpperCase(),
          type: this.config.orderTypes.limit,
          price: price.toFixed(this.config.pricePrecision),
          quantity: size.toFixed(this.config.sizePrecision),
          newClientOrderId: clientOrderId
        };
      });
      
      try {
        const timestamp = Date.now();
        const encodedOrders = encodeURIComponent(JSON.stringify(batchOrders));
        
        // Paramètres pour la requête batchOrders
        const batchParams = {
          timestamp,
          batchOrders: encodedOrders
        };
        
        // Construire l'URL signée
        const url = this.buildSignedURL(this.config.restEndpoints.batchOrders, batchParams);
        
        // Faire la requête API
        const response = await axios.post(url, {}, {
          headers: {
            'X-MEXC-APIKEY': this.config.apiKeys.apiKey,
            'Content-Type': 'application/json'
          }
        });
        
        if (response.data) {
          // Ajouter les résultats
          batch.forEach(({ price, size }, index) => {
            const clientOrderId = this.generateClientOrderId(side, price);
            batchResults.push({ clientOid: clientOrderId, price, size });
          });
          
          console.log(`✅ Lot placé avec succès: ${batch.length} ordres ${side}`);
        } else {
          console.error('❌ Erreur lors du placement du lot:', response.data);
        }
        
        // Respecter la limite de 2 requêtes par seconde
        if (i + this.config.batchProcessing.maxBatchSize < ordersData.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error('❌ Erreur lors du placement du lot:', error.response?.data || error.message);
      }
    }
    
    console.log(`📦 ${batchResults.length} ordres ${side} placés au total`);
    return batchResults;
  }
  
  // Annulation de plusieurs ordres
  async cancelBulkOrders(clientOrderIds) {
    // Pour MEXC, nous annulons de manière séquentielle car il n'y a pas d'API de batch cancel
    const results = [];
    
    console.log(`🧹 Annulation de ${clientOrderIds.length} ordres...`);
    
    for (let i = 0; i < clientOrderIds.length; i++) {
      const clientOrderId = clientOrderIds[i];
      const success = await this.cancelOrder(clientOrderId);
      
      if (success) {
        results.push(clientOrderId);
      }
      
      // Respecter la limite de 2 requêtes par seconde si nécessaire
      if (i > 0 && i % 2 === 0 && i < clientOrderIds.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`🧹 ${results.length} ordres annulés avec succès sur ${clientOrderIds.length}`);
    return results.length;
  }
  
  // Calculer la taille d'un ordre en BTC basée sur le montant en USDC
  calculateOrderSize(price) {
    // Montant en BTC = Montant en USDC / Prix BTC
    const rawSize = this.config.orderAmountUSDC / price;
    
    // Appliquer la précision définie dans la configuration
    const precision = this.config.sizePrecision || 6;
    const formattedSize = parseFloat(rawSize.toFixed(precision));
    
    return formattedSize;
  }
  
  // Gestion des événements d'ordres
  
  handleBuyOrderFilled(data) {
    const { clientOid, price } = data;
    
    console.log(`✅ Ordre d'achat ${clientOid} exécuté à ${price}$`);
    
    // NOUVEAU: Retirer de la liste des ordres en attente de confirmation
    if (this.pendingConfirmations.has(clientOid)) {
      console.log(`🔄 Suppression de l'ordre ${clientOid} de pendingConfirmations (achat exécuté)`);
      this.pendingConfirmations.delete(clientOid);
    } else {
      console.log(`⚠️ Ordre ${clientOid} non trouvé dans pendingConfirmations lors de l'exécution`);
    }
    
    // Retirer de la liste des ordres d'achat actifs
    this.activeBuyOrders.delete(clientOid);
    
    // Récupérer la taille totale de l'ordre
    const totalSize = this.orderTotalSizes.get(clientOid);
    
    if (totalSize) {
      // Calculer le prix de vente (prix d'achat + palier)
      const sellPrice = parseFloat((price + this.config.priceStep).toFixed(this.config.pricePrecision));
      
      // Placer l'ordre de vente avec la taille totale
      this.placeOrder('sell', sellPrice, totalSize);
      
      // Nettoyer le cache
      this.orderTotalSizes.delete(clientOid);
      
      // Émettre l'événement pour la stratégie avec la taille totale
      this.wsClient.emit('strategy_buy_filled', { 
        clientOid, 
        price,
        sellPrice,
        totalSize
      });
    }
  }
  
  handleSellOrderFilled(data) {
    const { clientOid, price, size } = data;
    
    console.log(`✅ Ordre de vente ${clientOid} exécuté à ${price}$ pour ${size} BTC`);
    
    // NOUVEAU: Retirer de la liste des ordres en attente de confirmation
    if (this.pendingConfirmations.has(clientOid)) {
      console.log(`🔄 Suppression de l'ordre ${clientOid} de pendingConfirmations (vente exécutée)`);
      this.pendingConfirmations.delete(clientOid);
    } else {
      console.log(`⚠️ Ordre ${clientOid} non trouvé dans pendingConfirmations lors de l'exécution`);
    }
    
    // Retirer de la liste des ordres de vente actifs
    this.activeSellOrders.delete(clientOid);
    
    // Émettre notre propre événement pour la stratégie, mais sans placer de nouvel ordre
    this.wsClient.emit('strategy_sell_filled', { 
      clientOid, 
      price, 
      size
    });
  }
  
  handleOrderCancelled(data) {
    const { clientOid, side } = data;
    
    console.log(`🚫 Ordre ${clientOid} annulé`);
    
    // NOUVEAU: Retirer de la liste des ordres en attente de confirmation
    if (this.pendingConfirmations.has(clientOid)) {
      console.log(`🔄 Suppression de l'ordre ${clientOid} de pendingConfirmations (ordre annulé)`);
      this.pendingConfirmations.delete(clientOid);
    } else {
      console.log(`⚠️ Ordre ${clientOid} non trouvé dans pendingConfirmations lors de l'annulation`);
    }
    
    // Retirer l'ordre des listes actives
    if (side === 'buy') {
      this.activeBuyOrders.delete(clientOid);
      // Nettoyer aussi le totalSize si c'est un ordre d'achat
      this.orderTotalSizes.delete(clientOid);
    } else if (side === 'sell') {
      this.activeSellOrders.delete(clientOid);
    }
  }
  
  // Obtenir tous les ordres d'achat actifs
  getActiveBuyOrders() {
    return Array.from(this.activeBuyOrders.values());
  }
  
  // Obtenir tous les ordres de vente actifs
  getActiveSellOrders() {
    return Array.from(this.activeSellOrders.values());
  }
  
  // Obtenir tous les ordres actifs
  getAllActiveOrders() {
    return [...this.getActiveBuyOrders(), ...this.getActiveSellOrders()];
  }
  
  // Trouver les ordres d'achat à un certain prix
  getBuyOrderAtPrice(price) {
    for (const order of this.activeBuyOrders.values()) {
      if (order.price === price) {
        return order;
      }
    }
    return null;
  }
  
  // Vérifier si un prix a déjà un ordre d'achat actif
  hasBuyOrderAtPrice(price) {
    return this.getBuyOrderAtPrice(price) !== null;
  }
  
  // Trouver les ordres de vente à un certain prix
  getSellOrderAtPrice(price) {
    for (const order of this.activeSellOrders.values()) {
      if (order.price === price) {
        return order;
      }
    }
    return null;
  }
  
  // Vérifier si un prix a déjà un ordre de vente actif
  hasSellOrderAtPrice(price) {
    return this.getSellOrderAtPrice(price) !== null;
  }
  
  // NOUVELLE MÉTHODE: Démarrer l'intervalle de nettoyage des ordres non confirmés
  startCleanupInterval() {
    // Nettoyer l'intervalle existant si présent
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Configurer un nouvel intervalle - toutes les 1000ms (1 seconde)
    this.cleanupInterval = setInterval(() => {
      this.cleanupPendingOrders();
    }, 1000);
    
    console.log('🧹 Intervalle de nettoyage des ordres non confirmés configuré (toutes les 1000ms)');
  }
  
  // NOUVELLE MÉTHODE: Nettoyer les ordres en attente de confirmation après un délai
  cleanupPendingOrders() {
    const now = Date.now();
    const ordersToCleanup = [];
    
    // Parcourir tous les ordres en attente de confirmation
    for (const [clientOrderId, orderInfo] of this.pendingConfirmations.entries()) {
      // NOUVEAU: Log détaillé pour chaque ordre en attente
      console.log(`🔍 Vérification de l'ordre ${clientOrderId}: statut=${orderInfo.status}, temps d'attente=${now - orderInfo.timestamp}ms`);
      
      // Ne nettoyer que si :
      // - L'ordre est en attente depuis plus d'une seconde
      // - ET l'ordre n'a pas reçu de statut 'new'
      if (now - orderInfo.timestamp > 1000 && orderInfo.status === ORDER_STATUS.PENDING) {
        console.log(`⚠️ Ordre ${clientOrderId} marqué pour nettoyage: en attente depuis ${now - orderInfo.timestamp}ms avec statut PENDING`);
        ordersToCleanup.push({
          clientOrderId,
          side: orderInfo.side,
          price: orderInfo.price,
          size: orderInfo.size
        });
      } else if (orderInfo.status !== ORDER_STATUS.PENDING) {
        // NOUVEAU: Log pour les ordres qui ont déjà été confirmés
        console.log(`✅ Ordre ${clientOrderId} déjà confirmé avec statut ${orderInfo.status}`);
      }
    }
    
    // Nettoyer les ordres en attente depuis trop longtemps
    if (ordersToCleanup.length > 0) {
      console.log(`🧹 Nettoyage de ${ordersToCleanup.length} ordres non confirmés après délai`);
      
      for (const order of ordersToCleanup) {
        // Retirer de la liste des ordres en attente
        this.pendingConfirmations.delete(order.clientOrderId);
        
        // Retirer des listes d'ordres actifs
        if (order.side === 'buy') {
          this.activeBuyOrders.delete(order.clientOrderId);
          this.orderTotalSizes.delete(order.clientOrderId);
        } else if (order.side === 'sell') {
          this.activeSellOrders.delete(order.clientOrderId);
        }
        
        // Émettre un événement pour informer la stratégie
        this.wsClient.emit('order_cleanup', {
          clientOid: order.clientOrderId,
          side: order.side,
          price: order.price,
          size: order.size,
          reason: 'timeout'
        });
        
        console.log(`🧹 Ordre ${order.clientOrderId} nettoyé: pas de confirmation après 1 seconde`);
      }
    }
  }
  
  // NOUVELLE MÉTHODE: Arrêter l'intervalle de nettoyage
  stopCleanupInterval() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log('🧹 Intervalle de nettoyage des ordres non confirmés arrêté');
    }
  }
}

module.exports = OrderService;
