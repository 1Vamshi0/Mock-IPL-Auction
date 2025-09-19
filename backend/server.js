// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const { MongoClient } = require('mongodb');

// --- MongoDB Atlas Setup ---
// IMPORTANT: Set this in your Render Environment Variables
const mongoUri = process.env.MONGO_URI;
if (!mongoUri) {
  console.error("FATAL ERROR: MONGO_URI environment variable is not set.");
}
const client = new MongoClient(mongoUri);
const db = client.db("auctionDB"); // Name your database
const stateCollection = db.collection("state");
const STATE_DOC_ID = "current_auction"; // ID to find our one state document

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { 
  cors: { 
    origin: process.env.NODE_ENV === 'production' ? false : '*',
    methods: ['GET', 'POST']
  } 
});

// --- Static assets ---
app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.use('/photos', express.static(path.join(__dirname, 'client', 'public', 'photos')));

// --- Auction State Variables (will be loaded from DB) ---
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

// --- Synergy Rules & Helpers (No changes needed here) ---
const synergyRules = {
  positive: { 'AO-AN': 20, 'BA-FI': 15, 'AN-WK': 15, 'BA-BO': 20, 'PA-SP': 25, 'PA-PA': 10, 'CS-PA': 20, 'CS-SP': 15, 'BA-CS': 10, 'BO-CS': 10, },
  negative: { 'AO-AO': -15, 'FI-FI': -10, 'SP-SP': -5, 'BA-BA': -5, 'WK-WK': -10, 'CS-CS': -10, 'BO-BO': -5, },
};
function isValidTeamId(teamId) { return Number.isInteger(teamId) && teamId >= 1 && teamId <= 8; }
function sanitizeString(str) { return str ? str.toString().trim() : ''; }

// --- Database Persistence Functions ---

// Helper to connect to the DB on startup
async function connectToDb() {
  if (!mongoUri) return;
  try {
    await client.connect();
    console.log("✅ Successfully connected to MongoDB Atlas.");
  } catch (error) {
    console.error("❌ Failed to connect to MongoDB:", error);
  }
}

// Save the current state to MongoDB
async function saveState() {
  if (!client.topology || !client.topology.isConnected()) {
    console.warn("⚠️ Cannot save state: Not connected to MongoDB.");
    return;
  }
  try {
    const state = {
      players, allPlayers, unsold, currentPlayerIndex, sets, currentBid, currentBidTeam,
      isReAuction, reAuctionUnsold, auctionHistory,
      teams: teams.map(t => ({ ...t, socketId: null, isConnected: false })),
    };
    await stateCollection.updateOne({ _id: STATE_DOC_ID }, { $set: state }, { upsert: true });
    console.log('💾 Auction state saved to MongoDB.');
  } catch (error) {
    console.error('Error saving state to MongoDB:', error);
  }
}

// Load state from MongoDB on startup
async function loadState() {
  if (!client.topology || !client.topology.isConnected()) return false;
  try {
    const savedState = await stateCollection.findOne({ _id: STATE_DOC_ID });
    if (savedState) {
      players = savedState.players || [];
      allPlayers = savedState.allPlayers || [];
      unsold = savedState.unsold || [];
      currentPlayerIndex = savedState.currentPlayerIndex || 0;
      sets = savedState.sets || [[], [], []];
      currentBid = savedState.currentBid || 0;
      currentBidTeam = savedState.currentBidTeam || null;
      isReAuction = savedState.isReAuction || false;
      reAuctionUnsold = savedState.reAuctionUnsold || [];
      teams = savedState.teams || teams;
      auctionHistory = savedState.auctionHistory || [];
      console.log('🔄 Auction state loaded successfully from MongoDB.');
      return true;
    }
  } catch (error) {
    console.error('Error loading state from MongoDB:', error);
  }
  return false;
}

// --- Player & Auction Logic (No changes needed here unless specified) ---

