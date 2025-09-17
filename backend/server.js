const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { 
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  } 
});

// Static assets
app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.use('/photos', express.static(path.join(__dirname, 'client', 'public', 'photos')));

let players = [];
let allPlayers = [];
let unsold = [];
let currentPlayerIndex = 0;
let sets = [[], [], []];
let currentBid = 0;
let currentBidTeam = null;
let isReAuction = false;
let reAuctionUnsold = [];
let auctioneerConnected = false;
let connectedTeams = new Set();
let auctionHistory = [];
const MAX_HISTORY_SIZE = 50;

let teams = Array.from({ length: 8 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
  budget: 450000000,
  remaining: 450000000,
  spent: 0,
  players: [],
  synergy: 0,
  isConnected: false,
  socketId: null
}));

// Synergy rules
const synergyRules = {
  positive: {
    'AO-AN': 20,
    'BA-FI': 15,
    'AN-WK': 15,
    'BA-BO': 20,
    'PA-SP': 25,
    'PA-PA': 10,
    'CS-PA': 20,
    'CS-SP': 15,
    'BA-CS': 10,
    'BO-CS': 10,
  },
  negative: {
    'AO-AO': -15,
    'FI-FI': -10,
    'SP-SP': -5,
    'BA-BA': -5,
    'WK-WK': -10,
    'CS-CS': -10,
    'BO-BO': -5,
  },
};

// Validation helpers
function isValidTeamId(teamId) {
  return Number.isInteger(teamId) && teamId >= 1 && teamId <= 8;
}

function sanitizeString(str) {
  return str ? str.toString().trim() : '';
}

// Update player status in allPlayers array
function updatePlayerStatus(playerSNo, status, soldToTeam = null, soldPrice = null) {
  const playerIndex = allPlayers.findIndex(p => p.sNo === playerSNo);
  if (playerIndex !== -1) {
    allPlayers[playerIndex].status = status;
    if (soldToTeam) {
      allPlayers[playerIndex].soldToTeam = soldToTeam;
    }
    if (soldPrice) {
      allPlayers[playerIndex].soldPrice = soldPrice;
    }
  }
}

// Helper function to create a snapshot of current auction state
function createAuctionSnapshot(action, playerData = null) {
  const snapshot = {
    timestamp: Date.now(),
    action,
    playerData,
    state: {
      currentPlayerIndex,
      currentBid,
      currentBidTeam,
      isReAuction,
      teams: teams.map(team => ({
        ...team,
        players: [...team.players],
        socketId: undefined
      })),
      allPlayers: allPlayers.map(p => ({ ...p }))
    }
  };
  
  auctionHistory.push(snapshot);
  
  if (auctionHistory.length > MAX_HISTORY_SIZE) {
    auctionHistory.shift();
  }
  
  console.log(`Auction snapshot created: ${action} (History size: ${auctionHistory.length})`);
}

// Helper function to restore auction state from snapshot
function restoreAuctionSnapshot(snapshot) {
  try {
    currentPlayerIndex = snapshot.state.currentPlayerIndex;
    currentBid = snapshot.state.currentBid;
    currentBidTeam = snapshot.state.currentBidTeam;
    isReAuction = snapshot.state.isReAuction;
    allPlayers = snapshot.state.allPlayers.map(p => ({ ...p }));
    
    snapshot.state.teams.forEach((savedTeam, index) => {
      if (teams[index]) {
        const currentSocketId = teams[index].socketId;
        const currentIsConnected = teams[index].isConnected;
        
        teams[index] = {
          ...savedTeam,
          socketId: currentSocketId,
          isConnected: currentIsConnected
        };
      }
    });
    
    console.log(`Auction state restored to: ${snapshot.action} at ${new Date(snapshot.timestamp).toLocaleTimeString()}`);
    return true;
  } catch (error) {
    console.error('Error restoring auction snapshot:', error);
    return false;
  }
}

