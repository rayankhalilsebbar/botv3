// config.js
module.exports = {
  // Paramètres de trading
  symbol: 'BTCUSDC',
  maxOrders: 20,           // Nombre maximum d'ordres actifs
  priceStep: 50,            // Écart entre les paliers en USD
  orderAmountUSDC: 1.5,      // Montant fixe en USDC pour chaque ordre
  pricePrecision: 2,        // Nombre de décimales pour les prix
  sizePrecision: 6,         // Nombre de décimales pour la taille des ordres
  
  // Paramètres WebSocket MEXC
  wsEndpoints: {
    public: 'wss://wbs-api.mexc.com/ws',
    private: 'wss://wbs-api.mexc.com/ws'  // Utilise listenKey en paramètre
  },
  
  // API REST MEXC
  restEndpoints: {
    baseUrl: 'https://api.mexc.com/api/v3',
    listenKey: '/userDataStream',
    batchOrders: '/batchOrders'
  },
  
  // Paramètres d'authentification MEXC
  apiKeys: {
    apiKey: process.env.MEXC_API_KEY || 'mx0vglCG1pAONOXh9y',
    secretKey: process.env.MEXC_SECRET_KEY || '81434cf6688b40b9aa25d4e1d88a8053'
  },
  
  // Paramètres pour les ordres en masse
  batchProcessing: {
    maxBatchSize: 20,          // Taille maximale d'un lot (limite MEXC)
    batchInterval: 500,        // Intervalle entre les lots en ms (respecte limite de 2 req/sec)
    priorityOrder: ['cancel', 'sell', 'buy'] // Priorité d'exécution des ordres
  },
  
  // Paramètres de la stratégie
  strategy: {
    updateInterval: 1001,      // Intervalle de mise à jour de la grille en ms
  },
  
  // Paramètres WebSocket et ping/pong
  pingInterval: 29000,         // Intervalle de ping/pong en ms
  
  // Canaux de souscription MEXC
  subscriptions: {
    price: 'spot@public.bookTicker.batch.v3.api.pb',
    orders: 'spot@private.orders.v3.api.pb'
  },
  
  // Type d'ordres MEXC
  orderTypes: {
    limit: 'LIMIT'       // Type d'ordre limit sans prise immédiate
  }
}; 
