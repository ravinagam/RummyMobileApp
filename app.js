'use strict';

/* ============================================================
   FIREBASE CONFIG
   Fill in your Firebase project details below.
   Steps:
     1. Go to https://console.firebase.google.com
     2. Create a project (or use an existing one)
     3. Add a Web App  → copy the firebaseConfig object
     4. Go to Firestore Database → Create database → Start in test mode
     5. Paste the values below
   ============================================================ */

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyDPBG8aKWe_JLeLDz-lbV8Kea7TZPulJf0',
  authDomain:        'rummy-d1e08.firebaseapp.com',
  projectId:         'rummy-d1e08',
  storageBucket:     'rummy-d1e08.firebasestorage.app',
  messagingSenderId: '928659183389',
  appId:             '1:928659183389:web:5cd159563d8ef2467533f4',
};

/* ============================================================
   CLOUD SYNC  — Firebase Firestore (optional)
   If FIREBASE_CONFIG is not filled in, the app works with
   localStorage only (same as before).
   ============================================================ */

const CloudSync = {
  _ready: false,
  _docRef: null,
  _pushing: false,

  init() {
    const configured = FIREBASE_CONFIG.apiKey &&
                       FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
    if (!configured) return;
    try {
      // Avoid double-init if Firebase was already initialised
      const app = firebase.apps.length
        ? firebase.app()
        : firebase.initializeApp(FIREBASE_CONFIG);
      this._docRef = firebase.firestore(app).collection('rummy').doc('data');
      this._ready  = true;
    } catch (err) {
      console.error('[CloudSync] init failed:', err);
    }
  },

  /** Pull cloud data and overwrite localStorage. Returns true if new data was found. */
  async pull() {
    if (!this._ready) return false;
    try {
      const snap = await this._docRef.get();
      if (snap.exists) {
        const data = snap.data();
        if (data && Array.isArray(data.sessions)) {
          localStorage.setItem(STORE_KEY, JSON.stringify(data));
          Store._cache = null; // invalidate cache
          return true;
        }
      }
    } catch (err) {
      console.error('[CloudSync] pull failed:', err);
    }
    return false;
  },

  /** Push current localStorage data to Firestore (fire-and-forget). */
  push() {
    if (!this._ready || this._pushing) return;
    this._pushing = true;
    Store._load();
    this._docRef.set(Store._cache)
      .catch(err => console.error('[CloudSync] push failed:', err))
      .finally(() => { this._pushing = false; });
  }
};

/* ============================================================
   UTILITIES
   ============================================================ */

function uuid() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function formatDateShort(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

/* ============================================================
   STORE  — all localStorage I/O
   ============================================================ */

const STORE_KEY = 'rummy_v1';

const Store = {
  _cache: null,

  _load() {
    if (this._cache) return;
    try {
      this._cache = JSON.parse(localStorage.getItem(STORE_KEY)) || { sessions: [] };
    } catch {
      this._cache = { sessions: [] };
    }
  },

  _persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify(this._cache));
    CloudSync.push();
  },

  getSessions() {
    this._load();
    return this._cache.sessions
      .slice()
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  },

  getSession(id) {
    this._load();
    return this._cache.sessions.find(s => s.id === id) || null;
  },

  getActiveSession() {
    this._load();
    return this._cache.sessions.find(s => s.status === 'active') || null;
  },

  saveSession(session) {
    this._load();
    const idx = this._cache.sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) {
      this._cache.sessions[idx] = session;
    } else {
      this._cache.sessions.push(session);
    }
    this._persist();
  },

  deleteSession(id) {
    this._load();
    this._cache.sessions = this._cache.sessions.filter(s => s.id !== id);
    this._persist();
  },

  createSession(playerNames, rules) {
    const session = {
      id: uuid(),
      date: new Date().toISOString(),
      status: 'active',
      rules: { ...rules },
      players: playerNames.map(name => ({ id: uuid(), name: name.trim() })),
      rounds: [],
      knockedOut: [],  // player IDs who have reached the target
      adjustments: {}  // playerId → score offset applied on rejoin
    };
    this.saveSession(session);
    return session;
  },

  addRound(sessionId, scores) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const round = {
      id: uuid(),
      number: session.rounds.length + 1,
      scores: { ...scores }
    };
    session.rounds.push(round);

    // Auto-knockout any active player who now meets/exceeds the target
    if (session.rules.targetScore) {
      const totals = getPlayerTotals(session);
      const ko = session.knockedOut || [];
      session.players.forEach(p => {
        if (!ko.includes(p.id) && totals[p.id] >= session.rules.targetScore) {
          ko.push(p.id);
        }
      });
      session.knockedOut = ko;
    }

    this.saveSession(session);
    return round;
  },

  knockoutPlayer(sessionId, playerId) {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.knockedOut = session.knockedOut || [];
    if (!session.knockedOut.includes(playerId)) {
      session.knockedOut.push(playerId);
    }
    this.saveSession(session);
  },

  rejoinPlayer(sessionId, playerId, adjustment) {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.knockedOut = (session.knockedOut || []).filter(id => id !== playerId);
    if (adjustment !== undefined) {
      session.adjustments = session.adjustments || {};
      // Add to any existing adjustment for this player
      session.adjustments[playerId] = (session.adjustments[playerId] || 0) + adjustment;
    }
    this.saveSession(session);
  },

  clearHistory() {
    this._load();
    this._cache.sessions = this._cache.sessions.filter(s => s.status === 'active');
    this._persist();
  },

  exportData() {
    this._load();
    return JSON.stringify(this._cache, null, 2);
  },

  importData(jsonString) {
    const incoming = JSON.parse(jsonString);
    if (!incoming || !Array.isArray(incoming.sessions)) throw new Error('Invalid file');
    this._load();
    // Merge: add sessions that don't already exist (by id)
    const existingIds = new Set(this._cache.sessions.map(s => s.id));
    incoming.sessions.forEach(s => {
      if (!existingIds.has(s.id)) this._cache.sessions.push(s);
    });
    this._persist();
    return incoming.sessions.length;
  },

  updateScore(sessionId, roundId, playerId, newScore) {
    const session = this.getSession(sessionId);
    if (!session) return;
    const round = session.rounds.find(r => r.id === roundId);
    if (!round) return;
    round.scores[playerId] = newScore;
    this.saveSession(session);
  },

  updateRound(sessionId, roundId, scores) {
    const session = this.getSession(sessionId);
    if (!session) return;
    const round = session.rounds.find(r => r.id === roundId);
    if (!round) return;
    round.scores = { ...scores };
    this.saveSession(session);
  },

  completeSession(sessionId, money) {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.status = 'completed';
    session.completedDate = new Date().toISOString();
    if (money && Object.keys(money).length > 0) session.money = money;
    this.saveSession(session);
  }
};

