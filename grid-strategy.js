// grid-strategy.js
class GridStrategy {
  constructor(config, orderService, wsClient) {
    this.config = config;
    this.orderService = orderService;
    this.wsClient = wsClient;
    
    this.running = false;
    this.updateInterval = null;
    this.isUpdating = false;  // Nouveau verrou
    this.lastProcessedPrice = null;
    this.lastGridUpdateTime = null;
    this.lastBasePrice = null;
    
    // NOUVELLE PROPRIÉTÉ: Ensemble des prix où un ordre de vente vient d'être placé au niveau supérieur
    this.recentlyPlacedSellLevels = new Set();
    
    // Écouteurs d'événements liés à la stratégie
    this.setupEventListeners();
  }
  
  setupEventListeners() {
    // Mise à jour du prix
    this.wsClient.on('price_update', (price) => {
      // Simplement stocker le nouveau prix, l'intervalle s'occupera de la mise à jour
      this.lastProcessedPrice = price;
    });
    
    // Exécution d'un ordre d'achat - déjà géré par OrderService qui place l'ordre de vente
    this.wsClient.on('strategy_buy_filled', (data) => {
      console.log(`📈 Stratégie: Achat exécuté à ${data.price}$, ordre de vente placé à ${data.sellPrice}$`);
      
      // NOUVEAU CODE: Ajouter le prix d'achat à la liste des prix verrouillés
      // (car un ordre de vente vient d'être placé au niveau supérieur)
      this.recentlyPlacedSellLevels.add(data.price);
      
      // Libérer ce prix après un délai égal à l'intervalle de mise à jour
      setTimeout(() => {
        this.recentlyPlacedSellLevels.delete(data.price);
      }, 1001); // Exactement l'intervalle de mise à jour de la grille
    });
    
    // Exécution d'un ordre de vente - modification pour ne plus afficher le prix d'achat puisqu'il n'est plus placé automatiquement
    this.wsClient.on('strategy_sell_filled', (data) => {
      console.log(`📉 Stratégie: Vente exécutée à ${data.price}$`);
      
      // NOUVELLE MODIFICATION: Déclencher updateGrid() après chaque vente pour maintenir la grille complète
      setTimeout(() => {
        console.log(`🔄 Mise à jour de la grille déclenchée après vente à ${data.price}$`);
        this.forceUpdateGrid();
      }, 100); // Petit délai pour laisser le temps à l'ordre d'être retiré des listes actives
    });
  }
  
  // Nouvelle méthode pour forcer la mise à jour de la grille sans vérifier si le prix a changé
  forceUpdateGrid() {
    if (!this.running) return;
    
    const currentPrice = this.wsClient.getCurrentPrice();
    if (!currentPrice) {
      console.log('⚠️ Impossible de mettre à jour la grille: prix actuel non disponible');
      return;
    }
    
    // Calculer le prix de base actuel
    const currentBasePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
    
    console.log(`🔄 Mise à jour forcée de la grille - Prix actuel: ${currentPrice}$ (base: ${currentBasePrice}$)`);
    
    // Ajuster la grille
    this.adjustGridUpwards(currentBasePrice);
    
    // Mémoriser le nouveau prix de base si nécessaire
    if (currentBasePrice > this.lastBasePrice) {
      this.lastBasePrice = currentBasePrice;
    }
    
    // Mettre à jour l'horodatage de la dernière mise à jour
    this.lastGridUpdateTime = Date.now();
    this.lastProcessedPrice = currentPrice;
  }
  