// Load players from CSV
function loadPlayers() {
  return new Promise((resolve, reject) => {
    const csvPath = process.env.PLAYERS_CSV || path.join(__dirname, 'players.csv');

    if (!fs.existsSync(csvPath)) {
      console.error(`CSV file not found at: ${csvPath}`);
      console.error('Please ensure players.csv exists in the project directory');
      reject(new Error('CSV file not found'));
      return;
    }

    players = [];
    allPlayers = [];
    
    const requiredColumns = ['S.No', 'Name', 'Role', 'Archetype', 'Base_Score', 'Base_Price'];
    let headerValidated = false;

    fs.createReadStream(csvPath)
      .pipe(csv())
      .on('headers', (headers) => {
        const missingColumns = requiredColumns.filter(col => !headers.includes(col));
        if (missingColumns.length > 0) {
          console.error(`Missing required columns in CSV: ${missingColumns.join(', ')}`);
          reject(new Error(`Missing required columns: ${missingColumns.join(', ')}`));
          return;
        }
        headerValidated = true;
      })
      .on('data', (row) => {
        if (!headerValidated) return;
        
        try {
          const player = {
            sNo: sanitizeString(row['S.No']),
            name: sanitizeString(row.Name),
            role: sanitizeString(row.Role),
            archetype: sanitizeString(row.Archetype),
            baseScore: parseInt(row.Base_Score) || 0,
            basePrice: (parseInt(row.Base_Price) || 0) * 100000,
            status: 'available',
            soldToTeam: null,
            soldPrice: null
          };
          
          if (player.name && player.archetype && player.baseScore > 0 && player.basePrice > 0) {
            players.push(player);
            allPlayers.push({ ...player });
          } else {
            console.warn(`Skipping invalid player row: ${JSON.stringify(row)}`);
          }
        } catch (error) {
          console.error(`Error processing player row: ${error.message}`);
        }
      })
      .on('error', (err) => {
        console.error('CSV Load Error:', err.message);
        reject(err);
      })
      .on('end', () => {
        if (players.length === 0) {
          console.error('No valid players loaded from CSV.');
          reject(new Error('No valid players loaded'));
          return;
        }
        
        if (players.length < 72) {
          console.warn(`Warning: Only ${players.length} players loaded. Expected at least 72 for full auction.`);
        }
        
        players = players.sort(() => Math.random() - 0.5);
        const playersPerSet = Math.ceil(players.length / 3);
        sets = [
          players.slice(0, playersPerSet), 
          players.slice(playersPerSet, playersPerSet * 2), 
          players.slice(playersPerSet * 2)
        ];

        allPlayers = allPlayers.sort((a, b) => {
          const aIndex = players.findIndex(p => p.sNo === a.sNo);
          const bIndex = players.findIndex(p => p.sNo === b.sNo);
          return aIndex - bIndex;
        });
        
        console.log(`Successfully loaded ${players.length} players`);
        console.log(`Sets: ${sets[0].length}, ${sets[1].length}, ${sets[2].length}`);
        
        emitUpdate();
        resolve();
      });
  });
}

// Synergy calculation with better error handling
function calculateSynergy(roster) {
  if (!Array.isArray(roster) || roster.length === 0) return 0;
  
  let baseTotal = 0;
  let positive = 0;
  let negative = 0;

  for (const player of roster) {
    if (player && typeof player.baseScore === 'number') {
      baseTotal += player.baseScore;
    }
  }

  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const player1 = roster[i];
      const player2 = roster[j];
      
      if (!player1?.archetype || !player2?.archetype) continue;
      
      let arch1 = sanitizeString(player1.archetype);
      let arch2 = sanitizeString(player2.archetype);
      
      if (!arch1 || !arch2) continue;
      
      if (arch1 > arch2) [arch1, arch2] = [arch2, arch1];
      const key = `${arch1}-${arch2}`;
      
      positive += synergyRules.positive[key] || 0;
      negative += synergyRules.negative[key] || 0;
    }
  }
  
  return baseTotal + positive + negative;
}

