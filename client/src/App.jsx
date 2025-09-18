import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from "socket.io-client";
import { confirmAlert } from "react-confirm-alert";
import "react-confirm-alert/src/react-confirm-alert.css";
import './App.css';

// =================================================================
// Reusable Tabs Component
// =================================================================
function Tabs({ tabs }) {
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  if (!tabs || tabs.length === 0) {
    return null;
  }

  return (
    <div className="card bg-white mb-6">
      <div className="tab-navigation__bar">
        {tabs.map((tab, index) => (
          <button
            key={index}
            onClick={() => setActiveTabIndex(index)}
            className={`tab-navigation__button ${
              activeTabIndex === index ? 'tab-navigation__button--active' : ''
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="p-6">
        {tabs[activeTabIndex].content}
      </div>
    </div>
  );
}

// =================================================================
// Synergy Calculation Helpers (matching server logic)
// =================================================================
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

function sanitizeString(str) {
  return str ? str.toString().trim() : '';
}

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

// =================================================================
// Original App Components (updated for compatibility)
// =================================================================

// Error Boundary Component
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center">
          <div className="card bg-red-100 border border-red-400 text-red-700 px-6 py-5 max-w-md text-center">
            <h2 className="text-xl font-bold mb-2">Application Error</h2>
            <p className="mb-4">Something went wrong. Please refresh the page.</p>
            <button
          onClick={() => window.location.reload()}
          className="btn-danger-solid"
        >
          <span className="button_top">Refresh Page</span>
        </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Routing (simple, no dependency)
function getRoute() {
  const p = window.location.pathname;
  if (p.startsWith('/auctioneer')) return { name: 'auctioneer' };
  if (p.startsWith('/team/')) {
    const id = parseInt(p.split('/team/')[1], 10);
    return { name: 'team', teamId: Number.isFinite(id) && id >= 1 && id <= 8 ? id : 1 };
  }
  if (p.startsWith('/observer')) return { name: 'observer' };
  return { name: 'landing' };
}

// Mirror the server's increment rule
function computeNextIncrement(currentBidOrBase) {
  const bid = currentBidOrBase || 0;
  if (bid < 5000000) return 500000;    // +50L
  if (bid < 10000000) return 1000000;  // +1Cr
  if (bid < 20000000) return 2000000;  // +2Cr
  return 5000000;                      // +5Cr
}

// Validation helper matching server logic
function isValidTeamId(teamId) {
  return Number.isInteger(teamId) && teamId >= 1 && teamId <= 8;
}

// Format helpers
const fmtL = (n) => `₹${(n / 100000)}L`;
const fmtCr = (n) => `₹${(n / 10000000)}Cr`;

// Custom hook for notifications
function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const timeoutRefs = useRef(new Set());

  const addNotification = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setNotifications(prev => [...prev, { id, message, type }]);
    
    const timeoutId = setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
      timeoutRefs.current.delete(timeoutId);
    }, 4200);
    
    timeoutRefs.current.add(timeoutId);
  }, []);

  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach(clearTimeout);
      timeoutRefs.current.clear();
    };
  }, []);

  return [notifications, addNotification];
}

// All Players Table Component
function AllPlayersTable({ allPlayers, currentPlayer, teams }) {
  const [sortConfig, setSortConfig] = useState({ key: 'sNo', direction: 'asc' });
  const [filterRole, setFilterRole] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const filteredAndSortedPlayers = useMemo(() => {
    let filtered = allPlayers.filter(player => {
      const matchesRole = filterRole === 'all' || player.role === filterRole;
      const matchesSearch = searchTerm === '' || 
        player.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        player.archetype.toLowerCase().includes(searchTerm.toLowerCase());
      return matchesRole && matchesSearch;
    });

    return filtered.sort((a, b) => {
      const aVal = a[sortConfig.key];
      const bVal = b[sortConfig.key];
      
      if (typeof aVal === 'string') {
        return sortConfig.direction === 'asc' 
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }
      
      return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }, [allPlayers, sortConfig, filterRole, searchTerm]);

  const uniqueRoles = [...new Set(allPlayers.map(p => p.role))].sort();

  const getRowClassName = (player) => {
    if (currentPlayer && player.sNo === currentPlayer.sNo) {
      return 'bg-blue-100 border-blue-300 font-semibold'; // Current player
    }
    if (player.status === 'sold') {
      return 'bg-green-50 text-green-800'; // Sold
    }
    return 'hover:bg-gray-50'; // Available
  };

  const getStatusDisplay = (player) => {
    if (currentPlayer && player.sNo === currentPlayer.sNo) {
      return <span className="badge bg-orange-500 text-white ">Current</span>;
    }
    if (player.status === 'sold') {
      const team = teams.find(t => t.id === player.soldToTeam);
      return (
        <div>
          <span className="badge bg-green-500 ">Sold</span>
          {team && <div className="text-xs text-green-700 mt-1">{team.name}</div>}
          <div className="text-xs text-green-600">{fmtL(player.soldPrice)}</div>
        </div>
      );
    }
    return <span className="badge bg-gray-400 text-gray-600">Available</span>;
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6 items-center">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Filter by Role</label>
          <select
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
          >
            <option value="all">All Roles</option>
            {uniqueRoles.map(role => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
          <input
            type="text"
            placeholder="Player name or archetype..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-48"
          />
        </div>
        
        <div className="text-sm text-gray-600 mt-6">
          Showing {filteredAndSortedPlayers.length} of {allPlayers.length} players
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border rounded-lg">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th 
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('sNo')}
              >
                #
              </th>
              <th 
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('name')}
              >
                Player Name
              </th>
              <th 
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('role')}
              >
                Role
              </th>
              <th 
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('archetype')}
              >
                Archetype
              </th>
              <th 
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('baseScore')}
              >
                Base Score
              </th>
              <th 
                className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('basePrice')}
              >
                Base Price
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredAndSortedPlayers.map((player) => (
              <tr key={player.sNo} className={getRowClassName(player)}>
                <td className="px-4 py-3 text-sm text-gray-600">{player.sNo}</td>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{player.name}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{player.role}</td>
                <td className="px-4 py-3 text-sm">
                  <span className="badge pink">{player.archetype}</span>
                </td>
                <td className="px-4 py-3 text-sm font-semibold text-pink-600">{player.baseScore}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{fmtL(player.basePrice)}</td>
                <td className="px-4 py-3 text-sm">{getStatusDisplay(player)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const route = getRoute();
  const isAuctioneerView = route.name === 'auctioneer';
  const isTeamView = route.name === 'team';
  const isObserverView = route.name === 'observer';
  const teamId = isTeamView ? route.teamId : null;

  const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

  const [state, setState] = useState({
    teams: [],
    currentPlayer: null,
    currentBid: 0,
    currentBidTeam: null,
    isReAuction: false,
    error: null,
    currentPlayerIndex: 0,
    totalPlayers: 72,
    myTeam: null,
    connectedTeams: [],
    auctioneerConnected: false,
    nextIncrement: 0,
    allPlayers: [] 
  });

  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [notifications, addNotification] = useNotifications();
  const socketRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  const socketOptions = useMemo(() => ({
    reconnection: true,
    reconnectionAttempts: maxReconnectAttempts,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket', 'polling'],
    timeout: 10000
  }), []);

  // Enhanced bid validation matching server logic
  const validateBid = useCallback((teamId, newBid) => {
    if (!isValidTeamId(teamId)) {
      return { valid: false, reason: 'Invalid team ID' };
    }
    
    const team = state.teams[teamId - 1];
    const player = state.currentPlayer;
    
    if (!player) {
      return { valid: false, reason: 'No player available' };
    }
    
    if (!team) {
      return { valid: false, reason: 'Team not found' };
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
  }, [state.teams, state.currentPlayer]);

  // Auctioneer actions with enhanced error handling
  const placeBidForTeam = useCallback((selectedTeamId) => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    if (!isValidTeamId(selectedTeamId)) {
      addNotification('Invalid team selection', 'error');
      return;
    }

    const player = state.currentPlayer;
    if (!player) {
      addNotification('No player available for bidding', 'error');
      return;
    }

    const newBid = state.currentBid === 0 
      ? player.basePrice 
      : state.currentBid + computeNextIncrement(state.currentBid);
    
    const validation = validateBid(selectedTeamId, newBid);
    
    if (!validation.valid) {
      addNotification(`Cannot place bid for Team ${selectedTeamId}: ${validation.reason}`, 'error');
      return;
    }

    setIsLoading(true);
    socketRef.current.emit('placeBidForTeam', selectedTeamId);
    
    setTimeout(() => setIsLoading(false), 3000);
  }, [isConnected, isLoading, isAuctioneerView, addNotification, state.currentPlayer, state.currentBid, validateBid]);

  const soldPlayer = useCallback(() => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    if (!state.currentBidTeam || state.currentBid === 0) {
      addNotification('No valid bid to complete sale', 'error');
      return;
    }

    if (!isValidTeamId(state.currentBidTeam)) {
      addNotification('Invalid bidding team', 'error');
      return;
    }

    const team = state.teams[state.currentBidTeam - 1];
    const player = state.currentPlayer;

    if (!team || !player) {
      addNotification('Invalid player or team', 'error');
      return;
    }

    if (team.remaining < state.currentBid) {
      addNotification('Team has insufficient budget', 'error');
      return;
    }

    confirmAlert({
      title: 'Confirm Sale',
      message: `Sell ${player.name} to ${team.name} for ${fmtL(state.currentBid)}?`,
      buttons: [
        {
          label: 'Yes, Sell',
          onClick: () => {
            setIsLoading(true);
            socketRef.current.emit('soldPlayer');
            setTimeout(() => setIsLoading(false), 3000);
          },
        },
        { label: 'Cancel', onClick: () => {} },
      ],
    });
  }, [state.currentPlayer, state.currentBidTeam, state.currentBid, state.teams, isConnected, isLoading, isAuctioneerView, addNotification]);

  const skipPlayer = useCallback(() => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    if (!state.currentPlayer) {
      addNotification('No player available to skip', 'error');
      return;
    }

    confirmAlert({
      title: 'Confirm Skip',
      message: `Skip ${state.currentPlayer.name}? This player will go to re-auction.`,
      buttons: [
        {
          label: 'Yes, Skip',
          onClick: () => {
            setIsLoading(true);
            socketRef.current.emit('skipPlayer');
            setTimeout(() => setIsLoading(false), 3000);
          },
        },
        { label: 'Cancel', onClick: () => {} },
      ],
    });
  }, [state.currentPlayer, isConnected, isLoading, isAuctioneerView, addNotification]);

  const resetBid = useCallback(() => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    if (!state.currentPlayer) {
      addNotification('No current player to reset bid for', 'error');
      return;
    }

    setIsLoading(true);
    socketRef.current.emit('resetBid');
    setTimeout(() => setIsLoading(false), 1500);
  }, [state.currentPlayer, isConnected, isLoading, isAuctioneerView, addNotification]);

 const undoLastAction = useCallback(() => {
  if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
    return;
  }
  
  confirmAlert({
    title: 'Confirm Undo',
    message: 'This will revert the last bid placed for the current player. Are you sure?',
    buttons: [
      {
        label: 'Yes, Undo',
        onClick: () => {
          setIsLoading(true);
          socketRef.current.emit('undoLastAction');
          setTimeout(() => setIsLoading(false), 3000);
        },
      },
      { label: 'Cancel', onClick: () => {} },
    ],
  });
}, [isConnected, isLoading, isAuctioneerView]);

  const resetAuction = useCallback(() => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    confirmAlert({
      title: 'Confirm Auction Reset',
      message: 'This will restart the entire auction from the beginning. All progress will be lost. Are you sure?',
      buttons: [
        {
          label: 'Yes, Reset Everything',
          onClick: () => {
            setIsLoading(true);
            socketRef.current.emit('resetAuction');
            setTimeout(() => setIsLoading(false), 5000);
          },
        },
        { label: 'Cancel', onClick: () => {} },
      ],
    });
  }, [isConnected, isLoading, isAuctioneerView]);

  // Socket connection management with enhanced error handling
  useEffect(() => {
    console.log('Connecting to backend:', backendUrl);
    
    const socket = io(backendUrl, socketOptions);
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      reconnectAttempts.current = 0;
      setState(prev => ({ ...prev, error: null }));

      if (isAuctioneerView) {
        socket.emit('joinAsAuctioneer');
        addNotification('Connected as Auctioneer', 'success');
      } else if (isTeamView && teamId) {
        socket.emit('joinAsTeam', teamId);
        addNotification(`Connected as Team ${teamId}`, 'success');
      } else if (isObserverView) {
        socket.emit('joinAsObserver');
        addNotification('Connected as Observer', 'success');
      }
    });

    socket.on('disconnect', (reason) => {
      setIsConnected(false);
      console.log('Disconnected:', reason);
      addNotification('Disconnected from server', 'error');
    });

    socket.on('connect_error', (err) => {
      console.error('Connection error:', err);
      setIsConnected(false);
      reconnectAttempts.current++;
      
      if (reconnectAttempts.current >= maxReconnectAttempts) {
        setState(prev => ({
          ...prev,
          error: 'Failed to connect to server after multiple attempts. Please check if the server is running and refresh the page.'
        }));
      } else {
        addNotification(`Connection attempt ${reconnectAttempts.current}/${maxReconnectAttempts} failed`, 'error');
      }
    });

    socket.on('reconnect', (attemptNumber) => {
      console.log('Reconnected after', attemptNumber, 'attempts');
      addNotification('Reconnected to server', 'success');
    });

    socket.on('update', (newState) => {
      try {
        if (newState && typeof newState === 'object') {
          setState(prev => {
            const updatedState = { ...prev };
            
            Object.keys(newState).forEach(key => {
              if (newState[key] !== undefined) {
                updatedState[key] = newState[key];
              }
            });
            
            // Recalculate synergy for teams if needed
            if (updatedState.teams && Array.isArray(updatedState.teams)) {
              updatedState.teams = updatedState.teams.map(team => ({
                ...team,
                synergy: Number.isFinite(team.synergy) ? team.synergy : calculateSynergy(team.players || [])
              }));
            }
            
            return updatedState;
          });
        }
        setIsLoading(false);
      } catch (error) {
        console.error('Error processing update:', error);
        addNotification('Error processing server update', 'error');
      }
    });

    socket.on('bidPlaced', (data) => {
      try {
        if (!data || typeof data !== 'object') return;
        
        if (isAuctioneerView || isObserverView) {
          addNotification(`${data.teamName || 'Team'} bid ${fmtL(data.amount || 0)} for ${data.playerName || 'player'}`, 'info');
        } else if (isTeamView && teamId === data.teamId) {
          addNotification(`You bid ${fmtL(data.amount || 0)} for ${data.playerName || 'player'}!`, 'success');
        } else if (isTeamView) {
          addNotification(`Team ${data.teamId || '?'} placed a bid`, 'warning');
        }
      } catch (error) {
        console.error('Error handling bidPlaced event:', error);
      }
    });

    socket.on('playerSold', (data) => {
      try {
        if (!data || typeof data !== 'object') return;
        
        if (isTeamView && teamId === data.teamId) {
          addNotification(`You won ${data.player?.name || 'player'} for ${fmtL(data.amount || 0)}!`, 'success');
        } else {
          addNotification(`${data.player?.name || 'Player'} sold to ${data.teamName || 'team'} for ${fmtL(data.amount || 0)}!`, 'info');
        }
      } catch (error) {
        console.error('Error handling playerSold event:', error);
      }
    });

    socket.on('playerSkipped', (data) => {
      try {
        addNotification(`${data?.player?.name || 'Player'} skipped - going to re-auction`, 'info');
      } catch (error) {
        console.error('Error handling playerSkipped event:', error);
      }
    });

    socket.on('bidReset', (data) => {
      try {
        addNotification(`Bid reset for ${data?.playerName || 'player'}`, 'info');
      } catch (error) {
        console.error('Error handling bidReset event:', error);
      }
    });

    // NEW: Handle undo completed event
   socket.on('undoCompleted', (data) => {
  try {
    const playerName = data?.playerName || 'unknown player';
    addNotification(`Successfully undid bid for ${playerName}`, 'success');
  } catch (error) {
    console.error('Error handling undoCompleted event:', error);
  }
});

    socket.on('setSummary', (teams) => {
      try {
        if (Array.isArray(teams) && teams.length > 0) {
          const topTeam = teams.reduce((best, team) => {
            const teamSynergy = Number.isFinite(team?.synergy) ? team.synergy : -Infinity;
            const bestSynergy = Number.isFinite(best?.synergy) ? best.synergy : -Infinity;
            return teamSynergy > bestSynergy ? team : best;
          }, null);
          
          if (topTeam) {
            const synergy = Number.isFinite(topTeam.synergy) ? Math.round(topTeam.synergy) : '0';
            addNotification(`Set complete! Leader: ${topTeam.name || 'Unknown'} (${synergy} synergy)`, 'success');
          }
        }
      } catch (error) {
        console.error('Error handling setSummary event:', error);
      }
    });

    socket.on('reAuctionStart', (data) => {
      try {
        const count = data?.unsoldCount || 0;
        addNotification(`Re-auction starting! ${count} players available`, 'info');
      } catch (error) {
        console.error('Error handling reAuctionStart event:', error);
      }
    });

    socket.on('auctionComplete', (data) => {
      try {
        const winner = data?.winner;
        if (winner) {
          const synergy = Number.isFinite(winner.synergy) ? Math.round(winner.synergy) : '0';
          addNotification(`Auction Complete! Winner: ${winner.name || 'Unknown'} (${synergy} synergy)`, 'success');
        }
      } catch (error) {
        console.error('Error handling auctionComplete event:', error);
      }
    });

    socket.on('connectionStatus', (status) => {
      try {
        setState(prev => ({
          ...prev,
          auctioneerConnected: Boolean(status?.auctioneerConnected),
          connectedTeams: Array.isArray(status?.connectedTeams) ? status.connectedTeams : []
        }));
      } catch (error) {
        console.error('Error handling connectionStatus event:', error);
      }
    });

    socket.on('forceDisconnect', (reason) => {
      try {
        addNotification(`Disconnected: ${reason || 'Unknown reason'}`, 'error');
        setTimeout(() => window.location.reload(), 1500);
      } catch (error) {
        console.error('Error handling forceDisconnect event:', error);
      }
    });

    socket.on('auctionReset', (data) => {
      try {
        const message = data?.message || 'Auction has been reset';
        addNotification(message, 'info');
        setTimeout(() => window.location.reload(), 2000);
      } catch (error) {
        console.error('Error handling auctionReset event:', error);
      }
    });

    socket.on('error', (errorMessage) => {
      try {
        addNotification(`Error: ${errorMessage || 'Unknown error'}`, 'error');
        setIsLoading(false);
      } catch (error) {
        console.error('Error handling error event:', error);
      }
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
      }
    };
  }, [isAuctioneerView, isTeamView, isObserverView, teamId, addNotification, backendUrl, socketOptions]);

  // Error screen
  if (state.error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="card bg-red-100 border border-red-400 text-red-700 px-6 py-5 max-w-lg text-center">
          <h2 className="text-xl font-bold mb-2">Connection Error</h2>
          <p className="mb-4">{state.error}</p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => window.location.reload()}
              className="btn-danger-solid"
            >
              Retry Connection
            </button>
            <button
              onClick={() => window.location.href = '/'}
              className="btn-secondary"
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Loading screen with better conditions
  const needsInitialData = isConnected && (
    (isAuctioneerView && state.teams.length === 0) ||
    (isObserverView && state.teams.length === 0) ||
    (isTeamView && (!state.myTeam || state.myTeam.id !== teamId))
  );

  if (needsInitialData) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="spin rounded w-12 h-12 border-2 border-pink-500" style={{
            borderTopColor: 'transparent',
            margin: '0 auto 1rem'
          }}></div>
          <p className="text-gray-600">Loading auction data...</p>
          <p className="text-sm text-gray-500 mt-2">
            {isConnected ? 'Connected - Waiting for data...' : 'Connecting...'}
          </p>
        </div>
      </div>
    );
  }

  // Notifications component
  const NotificationContainer = () => (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm">
      {notifications.map(n => (
        <div
          key={n.id}
          className={`notification px-4 py-2 text-sm ${n.type}`}
        >
          {n.message}
        </div>
      ))}
    </div>
  );

  const ConnectionStatus = () => (
    <div className="card bg-white p-3 mb-4">
      <div className="flex justify-between items-center text-sm">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <div className={`status-dot ${isConnected ? 'online' : 'offline'}`}></div>
            <span className={isConnected ? 'text-green-600' : 'text-red-600'}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </span>
          {(isAuctioneerView || isObserverView) && (
            <span className="flex items-center gap-1">
              <div className={`status-dot ${state.auctioneerConnected ? 'online' : 'offline'}`}></div>
              <span className={state.auctioneerConnected ? 'text-green-600' : 'text-gray-400'}>
                Auctioneer: {state.auctioneerConnected ? 'Online' : 'Offline'}
              </span>
            </span>
          )}
        </div>
        <div className="text-gray-600">
          Teams Online: {state.connectedTeams.length}/8
          {state.connectedTeams.length > 0 && ` (${state.connectedTeams.join(', ')})`}
        </div>
      </div>
    </div>
  );

  // Modern Auctioneer View Layout - Compact Single Page Version
  if (isAuctioneerView) {
    const canSell = Boolean(state.currentBidTeam && state.currentBid > 0);
    const progress = state.totalPlayers > 0
      ? Math.round((state.currentPlayerIndex / state.totalPlayers) * 100)
      : '0';
    const nextUpAmount = state.currentPlayer
      ? (state.currentBid === 0
          ? state.currentPlayer.basePrice
          : state.currentBid + (state.nextIncrement || computeNextIncrement(state.currentBid)))
      : 0;

    return (
      <div className="min-h-screen">
        <NotificationContainer />
        <header className="auctioneer-header-modern text-white">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <h1 className="text-2xl font-extrabold tracking-wider">
                CPL AUCTION
              </h1>
              <a
                href="/"
                className="text-white hover:text-orange-200 underline transition-colors text-sm"
              >
                ← Home
              </a>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold">
                Player {state.currentPlayerIndex} of {state.totalPlayers}
              </div>
              <div className="text-pink-200 text-sm">
                {progress}% Complete
                {state.isReAuction && <span className="ml-2">• Re-Auction</span>}
              </div>
            </div>
          </div>
          <div className="progress-container-modern">
            <div
              className="progress-fill-modern"
              style={{ width: `${Math.min(100, Math.max(0, Number(progress)))}%` }}
            />
          </div>
        </header>

        <main className="pb-24 p-4">
          {state.currentPlayer ? (
            <div className="main-compact-grid">
              <div className="player-spotlight">
                <div className="flex flex-col md:flex-row items-center md:items-start gap-4">
                  <div className="flex-shrink-0">
                    <img
                      src={`/photos/${state.currentPlayer.sNo}.png`}
                      alt={state.currentPlayer.name}
                      className="player-image-spotlight"
                      onError={(e) => {
                        e.target.src = '/default.jpg';
                        e.target.onerror = null;
                      }}
                    />
                  </div>
                  <div className="flex-1 min-w-0 text-center md:text-left">
                    <h2 className="player-name-spotlight truncate">
                      {state.currentPlayer.name}
                    </h2>
                    <div className="player-details-grid">
                      <div className="player-detail-card">
                        <div className="text-slate-600 text-xs mb-1">Role</div>
                        <div className="font-bold text-lg text-slate-800">
                          {state.currentPlayer.role}
                        </div>
                      </div>
                      <div className="player-detail-card">
                        <div className="text-slate-600 text-xs mb-1">Archetype</div>
                        <div className="font-bold text-lg text-slate-800 truncate">
                          {state.currentPlayer.archetype}
                        </div>
                      </div>
                      <div className="player-detail-card">
                        <div className="text-slate-600 text-xs mb-1">Score</div>
                        <div className="font-bold text-lg text-pink-600">
                          {state.currentPlayer.baseScore}
                        </div>
                      </div>
                      <div className="player-detail-card">
                        <div className="text-slate-600 text-xs mb-1">Base Price</div>
                        <div className="font-bold text-lg text-orange-600">
                          {fmtL(state.currentPlayer.basePrice)}
                        </div>
                      </div>
                    </div>

                    <div className={`bid-status-spotlight ${state.currentBid > 0 ? 'active-bidding' : ''}`}>
                      {state.currentBid === 0 ? (
                        <div>
                          <div className="starting-price">
                            {fmtL(state.currentPlayer.basePrice)}
                          </div>
                          <div className="text-slate-500 text-xs mt-2">
                            Waiting for first bid...
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div className="text-slate-600 text-lg mb-2">Current Highest Bid</div>
                          <div className="current-bid-amount">
                            {fmtL(state.currentBid)}
                          </div>
                          <div className="text-lg font-semibold text-orange-500 mb-2">
                            Team {state.currentBidTeam}
                          </div>
                          {nextUpAmount > 0 && (
                            <div className="text-slate-500 text-lg">
                              Next bid: {fmtL(nextUpAmount)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="team-grid-modern">
                <div className="team-cards-grid">
                  {state.teams.map((team) => {
                    const nextBidAmount = state.currentBid === 0
                      ? state.currentPlayer?.basePrice || 0
                      : state.currentBid + (state.nextIncrement || computeNextIncrement(state.currentBid));

                    const canTeamBid = team.remaining >= nextBidAmount &&
                                       team.players.length < 8 &&
                                       !isLoading &&
                                       isConnected;

                    return (
                      <button
                        key={team.id}
                        onClick={() => placeBidForTeam(team.id)}
                        disabled={!canTeamBid}
                        className={`team-bid-card ${state.currentBidTeam === team.id ? 'current-highest' : ''}`}
                      >
                        <div className="flex items-center justify-between w-full mb-3">
                          <div className="team-name-large">{team.name}</div>
                          {state.currentBidTeam === team.id && (
                            <span className="text-xs bg-orange-400  px-2 py-1 rounded-full font-bold">
                              Highest
                            </span>
                          )}
                        </div>
                        <div className="flex items-center justify-between w-full">
                          <div className="text-center">
                            <div className="text-xs text-slate-600 mb-1">Budget</div>
                            <div className="font-bold text-green-600 text-lg">{fmtCr(team.remaining)}</div>
                          </div>
                          <div className="text-center">
                            <div className="text-xs text-slate-600 mb-1">Next Bid</div>
                            <div className={`font-bold text-lg ${canTeamBid ? 'text-orange-500' : 'text-red-500'}`}>
                              {fmtL(nextBidAmount)}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-auction-state">
              <div className="empty-state-icon">🏏</div>
              <h2 className="empty-state-title">
                {state.isReAuction ? 'Re-Auction Complete' : 'No Player Available'}
              </h2>
              <p className="empty-state-description">
                {state.currentPlayerIndex >= state.totalPlayers
                  ? 'All players have been processed. The auction is complete!'
                  : 'Waiting for the next player to be loaded into the auction system.'
                }
              </p>
            </div>
          )}
        </main>

        <div className="control-panel-modern">
          <div className="control-buttons-grid">
            <button
              onClick={soldPlayer}
              disabled={!canSell || isLoading || !isConnected}
              className="control-button-modern btn-sell"
            >
              <span>💰</span>
              {isLoading ? 'PROCESSING...' : 'SELL'}
            </button>
            <button
              onClick={skipPlayer}
              disabled={isLoading || !isConnected || !state.currentPlayer}
              className="control-button-modern btn-skip"
            >
              <span>⏭️</span>
              {isLoading ? 'PROCESSING...' : 'SKIP'}
            </button>
            <button
              onClick={resetBid}
              disabled={isLoading || !isConnected || !state.currentPlayer}
              className="control-button-modern btn-reset"
            >
              <span>🔄</span>
              {isLoading ? 'PROCESSING...' : 'RESET BID'}
            </button>
            
            {state.currentPlayerIndex >= 48 && (
              <button
                onClick={resetAuction}
                disabled={isLoading || !isConnected}
                className="control-button-modern btn-danger"
              >
                <span>🧹</span>
                {isLoading ? 'PROCESSING...' : 'RESET AUCTION'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Team View Layout with Tabs
  if (isTeamView) {
    const myTeam = state.myTeam || {
      id: teamId,
      name: `Team ${teamId}`,
      remaining: 0,
      spent: 0,
      players: [],
      synergy: 0
    };
    const myCurrentBid = state.currentBidTeam === teamId;

    // Define the content for each tab
    const teamTabs = [
      {
        label: <>My Team Roster ({myTeam.players.length}/8)</>,
        content: (
          <div>
            <div className="mb-4">
              <div className="text-sm text-gray-600">
                Total Synergy: <span className="font-semibold text-orange-600">
                  {Number.isFinite(myTeam.synergy) ? Math.round(myTeam.synergy) : '0'}
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              {myTeam.players.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-6xl mb-4">👥</div>
                  <h3 className="text-xl font-bold text-gray-700 mb-2">No Players Yet</h3>
                  <p className="text-gray-500">Your purchased players will appear here</p>
                </div>
              ) : (
                <table>
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">#</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Player Name</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Role</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Archetype</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Base Score</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Base Price</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Bought Price</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Individual Synergy</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {myTeam.players.map((player, index) => {
                      const individualSynergy = player.individualSynergy || player.baseScore; // Simplified
                      return (
                        <tr key={player.sNo || index} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-600">{index + 1}</td>
                          <td className="px-4 py-3">
                            <div className="font-semibold text-gray-800">{player.name || 'Unknown'}</div>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">{player.role || 'N/A'}</td>
                          <td className="px-4 py-3">
                            <span className="badge pink">
                              {player.archetype || 'N/A'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-pink-600">
                            {player.baseScore || 0}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600">
                            {fmtL(player.basePrice || 0)}
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-green-600">
                            {fmtL(player.boughtPrice || 0)}
                          </td>
                          <td className="px-4 py-3 text-sm">
                             <span className={`font-semibold ${
                                  individualSynergy > (player.baseScore || 0) 
                                    ? 'text-green-600' 
                                    : individualSynergy < (player.baseScore || 0)
                                    ? 'text-red-600'
                                    : 'text-gray-600'
                                }`}>
                                  {Math.round(individualSynergy)}
                                </span>
                                <div className="text-xs text-gray-500">
                                  {individualSynergy > (player.baseScore || 0) 
                                    ? `+${Math.round(individualSynergy - (player.baseScore || 0))} synergy`
                                    : individualSynergy < (player.baseScore || 0)
                                    ? `${Math.round(individualSynergy - (player.baseScore || 0))} synergy`
                                    : 'No synergy effect'
                                  }
                                </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )
      },
      {
        label: <>All Players ({state.allPlayers.length})</>,
        content: (
          state.allPlayers.length > 0 ? (
            <AllPlayersTable 
              allPlayers={state.allPlayers} 
              currentPlayer={state.currentPlayer}
              teams={state.teams}
            />
          ) : (
            <div className="text-center py-12">
              <div className="text-6xl mb-4">📋</div>
              <h3 className="text-xl font-bold text-gray-700 mb-2">Player Data Loading</h3>
              <p className="text-gray-500">All players will appear here once the auction starts</p>
            </div>
          )
        )
      }
    ];

    return (
      <div className="min-h-screen p-4">
        <NotificationContainer />

        <div className="flex flex-wrap gap-2 mb-3">
          <a href="/" className="text-sm text-pink-600 underline hover:text-orange-600">
            ← Back to Role Select
          </a>
        </div>

        <header className={`text-white p-6 rounded-2xl mb-6 header-gradient transition-all ${
          myCurrentBid 
        }`}>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold ">{myTeam.name}</h1>
              {myCurrentBid && (
                <div className="text-green-100 font-semibold">🌟 HIGHEST BIDDER!</div>
              )}
            </div>
            <div className="text-right">
              <div className={`font-semibold ${isConnected ? 'text-green-200' : 'text-red-200'}`}>
                {isConnected ? 'Connected' : 'Disconnected'}
              </div>
              <div className="text-sm">Team Device #{teamId}</div>
            </div>
          </div>
        </header>

        <ConnectionStatus />

        {/* Team statistics grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="card bg-white p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{fmtCr(myTeam.remaining)}</div>
            <div className="text-gray-600 text-sm">Remaining Budget</div>
          </div>
          <div className="card bg-white p-4 text-center">
            <div className="text-2xl font-bold text-red-600">{fmtCr(myTeam.spent)}</div>
            <div className="text-gray-600 text-sm">Money Spent</div>
          </div>
          <div className="card bg-white p-4 text-center">
            <div className="text-2xl font-bold text-pink-600">{myTeam.players.length}/8</div>
            <div className="text-gray-600 text-sm">Players Bought</div>
          </div>
          <div className="card bg-white p-4 text-center">
            <div className="text-2xl font-bold text-orange-500">
              {Number.isFinite(myTeam.synergy) ? Math.round(myTeam.synergy) : '0'}
            </div>
            <div className="text-gray-600 text-sm">Team Synergy</div>
          </div>
        </div>

        {/* Current player section */}
        {state.currentPlayer && (
          <div className="card bg-white mb-6 overflow-hidden">
            <div className={`p-4 text-white font-semibold transition-all ${myCurrentBid ? 'bg-green-500' : 'bg-orange-500'}`}>
              <h2 className="text-xl font-bold">Current Player on Auction</h2>
              {myCurrentBid && (
                <p className="text-green-100">You have the highest bid!</p>
              )}
            </div>

            <div className="p-6">
              <div className="flex flex-col md:flex-row items-start gap-4 mb-4">
                <img
                  src={`/photos/${state.currentPlayer.sNo}.png`}
                  alt={state.currentPlayer.name}
                  className="w-24 h-24 object-cover rounded-2xl flex-shrink-0"
                  onError={(e) => {
                    e.target.src = '/default.jpg';
                    e.target.onerror = null;
                  }}
                />
                <div className="flex-1 min-w-0">
                  <h3 className="text-2xl font-bold text-gray-800 mb-2 truncate">
                    {state.currentPlayer.name}
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                    <div>
                      <span className="text-gray-600">Role: </span>
                      <span className="font-semibold">{state.currentPlayer.role}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Archetype: </span>
                      <span className="font-semibold">{state.currentPlayer.archetype}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Base Score: </span>
                      <span className="font-semibold">{state.currentPlayer.baseScore}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Base Price: </span>
                      <span className="font-semibold">{fmtL(state.currentPlayer.basePrice)}</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded-2xl border ${
                    myCurrentBid 
                      ? 'bg-green-50 border-green-200' 
                      : 'bg-gray-50 border-gray-200'
                  }`}>
                    {state.currentBid === 0 ? (
                      <div>
                        <span className="text-gray-600">Starting at base price: </span>
                        <span className="font-bold">{fmtL(state.currentPlayer.basePrice)}</span>
                      </div>
                    ) : (
                      <div>
                        <span className="text-gray-600">Current highest bid: </span>
                        <span className="font-bold">{fmtL(state.currentBid)}</span>
                        {state.currentBidTeam && (
                          <span className={`ml-2 ${myCurrentBid ? 'text-green-600' : 'text-orange-600'}`}>
                            by {myCurrentBid ? 'YOU' : `Team ${state.currentBidTeam}`}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mt-1">
                      Next increment: {fmtL(state.nextIncrement || computeNextIncrement(state.currentBid || state.currentPlayer.basePrice))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="text-center p-4 bg-orange-50 rounded-2xl">
                <p className="text-orange-800 font-semibold">Auctioneer controls all bidding</p>
                <p className="text-orange-600 text-sm">Watch for your team's bids and player assignments</p>
              </div>
            </div>
          </div>
        )}
        
        {/* Use the new Tabs component */}
        <Tabs tabs={teamTabs} />

      </div>
    );
  }

  // Observer View Layout
  if (isObserverView) {
    const progress = state.totalPlayers > 0 
      ? Math.round((state.currentPlayerIndex / state.totalPlayers) * 100)
      : '0';

    return (
      <div className="min-h-screen p-4">
        <NotificationContainer />
        <div className="flex flex-wrap gap-2 mb-3">
          <a href="/" className="text-sm text-pink-600 underline hover:text-orange-500">
            ← Back to Role Select
          </a>
        </div>
        <header className="header-gradient text-white p-4 rounded-2xl mb-4">
          <h1 className="text-2xl font-bold text-center">CPL Auction — Observer</h1>
          <div className="text-center mt-2">
            Progress: {progress}% | {state.isReAuction ? 'Re-Auction Mode' : 'Main Auction'}
          </div>
          <div className="mt-2 progress-bar" style={{ backgroundColor: 'rgba(255, 255, 255, 0.2)' }}>
            <div 
              className="bg-white h-2 transition-all rounded-full" 
              style={{ width: `${Math.min(100, Math.max(0, Number(progress)))}%` }}
            ></div>
          </div>
        </header>
        <ConnectionStatus />
        <div className="grid grid-cols-2 gap-4 mb-6">
          {state.teams.map(team => (
            <div key={team.id} className="card bg-white p-4 transition-all hover:transform hover:-translate-y-1">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-xl">{team.name}</h3>
                <span className={`text-sm font-semibold ${
                  state.connectedTeams.includes(team.id) ? 'text-green-600' : 'text-red-600'
                }`}>
                  {state.connectedTeams.includes(team.id) ? '● Online' : '● Offline'}
                </span>
              </div>
              <div className="observer-stats-grid">
                <div className="observer-stat-item">
                  <div className="stat-label">Budget Left</div>
                  <div className="stat-value text-green-600">{fmtCr(team.remaining)}</div>
                </div>
                <div className="observer-stat-item">
                  <div className="stat-label">Players</div>
                  <div className="stat-value text-pink-600">{team.players.length}/8</div>
                </div>
                <div className="observer-stat-item">
                  <div className="stat-label">Money Spent</div>
                  <div className="stat-value text-red-600">{fmtCr(team.spent)}</div>
                </div>
                <div className="observer-stat-item">
                  <div className="stat-label">Synergy</div>
                  <div className="stat-value text-orange-600">
                    {Number.isFinite(team.synergy) ? Math.round(team.synergy) : '0'}
                  </div>
                </div>
              </div>

              {state.currentBidTeam === team.id && (
                <div className="mt-4 text-center badge orange">
                  🏆 Highest Bidder
                </div>
              )}
            </div>
          ))}
        </div>
        {state.currentPlayer && (
          <div className="card bg-white p-6 mb-6">
            <div className="flex items-start gap-4 mb-4">
              <img
                src={`/photos/${state.currentPlayer.sNo}.png`}
                alt={state.currentPlayer.name}
                className="w-24 h-24 object-cover rounded-2xl flex-shrink-0"
                onError={(e) => {
                  e.target.src = '/default.jpg';
                  e.target.onerror = null;
                }}
              />
              <div className="flex-1 min-w-0">
                <h2 className="text-2xl font-bold mb-2 truncate">{state.currentPlayer.name}</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm text-gray-700">
                  <div>Role: <span className="font-semibold">{state.currentPlayer.role}</span></div>
                  <div>Archetype: <span className="font-semibold">{state.currentPlayer.archetype}</span></div>
                  <div>Score: <span className="font-semibold">{state.currentPlayer.baseScore}</span></div>
                  <div>Base Price: <span className="font-semibold">{fmtL(state.currentPlayer.basePrice)}</span></div>
                </div>
              </div>
            </div>
            <div className="bg-gray-50 p-4 rounded-2xl border border-gray-200">
              {state.currentBid === 0 ? (
                <div className="text-lg text-gray-700">
                  Starting at base price: <span className="font-bold text-orange-600">{fmtL(state.currentPlayer.basePrice)}</span>
                </div>
              ) : (
                <div className="text-lg text-gray-700">
                  Current bid: <span className="font-bold text-green-600">{fmtL(state.currentBid)}</span> by Team {state.currentBidTeam}
                </div>
              )}
              <div className="text-sm text-gray-500 mt-1">
                Next increment: {fmtL(state.nextIncrement || computeNextIncrement(state.currentBid || state.currentPlayer.basePrice))}
              </div>
            </div>
          </div>
        )}
        {state.allPlayers.length > 0 && (
          <div className="card bg-white mb-6">
            <div className="bg-gray-50 p-4 border-b rounded-t-2xl">
              <h2 className="text-xl font-bold text-gray-800">All Players Overview</h2>
              <p className="text-sm text-gray-600 mt-1">Complete auction status tracker</p>
            </div>
            <div className="p-6">
              <AllPlayersTable 
                allPlayers={state.allPlayers} 
                currentPlayer={state.currentPlayer}
                teams={state.teams}
              />
            </div>
          </div>
        )}
        {!state.currentPlayer && (
          <div className="card bg-white p-6 text-center">
            <div className="text-6xl mb-4">🏏</div>
            <h2 className="text-xl font-bold text-gray-700 mb-2">No Current Player</h2>
            <p className="text-gray-500">
              {state.isReAuction 
                ? 'Re-auction phase - waiting for next player' 
                : 'Main auction - waiting for next player'
              }
            </p>
          </div>
        )}
      </div>
    );
  }

  // Landing Page (Role Selection)
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card bg-white p-8 max-w-md w-full text-center">
        <div className="text-6xl mb-4">🏏</div>
        <h1 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-pink-500 to-orange-400 mb-2">CPL Auction</h1>
        <p className="text-gray-600 mb-6">Select your role to join the auction</p>
        <div className="space-y-3">
          <button
            onClick={() => (window.location.href = '/auctioneer')}
            className="w-full btn-primary"
          >
            Join as Auctioneer
          </button>
          <div className="grid grid-cols-2 gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8].map(teamNum => (
              <button
                key={teamNum}
                onClick={() => (window.location.href = `/team/${teamNum}`)}
                className="w-full btn-success"
              >
                Team {teamNum}
              </button>
            ))}
          </div>
          <button
            onClick={() => (window.location.href = '/observer')}
            className="w-full btn-secondary"
          >
            Join as Observer
          </button>
          <div className="text-xs text-gray-500 mt-6 p-2 bg-gray-50 rounded-lg">
           <div>Backend :
              <a 
                href= {backendUrl} 
                target="_blank" 
                rel="noopener noreferrer"
                className="bg-gray-200 px-1 rounded text-blue-600 hover:text-blue-800 underline font-mono text-xs"
              >
                {backendUrl}
              </a>
            </div>
            <div className="mt-1">
              Status: {isConnected ? '🟢 Ready' : '🔴 Not Connected'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;