const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const csv = require('csv-parser');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

let players = [];
let unsold = [];
let currentPlayerIndex = 0;
let sets = [[], [], []];
let currentBid = 0;
let currentBidTeam = null;
let isReAuction = false;
let reAuctionUnsold = [];
let teams = Array.from({ length: 6 }, (_, i) => ({
  id: i + 1,
  name: `Team ${i + 1}`,
  budget: 1000000000, // 100 Cr in rupees
  remaining: 1000000000,
  spent: 0,
  players: [],
  synergy: 0,
}));

const synergyRules = {
  positive: {
    'AO-AN': 20,
    'BA-FI': 15,
    'AN-WK-B': 15,
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
    'WK-B-WK-B': -10,
    'CS-CS': -10,
    'BO-BO': -5,
  },
};

// Load and shuffle players
fs.createReadStream('players.csv')
  .pipe(csv())
  .on('data', (row) => players.push({
    sNo: row['S.No'],
    name: row.Name,
    role: row.Role,
    archetype: row.Archetype,
    baseScore: parseInt(row.Base_Score) || 0,
    basePrice: parseInt(row.Base_Price) || 0, // In rupees, no multiplication
  }))
  .on('error', (err) => console.error('CSV Load Error:', err.message))
  .on('end', () => {
    if (players.length === 0) {
      console.error('No players loaded from CSV.');
    } else {
      players = players.sort(() => Math.random() - 0.5);
      sets = [players.slice(0, 24), players.slice(24, 48), players.slice(48, 72)];
      console.log('Players loaded and shuffled:', players.length);
      emitUpdate();
    }
  });

// Synergy calculation (per pair, not unique)
function calculateSynergy(roster) {
  let baseTotal = roster.reduce((sum, p) => sum + p.baseScore, 0);
  let positive = 0, negative = 0;
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      let arch1 = roster[i].archetype, arch2 = roster[j].archetype;
      if (arch1 > arch2) [arch1, arch2] = [arch2, arch1]; // Normalize key
      const key = `${arch1}-${arch2}`;
      positive += synergyRules.positive[key] || 0;
      negative += synergyRules.negative[key] || 0;
    }
  }
  return baseTotal + positive + negative;
}

// Get current player
function getCurrentPlayer() {
  if (isReAuction) {
    if (currentPlayerIndex >= reAuctionUnsold.length) return null;
    return reAuctionUnsold[currentPlayerIndex];
  } else {
    if (currentPlayerIndex >= 72) return null;
    const setIndex = Math.floor(currentPlayerIndex / 24);
    const indexInSet = currentPlayerIndex % 24;
    return sets[setIndex][indexInSet];
  }
}

// Get bid increment
function getIncrement(bid) {
  return bid < 10000000 ? 2000000 : 5000000; // 20 Lakhs or 0.5 Cr
}

// Emit update
function emitUpdate() {
  const updateData = { teams, currentPlayer: getCurrentPlayer(), currentBid, currentBidTeam, isReAuction };
  console.log('Emitting update:', updateData);
  io.emit('update', updateData);
}

// HTTP health check
app.get('/', (req, res) => {
  res.send('CPL Auction Game Server is running');
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  console.log('Current state - Teams:', teams.length, 'Current Player:', getCurrentPlayer()?.name || 'None');
  emitUpdate(); // Initial update

  socket.on('join', (teamId) => {
    console.log('Client joining team:', teamId);
    socket.teamId = teamId;
    emitUpdate();
  });

  socket.on('test', (message) => {
    console.log('Test message received:', message);
    socket.emit('testResponse', 'Hello from server!');
  });

  socket.on('placeBid', (teamId) => {
    const team = teams[teamId - 1];
    const player = getCurrentPlayer();
    if (!player || team.players.length >= 8) return;

    const newBid = currentBid === 0 ? player.basePrice : currentBid + getIncrement(currentBid);
    if (team.remaining < newBid) return;

    currentBid = newBid;
    currentBidTeam = teamId;
    emitUpdate();
  });

  socket.on('soldPlayer', () => {
    if (!currentBidTeam || currentBid === 0) return;
    const team = teams[currentBidTeam - 1];
    const player = getCurrentPlayer();
    if (!player || team.remaining < currentBid) return;

    team.remaining -= currentBid;
    team.spent += currentBid;
    team.players.push({ ...player, boughtPrice: currentBid });
    team.synergy = calculateSynergy(team.players);
    currentPlayerIndex++;
    currentBid = 0;
    currentBidTeam = null;
    if (currentPlayerIndex % 24 === 0 && !isReAuction) io.emit('setSummary', teams);
    if (currentPlayerIndex >= 72 && !isReAuction) {
      handleReAuction();
    } else if (isReAuction && currentPlayerIndex >= reAuctionUnsold.length) {
      declareWinner();
    }
    emitUpdate();
  });

  socket.on('skipPlayer', () => {
    const player = getCurrentPlayer();
    if (player) unsold.push(player);
    currentPlayerIndex++;
    currentBid = 0;
    currentBidTeam = null;
    if (currentPlayerIndex % 24 === 0 && !isReAuction) io.emit('setSummary', teams);
    if (currentPlayerIndex >= 72 && !isReAuction) {
      handleReAuction();
    } else if (isReAuction && currentPlayerIndex >= reAuctionUnsold.length) {
      declareWinner();
    }
    emitUpdate();
  });
});

function handleReAuction() {
  const needyTeams = teams.filter(t => t.players.length < 8);
  if (needyTeams.length === 0) {
    declareWinner();
    return;
  }
  reAuctionUnsold = unsold.sort(() => Math.random() - 0.5);
  currentPlayerIndex = 0;
  isReAuction = true;
  emitUpdate();
}

function declareWinner() {
  teams.sort((a, b) => b.synergy - a.synergy || b.remaining - a.remaining);
  io.emit('winner', teams[0]);
}

server.listen(5000, () => console.log('Server running on port 5000 at', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })));