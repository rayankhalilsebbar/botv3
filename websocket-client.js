const WebSocket = require('ws');
const crypto = require('crypto');
const EventEmitter = require('events');
const protobuf = require('protobufjs');
const axios = require('axios');

class WebSocketClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.publicWs = null;
    this.privateWs = null;
    this.publicConnected = false;
    this.privateConnected = false;
    this.isAuthenticated = false;
    this.currentPrice = null;
    this.listenKey = null;
    
    // Files d'attente pour les messages REST API
    this.messageQueue = {
      cancel: [],
      sell: [],
      buy: []
    };
    this.processingQueue = false;
    this.batchInterval = null;
    
    // Intervalles pour les pings
    this.publicPingInterval = null;
    this.privatePingInterval = null;

    // Timeouts pour les pongs
    this.publicPongTimeout = null;
    this.privatePongTimeout = null;

    // Paramètres de reconnexion
    this.publicReconnectAttempts = 0;
    this.privateReconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.publicScheduledReconnect = null;
    this.privateScheduledReconnect = null;
    
    // Protobuf roots
    this.protoRoot = null;
    
    // Intervalle de renouvellement du listenKey
    this.listenKeyRenewalInterval = null;
    
    // Indicateurs pour les reconnexions en cours
    this.publicReconnectionInProgress = false;
    this.privateReconnectionInProgress = false;
  }
  
  async connect() {
    try {
      // Charger d'abord les fichiers proto
      console.log('📦 Chargement des fichiers protobuf...');
      this.protoRoot = await protobuf.load([
        'PushDataV3ApiWrapper.proto',
        'PublicBookTickerBatchV3Api.proto',
        'PublicBookTickerV3Api.proto',
        'PrivateOrdersV3Api.proto'
      ]);
      
      // Obtenir le listenKey pour l'authentification
      console.log('🔑 Obtention du listenKey...');
      this.listenKey = await this.getListenKey();
      
      if (!this.listenKey) {
        throw new Error('Impossible d\'obtenir le listenKey');
      }
      
      console.log(`🔑 ListenKey obtenu: ${this.listenKey.substring(0, 10)}...`);
      
      // Connexion aux websockets
      await Promise.all([
        this.connectPublic(),
        this.connectPrivate()
      ]);
      
      // Démarrer le traitement par lots
      this.startBatchProcessing();
      
      return true;
    } catch (error) {
      console.error('❌ Erreur lors de la connexion aux WebSockets:', error);
      return false;
    }
  }
  
  async getListenKey() {
    try {
      const timestamp = Date.now();
      const queryString = `timestamp=${timestamp}`;
      
      // Générer la signature HMAC SHA256
      const signature = crypto
        .createHmac('sha256', this.config.apiKeys.secretKey)
        .update(queryString)
        .digest('hex');
      
      // URL complète avec signature
      const url = `${this.config.restEndpoints.baseUrl}${this.config.restEndpoints.listenKey}?${queryString}&signature=${signature}`;
      
      // NOUVEAUX LOGS DÉTAILLÉS
      console.log('\n=== OBTENTION DU LISTENKEY INITIAL ===');
      console.log('URL:', url);
      console.log('Headers:', {
        'X-MEXC-APIKEY': this.config.apiKeys.apiKey,
        'Content-Type': 'application/json'
      });
      
      // Faire la requête
      const response = await axios.post(url, {}, {
        headers: {
          'X-MEXC-APIKEY': this.config.apiKeys.apiKey,
          'Content-Type': 'application/json'
        }
      });
      
      // NOUVEAU LOG DE LA RÉPONSE
      console.log('Réponse:', response.data);
      
      if (response.data && response.data.listenKey) {
        this.listenKey = response.data.listenKey;
        console.log(`✅ ListenKey initial obtenu: ${this.listenKey.substring(0, 10)}...`);
        
        // Configurer le renouvellement automatique de la listenKey
        this.setupListenKeyRenewal();
        
        return this.listenKey;
      }
      
      throw new Error('ListenKey non trouvé dans la réponse');
    } catch (error) {
      console.error('❌ Erreur lors de l\'obtention du listenKey:', error.message);
      throw error;
    }
  }
  
  async extendListenKey() {
    if (!this.listenKey) {
      console.error('❌ Impossible de prolonger la listen key: aucune listen key active');
      return false;
    }
    
    try {
      const timestamp = Date.now();
      const queryString = `listenKey=${this.listenKey}&timestamp=${timestamp}`;
      
      const signature = crypto
        .createHmac('sha256', this.config.apiKeys.secretKey)
        .update(queryString)
        .digest('hex');
      
      const url = `${this.config.restEndpoints.baseUrl}${this.config.restEndpoints.listenKey}?${queryString}&signature=${signature}`;
      
      // NOUVEAUX LOGS DÉTAILLÉS
      console.log('\n=== RENOUVELLEMENT DU LISTENKEY ===');
      console.log('URL de renouvellement:', url);
      console.log('Headers:', {
        'X-MEXC-APIKEY': this.config.apiKeys.apiKey,
        'Content-Type': 'application/json'
      });
      
      // Faire la requête PUT
      const response = await axios.put(url, {}, {
        headers: {
          'X-MEXC-APIKEY': this.config.apiKeys.apiKey,
          'Content-Type': 'application/json'
        }
      });
      
      // NOUVEAU LOG DE LA RÉPONSE
      console.log('Réponse du renouvellement:', response.data);
      
      if (response.status === 200) {
        console.log('✅ Listen key prolongée avec succès pour 60 minutes supplémentaires');
        return true;
      } else {
        console.error('❌ Erreur lors de la prolongation de la listen key:', response.data);
        return false;
      }
    } catch (error) {
      console.error('❌ Erreur lors de la prolongation de la listen key:', error.response?.data || error.message);
      
      // Si l'erreur indique que la clé n'est plus valide, tenter d'en obtenir une nouvelle
      if (error.response?.status === 401) {
        console.log('⚠️ Listen key expirée, obtention d\'une nouvelle clé...');
        try {
          // Obtenir une nouvelle clé
          this.listenKey = await this.getListenKey();
          if (this.listenKey) {
            // Reconnecter le WebSocket privé avec la nouvelle clé
            console.log('🔑 Nouvelle listen key obtenue, reconnexion du WebSocket privé');
            this.reconnectPrivate();
            return true;
          }
        } catch (renewError) {
          console.error('❌ Erreur lors de l\'obtention d\'une nouvelle listen key:', renewError.message);
        }
      }
      
      return false;
    }
  }
  
  setupListenKeyRenewal() {
    // Nettoyer l'intervalle existant si présent
    if (this.listenKeyRenewalInterval) {
      clearInterval(this.listenKeyRenewalInterval);
    }
    
    // Configurer un nouvel intervalle - toutes les 2 minutes (120000 ms)
    this.listenKeyRenewalInterval = setInterval(async () => {
      console.log('⏰ Renouvellement programmé de la listen key (toutes les 2 minutes)');
      await this.extendListenKey();
    }, 2 * 60 * 1000);
    
    console.log('🔄 Renouvellement automatique de la listen key configuré (toutes les 2 minutes)');
  }
  
  async connectPublic() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Connexion au WebSocket public: ${this.config.wsEndpoints.public}`);
      
      this.publicWs = new WebSocket(this.config.wsEndpoints.public);
      console.log(`📊 État de la connexion publique: ws=${this.publicWs ? 'existe' : 'null'}, connecté=${this.publicConnected}`);
      
      this.publicWs.on('open', () => {
        console.log('✅ WebSocket public connecté');
        this.publicConnected = true;
        this.publicReconnectAttempts = 0;  // Réinitialiser les tentatives
        this.publicReconnectionInProgress = false;
        
        // S'abonner au canal ticker (prix)
        this.subscribeToPriceUpdates();
        
        // Configurer le ping/pong
        this.setupPublicPingPong();
        
        // Programmer une reconnexion
        this.schedulePublicReconnect();
        
        resolve();
      });
      
      this.publicWs.on('message', (message) => {
        try {
          // Essayer d'abord de parser tous les messages comme JSON, même si c'est un Buffer
          try {
            const messageStr = message.toString();
            const jsonData = JSON.parse(messageStr);
            // Si on arrive ici, c'est un JSON valide
            this.handleTextMessage(messageStr, 'public');
          } catch (jsonError) {
            // Ce n'est pas un JSON valide, essayer comme protobuf si c'est un Buffer
            if (message instanceof Buffer) {
              this.handleProtobufPrice(message);
            } else {
              // Messages texte non-JSON
              console.log(`📩 Message public non-JSON reçu: ${message.toString()}`);
            }
          }
        } catch (error) {
          console.error('❌ Erreur de traitement du message public:', error.message);
        }
      });
      
      this.publicWs.on('error', (error) => {
        console.error(`❌ Erreur WebSocket public: ${error.message}`);
        this.publicConnected = false;
        reject(error);
      });
      
      this.publicWs.on('close', (code, reason) => {
        console.warn(`⚠️ WebSocket public déconnecté: Code=${code}, Raison=${reason || 'Non spécifiée'}`);
        this.publicConnected = false;
        
        // Nettoyer les intervalles
        if (this.publicPingInterval) {
          clearInterval(this.publicPingInterval);
          this.publicPingInterval = null;
        }
        
        if (this.publicScheduledReconnect) {
          clearTimeout(this.publicScheduledReconnect);
          this.publicScheduledReconnect = null;
        }
        
        // Tenter de se reconnecter seulement si la déconnexion n'est pas due à une reconnexion programmée
        if (!this.publicReconnectionInProgress) {
          this.reconnectPublic();
        }
      });
    });
  }
  
  async connectPrivate() {
    return new Promise((resolve, reject) => {
      // URL avec listenKey pour le WebSocket privé
      const privateUrl = `${this.config.wsEndpoints.private}?listenKey=${this.listenKey}`;
      console.log(`🔌 Connexion au WebSocket privé avec listenKey`);
      
      this.privateWs = new WebSocket(privateUrl);
      console.log(`📊 État de la connexion privée: ws=${this.privateWs ? 'existe' : 'null'}, connecté=${this.privateConnected}, authentifié=${this.isAuthenticated}`);
      
      this.privateWs.on('open', () => {
        console.log('✅ WebSocket privé connecté');
        this.privateConnected = true;
        this.privateReconnectAttempts = 0;  // Réinitialiser les tentatives
        this.privateReconnectionInProgress = false;
        this.isAuthenticated = true;  // Avec listenKey, on est déjà authentifié
        
        // S'abonner au canal des ordres
        this.subscribeToOrderUpdates();
        
        // Configurer le ping/pong
        this.setupPrivatePingPong();
        
        // Programmer une reconnexion
        this.schedulePrivateReconnect();
        
        resolve();
      });
      
      this.privateWs.on('message', (message) => {
        try {
          // Essayer d'abord de parser tous les messages comme JSON, même si c'est un Buffer
          try {
            const messageStr = message.toString();
            const jsonData = JSON.parse(messageStr);
            // Si on arrive ici, c'est un JSON valide
            this.handleTextMessage(messageStr, 'private');
          } catch (jsonError) {
            // Ce n'est pas un JSON valide, essayer comme protobuf si c'est un Buffer
            if (message instanceof Buffer) {
              this.handleProtobufOrder(message);
            } else {
              // Messages texte non-JSON
              console.log(`📩 Message privé non-JSON reçu: ${message.toString()}`);
            }
          }
        } catch (error) {
          console.error('❌ Erreur de traitement du message privé:', error.message);
        }
      });
      
      this.privateWs.on('error', (error) => {
        console.error(`❌ Erreur WebSocket privé: ${error.message}`);
        this.privateConnected = false;
        this.isAuthenticated = false;
        reject(error);
      });
      
      this.privateWs.on('close', (code, reason) => {
        console.warn(`⚠️ WebSocket privé déconnecté: Code=${code}, Raison=${reason || 'Non spécifiée'}`);
        this.privateConnected = false;
        this.isAuthenticated = false;
        
        // Nettoyer les intervalles
        if (this.privatePingInterval) {
          clearInterval(this.privatePingInterval);
          this.privatePingInterval = null;
        }
        
        if (this.privateScheduledReconnect) {
          clearTimeout(this.privateScheduledReconnect);
          this.privateScheduledReconnect = null;
        }
        
        // Tenter de se reconnecter seulement si la déconnexion n'est pas due à une reconnexion programmée
        if (!this.privateReconnectionInProgress) {
          this.reconnectPrivate();
        }
      });
    });
  }
  
  handleProtobufPrice(message) {
    try {
      // Créer un nouveau Buffer à partir des données binaires
      const buffer = Buffer.from(message);
      
      const Wrapper = this.protoRoot.lookupType("PushDataV3ApiWrapper");
      const decoded = Wrapper.decode(buffer);
      
      // Vérifier si c'est un message de prix 
      if (decoded.publicBookTickerBatch && decoded.publicBookTickerBatch.items && decoded.publicBookTickerBatch.items.length > 0) {
        const firstItem = decoded.publicBookTickerBatch.items[0];
        
        // Extraire le askPrice (prix de vente) comme prix actuel
        const price = parseFloat(firstItem.askPrice);
        
        if (isNaN(price)) {
          console.error('❌ Prix invalide reçu:', firstItem);
          return;
        }
        
        this.currentPrice = price;
        this.emit('price_update', price);
      }
    } catch (error) {
      console.error('❌ Erreur de décodage protobuf (prix):', error.message);
    }
  }
  
  handleProtobufOrder(message) {
    try {
      // Créer un nouveau Buffer à partir des données binaires
      const buffer = Buffer.from(message);
      
      const Wrapper = this.protoRoot.lookupType("PushDataV3ApiWrapper");
      const decoded = Wrapper.decode(buffer);
      
      // Vérifier si c'est un message d'ordre
      if (decoded.privateOrders) {
        const order = decoded.privateOrders;
        const clientId = order.clientId;
        const status = order.status;
        const price = order.price;
        const side = order.tradeType === 1 ? 'buy' : 'sell';
        
        // Quantité selon le statut
        const size = order.status === 2 
          ? parseFloat(order.lastDealQuantity || order.cumulativeQuantity) 
          : parseFloat(order.quantity);
        
        console.log(`📋 Mise à jour d'ordre reçue: ${clientId || order.id}, Statut: ${status}`);
        
        // Traiter différents types de statuts (MEXC)
        // 1 = nouvel ordre, 2 = exécuté, 4 = annulé
        if (status === 2) {
          // Ordre exécuté (filled)
          // Déterminer s'il s'agit d'un achat ou d'une vente
          if (side === 'buy' || clientId.startsWith('buy_')) {
            this.emit('buy_order_filled', {
              clientOid: clientId, // Garder clientOid pour compatibilité
              price: parseFloat(price),
              size: size
            });
          } else if (side === 'sell' || clientId.startsWith('sell_')) {
            this.emit('sell_order_filled', {
              clientOid: clientId, // Garder clientOid pour compatibilité
              price: parseFloat(price),
              size: size
            });
          }
        } else if (status === 4) {
          // Ordre annulé
          this.emit('order_cancelled', {
            clientOid: clientId, // Garder clientOid pour compatibilité
            price: parseFloat(price),
            side: side
          });
        }
        
        // Émettre l'événement générique de mise à jour avec format BitGet pour compatibilité
        const compatOrder = {
          clientOid: clientId,
          status: status === 2 ? 'filled' : (status === 4 ? 'cancelled' : 'new'),
          price: price,
          newSize: size.toString(),
          side: side
        };
        
        this.emit('order_update', compatOrder);
      }
    } catch (error) {
      console.error('❌ Erreur de décodage protobuf (ordre):', error.message);
    }
  }
  
  handleTextMessage(messageStr, source) {
    try {
      // Essayer de parser comme JSON
      const data = JSON.parse(messageStr);
      
      // Afficher les messages reçus pour le debug
      console.log(`📩 Message ${source} JSON reçu: ${messageStr}`);
      
      // Format PONG exactement selon la doc MEXC: {"id": 0, "code": 0, "msg": "PONG"}
      if (
        (data.id === 0 && data.code === 0 && data.msg === 'PONG') ||
        // Format alternatif possible
        (data.msg === 'PONG')
      ) {
        console.log(`✅ PONG reçu sur WebSocket ${source}`);
        
        // Nettoyer le timeout approprié
        if (source === 'public' && this.publicPongTimeout) {
          clearTimeout(this.publicPongTimeout);
          this.publicPongTimeout = null;
        } else if (source === 'private' && this.privatePongTimeout) {
          clearTimeout(this.privatePongTimeout);
          this.privatePongTimeout = null;
        }
        
        return true;
      }
      
      // NOUVEAU CODE: Vérifier spécifiquement le message "Wrong listen key"
      if (source === 'private' && data.msg === 'Wrong listen key') {
        console.log('🔴 Erreur listenKey détectée: "Wrong listen key" - Demande d\'une nouvelle clé');
        
        // Annuler les tentatives de reconnexion en cours pour éviter un cycle infini
        this.privateReconnectionInProgress = false;
        this.privateReconnectAttempts = 0;
        
        // Démarrer la procédure de récupération de listenKey
        this.handleInvalidListenKey();
        
        return true;
      }
      
      // Cas particulier: réponses d'erreur qui peuvent être considérées comme des réponses valides
      if (
        (data.code === 0 && data.msg === 'msg format invalid') ||
        (data.code === 100403) ||  // Erreur d'autorisation
        (data.code && data.msg)    // Toute réponse d'erreur avec code et message
      ) {
        console.log(`⚠️ Message format potentiellement invalide reçu: ${messageStr} - traité comme réponse`);
        
        // Considérer comme une réponse valide pour éviter les reconnexions inutiles
        if (source === 'public' && this.publicPongTimeout) {
          clearTimeout(this.publicPongTimeout);
          this.publicPongTimeout = null;
        } else if (source === 'private' && this.privatePongTimeout) {
          clearTimeout(this.privatePongTimeout);
          this.privatePongTimeout = null;
        }
        
        return true;
      }
      
      return true; // Tous les messages JSON sont considérés comme traités
    } catch (error) {
      // Ce n'est pas un JSON valide
      return false;
    }
  }
  
  // NOUVELLE MÉTHODE: Gérer spécifiquement un listenKey invalide
  async handleInvalidListenKey() {
    console.log('🔑 Détection de listenKey invalide, démarrage procédure de récupération');
    
    // Arrêter toute tentative de reconnexion en cours
    this.privateReconnectionInProgress = true;
    
    // Déconnecter proprement le WebSocket privé actuel
    this.disconnectPrivate();
    
    try {
      // Attendre un court délai pour s'assurer que tout est bien nettoyé
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Générer une nouvelle listenKey
      console.log('🔑 Génération d\'une nouvelle listenKey...');
      const newListenKey = await this.getListenKey();
      
      if (newListenKey) {
        console.log(`🔑 Nouvelle listenKey obtenue: ${newListenKey.substring(0, 10)}...`);
        this.listenKey = newListenKey;
        
        // Réinitialiser les compteurs de tentatives
        this.privateReconnectAttempts = 0;
        
        // Tenter une reconnexion avec la nouvelle listenKey
        console.log('🔌 Tentative de reconnexion avec la nouvelle listenKey');
        await this.connectPrivate();
        
        console.log('✅ Reconnexion avec nouvelle listenKey réussie');
        this.privateReconnectionInProgress = false;
        return true;
      } else {
        throw new Error('Impossible d\'obtenir une nouvelle listenKey');
      }
    } catch (error) {
      console.error('❌ Échec de récupération après listenKey invalide:', error.message);
      this.privateReconnectionInProgress = false;
      
      // Planifier une nouvelle tentative après un délai
      console.log('🔄 Nouvelle tentative de récupération planifiée dans 30 secondes');
      setTimeout(() => this.handleInvalidListenKey(), 30000);
      return false;
    }
  }
  
  subscribeToPriceUpdates() {
    if (!this.publicConnected) {
      console.error('❌ WebSocket public non connecté, impossible de s\'abonner au prix');
      return;
    }
    
    const channel = `${this.config.subscriptions.price}@${this.config.symbol}`;
    const subscribeMessage = {
      method: "SUBSCRIPTION",
      params: [channel]
    };
    
    console.log(`📤 Abonnement au canal de prix pour ${this.config.symbol}`);
    this.publicWs.send(JSON.stringify(subscribeMessage));
  }
  
  subscribeToOrderUpdates() {
    if (!this.privateConnected || !this.isAuthenticated) {
      console.error('❌ WebSocket privé non connecté ou non authentifié, impossible de s\'abonner aux ordres');
      return;
    }
    
    const subscribeMessage = {
      method: "SUBSCRIPTION",
      params: [this.config.subscriptions.orders]
    };
    
    console.log(`📤 Abonnement au canal des ordres`);
    this.privateWs.send(JSON.stringify(subscribeMessage));
  }
  
  // Méthodes de gestion des ping/pong
  setupPublicPingPong() {
    // Nettoyer l'intervalle existant si présent
    if (this.publicPingInterval) {
      clearInterval(this.publicPingInterval);
      this.publicPingInterval = null;
    }
    
    // Configurer un nouveau ping/pong
    this.publicPingInterval = setInterval(() => {
      if (this.publicConnected) {
        console.log('📤 Envoi PING au WebSocket public');
        
        // Format PING exactement selon la doc MEXC: {"method": "PING"}
        try {
          this.publicWs.send(JSON.stringify({ "method": "PING" }));
          
          // Configurer un timeout pour la réponse pong
          this.publicPongTimeout = setTimeout(() => {
            console.warn('⚠️ Pas de PONG reçu du WebSocket public dans le délai imparti');
            
            // Fermer la connexion et déclencher une reconnexion
            this.publicWs.terminate();
            this.publicConnected = false;
            this.reconnectPublic();
          }, 10000); // 10 secondes pour recevoir le pong
        } catch (error) {
          console.error('❌ Erreur lors de l\'envoi du PING au WebSocket public:', error.message);
        }
      }
    }, this.config.pingInterval);
  }
  
  setupPrivatePingPong() {
    // Nettoyer l'intervalle existant si présent
    if (this.privatePingInterval) {
      clearInterval(this.privatePingInterval);
      this.privatePingInterval = null;
    }
    
    // Configurer un nouveau ping/pong
    this.privatePingInterval = setInterval(() => {
      if (this.privateConnected) {
        console.log('📤 Envoi PING au WebSocket privé');
        
        // Format PING exactement selon la doc MEXC: {"method": "PING"}
        try {
          this.privateWs.send(JSON.stringify({ "method": "PING" }));
          
          // Configurer un timeout pour la réponse pong
          this.privatePongTimeout = setTimeout(() => {
            console.warn('⚠️ Pas de PONG reçu du WebSocket privé dans le délai imparti');
            
            // Fermer la connexion et déclencher une reconnexion
            this.privateWs.terminate();
            this.privateConnected = false;
            this.isAuthenticated = false;
            this.reconnectPrivate();
          }, 10000); // 10 secondes pour recevoir le pong
        } catch (error) {
          console.error('❌ Erreur lors de l\'envoi du PING au WebSocket privé:', error.message);
        }
      }
    }, this.config.pingInterval);
  }
  
  schedulePublicReconnect() {
    // Programmation d'une reconnexion périodique pour éviter les déconnexions inactives
    if (this.publicScheduledReconnect) {
      clearTimeout(this.publicScheduledReconnect);
    }
    
    this.publicScheduledReconnect = setTimeout(() => {
      console.log('⏰ Reconnexion programmée du WebSocket public déclenchée');
      this.reconnectPublic(true);
    }, 23 * 60 * 60 * 1000 + 50 * 60 * 1000); // 23h50m
  }
  
  schedulePrivateReconnect() {
    // Programmation d'une reconnexion périodique pour éviter les déconnexions inactives
    if (this.privateScheduledReconnect) {
      clearTimeout(this.privateScheduledReconnect);
    }
    
    this.privateScheduledReconnect = setTimeout(() => {
      console.log('⏰ Reconnexion programmée du WebSocket privé déclenchée');
      this.reconnectPrivate(true);
    }, 23 * 60 * 60 * 1000 + 50 * 60 * 1000); // 23h50m
  }
  
  reconnectPublic(scheduled = false) {
    // Si c'est une reconnexion programmée, déconnecter proprement d'abord
    if (scheduled) {
      console.log(`🔄 Début de la reconnexion programmée du WebSocket public`);
      this.publicReconnectionInProgress = true;
      this.publicReconnectAttempts = 0;
      
      // Déconnecter proprement avant de reconnecter
      this.disconnectPublic();
      
      // Ajouter un délai pour assurer que la déconnexion est complète
      setTimeout(() => {
        console.log(`🔄 Tentative de reconnexion programmée du WebSocket public`);
        this.connectPublic().catch(error => {
          console.error('❌ Échec de reconnexion programmée du WebSocket public:', error);
          this.publicReconnectionInProgress = false;
        });
      }, 3000); // Délai de 3 secondes
      
      return; // Sortir pour éviter le code de reconnexion standard
    }
    
    // Déjà une tentative en cours
    if (this.publicReconnectionInProgress) return;
    this.publicReconnectionInProgress = true;
    
    // Incrémenter le compteur de tentatives
    this.publicReconnectAttempts++;
    
    // Vérifier si on a atteint le nombre maximal de tentatives
    if (this.publicReconnectAttempts > this.maxReconnectAttempts) {
      console.error(`❌ Nombre maximal de tentatives de reconnexion atteint pour le WebSocket public`);
      this.publicReconnectionInProgress = false;
      return;
    }
    
    // Calculer le délai de backoff exponentiel
    const reconnectDelay = Math.min(30000, 1000 * Math.pow(2, this.publicReconnectAttempts));
    
    console.log(`🔄 Tentative de reconnexion WebSocket public dans ${reconnectDelay / 1000} secondes (tentative ${this.publicReconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(async () => {
      try {
        await this.connectPublic();
        this.publicReconnectionInProgress = false;
      } catch (error) {
        console.error('❌ Échec de la reconnexion WebSocket public:', error.message);
        this.publicReconnectionInProgress = false;
        this.reconnectPublic();
      }
    }, reconnectDelay);
  }
  
  reconnectPrivate(scheduled = false) {
    // Si c'est une reconnexion programmée, déconnecter proprement d'abord
    if (scheduled) {
      console.log(`🔄 Début de la reconnexion programmée du WebSocket privé`);
      this.privateReconnectionInProgress = true;
      this.privateReconnectAttempts = 0;
      
      // Déconnecter proprement avant de reconnecter
      this.disconnectPrivate();
      
      // Vérifier si nous avons besoin d'un nouveau listenKey
      setTimeout(async () => {
        try {
          console.log('🔑 Obtention d\'un nouveau listenKey pour la reconnexion programmée...');
          // Tenter d'obtenir un nouveau listenKey pour la reconnexion
          this.listenKey = await this.getListenKey();
          
          console.log(`🔄 Tentative de reconnexion programmée du WebSocket privé avec nouveau listenKey`);
          await this.connectPrivate();
          this.privateReconnectionInProgress = false;
        } catch (error) {
          console.error('❌ Échec de reconnexion programmée du WebSocket privé:', error);
          this.privateReconnectionInProgress = false;
        }
      }, 3000); // Délai de 3 secondes
      
      return; // Sortir pour éviter le code de reconnexion standard
    }
    
    // Déjà une tentative en cours
    if (this.privateReconnectionInProgress) return;
    this.privateReconnectionInProgress = true;
    
    // Incrémenter le compteur de tentatives
    this.privateReconnectAttempts++;
    
    // Vérifier si on a atteint le nombre maximal de tentatives
    if (this.privateReconnectAttempts > this.maxReconnectAttempts) {
      console.error(`❌ Nombre maximal de tentatives de reconnexion atteint pour le WebSocket privé`);
      this.privateReconnectionInProgress = false;
      return;
    }
    
    // Calculer le délai de backoff exponentiel
    const reconnectDelay = Math.min(30000, 1000 * Math.pow(2, this.privateReconnectAttempts));
    
    console.log(`🔄 Tentative de reconnexion WebSocket privé dans ${reconnectDelay / 1000} secondes (tentative ${this.privateReconnectAttempts}/${this.maxReconnectAttempts})`);
    
    setTimeout(async () => {
      try {
        // Vérifier si nous avons besoin d'un nouveau listenKey
        if (!this.listenKey) {
          console.log('🔑 Obtention d\'un nouveau listenKey pour la reconnexion...');
          this.listenKey = await this.getListenKey();
        }
        
        await this.connectPrivate();
        this.privateReconnectionInProgress = false;
      } catch (error) {
        console.error('❌ Échec de la reconnexion WebSocket privé:', error.message);
        this.privateReconnectionInProgress = false;
        this.reconnectPrivate();
      }
    }, reconnectDelay);
  }
  
  // Remplacer disconnect() par deux méthodes séparées
  disconnectPublic() {
    console.log(`🔌 Déconnexion du WebSocket public initiée`);
    
    // Nettoyer les timeouts et intervalles
    if (this.publicPingInterval) {
      console.log('🧹 Nettoyage de l\'intervalle de ping public');
      clearInterval(this.publicPingInterval);
      this.publicPingInterval = null;
    }
    
    if (this.publicPongTimeout) {
      console.log('🧹 Nettoyage du timeout de pong public');
      clearTimeout(this.publicPongTimeout);
      this.publicPongTimeout = null;
    }
    
    if (this.publicScheduledReconnect) {
      console.log('🧹 Nettoyage de la reconnexion programmée publique');
      clearTimeout(this.publicScheduledReconnect);
      this.publicScheduledReconnect = null;
    }
    
    // Se désabonner avant de fermer
    if (this.publicWs && this.publicConnected) {
      try {
        this.unsubscribeFromPriceUpdates();
      } catch (error) {
        console.error('❌ Erreur lors du désabonnement:', error.message);
      }
    }
    
    if (this.publicWs) {
      console.log('👋 Fermeture de la connexion WebSocket publique');
      
      // Supprimer tous les listeners
      this.publicWs.removeAllListeners('message');
      this.publicWs.removeAllListeners('open');
      this.publicWs.removeAllListeners('close');
      this.publicWs.removeAllListeners('error');
      
      // Fermer la connexion avec un code normal
      try {
        this.publicWs.close(1000, 'Fermeture normale');
      } catch (error) {
        console.error('❌ Erreur lors de la fermeture du WebSocket public:', error.message);
      }
      
      this.publicWs = null;
    }
    
    // Réinitialiser les états
    this.publicConnected = false;
    
    console.log('✅ Déconnexion du WebSocket public terminée');
  }

  disconnectPrivate() {
    console.log(`🔌 Déconnexion du WebSocket privé initiée`);
    
    // Nettoyer les timeouts et intervalles
    if (this.privatePingInterval) {
      console.log('🧹 Nettoyage de l\'intervalle de ping privé');
      clearInterval(this.privatePingInterval);
      this.privatePingInterval = null;
    }
    
    if (this.privatePongTimeout) {
      console.log('🧹 Nettoyage du timeout de pong privé');
      clearTimeout(this.privatePongTimeout);
      this.privatePongTimeout = null;
    }
    
    if (this.privateScheduledReconnect) {
      console.log('🧹 Nettoyage de la reconnexion programmée privée');
      clearTimeout(this.privateScheduledReconnect);
      this.privateScheduledReconnect = null;
    }
    
    // Se désabonner avant de fermer
    if (this.privateWs && this.privateConnected && this.isAuthenticated) {
      try {
        this.unsubscribeFromOrderUpdates();
      } catch (error) {
        console.error('❌ Erreur lors du désabonnement:', error.message);
      }
    }
    
    if (this.privateWs) {
      console.log('👋 Fermeture de la connexion WebSocket privée');
      
      // Supprimer tous les listeners
      this.privateWs.removeAllListeners('message');
      this.privateWs.removeAllListeners('open');
      this.privateWs.removeAllListeners('close');
      this.privateWs.removeAllListeners('error');
      
      // Fermer la connexion avec un code normal
      try {
        this.privateWs.close(1000, 'Fermeture normale');
      } catch (error) {
        console.error('❌ Erreur lors de la fermeture du WebSocket privé:', error.message);
      }
      
      this.privateWs = null;
    }
    
    // Réinitialiser les états
    this.privateConnected = false;
    this.isAuthenticated = false;
    
    console.log('✅ Déconnexion du WebSocket privé terminée');
  }
  
  // Mettre à jour la méthode disconnect principale pour utiliser les nouvelles méthodes
  disconnect() {
    console.log('🛑 Déconnexion des WebSockets');
    
    // Arrêter le traitement par lots
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
    
    // Arrêter le renouvellement du listenKey
    if (this.listenKeyRenewalInterval) {
      clearInterval(this.listenKeyRenewalInterval);
      this.listenKeyRenewalInterval = null;
      console.log('🛑 Intervalle de renouvellement listenKey arrêté');
    }
    
    // Utiliser les nouvelles méthodes de déconnexion
    this.disconnectPublic();
    this.disconnectPrivate();
    
    console.log('👋 WebSockets déconnectés proprement');
  }
  
  // Méthodes de désabonnement pour MEXC
  unsubscribeFromPriceUpdates() {
    if (!this.publicConnected) {
      console.log('❌ WebSocket public non connecté, impossible de se désabonner du prix');
      return;
    }
    
    try {
      const channel = `${this.config.subscriptions.price}@${this.config.symbol}`;
      const unsubscribeMessage = {
        method: "UNSUBSCRIPTION",
        params: [channel]
      };
      
      console.log(`📤 Désabonnement du canal de prix pour ${this.config.symbol}`);
      this.publicWs.send(JSON.stringify(unsubscribeMessage));
    } catch (error) {
      console.error('❌ Erreur lors du désabonnement aux mises à jour de prix:', error.message);
    }
  }
  
  unsubscribeFromOrderUpdates() {
    if (!this.privateConnected || !this.isAuthenticated) {
      console.log('❌ WebSocket privé non connecté ou non authentifié, impossible de se désabonner des ordres');
      return;
    }
    
    try {
      const unsubscribeMessage = {
        method: "UNSUBSCRIPTION",
        params: [this.config.subscriptions.orders]
      };
      
      console.log(`📤 Désabonnement du canal des ordres`);
      this.privateWs.send(JSON.stringify(unsubscribeMessage));
    } catch (error) {
      console.error('❌ Erreur lors du désabonnement aux mises à jour d\'ordres:', error.message);
    }
  }
  
  // Pour l'API REST - Gestion des files d'attente
  startBatchProcessing() {
    console.log('🚀 Démarrage du traitement par lots');
    
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
    }
    
    this.batchInterval = setInterval(() => {
      this.processNextBatch();
    }, this.config.batchProcessing.batchInterval);
  }
  
  stopBatchProcessing() {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
  }
  
  queueMessage(message, type) {
    if (!type || !this.messageQueue[type]) {
      console.error(`❌ Type de message invalide: ${type}`);
      return;
    }
    
    this.messageQueue[type].push(message);
  }
  
  async processNextBatch() {
    if (this.processingQueue) return;
    this.processingQueue = true;
    
    try {
      // Traiter les messages par priorité (cancel, sell, buy)
      for (const type of this.config.batchProcessing.priorityOrder) {
        const queue = this.messageQueue[type];
        
        // Rien à traiter dans cette file
        if (queue.length === 0) continue;
        
        // Prendre un lot de messages selon la taille max configurée
        const batch = queue.splice(0, this.config.batchProcessing.maxBatchSize);
        
        if (batch.length > 0) {
          console.log(`📦 Traitement d'un lot de ${batch.length} messages ${type}`);
          await this.sendBatchToAPI(batch, type);
          break; // On ne traite qu'un seul lot par intervalle
        }
      }
    } catch (error) {
      console.error('❌ Erreur lors du traitement du lot:', error);
    } finally {
      this.processingQueue = false;
    }
  }
  
  async sendBatchToAPI(batch, type) {
    // Cette méthode sera remplacée par l'implémentation dans order-service.js
    // qui fera les appels API REST nécessaires
    console.log(`📤 Envoi d'un lot de ${batch.length} messages ${type} à l'API REST`);
  }
  
  getCurrentPrice() {
    return this.currentPrice;
  }
}

module.exports = WebSocketClient; 