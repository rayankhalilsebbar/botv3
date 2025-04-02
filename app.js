const config = require('./config');
const WebSocketClient = require('./websocket-client');
const OrderService = require('./order-service');
const GridStrategy = require('./grid-strategy');

async function main() {
  try {
    console.log("\n======= ROBOT DE TRADING GRID MEXC =======");
    console.log("Initialisation des composants...");
    
    // Initialiser le client WebSocket
    const wsClient = new WebSocketClient(config);
    
    // Initialiser le service d'ordres
    const orderService = new OrderService(config, wsClient);
    
    // Initialiser la stratégie de grille
    const gridStrategy = new GridStrategy(config, orderService, wsClient);
    
    // Connecter les WebSockets
    console.log("Connexion aux WebSockets MEXC...");
    const connected = await wsClient.connect();
    
    if (!connected) {
      throw new Error("Impossible de se connecter aux WebSockets MEXC");
    }
    
    // Attendre que le prix soit disponible
    console.log("Attente de la récupération du prix initial...");
    let attempts = 0;
    const maxAttempts = 20;
    
    while (!wsClient.getCurrentPrice() && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
      process.stdout.write(".");
    }
    
    console.log("");
    
    if (!wsClient.getCurrentPrice()) {
      throw new Error("Impossible de récupérer le prix initial après plusieurs tentatives");
    }
    
    console.log(`💰 Prix initial: ${wsClient.getCurrentPrice()}$`);
    
    // Démarrer la stratégie après un court délai pour s'assurer que tout est prêt
    setTimeout(() => {
      gridStrategy.start();
    }, 2000);
    
    console.log("======= ROBOT DE TRADING DÉMARRÉ AVEC SUCCÈS =======");
    
    // Configurer un intervalle pour afficher l'état de la grille périodiquement
    const statsInterval = setInterval(() => {
      gridStrategy.logGridStatus();
    }, 60000); // Toutes les minutes
    
    // Gérer l'arrêt propre
    process.on('SIGINT', async () => {
      console.log("\n🛑 Arrêt du robot de trading...");
      
      // Arrêter la stratégie
      gridStrategy.stop();
      
      // Arrêter l'affichage des statistiques
      clearInterval(statsInterval);
      
      // Déconnecter les WebSockets
      wsClient.disconnect();
      
      // Afficher l'état final
      gridStrategy.logGridStatus();
      
      console.log("👋 Au revoir!");
      process.exit(0);
    });
    
  } catch (error) {
    console.error("❌ Erreur critique lors du démarrage du robot:", error);
    process.exit(1);
  }
}

// Démarrer le programme
main(); 