function updatePlayerStatus(playerSNo, status, soldToTeam = null, soldPrice = null) {
  const playerIndex = allPlayers.findIndex(p => p.sNo === playerSNo);
  if (playerIndex !== -1) {
    allPlayers[playerIndex].status = status;
    if (soldToTeam) allPlayers[playerIndex].soldToTeam = soldToTeam;
    if (soldPrice) allPlayers[playerIndex].soldPrice = soldPrice;
  }
}

function createAuctionSnapshot(action, playerData = null) {
  const snapshot = {
    timestamp: Date.now(), action, playerData,
    state: {
      currentPlayerIndex, currentBid, currentBidTeam, isReAuction,
      unsold: [...unsold], reAuctionUnsold: [...reAuctionUnsold],
      teams: teams.map(team => ({ ...team, players: [...team.players], socketId: undefined })),
      allPlayers: allPlayers.map(p => ({ ...p }))
    }
  };
  auctionHistory.push(snapshot);
  if (auctionHistory.length > MAX_HISTORY_SIZE) auctionHistory.shift();
  console.log(`Snapshot created: ${action}`);
}

function restoreAuctionSnapshot(snapshot) {
  try {
    currentPlayerIndex = snapshot.state.currentPlayerIndex;
    currentBid = snapshot.state.currentBid;
    currentBidTeam = snapshot.state.currentBidTeam;
    isReAuction = snapshot.state.isReAuction;
    unsold = [...snapshot.state.unsold];
    reAuctionUnsold = [...snapshot.state.reAuctionUnsold];
    allPlayers = snapshot.state.allPlayers.map(p => ({ ...p }));
    snapshot.state.teams.forEach((savedTeam, index) => {
      if (teams[index]) {
        const currentSocketId = teams[index].socketId;
        const currentIsConnected = teams[index].isConnected;
        teams[index] = { ...savedTeam, socketId: currentSocketId, isConnected: currentIsConnected };
      }
    });
    console.log(`Auction state restored to: ${snapshot.action}`);
    return true;
  } catch (error) {
    console.error('Error restoring auction snapshot:', error);
    return false;
  }
}

function loadPlayers() {
  return new Promise((resolve, reject) => {
    const csvPath = process.env.PLAYERS_CSV || path.join(__dirname, 'players.csv');
    if (!fs.existsSync(csvPath)) return reject(new Error('CSV file not found'));
    players = [];
    allPlayers = [];
    fs.createReadStream(csvPath).pipe(csv())
      .on('data', (row) => {
        try {
          const player = {
            sNo: sanitizeString(row['S.No']), name: sanitizeString(row.Name), role: sanitizeString(row.Role),
            archetype: sanitizeString(row.Archetype), baseScore: parseInt(row.Base_Score) || 0,
            basePrice: (parseInt(row.Base_Price) || 0) * 100000, status: 'available',
            soldToTeam: null, soldPrice: null
          };
          if (player.name && player.archetype && player.baseScore > 0 && player.basePrice > 0) {
            players.push(player);
            allPlayers.push({ ...player });
          }
        } catch (error) { console.error(`Error processing player row: ${error.message}`); }
      })
      .on('end', () => {
        if (players.length === 0) return reject(new Error('No valid players loaded'));
        players = players.sort(() => Math.random() - 0.5);
        const playersPerSet = Math.ceil(players.length / 3);
        sets = [players.slice(0, playersPerSet), players.slice(playersPerSet, playersPerSet * 2), players.slice(playersPerSet * 2)];
        allPlayers = allPlayers.sort((a, b) => {
          const aIndex = players.findIndex(p => p.sNo === a.sNo);
          const bIndex = players.findIndex(p => p.sNo === b.sNo);
          return aIndex - bIndex;
        });
        console.log(`Successfully loaded ${players.length} players`);
        emitUpdate();
        resolve();
      })
      .on('error', (err) => reject(err));
  });
}