/* ============================================================
   SCORING HELPERS
   ============================================================ */

function getPlayerTotals(session) {
  const totals = {};
  session.players.forEach(p => { totals[p.id] = 0; });
  session.rounds.forEach(round => {
    session.players.forEach(p => {
      totals[p.id] += (round.scores[p.id] ?? 0);
    });
  });
  // Apply rejoin adjustments
  const adjustments = session.adjustments || {};
  Object.keys(adjustments).forEach(pid => {
    if (totals[pid] !== undefined) totals[pid] += adjustments[pid];
  });
  return totals;
}

function getRankedPlayers(session) {
  const totals = getPlayerTotals(session);
  return session.players
    .map(p => ({ ...p, total: totals[p.id] }))
    .sort((a, b) =>
      session.rules.winCondition === 'lowest'
        ? a.total - b.total
        : b.total - a.total
    );
}

/**
 * Returns effective money settlement for a session.
 * Uses manually entered money if available, otherwise calculates
 * from session.rules.gameAmount (winner receives, others pay).
 */
function getEffectiveMoney(session) {
  if (session.money && Object.keys(session.money).length > 0) return session.money;
  if (session.rounds.length === 0) return {};
  return calcSettlement(session);
}

/**
 * Calculate settlement amounts from scores + gameAmount base.
 * Each loser pays: -(their total score) - gameAmount
 * Winner receives: sum of all losers' payments (positive)
 */
function calcSettlement(session) {
  const totals  = getPlayerTotals(session);
  const ranked  = getRankedPlayers(session);
  const winner  = ranked[0];
  const gameAmt = (session.rules && session.rules.gameAmount) || 0;
  const money   = {};
  let winnerReceives = 0;
  session.players.forEach(p => {
    if (p.id !== winner.id) {
      const owes = totals[p.id] + gameAmt;
      money[p.id] = -owes;           // negative = they pay
      winnerReceives += owes;
    }
  });
  money[winner.id] = winnerReceives; // positive = winner receives
  return money;
}

function getWinner(session) {
  if (!session || session.rounds.length === 0) return null;
  return getRankedPlayers(session)[0];
}

/* ============================================================
   ROUTER  — hash-based SPA routing
   ============================================================ */

const Router = {
  routes: {},

  on(path, handler) { this.routes[path] = handler; },

  navigate(hash) { window.location.hash = hash; },

  init() {
    window.addEventListener('hashchange', () => this._dispatch());
    this._dispatch();
  },

  _dispatch() {
    const hash = window.location.hash.slice(1) || '/';
    // split and clean: "/game/abc" → ["game","abc"]
    const parts = hash.split('/').filter(Boolean);
    const routeKey = parts.length ? '/' + parts[0] : '/';
    const params = parts.slice(1);

    const handler = this.routes[routeKey] || this.routes['/'];
    if (handler) handler(params);
  }
};

/* ============================================================
   UI HELPERS
   ============================================================ */

function setContent(html) {
  document.getElementById('page-content').innerHTML = html;
}

function setTitle(title) {
  document.getElementById('page-title').textContent = title;
}

function showBack(show, href) {
  const btn = document.getElementById('btn-back');
  btn.hidden = !show;
  btn._href = href || '/';
}

function showModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  // Focus first input after render
  setTimeout(() => {
    const first = document.querySelector('#modal input');
    if (first) first.focus();
  }, 50);
}

function hideModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function exportData() {
  const json = Store.exportData();
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `rummy-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported!', 'success');
}

function importData(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const count = Store.importData(e.target.result);
      showToast(`Imported ${count} session(s)!`, 'success');
      renderHome();
    } catch {
      showToast('Invalid backup file', 'error');
    }
    input.value = ''; // reset so same file can be re-imported if needed
  };
  reader.readAsText(file);
}

function showToast(msg, type = 'info') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `toast toast-${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2800);
}

/* ============================================================
   PAGE: HOME
   ============================================================ */

function renderHome() {
  setTitle('Rummy 🃏');
  showBack(false);

  const sessions  = Store.getSessions();
  const active    = sessions.find(s => s.status === 'active');
  const completed = sessions.filter(s => s.status === 'completed');

  /* Active game banner */
  let activeHtml = '';
  if (active) {
    const leader = getRankedPlayers(active)[0];
    activeHtml = `
      <div class="card card-active" onclick="Router.navigate('/game/${active.id}')">
        <div class="card-tag">Active Game</div>
        <div class="card-title">${formatDateShort(active.date)}</div>
        <div class="card-meta">
          ${active.players.map(p => p.name).join(', ')}
          &middot; ${active.rounds.length} round${active.rounds.length !== 1 ? 's' : ''}
        </div>
        ${leader && active.rounds.length > 0
          ? `<div class="card-leader">Leading: ${leader.name} (${leader.total})</div>`
          : ''}
        <div class="card-arrow">Continue →</div>
      </div>`;
  }

  /* Completed sessions */
  let historyHtml = '';
  if (completed.length > 0) {
    historyHtml = `
      <h2 class="section-title" style="margin-top:20px">Recent Games</h2>
      ${completed.slice(0, 8).map(s => {
        const winner = getWinner(s);
        return `
          <div class="card card-history" onclick="Router.navigate('/history/${s.id}')">
            <div class="card-row">
              <span class="card-date">${formatDateShort(s.date)}</span>
              ${winner ? `<span class="badge badge-winner">🏆 ${winner.name}</span>` : ''}
            </div>
            <div class="card-meta">
              ${s.players.map(p => p.name).join(', ')} &middot; ${s.rounds.length} rounds
            </div>
          </div>`;
      }).join('')}`;
  }

  const emptyHtml = (!active && completed.length === 0) ? `
    <div class="empty-state">
      <div class="empty-icon">🃏</div>
      <p>No games yet.<br>Tap <strong>New Game</strong> to start!</p>
    </div>` : '';

  setContent(`
    <div>
      ${activeHtml}
      <button class="btn btn-primary btn-block" onclick="Router.navigate('/setup')">
        + New Game
      </button>
      ${historyHtml}
      ${emptyHtml}
      <div class="data-transfer">
        <button class="btn btn-outline btn-sm" onclick="exportData()">⬇ Export Data</button>
        <label class="btn btn-outline btn-sm" style="cursor:pointer">
          ⬆ Import Data
          <input type="file" accept=".json" style="display:none"
                 onchange="importData(this)">
        </label>
      </div>
    </div>
  `);
}

/* ============================================================
   PAGE: SETUP
   ============================================================ */

function renderSetup() {
  setTitle('New Game');
  showBack(true, '/');

  setContent(`
    <form id="setup-form">
      <div class="form-section">
        <h2 class="section-title">Players</h2>
        <div id="player-list">
          ${[1, 2, 3, 4].map(i => `
            <div class="player-row">
              <span class="player-num">${i}</span>
              <input type="text" class="input player-input"
                     placeholder="Player ${i} name"
                     maxlength="20"
                     ${i <= 2 ? 'required' : ''}>
              ${i > 2
                ? `<button type="button" class="btn-icon btn-remove" onclick="removePlayerRow(this)" title="Remove">✕</button>`
                : `<span class="spacer"></span>`}
            </div>`).join('')}
        </div>
        <button type="button" class="btn btn-outline btn-sm"
                id="btn-add-player" onclick="addPlayerRow()"
                style="margin-top:4px">
          + Add Player
        </button>
      </div>

      <div class="form-section">
        <h2 class="section-title">Rules</h2>

        <div class="form-group">
          <label class="form-label">Target Score (game ends when a player reaches this)</label>
          <input type="number" class="input" id="target-score"
                 value="201" min="1" max="9999" required>
        </div>

        <div class="form-group">
          <label class="form-label">Game Amount (₹ per game)</label>
          <input type="number" class="input" id="game-amount"
                 value="300" min="0">
        </div>

        <div class="form-group">
          <label class="form-label">Drop Scores</label>
          <div class="drop-scores-grid">
            <div class="drop-score-item">
              <label class="drop-score-label">D — Drop</label>
              <input type="number" class="input" id="drop-score" value="20" min="0">
            </div>
            <div class="drop-score-item">
              <label class="drop-score-label">M — Mid Drop</label>
              <input type="number" class="input" id="mid-drop-score" value="40" min="0">
            </div>
            <div class="drop-score-item">
              <label class="drop-score-label">F — Full Count</label>
              <input type="number" class="input" id="full-count-score" value="80" min="0">
            </div>
          </div>
        </div>
      </div>

      <button type="submit" class="btn btn-primary btn-block">Start Game →</button>
    </form>
  `);

  document.getElementById('setup-form').addEventListener('submit', handleSetupSubmit);
}

