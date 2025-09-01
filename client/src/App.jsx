import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { io } from "socket.io-client";
import { confirmAlert } from "react-confirm-alert";
import "react-confirm-alert/src/react-confirm-alert.css";
import './App.css';

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
        <div className="min-h-screen flex items-center justify-center bg-gray-100">
          <div className="bg-red-100 border border-red-400 text-red-700 px-6 py-5 rounded-lg max-w-md text-center">
            <h2 className="text-xl font-bold mb-2">Application Error</h2>
            <p className="mb-4">Something went wrong. Please refresh the page.</p>
            <button
              onClick={() => window.location.reload()}
              className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 transition-colors"
            >
              Refresh Page
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
    return { name: 'team', teamId: Number.isFinite(id) && id >= 1 && id <= 6 ? id : 1 };
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

// Format helpers
const fmtL = (n) => `₹${(n / 100000).toFixed(2)}L`;
const fmtCr = (n) => `₹${(n / 10000000).toFixed(1)}Cr`;

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
    nextIncrement: 0
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

  // Auctioneer actions with better error handling
  const placeBidForTeam = useCallback((selectedTeamId) => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    if (!Number.isInteger(selectedTeamId) || selectedTeamId < 1 || selectedTeamId > 6) {
      addNotification('Invalid team selection', 'error');
      return;
    }

    setIsLoading(true);
    socketRef.current.emit('placeBidForTeam', selectedTeamId);
    
    setTimeout(() => setIsLoading(false), 3000);
  }, [isConnected, isLoading, isAuctioneerView, addNotification]);

  const soldPlayer = useCallback(() => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    confirmAlert({
      title: 'Confirm Sale',
      message: state.currentPlayer && state.currentBidTeam
        ? `Sell ${state.currentPlayer.name} to Team ${state.currentBidTeam} for ${fmtL(state.currentBid)}?`
        : 'No valid bid to complete sale',
      buttons: [
        {
          label: 'Yes, Sell',
          onClick: () => {
            if (state.currentPlayer && state.currentBidTeam) {
              setIsLoading(true);
              socketRef.current.emit('soldPlayer');
              setTimeout(() => setIsLoading(false), 3000);
            }
          },
        },
        { label: 'Cancel', onClick: () => {} },
      ],
    });
  }, [state.currentPlayer, state.currentBidTeam, state.currentBid, isConnected, isLoading, isAuctioneerView]);

  const skipPlayer = useCallback(() => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    confirmAlert({
      title: 'Confirm Skip',
      message: state.currentPlayer
        ? `Skip ${state.currentPlayer.name}? This player will go to re-auction.`
        : 'No player available to skip.',
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
  }, [state.currentPlayer, isConnected, isLoading, isAuctioneerView]);

  const resetBid = useCallback(() => {
    if (!socketRef.current || !isConnected || isLoading || !isAuctioneerView) {
      return;
    }

    setIsLoading(true);
    socketRef.current.emit('resetBid');
    setTimeout(() => setIsLoading(false), 1500);
  }, [isConnected, isLoading, isAuctioneerView]);

  // Socket connection management
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
            
            return updatedState;
          });
        }
        setIsLoading(false);
      } catch (error) {
        console.error('Error processing update:', error);
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

    socket.on('setSummary', (teams) => {
      try {
        if (Array.isArray(teams) && teams.length > 0) {
          const topTeam = teams.reduce((best, team) => {
            const teamSynergy = Number.isFinite(team?.synergy) ? team.synergy : -Infinity;
            const bestSynergy = Number.isFinite(best?.synergy) ? best.synergy : -Infinity;
            return teamSynergy > bestSynergy ? team : best;
          }, null);
          
          if (topTeam) {
            const synergy = Number.isFinite(topTeam.synergy) ? topTeam.synergy.toFixed(1) : '0.0';
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
          const synergy = Number.isFinite(winner.synergy) ? winner.synergy.toFixed(1) : '0.0';
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

    socket.on('error', (errorMessage) => {
      try {
        addNotification(`Error: ${errorMessage || 'Unknown error'}`, 'error');
        setIsLoading(false);
      } catch (error) {
        console.error('Error handling error event:', error);
      }
    });

    socket.on('bidReset', (data) => {
      try {
        addNotification(`Bid reset for ${data?.playerName || 'player'}`, 'info');
      } catch (error) {
    console.error('Error handling bidReset event:', error);
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
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-red-100 border border-red-400 text-red-700 px-6 py-5 rounded-lg max-w-lg text-center">
          <h2 className="text-xl font-bold mb-2">Connection Error</h2>
          <p className="mb-4">{state.error}</p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={() => window.location.reload()}
              className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600 transition-colors"
            >
              Retry Connection
            </button>
            <button
              onClick={() => window.location.href = '/'}
              className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-600 transition-colors"
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
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="spin rounded w-12 h-12 border-2 border-blue-500" style={{
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
          className={`notification px-4 py-2 rounded-lg text-sm ${n.type}`}
        >
          {n.message}
        </div>
      ))}
    </div>
  );

  const ConnectionStatus = () => (
    <div className="bg-white p-3 rounded-lg shadow-sm border mb-4">
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
          Teams Online: {state.connectedTeams.length}/6
          {state.connectedTeams.length > 0 && ` (${state.connectedTeams.join(', ')})`}
        </div>
      </div>
    </div>
  );

  // Auctioneer View Layout
  if (isAuctioneerView) {
    const canSell = Boolean(state.currentBidTeam && state.currentBid > 0);
    const progress = state.totalPlayers > 0 
      ? ((state.currentPlayerIndex / state.totalPlayers) * 100).toFixed(1)
      : '0.0';
    const nextUpAmount = state.currentPlayer
      ? (state.currentBid === 0
          ? state.currentPlayer.basePrice
          : state.currentBid + (state.nextIncrement || computeNextIncrement(state.currentBid)))
      : 0;

    return (
      <div className="min-h-screen flex flex-col bg-gray-900 text-white">
        <NotificationContainer />

        {/* HEADER */}
        <header className="auctioneer-header p-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-extrabold tracking-wide text-blue-400">
                CPL Auctioneer
              </h1>
              <a 
                href="/" 
                className="text-sm text-blue-300 hover:text-blue-200 underline no-underline"
              >
                ← Home
              </a>
            </div>
            <div className="text-sm text-gray-300">
              Progress: {progress}% ({state.currentPlayerIndex}/{state.totalPlayers})
              {state.isReAuction && <span className="ml-2 text-yellow-300">(Re-Auction)</span>}
            </div>
          </div>
          <div className="mt-2 progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${Math.min(100, Math.max(0, Number(progress)))}%` }}
            />
          </div>
        </header>

        {/* CONNECTION STATUS */}
        <div className="px-4 py-2 bg-gray-800">
          <div className="flex justify-between items-center text-sm">
            <div className="flex items-center gap-4">
              <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
                {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
              </span>
              <span className="text-gray-300">
                Teams Online: {state.connectedTeams.length}/6
              </span>
            </div>
            {isLoading && (
              <span className="text-yellow-400 pulse">Processing...</span>
            )}
          </div>
        </div>

        {/* MAIN STAGE */}
        <main className="flex-1 flex flex-col items-center justify-center p-6">
          {state.currentPlayer ? (
            <div className="auctioneer-main p-6 max-w-4xl w-full">
              <div className="flex flex-col md:flex-row items-center gap-6">
                {/* Player Image */}
                <div className="flex-shrink-0">
                  <img
                    src={`/photos/${state.currentPlayer.sNo}.jpg`}
                    alt={state.currentPlayer.name}
                    className="w-48 h-48 object-cover rounded-xl player-card-img"
                    onError={(e) => {
                      e.target.src = '/default.jpg';
                      e.target.onerror = null;
                    }}
                  />
                </div>

                {/* Player Details */}
                <div className="flex-1 min-w-0">
                  <h2 className="text-4xl font-bold mb-3 text-yellow-300 truncate">
                    {state.currentPlayer.name}
                  </h2>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-base mb-4">
                    <div>
                      <span className="text-gray-400 block">Role</span>
                      <div className="font-semibold">{state.currentPlayer.role}</div>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Archetype</span>
                      <div className="font-semibold">{state.currentPlayer.archetype}</div>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Base Score</span>
                      <div className="font-semibold">{state.currentPlayer.baseScore}</div>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Base Price</span>
                      <div className="font-semibold text-blue-300">
                        {fmtL(state.currentPlayer.basePrice)}
                      </div>
                    </div>
                  </div>

                  {/* Current Bid Display */}
                  <div className="bg-gray-800 p-4 rounded-xl text-center border border-gray-700">
                    {state.currentBid === 0 ? (
                      <div className="text-xl">
                        Starting Price:{' '}
                        <span className="font-bold text-blue-400">
                          {fmtL(state.currentPlayer.basePrice)}
                        </span>
                      </div>
                    ) : (
                      <div className="text-xl">
                        Current Bid:{' '}
                        <span className="font-bold text-green-400">
                          {fmtL(state.currentBid)}
                        </span>
                        <span className="ml-2 text-yellow-300">
                          (Team {state.currentBidTeam})
                        </span>
                      </div>
                    )}
                    {nextUpAmount > 0 && (
                      <div className="text-sm text-gray-400 mt-1">
                        Next bid will be:{' '}
                        <span className="font-semibold">{fmtL(nextUpAmount)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center">
              <div className="text-6xl mb-4">🏏</div>
              <div className="text-gray-400 text-lg">
                {state.isReAuction ? 'Re-auction completed' : 'No player currently available'}
              </div>
              <div className="text-gray-500 text-sm mt-2">
                {state.currentPlayerIndex >= state.totalPlayers 
                  ? 'All players have been processed' 
                  : 'Waiting for next player...'
                }
              </div>
            </div>
          )}
        </main>

        {/* TEAM GRID */}
        {state.currentPlayer && (
          <section className="bg-gray-800 p-4 border-t border-blue-600">
            <h3 className="text-lg font-bold mb-3 text-center text-blue-300">
              Select Team to Place Bid
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
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
                    className={`bid-button p-4 rounded-xl text-left w-full focus:outline-none 
                      ${state.currentBidTeam === team.id
                        ? 'current-bid'
                        : canTeamBid
                        ? 'hover:bg-blue-800'
                        : 'disabled:bg-gray-700 disabled:opacity-50'
                      }`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold truncate">{team.name}</span>
                      <div className="flex items-center gap-1">
                        {state.connectedTeams.includes(team.id) && (
                          <span className="text-green-400 text-xs">●</span>
                        )}
                        {state.currentBidTeam === team.id && (
                          <span className="text-yellow-400 font-semibold text-xs">
                            HIGHEST
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-gray-400 space-y-1">
                      <div>Budget: <span className="font-semibold text-white">{fmtCr(team.remaining)}</span></div>
                      <div>Players: <span className="font-semibold text-white">{team.players.length}/8</span></div>
                      <div>
                        Next Bid:{' '}
                        <span className={`font-semibold ${canTeamBid ? 'text-blue-300' : 'text-red-400'}`}>
                          {fmtL(nextBidAmount)}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* FOOTER CONTROLS */}
        <footer className="p-4 bg-gray-800 border-t border-blue-600 flex justify-center gap-4">
          <button
            onClick={soldPlayer}
            disabled={!canSell || isLoading || !isConnected}
            className="control-button sell px-6 py-3 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-green-400"
          >
            {isLoading ? 'PROCESSING...' : 'SELL 💰'}
          </button>
          <button
            onClick={skipPlayer}
            disabled={isLoading || !isConnected || !state.currentPlayer}
            className="control-button skip px-6 py-3 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-400"
          >
            {isLoading ? 'PROCESSING...' : 'SKIP ➡️'}
          </button>
          <button
            onClick={resetBid}
            disabled={isLoading || !isConnected || !state.currentPlayer}
            className="control-button reset px-6 py-3 text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-red-400"
          >
            {isLoading ? 'PROCESSING...' : 'RESET 🔄'}
          </button>
        </footer>
      </div>
    );
  }

  // Team View Layout
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

    return (
      <div className="min-h-screen bg-gray-100 p-4">
        <NotificationContainer />

        <div className="flex flex-wrap gap-2 mb-3">
          <a href="/" className="text-sm text-blue-600 underline hover:text-blue-800">
            ← Back to Role Select
          </a>
        </div>

        <header className={`text-white p-6 rounded-lg mb-6 shadow-lg transition-all ${
          myCurrentBid 
            ? 'gradient-green' 
            : 'gradient-blue'
        }`}>
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold">{myTeam.name}</h1>
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
          <div className="bg-white p-4 rounded-lg shadow-sm text-center border">
            <div className="text-2xl font-bold text-green-600">{fmtCr(myTeam.remaining)}</div>
            <div className="text-gray-600 text-sm">Remaining Budget</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm text-center border">
            <div className="text-2xl font-bold text-red-600">{fmtCr(myTeam.spent)}</div>
            <div className="text-gray-600 text-sm">Money Spent</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm text-center border">
            <div className="text-2xl font-bold text-purple-600">{myTeam.players.length}/8</div>
            <div className="text-gray-600 text-sm">Players Bought</div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow-sm text-center border">
            <div className="text-2xl font-bold text-blue-600">
              {Number.isFinite(myTeam.synergy) ? myTeam.synergy.toFixed(1) : '0.0'}
            </div>
            <div className="text-gray-600 text-sm">Team Synergy</div>
          </div>
        </div>

        {/* Current player section */}
        {state.currentPlayer && (
          <div className="bg-white rounded-lg shadow-sm border mb-6 overflow-hidden">
            <div className={`p-4 text-white font-semibold transition-all ${myCurrentBid ? 'bg-green-500' : 'bg-blue-500'}`}>
              <h2 className="text-xl font-bold">Current Player on Auction</h2>
              {myCurrentBid && (
                <p className="text-green-100">You have the highest bid!</p>
              )}
            </div>

            <div className="p-6">
              <div className="flex flex-col md:flex-row items-start gap-4 mb-4">
                <img
                  src={`/photos/${state.currentPlayer.sNo}.jpg`}
                  alt={state.currentPlayer.name}
                  className="w-24 h-24 object-cover rounded-lg shadow-sm flex-shrink-0"
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

                  {/* Current bidding status */}
                  <div className={`p-3 rounded-lg border ${
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
                          <span className={`ml-2 ${myCurrentBid ? 'text-green-600' : 'text-blue-600'}`}>
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

              <div className="text-center p-4 bg-blue-50 rounded-lg">
                <p className="text-blue-800 font-semibold">Auctioneer controls all bidding</p>
                <p className="text-blue-600 text-sm">Watch for your team's bids and player assignments</p>
              </div>
            </div>
          </div>
        )}

        {/* Team roster section */}
        <div className="bg-white rounded-lg shadow-sm border">
          <div className="bg-gray-50 p-4 border-b">
            <h2 className="text-xl font-bold text-gray-800">My Team Roster ({myTeam.players.length}/8)</h2>
            <div className="text-sm text-gray-600 mt-1">
              Total Synergy: <span className="font-semibold text-blue-600">
                {Number.isFinite(myTeam.synergy) ? myTeam.synergy.toFixed(1) : '0.0'}
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
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-600">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {myTeam.players.map((player, index) => {
                    const valueDiff = (player.boughtPrice || 0) - (player.basePrice || 0);
                    const isGoodDeal = valueDiff <= 0;
                    
                    return (
                      <tr key={player.sNo || index} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-600">{index + 1}</td>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-gray-800">{player.name || 'Unknown'}</div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">{player.role || 'N/A'}</td>
                        <td className="px-4 py-3">
                          <span className="badge blue">
                            {player.archetype || 'N/A'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold text-purple-600">
                          {player.baseScore || 0}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {fmtL(player.basePrice || 0)}
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold text-green-600">
                          {fmtL(player.boughtPrice || 0)}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`font-semibold ${isGoodDeal ? 'text-green-600' : 'text-red-600'}`}>
                            {isGoodDeal ? 'Good Deal' : 'Overpaid'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Observer View Layout
  if (isObserverView) {
    const progress = state.totalPlayers > 0 
      ? ((state.currentPlayerIndex / state.totalPlayers) * 100).toFixed(1) 
      : '0.0';

    return (
      <div className="min-h-screen bg-gray-100 p-4">
        <NotificationContainer />

        <div className="flex flex-wrap gap-2 mb-3">
          <a href="/" className="text-sm text-blue-600 underline hover:text-blue-800">
            ← Back to Role Select
          </a>
        </div>

        <header className="bg-purple-600 text-white p-4 rounded-lg mb-4 shadow-lg">
          <h1 className="text-2xl font-bold text-center">CPL Auction – Observer</h1>
          <div className="text-center mt-2">
            Progress: {progress}% | {state.isReAuction ? 'Re-Auction Mode' : 'Main Auction'}
          </div>
          <div className="mt-2 progress-bar" style={{ backgroundColor: 'rgba(147, 51, 234, 0.6)' }}>
            <div 
              className="bg-white h-2 transition-all" 
              style={{ width: `${Math.min(100, Math.max(0, Number(progress)))}%` }}
            ></div>
          </div>
        </header>

        <ConnectionStatus />

        {/* Teams overview grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {state.teams.map(team => (
            <div key={team.id} className="bg-white p-4 rounded-lg shadow-sm border transition-all hover:shadow-lg">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold text-lg">{team.name}</h3>
                <div className="flex items-center gap-2">
                  <span className={`text-sm ${
                    state.connectedTeams.includes(team.id) ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {state.connectedTeams.includes(team.id) ? '🟢 Online' : '🔴 Offline'}
                  </span>
                </div>
              </div>
              <div className="space-y-1 text-sm text-gray-700">
                <div>Budget Left: <span className="font-semibold">{fmtCr(team.remaining)}</span></div>
                <div>Spent: <span className="font-semibold">{fmtCr(team.spent)}</span></div>
                <div>Players: <span className="font-semibold">{team.players.length}/8</span></div>
                <div>Synergy: <span className="font-semibold text-blue-600">
                  {Number.isFinite(team.synergy) ? team.synergy.toFixed(1) : '0.0'}
                </span></div>
              </div>
              {state.currentBidTeam === team.id && (
                <div className="mt-2 text-xs badge yellow">
                  Highest Bidder
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Current player display */}
        {state.currentPlayer && (
          <div className="bg-white p-6 rounded-lg shadow-sm border transition-all">
            <div className="flex items-start gap-4 mb-4">
              <img
                src={`/photos/${state.currentPlayer.sNo}.jpg`}
                alt={state.currentPlayer.name}
                className="w-24 h-24 object-cover rounded-lg flex-shrink-0 shadow-md"
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

            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              {state.currentBid === 0 ? (
                <div className="text-lg text-gray-700">
                  Starting at base price: <span className="font-bold text-blue-600">{fmtL(state.currentPlayer.basePrice)}</span>
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

        {/* No current player message */}
        {!state.currentPlayer && (
          <div className="bg-white p-6 rounded-lg shadow-sm border text-center">
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
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-lg shadow-lg max-w-md w-full text-center border">
        <div className="text-6xl mb-4">🏏</div>
        <h1 className="text-3xl font-bold text-gray-800 mb-2">CPL Auction</h1>
        <p className="text-gray-600 mb-6">Select your role to join the auction</p>

        <div className="space-y-3">
          <button
            onClick={() => (window.location.href = '/auctioneer')}
            className="w-full bg-blue-500 text-white py-3 px-4 rounded-lg hover:bg-blue-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            Join as Auctioneer
          </button>

          <div className="grid grid-cols-2 gap-2">
            {[1, 2, 3, 4, 5, 6].map(teamNum => (
              <button
                key={teamNum}
                onClick={() => (window.location.href = `/team/${teamNum}`)}
                className="bg-green-500 text-white py-2 px-3 rounded hover:bg-green-600 transition-colors text-sm focus:outline-none focus:ring-2 focus:ring-green-400"
              >
                Team {teamNum}
              </button>
            ))}
          </div>

          <button
          onClick={() => (window.location.href = '/observer')}
          className="w-full py-3 px-4 rounded-lg 
                    bg-gradient-to-r from-blue-500 to-indigo-500 
                    text-white font-semibold 
                    shadow-md hover:shadow-lg 
                    hover:from-blue-600 hover:to-indigo-600
                    transition-all duration-200 
                    focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
          Join as Observer
        </button>


          <div className="text-xs text-gray-500 mt-6 p-2 bg-gray-50 rounded">
            <div>Backend: <code className="bg-gray-200 px-1 rounded">{backendUrl}</code></div>
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