// ... other helper functions like calculateSynergy, getCurrentPlayer, getIncrement, etc. remain the same ...
function calculateSynergy(roster) { if (!Array.isArray(roster) || roster.length === 0) return 0; let baseTotal=0, positive=0, negative=0; for (const player of roster) { if (player && typeof player.baseScore==='number') baseTotal += player.baseScore; } for (let i=0; i < roster.length; i++) { for (let j=i + 1; j < roster.length; j++) { const p1=roster[i], p2=roster[j]; if (!p1?.archetype || !p2?.archetype) continue; let a1=sanitizeString(p1.archetype), a2=sanitizeString(p2.archetype); if (!a1 || !a2) continue; if (a1 > a2) [a1, a2]=[a2, a1]; const key=`${a1}-${a2}`; positive += synergyRules.positive[key] || 0; negative += synergyRules.negative[key] || 0; } } return baseTotal + positive + negative; }
function calculatePlayerSynergy(targetPlayer, roster) { if (!targetPlayer || !Array.isArray(roster) || roster.length===0) return 0; const playerIndex=roster.findIndex(p => p.sNo===targetPlayer.sNo); if (playerIndex===-1) return 0; let playerSynergy=targetPlayer.baseScore || 0, positiveBonus=0, negativePenalty=0; for (let i=0; i < roster.length; i++) { if (i===playerIndex) continue; const otherPlayer=roster[i]; if (!otherPlayer?.archetype || !targetPlayer?.archetype) continue; let a1=sanitizeString(targetPlayer.archetype), a2=sanitizeString(otherPlayer.archetype); if (!a1 || !a2) continue; if (a1 > a2) [a1, a2]=[a2, a1]; const key=`${a1}-${a2}`; positiveBonus += synergyRules.positive[key] || 0; negativePenalty += synergyRules.negative[key] || 0; } return playerSynergy + positiveBonus + negativePenalty; }
function getCurrentPlayer() { if (isReAuction) return reAuctionUnsold[currentPlayerIndex] || null; const totalPlayers=players.length; if (currentPlayerIndex >= totalPlayers) return null; const playersPerSet=Math.ceil(totalPlayers / 3); const setIndex=Math.floor(currentPlayerIndex / playersPerSet); const indexInSet=currentPlayerIndex % playersPerSet; if (!sets[setIndex] || !sets[setIndex][indexInSet]) return null; return sets[setIndex][indexInSet]; }
function getIncrement(bid) { if (bid < 5000000) return 500000; if (bid < 10000000) return 1000000; if (bid < 20000000) return 2000000; return 5000000; }
function validateBid(teamId, newBid) { if (!isValidTeamId(teamId)) return { valid: false, reason: 'Invalid team ID' }; const team=teams[teamId - 1], player=getCurrentPlayer(); if (!player) return { valid: false, reason: 'No player available' }; if (team.players.length >= 8) return { valid: false, reason: 'Team roster is full (8 players)' }; if (team.remaining < newBid) return { valid: false, reason: 'Insufficient team budget' }; if (newBid <= 0) return { valid: false, reason: 'Bid must be positive' }; return { valid: true }; }
function handleReAuction() { const needyTeams = teams.filter(t => t.players.length < 8); if (needyTeams.length === 0 || unsold.length === 0) { declareWinner(); return; } reAuctionUnsold = [...unsold].sort(() => Math.random() - 0.5); currentPlayerIndex = 0; isReAuction = true; io.emit('reAuctionStart', { unsoldCount: reAuctionUnsold.length, needyTeams: needyTeams.map(t => t.name) }); emitUpdate(); }
function declareWinner() { const sortedTeams = [...teams].sort((a, b) => (b.synergy || 0) - (a.synergy || 0) || b.remaining - a.remaining); io.emit('auctionComplete', { winner: sortedTeams[0], standings: sortedTeams }); }

// --- Socket.IO Event Handlers ---

function emitUpdate() {
  try {
    const currentPlayer = getCurrentPlayer();
    const computeNextFrom = currentBid || (currentPlayer ? currentPlayer.basePrice : 0);
    const nextIncrement = currentPlayer ? getIncrement(computeNextFrom) : 0;
    const totalPlayers = isReAuction ? reAuctionUnsold.length : players.length;
    const baseUpdateData = {
      teams: teams.map(t => ({ ...t, socketId: undefined, synergy: Number.isFinite(t.synergy) ? t.synergy : 0 })),
      currentPlayer, currentBid, currentBidTeam, isReAuction, currentPlayerIndex, totalPlayers,
      connectedTeams: Array.from(connectedTeams), auctioneerConnected, nextIncrement, allPlayers
    };
    io.to('auctioneer').emit('update', baseUpdateData);
    teams.forEach(team => {
      if (team.socketId) io.to(team.socketId).emit('update', { ...baseUpdateData, myTeam: { ...team, socketId: undefined, synergy: Number.isFinite(team.synergy) ? team.synergy : 0 } });
    });
    io.to('observers').emit('update', baseUpdateData);
  } catch (error) { console.error('Error in emitUpdate:', error); }
}

async function resetAuction() {
  console.log('Starting auction reset...');
  auctionHistory = []; unsold = []; reAuctionUnsold = []; currentPlayerIndex = 0;
  currentBid = 0; currentBidTeam = null; isReAuction = false;
  teams = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, name: `Team ${i + 1}`, budget: 450000000, remaining: 450000000,
    spent: 0, players: [], synergy: 0, isConnected: false, socketId: null
  }));
  await loadPlayers();
  await saveState(); // Save the fresh state to DB
  console.log('Auction reset completed successfully');
  io.emit('auctionReset', { message: 'Auction has been reset by Auctioneer' });
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('joinAsAuctioneer', () => { /* ... unchanged ... */ if (auctioneerConnected) { socket.emit('forceDisconnect', 'Another auctioneer is already connected'); socket.disconnect(); return; } socket.join('auctioneer'); auctioneerConnected = true; socket.isAuctioneer = true; emitUpdate(); io.emit('connectionStatus', { auctioneerConnected, connectedTeams: Array.from(connectedTeams) }); });
  socket.on('joinAsTeam', (teamId) => { /* ... unchanged ... */ if (!isValidTeamId(teamId)) { socket.emit('error', 'Invalid team ID'); return; } const existingTeam = teams[teamId - 1]; if (existingTeam.socketId && existingTeam.socketId !== socket.id) { io.to(existingTeam.socketId).emit('forceDisconnect', 'Another device connected'); } socket.join(`team-${teamId}`); socket.teamId = teamId; teams[teamId - 1].isConnected = true; teams[teamId - 1].socketId = socket.id; connectedTeams.add(teamId); emitUpdate(); io.emit('connectionStatus', { auctioneerConnected, connectedTeams: Array.from(connectedTeams) }); });
  socket.on('joinAsObserver', () => { /* ... unchanged ... */ socket.join('observers'); socket.isObserver = true; emitUpdate(); });

  // --- AUCTIONEER ACTIONS (now async) ---

  socket.on('resetAuction', async () => {
    if (!socket.isAuctioneer) return;
    console.log('Auctioneer requested auction reset');
    try {
      await resetAuction();
    } catch (error) {
      console.error('Error during auction reset:', error);
      socket.emit('error', 'Failed to reset auction.');
    }
  });

  socket.on('placeBidForTeam', (teamId) => { /* ... unchanged ... */ if (!socket.isAuctioneer) return; const player = getCurrentPlayer(); if (!player) return; const newBid = currentBid === 0 ? player.basePrice : currentBid + getIncrement(currentBid); const validation = validateBid(teamId, newBid); if (!validation.valid) { socket.emit('error', validation.reason); return; } currentBid = newBid; currentBidTeam = teamId; io.emit('bidPlaced', { teamId, amount: newBid, playerName: player.name }); emitUpdate(); });
  
  socket.on('resetBid', () => { /* ... unchanged ... */ if (!socket.isAuctioneer) return; const player = getCurrentPlayer(); if (player) { currentBid = 0; currentBidTeam = null; io.emit('bidReset'); emitUpdate(); } });

  socket.on('soldPlayer', async () => { // Make async
    if (!socket.isAuctioneer || !currentBidTeam || currentBid === 0) return;
    const team = teams[currentBidTeam - 1], player = getCurrentPlayer();
    if (!player || !team || team.remaining < currentBid) return;
    createAuctionSnapshot('BEFORE_SOLD', { playerName: player.name, teamId: currentBidTeam, amount: currentBid });
    team.remaining -= currentBid;
    team.spent += currentBid;
    const playerWithSynergy = { ...player, boughtPrice: currentBid, individualSynergy: calculatePlayerSynergy(player, [...team.players, player]) };
    team.players.push(playerWithSynergy);
    team.synergy = calculateSynergy(team.players);
    updatePlayerStatus(player.sNo, 'sold', currentBidTeam, currentBid);
    io.emit('playerSold', { player: playerWithSynergy, teamId: currentBidTeam, amount: currentBid });
    currentPlayerIndex++; currentBid = 0; currentBidTeam = null;
    if (currentPlayerIndex >= players.length && !isReAuction) handleReAuction();
    else if (isReAuction && currentPlayerIndex >= reAuctionUnsold.length) declareWinner();
    await saveState(); // Save state after action
    emitUpdate();
  });

  socket.on('skipPlayer', async () => { // Make async
    if (!socket.isAuctioneer) return;
    const player = getCurrentPlayer();
    if (!player) return;
    createAuctionSnapshot('BEFORE_SKIP', { playerName: player.name });
    unsold.push(player);
    updatePlayerStatus(player.sNo, 'available');
    io.emit('playerSkipped', { player });
    currentPlayerIndex++; currentBid = 0; currentBidTeam = null;
    if (currentPlayerIndex >= players.length && !isReAuction) handleReAuction();
    else if (isReAuction && currentPlayerIndex >= reAuctionUnsold.length) declareWinner();
    await saveState(); // Save state after action
    emitUpdate();
  });

  socket.on('undoLastAction', async () => { // Make async
    if (!socket.isAuctioneer || auctionHistory.length === 0) return;
    const lastSnapshot = auctionHistory.pop();
    if (!lastSnapshot || !lastSnapshot.action.startsWith('BEFORE_')) return;
    if (restoreAuctionSnapshot(lastSnapshot)) {
      const actionType = lastSnapshot.action.replace('BEFORE_', '');
      io.emit('undoCompleted', { action: actionType, playerName: lastSnapshot.playerData?.playerName });
      await saveState(); // Save the restored state
      emitUpdate();
    }
  });

  socket.on('disconnect', () => { /* ... unchanged ... */ if (socket.isAuctioneer) auctioneerConnected = false; if (socket.teamId) { const teamIndex = socket.teamId - 1; if (teams[teamIndex] && teams[teamIndex].socketId === socket.id) { teams[teamIndex].isConnected = false; teams[teamIndex].socketId = null; connectedTeams.delete(socket.teamId); } } emitUpdate(); io.emit('connectionStatus', { auctioneerConnected, connectedTeams: Array.from(connectedTeams) }); });

  emitUpdate();
});

// --- Server Startup ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  await connectToDb();
  
  const stateLoaded = await loadState();
  if (stateLoaded) {
    console.log("✅ Resumed auction from saved state in MongoDB.");
  } else {
    console.log("🌱 No saved state found, starting fresh auction.");
    try {
      await loadPlayers();
      await saveState(); // Perform an initial save of the fresh state
    } catch (error) {
      console.error('❌ Failed to load players on initial startup:', error);
    }
  }
});