  // Nouvelle méthode updateGrid unifiée
  updateGrid() {
    if (!this.running) return;
    if (this.isUpdating) return;  // Protection contre les exécutions simultanées
    
    this.isUpdating = true;
    
    try {
      const currentPrice = this.wsClient.getCurrentPrice();
      if (!currentPrice) {
        console.log('⚠️ Impossible de mettre à jour la grille: prix actuel non disponible');
        return;
      }
  
      // 1. Calculer le prix de base actuel
      const currentBasePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
  
      // 2. Ajuster la grille vers le haut si nécessaire - UNIQUEMENT SI LE PRIX DE BASE A AUGMENTÉ
      // Comportement de BitGet: ne pas réagir aux baisses de prix, seulement aux hausses
      if (this.lastBasePrice && currentBasePrice > this.lastBasePrice) {
        console.log(`📈 Le prix est monté - Prix actuel: ${currentPrice}$ (base: ${currentBasePrice}$ > dernière base: ${this.lastBasePrice}$)`);
        
        // Obtenir les ordres actifs
        const activeBuyOrders = this.orderService.getActiveBuyOrders();
        
        // Générer la nouvelle grille idéale
        const newGrid = this.generateGrid(currentPrice);
        
        // Identifier les ordres à annuler (trop bas)
        const ordersToCancel = [];
        const existingPrices = new Set();
        
        for (const order of activeBuyOrders) {
          existingPrices.add(order.price);
          if (!newGrid.includes(order.price)) {
            ordersToCancel.push(order.clientOid);
          }
        }
  
        // Identifier les nouveaux prix à ajouter avec vérification des ordres de vente
        const newPricesToAdd = newGrid.filter(price => {
          // Vérifie qu'il n'y a pas déjà un ordre d'achat à ce prix
          if (existingPrices.has(price)) {
            return false;
          }
          
          // NOUVELLE VÉRIFICATION: Ignorer les prix où un ordre de vente vient d'être placé au niveau supérieur
          if (this.recentlyPlacedSellLevels.has(price)) {
            console.log(`⚠️ Prix ${price}$ ignoré car un ordre de vente vient d'être placé au niveau supérieur`);
            return false;
          }
          
          // Vérifie qu'il n'y a pas d'ordre de vente au niveau supérieur
          const sellPriceLevel = parseFloat((price + this.config.priceStep).toFixed(this.config.pricePrecision));
          if (this.orderService.hasSellOrderAtPrice(sellPriceLevel)) {
            return false;
          }
          
          return true;
        });
        
        // Appliquer les changements
        if (ordersToCancel.length > 0) {
          console.log(`❌ Annulation de ${ordersToCancel.length} ordres trop éloignés de la nouvelle grille`);
          this.orderService.cancelBulkOrders(ordersToCancel);
        }
  
        if (newPricesToAdd.length > 0) {
          console.log(`📈 Ajout de ${newPricesToAdd.length} nouveaux niveaux de prix à la grille`);
          const newOrdersData = newPricesToAdd.map(price => ({
            price,
            size: this.orderService.calculateOrderSize(price)
          }));
          this.orderService.placeBulkOrders(newOrdersData, 'buy');
        }
  
        this.lastBasePrice = currentBasePrice;
      }
  
      // 3. Combler les trous dans la grille existante
      const activeBuyOrders = this.orderService.getActiveBuyOrders();
      const idealGrid = this.generateGrid(currentPrice);
      
      // Identifier les trous avec vérification des ordres de vente
      const existingPrices = new Set(activeBuyOrders.map(order => order.price));
      const holes = idealGrid
        .filter(price => {
          // Vérifie qu'il n'y a pas déjà un ordre d'achat à ce prix
          if (existingPrices.has(price)) {
            return false;
          }
          
          // NOUVELLE VÉRIFICATION: Ignorer les prix où un ordre de vente vient d'être placé au niveau supérieur
          if (this.recentlyPlacedSellLevels.has(price)) {
            console.log(`⚠️ Trou ignoré au prix ${price}$ car un ordre de vente vient d'être placé au niveau supérieur`);
            return false;
          }
          
          // Vérifie qu'il n'y a pas d'ordre de vente au niveau supérieur
          const sellPriceLevel = parseFloat((price + this.config.priceStep).toFixed(this.config.pricePrecision));
          if (this.orderService.hasSellOrderAtPrice(sellPriceLevel)) {
            return false;
          }
          
          return true;
        })
        .map(price => ({
          price,
          distanceFromCurrent: Math.abs(currentPrice - price)
        }))
        .sort((a, b) => a.distanceFromCurrent - b.distanceFromCurrent);

      // Vérifier si nous avons atteint la limite d'ordres
      const activeSellOrders = this.orderService.getActiveSellOrders();
      const totalActiveOrders = activeBuyOrders.length + activeSellOrders.length;
      const canAddWithoutCancelling = totalActiveOrders < this.config.maxOrders;

      if (canAddWithoutCancelling && holes.length > 0) {
        // Si on n'a pas atteint la limite, simplement ajouter des ordres pour les trous
        // Limiter le nombre de nouveaux ordres à placer
        const holesToFill = holes.slice(0, this.config.maxOrders - totalActiveOrders);
        
        if (holesToFill.length > 0) {
          console.log(`📈 Ajout de ${holesToFill.length} nouveaux niveaux pour combler les trous`);
          
          const newOrdersData = holesToFill.map(hole => ({
            price: hole.price,
            size: this.orderService.calculateOrderSize(hole.price)
          }));
          
          this.orderService.placeBulkOrders(newOrdersData, 'buy');
        }
      } else if (holes.length > 0) {
        // Si on a atteint la limite, on va déplacer des ordres comme dans BitGet
        // en annulant et plaçant dans le même cycle
        
        // Limiter le nombre de trous à combler
        const maxHolesToFill = Math.min(holes.length, 20); // Limiter à 20 pour permettre un remplissage rapide de la grille
        const holesToFill = holes.slice(0, maxHolesToFill);
        
        if (holesToFill.length > 0) {
          // Comme dans BitGet, on va garder une correspondance directe entre ordres annulés et prix à remplir
          const movableOrders = activeBuyOrders
            .map(order => ({
              order,
              distanceFromCurrent: Math.abs(currentPrice - order.price)
            }))
            .sort((a, b) => b.distanceFromCurrent - a.distanceFromCurrent); // Les plus éloignés d'abord
          
          // Combler les trous en déplaçant des ordres (comme BitGet)
          const holeOrdersToCancel = [];
          const newHoleOrdersToPlace = [];
          
          for (const hole of holesToFill) {
            if (movableOrders.length === 0) break;
            
            const farOrder = movableOrders[0];
            if (farOrder.distanceFromCurrent > hole.distanceFromCurrent) {
              holeOrdersToCancel.push(farOrder.order.clientOid);
              newHoleOrdersToPlace.push(hole.price);
              movableOrders.shift();
            }
          }
          
          // Appliquer les changements pour les trous
          if (holeOrdersToCancel.length > 0) {
            console.log(`🔄 Optimisation: Déplacement de ${holeOrdersToCancel.length} ordres pour combler les trous`);
            this.orderService.cancelBulkOrders(holeOrdersToCancel);
            
            // Placer immédiatement les nouveaux ordres (comme BitGet)
            const newOrdersData = newHoleOrdersToPlace.map(price => ({
              price,
              size: this.orderService.calculateOrderSize(price)
            }));
            
            this.orderService.placeBulkOrders(newOrdersData, 'buy');
          }
        }
      }

      // Mettre à jour l'horodatage de la dernière mise à jour
      this.lastGridUpdateTime = Date.now();
      this.lastProcessedPrice = currentPrice;
    } catch (error) {
      console.error('❌ Erreur lors de la mise à jour de la grille:', error);
    } finally {
      this.isUpdating = false;
    }
  }
  