// Calculate individual player synergy
function calculatePlayerSynergy(targetPlayer, roster) {
  if (!targetPlayer || !Array.isArray(roster) || roster.length === 0) return 0;
  
  const playerIndex = roster.findIndex(p => p.sNo === targetPlayer.sNo);
  if (playerIndex === -1) return 0;
  
  let playerSynergy = targetPlayer.baseScore || 0;
  let positiveBonus = 0;
  let negativePenalty = 0;

  for (let i = 0; i < roster.length; i++) {
    if (i === playerIndex) continue;
    
    const otherPlayer = roster[i];
    if (!otherPlayer?.archetype || !targetPlayer?.archetype) continue;
    
    let arch1 = sanitizeString(targetPlayer.archetype);
    let arch2 = sanitizeString(otherPlayer.archetype);
    
    if (!arch1 || !arch2) continue;
    
    if (arch1 > arch2) [arch1, arch2] = [arch2, arch1];
    const key = `${arch1}-${arch2}`;
    
    positiveBonus += synergyRules.positive[key] || 0;
    negativePenalty += synergyRules.negative[key] || 0;
  }
  
  return playerSynergy + positiveBonus + negativePenalty;
}

// Auction helpers
function getCurrentPlayer() {
  if (isReAuction) {
    if (currentPlayerIndex >= reAuctionUnsold.length) return null;
    return reAuctionUnsold[currentPlayerIndex];
  } else {
    const totalPlayers = players.length;
    if (currentPlayerIndex >= totalPlayers) return null;
    
    const setIndex = Math.floor(currentPlayerIndex / Math.ceil(totalPlayers / 3));
    const indexInSet = currentPlayerIndex % Math.ceil(totalPlayers / 3);
    
    if (!sets[setIndex] || !sets[setIndex][indexInSet]) return null;
    return sets[setIndex][indexInSet];
  }
}

function getIncrement(bid) {
  if (bid < 5000000) return 500000;
  if (bid < 10000000) return 1000000;
  if (bid < 20000000) return 2000000;
  return 5000000;
}

// Emit state updates
function emitUpdate() {
  try {
    const currentPlayer = getCurrentPlayer();
    const nextIncrement = currentPlayer 
      ? (currentBid === 0 ? getIncrement(currentPlayer.basePrice) : getIncrement(currentBid))
      : 0;

    const updateData = {
      teams: teams.map(team => ({
        ...team,
        socketId: undefined
      })),
      currentPlayer,
      currentBid,
      currentBidTeam,
      isReAuction,
      currentPlayerIndex,
      totalPlayers: players.length,
      connectedTeams: Array.from(connectedTeams),
      auctioneerConnected,
      nextIncrement,
      allPlayers
    };

    io.emit('update', updateData);
  } catch (error) {
    console.error('Error emitting update:', error);
  }
}

