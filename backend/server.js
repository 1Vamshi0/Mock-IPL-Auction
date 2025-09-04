// server.js
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
    origin: '*',
    methods: ['GET', 'POST']
  } 
});

// Static assets
app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.use('/photos', express.static(path.join(__dirname, 'client', 'public', 'photos')));

let players = [];
let unsold = [];
let currentPlayerIndex = 0;
let sets = [[], [], []];
let currentBid = 0;
let currentBidTeam = null;
let isReAuction = false;
let reAuctionUnsold = [];
let auctioneerConnected = false;
let connectedTeams = new Set();

let teams = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
  budget: 450000000, // 100 Cr
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
  return Number.isInteger(teamId) && teamId >= 1 && teamId <= 6;
}

function sanitizeString(str) {
  return str ? str.toString().trim() : '';
}

// Load players from CSV
function loadPlayers() {
  const csvPath = process.env.PLAYERS_CSV || path.join(__dirname, 'players.csv');

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found at: ${csvPath}`);
    console.error('Please ensure players.csv exists in the project directory');
    process.exit(1);
  }

  const requiredColumns = ['S.No', 'Name', 'Role', 'Archetype', 'Base_Score', 'Base_Price'];
  let headerValidated = false;

  fs.createReadStream(csvPath)
    .pipe(csv())
    .on('headers', (headers) => {
      const missingColumns = requiredColumns.filter(col => !headers.includes(col));
      if (missingColumns.length > 0) {
        console.error(`Missing required columns in CSV: ${missingColumns.join(', ')}`);
        process.exit(1);
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
          // CSV base price is in Lakhs → convert to rupees
          basePrice: (parseInt(row.Base_Price) || 0) * 100000,
        };
        
        // Validate required fields
        if (player.name && player.archetype && player.baseScore > 0 && player.basePrice > 0) {
          players.push(player);
        } else {
          console.warn(`Skipping invalid player row: ${JSON.stringify(row)}`);
        }
      } catch (error) {
        console.error(`Error processing player row: ${error.message}`);
      }
    })
    .on('error', (err) => {
      console.error('CSV Load Error:', err.message);
      process.exit(1);
    })
    .on('end', () => {
      if (players.length === 0) {
        console.error('No valid players loaded from CSV.');
        process.exit(1);
      }
      
      if (players.length < 72) {
        console.warn(`Warning: Only ${players.length} players loaded. Expected at least 72 for full auction.`);
      }
      
      // Shuffle and divide into sets
      players = players.sort(() => Math.random() - 0.5);
      const playersPerSet = Math.ceil(players.length / 3);
      sets = [
        players.slice(0, playersPerSet), 
        players.slice(playersPerSet, playersPerSet * 2), 
        players.slice(playersPerSet * 2)
      ];
      
      console.log(`Successfully loaded ${players.length} players`);
      console.log(`Sets: ${sets[0].length}, ${sets[1].length}, ${sets[2].length}`);
      emitUpdate();
    });
}

// Synergy calculation with better error handling
function calculateSynergy(roster) {
  if (!Array.isArray(roster) || roster.length === 0) return 0;
  
  let baseTotal = 0;
  let positive = 0;
  let negative = 0;

  // Calculate base total safely
  for (const player of roster) {
    if (player && typeof player.baseScore === 'number') {
      baseTotal += player.baseScore;
    }
  }

  // Calculate synergy bonuses/penalties
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const player1 = roster[i];
      const player2 = roster[j];
      
      if (!player1?.archetype || !player2?.archetype) continue;
      
      let arch1 = sanitizeString(player1.archetype);
      let arch2 = sanitizeString(player2.archetype);
      
      if (!arch1 || !arch2) continue;
      
      // Ensure consistent ordering for lookup
      if (arch1 > arch2) [arch1, arch2] = [arch2, arch1];
      const key = `${arch1}-${arch2}`;
      
      positive += synergyRules.positive[key] || 0;
      negative += synergyRules.negative[key] || 0;
    }
  }
  
  return baseTotal + positive + negative;
}

// Add this function to server.js after the calculateSynergy function
function calculatePlayerSynergy(targetPlayer, roster) {
  if (!targetPlayer || !Array.isArray(roster) || roster.length === 0) return 0;
  
  // Find the target player in roster
  const playerIndex = roster.findIndex(p => p.sNo === targetPlayer.sNo);
  if (playerIndex === -1) return 0;
  
  let playerSynergy = targetPlayer.baseScore || 0; // Start with base score
  let positiveBonus = 0;
  let negativePenalty = 0;

  // Calculate synergy with all other players in roster
  for (let i = 0; i < roster.length; i++) {
    if (i === playerIndex) continue; // Skip self
    
    const otherPlayer = roster[i];
    if (!otherPlayer?.archetype || !targetPlayer?.archetype) continue;
    
    let arch1 = sanitizeString(targetPlayer.archetype);
    let arch2 = sanitizeString(otherPlayer.archetype);
    
    if (!arch1 || !arch2) continue;
    
    // Ensure consistent ordering for lookup
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
  if (bid < 5000000) return 500000;     // +50L
  if (bid < 10000000) return 1000000;   // +1Cr
  if (bid < 20000000) return 2000000;   // +2Cr
  return 5000000;                       // +5Cr
}

// Emit state updates
function emitUpdate() {
  try {
    const currentPlayer = getCurrentPlayer();
    const computeNextFrom = currentBid || (currentPlayer ? currentPlayer.basePrice : 0);
    const nextIncrement = currentPlayer ? getIncrement(computeNextFrom) : 0;
    const totalPlayers = isReAuction ? reAuctionUnsold.length : players.length;

    const baseUpdateData = {
      teams: teams.map(t => ({ 
        ...t, 
        socketId: undefined,
        synergy: Number.isFinite(t.synergy) ? t.synergy : 0
      })),
      currentPlayer,
      currentBid,
      currentBidTeam,
      isReAuction,
      currentPlayerIndex,
      totalPlayers,
      connectedTeams: Array.from(connectedTeams),
      auctioneerConnected,
      nextIncrement
    };

    io.to('auctioneer').emit('update', baseUpdateData);
    
    teams.forEach(team => {
      if (team.socketId) {
        io.to(team.socketId).emit('update', {
          ...baseUpdateData,
          myTeam: {
            ...team,
            socketId: undefined,
            synergy: Number.isFinite(team.synergy) ? team.synergy : 0
          },
        });
      }
    });
    
    io.to('observers').emit('update', baseUpdateData);

    console.log(
      'Update emitted - Current Player:',
      currentPlayer?.name || 'None',
      '| Current Bid:',
      currentBid,
      '| Next +',
      nextIncrement
    );
  } catch (error) {
    console.error('Error in emitUpdate:', error);
  }
}

function validateBid(teamId, newBid) {
  if (!isValidTeamId(teamId)) {
    return { valid: false, reason: 'Invalid team ID' };
  }
  
  const team = teams[teamId - 1];
  const player = getCurrentPlayer();
  
  if (!player) {
    return { valid: false, reason: 'No player available' };
  }
  
  if (team.players.length >= 8) {
    return { valid: false, reason: 'Team roster is full (8 players)' };
  }
  
  if (team.remaining < newBid) {
    return { valid: false, reason: 'Insufficient team budget' };
  }
  
  if (newBid <= 0) {
    return { valid: false, reason: 'Bid must be positive' };
  }
  
  return { valid: true };
}

// HTTP routes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    playersLoaded: players.length,
    currentPlayer: getCurrentPlayer()?.name || 'None',
    isReAuction,
    auctioneerConnected,
    connectedTeams: Array.from(connectedTeams).length
  });
});

// Socket handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinAsAuctioneer', () => {
    console.log('Auctioneer connected:', socket.id);
    socket.join('auctioneer');
    auctioneerConnected = true;
    socket.isAuctioneer = true;
    emitUpdate();
    io.emit('connectionStatus', { 
      auctioneerConnected, 
      connectedTeams: Array.from(connectedTeams) 
    });
  });

  socket.on('joinAsTeam', (teamId) => {
    console.log(`Team ${teamId} attempting to connect:`, socket.id);
    
    if (!isValidTeamId(teamId)) {
      socket.emit('error', 'Invalid team ID');
      return;
    }

    const existingTeam = teams[teamId - 1];
    if (existingTeam.socketId && existingTeam.socketId !== socket.id) {
      io.to(existingTeam.socketId).emit('forceDisconnect', 'Another device connected for your team');
    }
    
    socket.join(`team-${teamId}`);
    socket.teamId = teamId;
    teams[teamId - 1].isConnected = true;
    teams[teamId - 1].socketId = socket.id;
    connectedTeams.add(teamId);
    
    console.log(`Team ${teamId} connected successfully`);
    emitUpdate();
    io.emit('connectionStatus', { 
      auctioneerConnected, 
      connectedTeams: Array.from(connectedTeams) 
    });
  });

  socket.on('joinAsObserver', () => {
    console.log('Observer connected:', socket.id);
    socket.join('observers');
    socket.isObserver = true;
    emitUpdate();
  });

  // Auctioneer-only bidding
  socket.on('placeBidForTeam', (teamId) => {
    if (!socket.isAuctioneer) {
      socket.emit('error', 'Only auctioneer can place bids');
      return;
    }

    if (!isValidTeamId(teamId)) {
      socket.emit('error', 'Invalid team ID');
      return;
    }

    const player = getCurrentPlayer();
    if (!player) {
      socket.emit('error', 'No player available for bidding');
      return;
    }

    const newBid = currentBid === 0 ? player.basePrice : currentBid + getIncrement(currentBid);
    const validation = validateBid(teamId, newBid);
    
    if (!validation.valid) {
      socket.emit('error', `Cannot place bid for Team ${teamId}: ${validation.reason}`);
      return;
    }

    currentBid = newBid;
    currentBidTeam = teamId;

    console.log(`Auctioneer placed bid: Team ${teamId}, Amount: ₹${(newBid/100000).toFixed(2)}L, Player: ${player.name}`);

    io.emit('bidPlaced', {
      teamId,
      teamName: teams[teamId - 1].name,
      amount: newBid,
      playerName: player.name,
      placedByAuctioneer: true
    });

    emitUpdate();
  });

  // Modify the soldPlayer socket handler to include individual synergy
  socket.on('soldPlayer', () => {
    if (!socket.isAuctioneer) {
      socket.emit('error', 'Only auctioneer can mark players as sold');
      return;
    }
    
    if (!currentBidTeam || currentBid === 0) {
      socket.emit('error', 'No valid bid to complete sale');
      return;
    }
    
    if (!isValidTeamId(currentBidTeam)) {
      socket.emit('error', 'Invalid bidding team');
      return;
    }
    
    const team = teams[currentBidTeam - 1];
    const player = getCurrentPlayer();
    
    if (!player || !team) {
      socket.emit('error', 'Invalid player or team');
      return;
    }
    
    if (team.remaining < currentBid) {
      socket.emit('error', 'Insufficient team budget');
      return;
    }
    
    // Complete the sale
    team.remaining -= currentBid;
    team.spent += currentBid;
    
    // Calculate individual player synergy before adding to team
    const playerWithSynergy = { 
      ...player, 
      boughtPrice: currentBid,
      individualSynergy: calculatePlayerSynergy(player, [...team.players, player])
    };
    
    team.players.push(playerWithSynergy);
    team.synergy = calculateSynergy(team.players);
  
    console.log(`Player sold: ${player.name} to Team ${currentBidTeam} for ₹${(currentBid/100000).toFixed(2)}L`);
  
    io.emit('playerSold', {
      player: playerWithSynergy,
      teamId: currentBidTeam,
      teamName: team.name,
      amount: currentBid
    });
  
    // Move to next player
    currentPlayerIndex++;
    currentBid = 0;
    currentBidTeam = null;
  
    // Check for set completion or auction end
    const playersPerSet = Math.ceil(players.length / 3);
    if (currentPlayerIndex % playersPerSet === 0 && !isReAuction) {
      io.emit('setSummary', teams);
    }
    
    if (currentPlayerIndex >= players.length && !isReAuction) {
      handleReAuction();
    } else if (isReAuction && currentPlayerIndex >= reAuctionUnsold.length) {
      declareWinner();
    }
    
    emitUpdate();
  });
  

  socket.on('skipPlayer', () => {
    if (!socket.isAuctioneer) {
      socket.emit('error', 'Only auctioneer can skip players');
      return;
    }

    const player = getCurrentPlayer();
    if (player) {
      unsold.push(player);
      console.log(`Player skipped: ${player.name}`);
      io.emit('playerSkipped', { 
        player, 
        reason: 'No bids received' 
      });
    }

    currentPlayerIndex++;
    currentBid = 0;
    currentBidTeam = null;

    const playersPerSet = Math.ceil(players.length / 3);
    if (currentPlayerIndex % playersPerSet === 0 && !isReAuction) {
      io.emit('setSummary', teams);
    }
    
    if (currentPlayerIndex >= players.length && !isReAuction) {
      handleReAuction();
    } else if (isReAuction && currentPlayerIndex >= reAuctionUnsold.length) {
      declareWinner();
    }
    
    emitUpdate();
  });

  socket.on('resetBid', () => {
    if (!socket.isAuctioneer) {
      socket.emit('error', 'Only auctioneer can reset bids');
      return;
    }

    const player = getCurrentPlayer();
    if (player) {
      currentBid = 0;
      currentBidTeam = null;
      console.log(`Bid reset for player: ${player.name}`);
      io.emit('bidReset', { 
        playerName: player.name, 
        message: 'Bidding reset to base price' 
      });
      emitUpdate();
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    if (socket.isAuctioneer) {
      auctioneerConnected = false;
      io.emit('connectionStatus', { 
        auctioneerConnected, 
        connectedTeams: Array.from(connectedTeams) 
      });
    }

    if (socket.teamId) {
      const teamIndex = socket.teamId - 1;
      if (teams[teamIndex] && teams[teamIndex].socketId === socket.id) {
        teams[teamIndex].isConnected = false;
        teams[teamIndex].socketId = null;
        connectedTeams.delete(socket.teamId);
        io.emit('connectionStatus', { 
          auctioneerConnected, 
          connectedTeams: Array.from(connectedTeams) 
        });
      }
    }
    emitUpdate();
  });

  emitUpdate();
});

function handleReAuction() {
  const needyTeams = teams.filter(t => t.players.length < 8);
  if (needyTeams.length === 0 || unsold.length === 0) {
    console.log('No teams need more players or no unsold players available');
    declareWinner();
    return;
  }

  console.log(`Starting re-auction with ${unsold.length} unsold players`);
  reAuctionUnsold = [...unsold].sort(() => Math.random() - 0.5);
  currentPlayerIndex = 0;
  isReAuction = true;

  io.emit('reAuctionStart', {
    unsoldCount: reAuctionUnsold.length,
    needyTeams: needyTeams.map(t => t.name)
  });
  emitUpdate();
}

function declareWinner() {
  console.log('Auction completed - calculating winner');
  const sortedTeams = [...teams].sort((a, b) => {
    const synergyA = Number.isFinite(a.synergy) ? a.synergy : 0;
    const synergyB = Number.isFinite(b.synergy) ? b.synergy : 0;
    
    if (synergyB !== synergyA) return synergyB - synergyA;
    return b.remaining - a.remaining;
  });
  
  console.log('Final standings:', sortedTeams.map(t => 
    `${t.name}: ${Number.isFinite(t.synergy) ? t.synergy.toFixed(1) : 0} synergy`
  ));
  
  io.emit('auctionComplete', { 
    winner: sortedTeams[0], 
    standings: sortedTeams 
  });
}

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Auctioneer-Only Bidding Mode:');
  console.log('- Auctioneer: Controls all bidding via team selection');
  console.log('- Teams: View-only displays with roster and synergy');
  console.log('- Bidding: Only auctioneer can place bids for teams');
  console.log('Environment:', process.env.NODE_ENV || 'development');
  loadPlayers();
});