function addPlayerRow() {
  const list  = document.getElementById('player-list');
  const count = list.querySelectorAll('.player-row').length;
  if (count >= 6) { showToast('Maximum 6 players', 'warning'); return; }

  const i   = count + 1;
  const row = document.createElement('div');
  row.className = 'player-row';
  row.innerHTML = `
    <span class="player-num">${i}</span>
    <input type="text" class="input player-input"
           placeholder="Player ${i} name" maxlength="20">
    <button type="button" class="btn-icon btn-remove"
            onclick="removePlayerRow(this)" title="Remove">✕</button>`;
  list.appendChild(row);
  row.querySelector('input').focus();

  if (count + 1 >= 6) {
    document.getElementById('btn-add-player').disabled = true;
  }
}

function removePlayerRow(btn) {
  btn.closest('.player-row').remove();
  // Renumber remaining rows
  document.querySelectorAll('#player-list .player-row').forEach((row, i) => {
    row.querySelector('.player-num').textContent = i + 1;
    row.querySelector('input').placeholder = `Player ${i + 1} name`;
  });
  const addBtn = document.getElementById('btn-add-player');
  if (addBtn) addBtn.disabled = false;
}

function handleSetupSubmit(e) {
  e.preventDefault();
  const names = Array.from(document.querySelectorAll('.player-input'))
    .map(i => i.value.trim())
    .filter(Boolean);

  if (names.length < 2) {
    showToast('Need at least 2 players', 'error'); return;
  }
  if (new Set(names.map(n => n.toLowerCase())).size !== names.length) {
    showToast('Player names must be unique', 'error'); return;
  }

  const targetScore    = parseInt(document.getElementById('target-score').value)    || 201;
  const winCondition   = 'lowest';
  const gameAmount     = parseInt(document.getElementById('game-amount').value)     || 0;
  const dropScore      = parseInt(document.getElementById('drop-score').value)      || 20;
  const midDropScore   = parseInt(document.getElementById('mid-drop-score').value)  || 40;
  const fullCountScore = parseInt(document.getElementById('full-count-score').value)|| 80;

  // Complete any existing active session before starting a new one
  const existing = Store.getActiveSession();
  if (existing) Store.completeSession(existing.id);

  const session = Store.createSession(names, { targetScore, winCondition, gameAmount, dropScore, midDropScore, fullCountScore });
  Router.navigate(`/game/${session.id}`);
}

/* ============================================================
   PAGE: GAME
   ============================================================ */

function renderGame(params) {
  const id      = params[0];
  const session = Store.getSession(id);

  if (!session) {
    showToast('Game not found', 'error');
    Router.navigate('/');
    return;
  }

  const isActive = session.status === 'active';
  const ranked   = getRankedPlayers(session);
  const totals   = getPlayerTotals(session);

  setTitle(isActive ? 'Game' : 'Game Summary');
  // Back goes to /history if accessed from history, else home
  const fromHistory = window.location.hash.startsWith('#/history');
  showBack(true, fromHistory ? '/history' : '/');

  const knockedOut = session.knockedOut || [];
  const activePlayers = session.players.filter(p => !knockedOut.includes(p.id));

  /* Completed banner + money settlement */
  let completedHtml = '';
  if (!isActive) {
    const winner         = getWinner(session);
    const effectiveMoney = getEffectiveMoney(session);
    const settlementHtml = Object.keys(effectiveMoney).length > 0 ? `
      <div class="settlement-card">
        <div class="settlement-title">💰 Settlement</div>
        ${session.players.filter(p => effectiveMoney[p.id] !== undefined).map(p => {
          const amt = effectiveMoney[p.id];
          return `
          <div class="settlement-row">
            <span class="settlement-name">${p.name}</span>
            <span class="settlement-amount ${amt >= 0 ? 'amt-positive' : 'amt-negative'}">
              ${amt >= 0 ? '+' : ''}₹${amt}
            </span>
          </div>`;
        }).join('')}
      </div>` : '';
    completedHtml = `
      <div class="card card-completed">
        <div class="completed-title">Game Over</div>
        <div class="winner-name">🏆 ${winner ? winner.name : '—'}</div>
        <div class="completed-date">${formatDate(session.date)}</div>
      </div>
      ${settlementHtml}`;
  }

  /* Rank list — shows OUT badge and Rejoin button for knocked-out players */
  const rejoined = Object.keys(session.adjustments || {});
  const rankHtml = `
    <div class="rank-list" style="margin-bottom:14px">
      ${ranked.map((p, i) => {
        const isOut      = knockedOut.includes(p.id);
        const hasRejoined = rejoined.includes(p.id);
        return `
          <div class="rank-item ${i === 0 && !isOut ? 'rank-first' : ''} ${isOut ? 'rank-out' : ''}">
            <span class="rank-pos">${i + 1}</span>
            <span class="rank-name">${p.name}</span>
            ${isOut       ? `<span class="badge badge-out">OUT</span>` : ''}
            ${hasRejoined ? `<span class="badge badge-rejoin">R</span>` : ''}
            <span class="rank-score">${p.total}</span>
            ${isActive && isOut
              ? `<button class="btn btn-sm btn-outline" style="margin-left:6px"
                         onclick="rejoinPlayer('${session.id}','${p.id}')">Rejoin</button>`
              : ''}
          </div>`;
      }).join('')}
    </div>`;

  /* Score table */
  const tableHtml = session.rounds.length > 0
    ? buildScoreTable(session, isActive)
    : `<div class="empty-state" style="padding:32px">
         <p>No rounds yet.<br>Tap <strong>+ Round</strong> to add the first!</p>
       </div>`;

  /* Action buttons */
  const actionsHtml = isActive ? `
    <div class="fab-container">
      <button class="fab" onclick="showAddRoundModal('${session.id}')">+ Round</button>
    </div>
    <div class="game-actions">
      <button class="btn btn-outline btn-danger"
              onclick="confirmEndGame('${session.id}')">End Game</button>
    </div>` : `
    <div class="game-actions">
      <button class="btn btn-outline"
              onclick="confirmDeleteSession('${session.id}')">Delete Game</button>
    </div>`;

  setContent(`
    <div>
      ${completedHtml}
      ${rankHtml}
      <div class="score-table-wrapper">${tableHtml}</div>
      ${actionsHtml}
    </div>
  `);
}