// Socket.IO handlers
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on('joinAsAuctioneer', () => {
    if (auctioneerConnected) {
      socket.emit('forceDisconnect', 'Another auctioneer is already connected.');
      return;
    }

    auctioneerConnected = true;
    socket.join('auctioneer');
    console.log(`Auctioneer connected: ${socket.id}`);
    socket.emit('connectionStatus', {
      connectedTeams: Array.from(connectedTeams),
      auctioneerConnected
    });
    emitUpdate();
  });

  socket.on('joinAsTeam', (teamId) => {
    if (!isValidTeamId(teamId)) {
      socket.emit('error', 'Invalid team ID');
      socket.disconnect();
      return;
    }

    const teamIndex = teamId - 1;
    if (teams[teamIndex].socketId && teams[teamIndex].isConnected) {
      socket.emit('forceDisconnect', `Team ${teamId} is already connected.`);
      return;
    }

    teams[teamIndex].socketId = socket.id;
    teams[teamIndex].isConnected = true;
    connectedTeams.add(teamId);
    socket.join(`team${teamId}`);
    console.log(`Team ${teamId} connected: ${socket.id}`);

    socket.emit('connectionStatus', {
      connectedTeams: Array.from(connectedTeams),
      auctioneerConnected
    });

    socket.emit('update', {
      teams: teams.map(team => ({
        ...team,
        socketId: undefined
      })),
      myTeam: { ...teams[teamIndex], socketId: undefined },
      currentPlayer: getCurrentPlayer(),
      currentBid,
      currentBidTeam,
      isReAuction,
      currentPlayerIndex,
      totalPlayers: players.length,
      connectedTeams: Array.from(connectedTeams),
      auctioneerConnected,
      nextIncrement: getCurrentPlayer() 
        ? (currentBid === 0 ? getIncrement(getCurrentPlayer().basePrice) : getIncrement(currentBid))
        : 0,
      allPlayers
    });

    io.emit('connectionStatus', {
      connectedTeams: Array.from(connectedTeams),
      auctioneerConnected
    });
  });

  socket.on('joinAsObserver', () => {
    socket.join('observer');
    console.log(`Observer connected: ${socket.id}`);
    emitUpdate();
  });

  socket.on('placeBidForTeam', (teamId) => {
    if (!socket.rooms.has('auctioneer')) {
      socket.emit('error', 'Only auctioneer can place bids');
      return;
    }

    if (!isValidTeamId(teamId)) {
      socket.emit('error', 'Invalid team ID');
      return;
    }

    const team = teams[teamId - 1];
    const currentPlayer = getCurrentPlayer();
    if (!currentPlayer) {
      socket.emit('error', 'No player available for bidding');
      return;
    }

    const newBid = currentBid === 0 ? currentPlayer.basePrice : currentBid + getIncrement(currentBid);

    if (team.players.length >= 8) {
      socket.emit('error', `Team ${teamId} has reached maximum players (8)`);
      return;
    }

    if (team.remaining < newBid) {
      socket.emit('error', `Team ${teamId} has insufficient funds`);
      return;
    }

    // Create snapshot before placing bid
    createAuctionSnapshot('BEFORE_BID', {
      playerName: currentPlayer.name,
      teamId,
      amount: newBid,
      teamName: team.name
    });

    currentBid = newBid;
    currentBidTeam = teamId;

    io.emit('bidPlaced', {
      teamId,
      teamName: team.name,
      amount: newBid,
      playerName: currentPlayer.name
    });

    emitUpdate();
  });

  socket.on('soldPlayer', () => {
    if (!socket.rooms.has('auctioneer')) {
      socket.emit('error', 'Only auctioneer can sell players');
      return;
    }

    const currentPlayer = getCurrentPlayer();
    if (!currentPlayer) {
      socket.emit('error', 'No player available to sell');
      return;
    }

    if (!currentBidTeam || currentBid === 0) {
      socket.emit('error', 'No valid bid to complete sale');
      return;
    }

    const teamIndex = currentBidTeam - 1;
    const team = teams[teamIndex];

    if (team.remaining < currentBid) {
      socket.emit('error', `Team ${currentBidTeam} has insufficient funds`);
      return;
    }

    team.players.push({
      ...currentPlayer,
      boughtPrice: currentBid,
      individualSynergy: calculatePlayerSynergy(currentPlayer, [...team.players, currentPlayer])
    });

    team.spent += currentBid;
    team.remaining -= currentBid;
    team.synergy = calculateSynergy(team.players);

    updatePlayerStatus(currentPlayer.sNo, 'sold', currentBidTeam, currentBid);

    io.emit('playerSold', {
      player: currentPlayer,
      teamId: currentBidTeam,
      teamName: team.name,
      amount: currentBid
    });

    currentBid = 0;
    currentBidTeam = null;
    currentPlayerIndex++;

    if (!isReAuction && currentPlayerIndex >= players.length && unsold.length > 0) {
      isReAuction = true;
      reAuctionUnsold = [...unsold];
      unsold = [];
      currentPlayerIndex = 0;
      io.emit('reAuctionStart', { unsoldCount: reAuctionUnsold.length });
    } else if (currentPlayerIndex >= (isReAuction ? reAuctionUnsold.length : players.length)) {
      const winner = teams.reduce((best, team) => {
        return team.synergy > (best?.synergy || -Infinity) ? team : best;
      }, null);
      io.emit('auctionComplete', { winner });
    }

    if (currentPlayerIndex > 0 && currentPlayerIndex % Math.ceil(players.length / 3) === 0 && !isReAuction) {
      io.emit('setSummary', teams);
    }

    emitUpdate();
  });

  socket.on('skipPlayer', () => {
    if (!socket.rooms.has('auctioneer')) {
      socket.emit('error', 'Only auctioneer can skip players');
      return;
    }

    const currentPlayer = getCurrentPlayer();
    if (!currentPlayer) {
      socket.emit('error', 'No player available to skip');
      return;
    }

    unsold.push(currentPlayer);
    updatePlayerStatus(currentPlayer.sNo, 'unsold');

    io.emit('playerSkipped', { player: currentPlayer });

    currentBid = 0;
    currentBidTeam = null;
    currentPlayerIndex++;

    if (!isReAuction && currentPlayerIndex >= players.length && unsold.length > 0) {
      isReAuction = true;
      reAuctionUnsold = [...unsold];
      unsold = [];
      currentPlayerIndex = 0;
      io.emit('reAuctionStart', { unsoldCount: reAuctionUnsold.length });
    } else if (currentPlayerIndex >= (isReAuction ? reAuctionUnsold.length : players.length)) {
      const winner = teams.reduce((best, team) => {
        return team.synergy > (best?.synergy || -Infinity) ? team : best;
      }, null);
      io.emit('auctionComplete', { winner });
    }

    if (currentPlayerIndex > 0 && currentPlayerIndex % Math.ceil(players.length / 3) === 0 && !isReAuction) {
      io.emit('setSummary', teams);
    }

    emitUpdate();
  });

  socket.on('resetBid', () => {
    if (!socket.rooms.has('auctioneer')) {
      socket.emit('error', 'Only auctioneer can reset bids');
      return;
    }

    const currentPlayer = getCurrentPlayer();
    if (!currentPlayer) {
      socket.emit('error', 'No player available to reset bid');
      return;
    }

    currentBid = 0;
    currentBidTeam = null;

    io.emit('bidReset', { playerName: currentPlayer.name });
    emitUpdate();
  });

  socket.on('undoLastAction', () => {
    if (!socket.rooms.has('auctioneer')) {
      socket.emit('error', 'Only auctioneer can undo actions');
      return;
    }

    if (auctionHistory.length === 0) {
      socket.emit('error', 'No actions to undo');
      return;
    }

    const lastSnapshot = auctionHistory.pop();
    if (!lastSnapshot || lastSnapshot.action !== 'BEFORE_BID') {
      socket.emit('error', 'No valid bid action to undo');
      return;
    }

    const success = restoreAuctionSnapshot(lastSnapshot);
    if (success) {
      socket.emit('undoCompleted', {
        playerName: lastSnapshot.playerData?.playerName || 'unknown player'
      });
      emitUpdate();
    } else {
      socket.emit('error', 'Failed to undo bid action');
    }
  });

  socket.on('resetAuction', () => {
    if (!socket.rooms.has('auctioneer')) {
      socket.emit('error', 'Only auctioneer can reset auction');
      return;
    }

    loadPlayers().catch(err => {
      console.error('Error resetting auction:', err);
      socket.emit('error', 'Failed to reset auction');
    });
    auctionHistory = [];
    io.emit('auctionReset');
  });

  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    
    if (socket.rooms.has('auctioneer')) {
      auctioneerConnected = false;
      io.emit('connectionStatus', {
        connectedTeams: Array.from(connectedTeams),
        auctioneerConnected
      });
    }

    const teamIndex = teams.findIndex(team => team.socketId === socket.id);
    if (teamIndex !== -1) {
      teams[teamIndex].socketId = null;
      teams[teamIndex].isConnected = false;
      connectedTeams.delete(teams[teamIndex].id);
      io.emit('connectionStatus', {
        connectedTeams: Array.from(connectedTeams),
        auctioneerConnected
      });
    }
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  loadPlayers().catch(err => {
    console.error('Failed to load players:', err);
    process.exit(1);
  });
});