  start() {
    if (this.running) {
      console.log('⚠️ La stratégie est déjà en cours d\'exécution');
      return;
    }
    
    console.log('🚀 Démarrage de la stratégie de grille');
    this.running = true;
    
    // Initialiser le prix de base
    const currentPrice = this.wsClient.getCurrentPrice();
    if (!currentPrice) {
      console.error('❌ Impossible de démarrer la stratégie: prix actuel non disponible');
      this.running = false;
      return;
    }
    
    // Initialiser la grille
    this.lastBasePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
    console.log(`🔢 Prix de base initial: ${this.lastBasePrice}$`);
    
    // Configurer l'intervalle de mise à jour
    this.updateInterval = setInterval(() => {
      this.updateGrid();
    }, this.config.strategy.updateInterval);
    
    // Déclencher une première mise à jour immédiate
    this.updateGrid();
  }
  
  stop() {
    if (!this.running) {
      console.log('⚠️ La stratégie n\'est pas en cours d\'exécution');
      return;
    }
    
    console.log('🛑 Arrêt de la stratégie de grille');
    this.running = false;
    
    // Nettoyer l'intervalle
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
  
  generateGrid(currentPrice) {
    const grid = [];
    const basePrice = Math.floor(currentPrice / this.config.priceStep) * this.config.priceStep;
    
    // Générer la grille pour le nombre total d'ordres configuré (sans division par 2)
    for (let i = 0; i < this.config.maxOrders; i++) {
      const price = basePrice - i * this.config.priceStep;
      if (price > 0) {
        grid.push(parseFloat(price.toFixed(this.config.pricePrecision)));
      }
    }
    
    return grid;
  }
  
  logGridStatus() {
    if (!this.running) {
      console.log('⚠️ La stratégie n\'est pas en cours d\'exécution');
      return;
    }
    
    const currentPrice = this.wsClient.getCurrentPrice();
    if (!currentPrice) {
      console.error('❌ Impossible d\'afficher le statut: prix actuel non disponible');
      return;
    }
    
    const activeBuyOrders = this.orderService.getActiveBuyOrders();
    const activeSellOrders = this.orderService.getActiveSellOrders();
    
    console.log('\n=== STATUT DE LA GRILLE ===');
    console.log(`Prix actuel: ${currentPrice}$`);
    console.log(`Ordres d'achat actifs: ${activeBuyOrders.length}`);
    console.log(`Ordres de vente actifs: ${activeSellOrders.length}`);
    console.log(`Total des ordres: ${activeBuyOrders.length + activeSellOrders.length}/${this.config.maxOrders}`);
    console.log('========================\n');
  }
  
  adjustGridUpwards(currentBasePrice) {
    // Obtenir les ordres actuels
    const activeBuyOrders = this.orderService.getActiveBuyOrders();
    const activeSellOrders = this.orderService.getActiveSellOrders();
    const currentPrice = this.wsClient.getCurrentPrice();
    
    // Générer la nouvelle grille idéale
    const newGrid = this.generateGrid(currentBasePrice);
    
    console.log(`📊 Ajustement de la grille - Base: ${currentBasePrice}$, ${newGrid.length} niveaux générés`);
    
    // 1. Identifier les ordres d'achat à annuler (ceux qui ne font plus partie de la grille idéale)
    const buyOrdersToCancel = activeBuyOrders
      .filter(order => !newGrid.includes(order.price))
      .map(order => order.clientOid);
    
    // 2. Identifier les prix manquants dans la grille
    const existingBuyPrices = new Set(activeBuyOrders.map(order => order.price));
    const existingSellPrices = new Set(activeSellOrders.map(order => order.price));
    
    // 3. Nouveaux niveaux de prix à ajouter avec vérification des ordres de vente
    const newPricesToAdd = newGrid
      .filter(price => {
        // Vérifie qu'il n'y a pas déjà un ordre d'achat à ce prix
        if (existingBuyPrices.has(price)) {
          return false;
        }
        
        // NOUVELLE VÉRIFICATION: Ignorer les prix où un ordre de vente vient d'être placé au niveau supérieur
        if (this.recentlyPlacedSellLevels.has(price)) {
          console.log(`⚠️ Prix ${price}$ ignoré dans adjustGridUpwards car un ordre de vente vient d'être placé au niveau supérieur`);
          return false;
        }
        
        // Vérifie qu'il n'y a pas d'ordre de vente au niveau supérieur
        const sellPriceLevel = parseFloat((price + this.config.priceStep).toFixed(this.config.pricePrecision));
        if (existingSellPrices.has(sellPriceLevel)) {
          return false;
        }
        
        return true;
      });
    
    // 4. Appliquer les changements
    
    // 4.1 Annuler les ordres
    if (buyOrdersToCancel.length > 0) {
      console.log(`❌ Annulation de ${buyOrdersToCancel.length} ordres d'achat obsolètes`);
      this.orderService.cancelBulkOrders(buyOrdersToCancel);
    }
    
    // 4.2 Ajouter de nouveaux ordres d'achat
    if (newPricesToAdd.length > 0) {
      // Vérifier si nous avons dépassé la limite d'ordres
      const totalActiveOrders = activeBuyOrders.length + activeSellOrders.length - buyOrdersToCancel.length;
      const availableSlots = this.config.maxOrders - totalActiveOrders;
      
      // Limiter le nombre de nouveaux ordres si nécessaire
      const pricesToAdd = newPricesToAdd.slice(0, availableSlots);
      
      if (pricesToAdd.length > 0) {
        console.log(`📈 Ajout de ${pricesToAdd.length} nouveaux niveaux de prix à la grille`);
        const newOrdersData = pricesToAdd.map(price => ({
          price,
          size: this.orderService.calculateOrderSize(price)
        }));
        this.orderService.placeBulkOrders(newOrdersData, 'buy');
      }
    }
  }
}

module.exports = GridStrategy; 