function buildScoreTable(session, isActive) {
  const totals     = getPlayerTotals(session);
  const knockedOut = session.knockedOut || [];
  const rejoined   = Object.keys(session.adjustments || {});

  const headerCells = session.rounds
    .map(r => `<th>R${r.number}${isActive
      ? `<button class="btn-round-edit" title="Edit round" onclick="showEditRoundModal('${session.id}','${r.id}')">✎</button>`
      : ''}</th>`)
    .join('');

  const bodyRows = session.players.map(player => {
    const isOut       = knockedOut.includes(player.id);
    const hasRejoined = rejoined.includes(player.id);

    const scoreCells = session.rounds.map(round => {
      const score = round.scores[player.id] ?? 0;
      if (isActive) {
        return `<td class="score-cell"
                    data-session="${session.id}"
                    data-round="${round.id}"
                    data-player="${player.id}"
                    onclick="startEditScore(this)">${score}</td>`;
      }
      return `<td class="score-cell">${score}</td>`;
    }).join('');

    const nameLabel = `${player.name}${hasRejoined ? ' <span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px">R</span>' : ''}`;

    return `
      <tr>
        <td class="player-col sticky">${nameLabel}</td>
        ${scoreCells}
        <td class="total-col ${isOut ? 'total-out' : ''}">${totals[player.id]}</td>
      </tr>`;
  }).join('');

  return `
    <table class="score-table">
      <thead>
        <tr>
          <th class="player-col sticky">Player</th>
          ${headerCells}
          <th class="total-col">Total</th>
        </tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

/* Edit an existing round's scores via modal */
function showEditRoundModal(sessionId, roundId) {
  const session = Store.getSession(sessionId);
  if (!session) return;
  const round      = session.rounds.find(r => r.id === roundId);
  const knockedOut = session.knockedOut || [];

  const inputs = session.players.map(p => {
    const isOut = knockedOut.includes(p.id);
    const score = round.scores[p.id] ?? '';
    if (isOut) {
      return `
        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px">
            ${p.name} <span class="badge badge-out">OUT</span>
          </label>
          <input type="number" class="input" value="—" disabled style="opacity:.4">
        </div>`;
    }
    const d = session.rules.dropScore      ?? 20;
    const m = session.rules.midDropScore   ?? 40;
    const f = session.rules.fullCountScore ?? 80;
    return `
      <div class="form-group">
        <label class="form-label">${p.name}</label>
        <div class="score-input-row">
          <input type="number" class="input round-score-input"
                 data-player="${p.id}" value="${score}"
                 placeholder="0" oninput="liveValidateRoundScore(this)">
          <div class="score-quick-btns">
            <button type="button" class="btn-quick" onclick="fillDropScore(this,${d})">D</button>
            <button type="button" class="btn-quick btn-quick-m" onclick="fillDropScore(this,${m})">M</button>
            <button type="button" class="btn-quick btn-quick-f" onclick="fillDropScore(this,${f})">F</button>
          </div>
        </div>
      </div>`;
  }).join('');

  showModal(`
    <div class="modal-header">
      <h2>Edit Round ${round.number}</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">${inputs}</div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditedRound('${sessionId}','${roundId}')">Save</button>
    </div>
  `);
}

function saveEditedRound(sessionId, roundId) {
  const inputs = document.querySelectorAll('.round-score-input');
  const scores = {};
  let valid = true;

  inputs.forEach(input => {
    const val = input.value.trim();
    if (val === '' || isNaN(parseInt(val))) {
      input.classList.add('input-error'); valid = false;
    } else {
      input.classList.remove('input-error');
      scores[input.dataset.player] = parseInt(val);
    }
  });
  if (!valid) { showToast('Enter a score for every player', 'error'); return; }

  const zeroCount = Object.values(scores).filter(s => s === 0).length;
  if (zeroCount === 0) { showToast('Exactly one player must score zero', 'error'); return; }
  if (zeroCount > 1)   { showToast('Only one player can score zero', 'error');     return; }

  Store.updateRound(sessionId, roundId, scores);
  hideModal();
  renderGame([sessionId]);
  showToast('Round updated!', 'success');
}

/* Inline score editing */
function startEditScore(cell) {
  if (cell.querySelector('input')) return; // already editing

  const original = cell.textContent.trim();
  const input    = document.createElement('input');
  input.type      = 'number';
  input.value     = original;
  input.className = 'score-input';

  cell.textContent = '';
  cell.appendChild(input);
  input.focus();
  input.select();

  const save = () => {
    const val = parseInt(input.value);
    if (input.value.trim() === '' || isNaN(val)) {
      cell.textContent = original;
      return;
    }
    Store.updateScore(
      cell.dataset.session,
      cell.dataset.round,
      cell.dataset.player,
      val
    );
    renderGame([cell.dataset.session]);
    showToast('Score updated', 'success');
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { cell.textContent = original; }
  });
}

/* Fill a score input with a preset drop value and re-run live validation */
function fillDropScore(btn, value) {
  const input = btn.closest('.score-input-row').querySelector('.round-score-input');
  if (!input) return;
  input.value = value;
  liveValidateRoundScore(input);
}

/* Add Round modal */
function showAddRoundModal(sessionId) {
  const session = Store.getSession(sessionId);
  if (!session) return;

  const knockedOut = session.knockedOut || [];
  let firstActive = true;
  const inputs = session.players.map(p => {
    const isOut = knockedOut.includes(p.id);
    if (isOut) {
      return `
        <div class="form-group">
          <label class="form-label" style="display:flex;align-items:center;gap:8px">
            ${p.name} <span class="badge badge-out">OUT</span>
          </label>
          <input type="number" class="input" value="—" disabled
                 style="opacity:.4;cursor:not-allowed">
        </div>`;
    }
    const autofocus = firstActive ? 'autofocus' : '';
    firstActive = false;
    const d = session.rules.dropScore      ?? 20;
    const m = session.rules.midDropScore   ?? 40;
    const f = session.rules.fullCountScore ?? 80;
    return `
      <div class="form-group">
        <label class="form-label">${p.name}</label>
        <div class="score-input-row">
          <input type="number" class="input round-score-input"
                 data-player="${p.id}"
                 placeholder="0"
                 oninput="liveValidateRoundScore(this)"
                 ${autofocus}>
          <div class="score-quick-btns">
            <button type="button" class="btn-quick" title="Drop (${d})"
                    onclick="fillDropScore(this,${d})">D</button>
            <button type="button" class="btn-quick btn-quick-m" title="Mid Drop (${m})"
                    onclick="fillDropScore(this,${m})">M</button>
            <button type="button" class="btn-quick btn-quick-f" title="Full Count (${f})"
                    onclick="fillDropScore(this,${f})">F</button>
          </div>
        </div>
      </div>`;
  }).join('');

  showModal(`
    <div class="modal-header">
      <h2>Round ${session.rounds.length + 1} Scores</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <form id="round-form" onsubmit="submitRound(event, '${sessionId}')">
        ${inputs}
        <button type="submit" style="display:none">Submit</button>
      </form>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitRound(null, '${sessionId}')">Save Round</button>
    </div>
  `);
}

function liveValidateRoundScore(changedInput) {
  const inputs = Array.from(document.querySelectorAll('.round-score-input'));
  const val = parseInt(changedInput.value);

  // Clear error on current input first
  changedInput.classList.remove('input-error');

  if (!isNaN(val) && val === 0) {
    // Block if another player already has 0
    const otherHasZero = inputs.some(i => i !== changedInput && parseInt(i.value) === 0);
    if (otherHasZero) {
      changedInput.classList.add('input-error');
      showToast('Another player already has 0 this round', 'warning');
      return;
    }
  }

  // Auto-fill: if all filled inputs have non-zero scores and exactly one
  // input is still empty, that player must be the zero — fill it automatically
  const emptyOnes       = inputs.filter(i => i.value.trim() === '');
  const filledInputs    = inputs.filter(i => i.value.trim() !== '');
  const noZeroYet       = !filledInputs.some(i => parseInt(i.value) === 0);
  const allFilledNonZero = filledInputs.every(i => parseInt(i.value) > 0);

  if (noZeroYet && emptyOnes.length === 1 && allFilledNonZero) {
    emptyOnes[0].value = '0';
    emptyOnes[0].classList.remove('input-error');
  }
}

function submitRound(e, sessionId) {
  if (e) e.preventDefault();
  const inputs = document.querySelectorAll('.round-score-input');
  const scores = {};
  let valid = true;

  inputs.forEach(input => {
    const val = input.value.trim();
    if (val === '' || isNaN(parseInt(val))) {
      input.classList.add('input-error');
      valid = false;
    } else {
      input.classList.remove('input-error');
      scores[input.dataset.player] = parseInt(val);
    }
  });

  if (!valid) {
    showToast('Enter a score for every player', 'error');
    return;
  }

  const zeroCount = Object.values(scores).filter(s => s === 0).length;
  if (zeroCount === 0) {
    inputs.forEach(input => input.classList.add('input-error'));
    showToast('Exactly one player must score zero per round', 'error');
    return;
  }
  if (zeroCount > 1) {
    inputs.forEach(input => {
      if (parseInt(input.value) === 0) input.classList.add('input-error');
    });
    showToast('Only one player can score zero per round', 'error');
    return;
  }

  const beforeKO = (Store.getSession(sessionId).knockedOut || []).slice();
  Store.addRound(sessionId, scores);
  const session = Store.getSession(sessionId);
  const newKO = (session.knockedOut || []).filter(id => !beforeKO.includes(id));
  hideModal();
  renderGame([sessionId]);
  if (newKO.length > 0) {
    const names = newKO.map(id => session.players.find(p => p.id === id)?.name).join(', ');
    showToast(`${names} reached the target and is OUT!`, 'warning');
  } else {
    showToast('Round saved!', 'success');
  }
}

function confirmEndGame(sessionId) {
  const session    = Store.getSession(sessionId);
  if (!session) return;
  const knockedOut = session.knockedOut || [];
  const totals     = getPlayerTotals(session);

  // Auto-calculate amounts: each loser pays their score + gameAmount base
  const ranked     = getRankedPlayers(session);
  const winner     = ranked[0];
  const defaults   = calcSettlement(session);

  const playerRows = session.players.map(p => {
    const isOut      = knockedOut.includes(p.id);
    const isWinner   = p.id === winner.id;
    const defaultAmt = defaults[p.id] !== undefined ? defaults[p.id] : '';
    return `
      <div class="money-row ${isOut ? 'money-row-out' : ''}">
        <div class="money-player-info">
          <span class="money-player-name">${p.name}</span>
          ${isOut ? `<span class="badge badge-out" style="font-size:11px">OUT</span>` : ''}
          ${isWinner ? `<span class="badge badge-winner" style="font-size:11px">🏆</span>` : ''}
          <span class="money-score">Score: ${totals[p.id]}</span>
        </div>
        <input type="number" class="input money-input" data-player="${p.id}"
               value="${defaultAmt}" placeholder="0">
      </div>`;
  }).join('');

  showModal(`
    <div class="modal-header">
      <h2>Game Settlement 💰</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <p class="money-hint">+ received &nbsp;·&nbsp; − paid</p>
      <div class="money-list">${playerRows}</div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-danger" onclick="endGame('${sessionId}')">End Game</button>
    </div>
  `);
}

function rejoinPlayer(sessionId, playerId) {
  const session = Store.getSession(sessionId);
  if (!session) return;
  const player     = session.players.find(p => p.id === playerId);
  const knockedOut = session.knockedOut || [];
  const totals     = getPlayerTotals(session);

  // Highest total among currently active players (excludes the rejoining player)
  const activeTotals = session.players
    .filter(p => !knockedOut.includes(p.id))
    .map(p => totals[p.id]);
  const highestActive = activeTotals.length > 0 ? Math.max(...activeTotals) : totals[playerId];
  const suggestedScore = highestActive + 1;

  showModal(`
    <div class="modal-header">
      <h2>${player?.name ?? 'Player'} Rejoins</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:14px">
        Current total: <strong>${totals[playerId]}</strong>.
        Set their new starting score (suggested: highest player + 1).
      </p>
      <div class="form-group">
        <label class="form-label">Starting Score</label>
        <input type="number" class="input" id="rejoin-score"
               value="${suggestedScore}" min="0">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary"
              onclick="confirmRejoin('${sessionId}','${playerId}',${totals[playerId]})">
        Confirm Rejoin
      </button>
    </div>
  `);
}

function confirmRejoin(sessionId, playerId, currentTotal) {
  const input = document.getElementById('rejoin-score');
  const newScore = parseInt(input?.value);
  if (isNaN(newScore) || newScore < 0) {
    input?.classList.add('input-error');
    showToast('Enter a valid score', 'error');
    return;
  }
  const adjustment = newScore - currentTotal;
  const session    = Store.getSession(sessionId);
  const player     = session?.players.find(p => p.id === playerId);
  Store.rejoinPlayer(sessionId, playerId, adjustment);
  hideModal();
  renderGame([sessionId]);
  showToast(`${player?.name ?? 'Player'} rejoined with score ${newScore}!`, 'success');
}

function endGame(sessionId) {
  const money = {};
  document.querySelectorAll('.money-input').forEach(input => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val !== 0) money[input.dataset.player] = val;
  });
  Store.completeSession(sessionId, money);
  hideModal();
  renderGame([sessionId]);
  showToast('Game completed!', 'success');
}

function confirmDeleteSession(sessionId) {
  showModal(`
    <div class="modal-header">
      <h2>Delete Game?</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-muted);font-size:15px">
        This will permanently delete this game and all its scores.
      </p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-danger" onclick="deleteSession('${sessionId}')">Delete</button>
    </div>
  `);
}

function deleteSession(sessionId) {
  Store.deleteSession(sessionId);
  hideModal();
  Router.navigate('/history');
  showToast('Game deleted', 'info');
}

function confirmClearHistory() {
  showModal(`
    <div class="modal-header">
      <h2>Clear All History?</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-muted);font-size:15px">
        This will permanently delete all completed games. Active games will not be affected.
      </p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-danger" onclick="clearHistory()">Clear All</button>
    </div>
  `);
}

function clearHistory() {
  Store.clearHistory();
  hideModal();
  renderHistory([]);
  showToast('History cleared', 'info');
}

/* ============================================================
   PAGE: HISTORY
   ============================================================ */

function renderHistory(params) {
  /* If an id is given, show that session's score detail */
  if (params[0]) {
    renderGame(params);
    return;
  }

  setTitle('History');
  showBack(true, '/');

  const sessions = Store.getSessions().filter(s => s.status === 'completed');

  if (sessions.length === 0) {
    setContent(`
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>No completed games yet.</p>
      </div>`);
    return;
  }

  /* Build per-player net money totals across all completed sessions */
  const playerNetMap = {}; // name → net amount (positive = received, negative = paid)
  sessions.forEach(s => {
    const money = getEffectiveMoney(s);
    s.players.forEach(p => {
      if (money[p.id] === undefined) return;
      playerNetMap[p.name] = (playerNetMap[p.name] || 0) + money[p.id];
    });
  });
  const summaryPlayers = Object.entries(playerNetMap)
    .sort((a, b) => b[1] - a[1]); // highest net first
  const summaryHtml = summaryPlayers.length > 0 ? `
    <div class="player-summary-card">
      <div class="section-title">Player Summary</div>
      ${summaryPlayers.map(([name, net]) => `
        <div class="summary-row">
          <span class="summary-name">${name}</span>
          <span class="summary-net ${net >= 0 ? 'net-positive' : 'net-negative'}">
            ${net >= 0 ? '+' : ''}₹${net}
          </span>
        </div>`).join('')}
    </div>` : '';

  setContent(`
    <div>
      ${summaryHtml}
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        <button class="btn btn-outline btn-sm btn-danger"
                onclick="confirmClearHistory()">Clear History</button>
      </div>
      ${sessions.map(s => {
        const winner = getWinner(s);
        const totals = getPlayerTotals(s);
        const money  = getEffectiveMoney(s);
        return `
          <div class="card card-history"
               onclick="Router.navigate('/history/${s.id}')">
            <div class="card-row">
              <span class="card-date">${formatDate(s.date)}</span>
              ${winner ? `<span class="badge badge-winner">🏆 ${winner.name}</span>` : ''}
            </div>
            <div class="card-meta">
              ${s.rounds.length} rounds &middot; Target: ${s.rules.targetScore}
            </div>
            <div class="player-scores">
              ${s.players.map(p => {
                const amt = money[p.id];
                const amtStr = amt !== undefined
                  ? ` · <span style="color:${amt >= 0 ? 'var(--success)' : 'var(--danger)'}">
                        ${amt >= 0 ? '+' : ''}₹${amt}</span>`
                  : '';
                return `<span class="player-score-chip ${winner && winner.id === p.id ? 'chip-winner' : ''}">
                  ${p.name}: ${totals[p.id]}${amtStr}
                </span>`;
              }).join('')}
            </div>
          </div>`;
      }).join('')}
    </div>
  `);
}

/* ============================================================
   INIT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  /* Back button */
  document.getElementById('btn-back').addEventListener('click', () => {
    const btn = document.getElementById('btn-back');
    Router.navigate(btn._href || '/');
  });

  /* History shortcut in header */
  document.getElementById('btn-history').addEventListener('click', () => {
    Router.navigate('/history');
  });

  /* Close modal when clicking the overlay backdrop */
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) hideModal();
  });

  /* Close modal on Escape key */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideModal();
  });

  /* Routes */
  Router.on('/',        ()       => renderHome());
  Router.on('/setup',   ()       => renderSetup());
  Router.on('/game',    params   => renderGame(params));
  Router.on('/history', params   => renderHistory(params));

  /* Init Firebase then pull cloud data before rendering */
  CloudSync.init();
  CloudSync.pull()
    .then(synced => {
      if (synced) showToast('☁ Data synced', 'success');
    })
    .catch(() => {})
    .finally(() => Router.init());
});
