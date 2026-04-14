'use strict';

/* ============================================================
   HAPTIC FEEDBACK  — light vibration on Android Chrome
   ============================================================ */
function haptic(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern ?? 10);
}

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

const RECAPTCHA_SITE_KEY = '6Lf6RIwsAAAAAPJBnXkgQJG-6TpsVjT1f47n1tCT';

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

/* ============================================================
   AUTH  — Firebase Authentication (cross-device login)
   Same email + password works on any device. Session is
   managed by Firebase automatically.
   ============================================================ */

const Auth = {
  _user: null,

  _fbAuth() {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
    if (!firebase.apps[0]._appCheckInitialized) {
      firebase.appCheck(app).activate(
        new firebase.appCheck.ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
        true
      );
      firebase.apps[0]._appCheckInitialized = true;
    }
    return firebase.auth(app);
  },

  // Resolves with user object if already signed in, else null
  init() {
    return new Promise(resolve => {
      this._fbAuth().onAuthStateChanged(user => {
        this._user = user || null;
        resolve(user ? { email: user.email, uid: user.uid } : null);
      });
    });
  },

  signIn(email, password) {
    return this._fbAuth()
      .signInWithEmailAndPassword(email.trim(), password)
      .then(cred => {
        this._user = cred.user;
        return { email: cred.user.email, uid: cred.user.uid };
      });
  },

  register(email, password) {
    return this._fbAuth()
      .createUserWithEmailAndPassword(email.trim(), password)
      .then(cred => {
        this._user = cred.user;
        return { email: cred.user.email, uid: cred.user.uid };
      });
  },

  signOut() {
    return this._fbAuth().signOut().then(() => { this._user = null; });
  },

  get uid()   { return this._user ? this._user.uid : null; },
  get email() { return this._user ? this._user.email : null; },
};

const CloudSync = {
  _ready: false,
  _docRef: null,
  _pushing: false,
  _pulled: false,   // block push until pull has completed at least once
  _lastPush: 0,     // timestamp of last push, used to debounce own-write snapshots
  _listener: null,  // Firestore onSnapshot unsubscribe handle

  init() {
    const configured = FIREBASE_CONFIG.apiKey &&
                       FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';
    if (!configured) { this._pulled = true; return; } // no cloud — allow push freely
    try {
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      // Scope Firestore doc per user so data is isolated between logins
      const uid = Auth.uid || 'shared';
      this._docRef = firebase.firestore(app).collection('rummy').doc(uid);
      this._ready  = true;
    } catch (err) {
      console.error('[CloudSync] init failed:', err);
    }
  },

  /** Pull cloud data and overwrite localStorage. Returns true if new data was found. */
  async pull() {
    if (!this._ready) { this._pulled = true; return false; }
    try {
      const snap = await this._docRef.get();
      if (snap.exists) {
        const data = snap.data();
        if (data && Array.isArray(data.sessions)) {
          localStorage.setItem(getStoreKey(), JSON.stringify(data));
          Store._cache = null; // invalidate cache
          this._pulled = true;
          return true;
        }
      }
    } catch (err) {
      console.error('[CloudSync] pull failed:', err);
    }
    this._pulled = true; // allow push even if pull failed
    return false;
  },

  /** Push current localStorage data to Firestore (fire-and-forget). */
  push() {
    if (!this._ready || this._pushing || !this._pulled) return;
    this._pushing = true;
    this._lastPush = Date.now();
    Store._load();
    this._docRef.set(Store._cache)
      .catch(err => console.error('[CloudSync] push failed:', err))
      .finally(() => { this._pushing = false; });
  },

  /** Start real-time listener so remote changes auto-update this device. */
  listen() {
    if (!this._ready || this._listener) return;
    this._listener = this._docRef.onSnapshot(snap => {
      // Skip snapshots triggered by our own recent push (within 4 seconds)
      if (Date.now() - this._lastPush < 4000) return;
      if (!snap.exists) return;
      const data = snap.data();
      if (!data || !Array.isArray(data.sessions)) return;
      localStorage.setItem(getStoreKey(), JSON.stringify(data));
      Store._cache = null;
      // Re-render game screen if user is currently viewing one
      const match = window.location.hash.match(/^#\/game\/(.+)$/);
      if (match) {
        renderGame([match[1]]);
      }
    }, err => {
      console.error('[CloudSync] listen failed:', err);
    });
  },

  /** Stop real-time listener (e.g. on sign-out). */
  stopListening() {
    if (this._listener) {
      this._listener();
      this._listener = null;
    }
  }
};

/* ============================================================
   INACTIVITY TIMER — auto-logout after 1 hour of no interaction
   ============================================================ */

const InactivityTimer = {
  _timer: null,
  _LIMIT: 60 * 60 * 1000, // 1 hour

  _activity() {
    sessionStorage.setItem('lastActivity', Date.now());
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._logout(), this._LIMIT);
  },

  _logout() {
    if (!Auth.uid) return;
    handleSignOut();
    showToast('Logged out due to inactivity.', 'warning');
  },

  start() {
    // Reset timer on any user interaction
    ['click', 'touchstart', 'keydown', 'scroll'].forEach(ev =>
      document.addEventListener(ev, () => this._activity(), { passive: true })
    );
    // When returning from background, check if 1 hour has already passed
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !Auth.uid) return;
      const last = parseInt(sessionStorage.getItem('lastActivity') || '0', 10);
      if (last && Date.now() - last > this._LIMIT) {
        this._logout();
      } else {
        this._activity();
      }
    });
    this._activity();
  },

  stop() {
    clearTimeout(this._timer);
    sessionStorage.removeItem('lastActivity');
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

// Scoped per user — returns a unique key for each login
function getStoreKey() {
  return Auth.uid ? `rummy_v1_${Auth.uid}` : 'rummy_v1';
}

const Store = {
  _cache: null,

  _load() {
    if (this._cache) return;
    try {
      this._cache = JSON.parse(localStorage.getItem(getStoreKey())) || { sessions: [] };
    } catch {
      this._cache = { sessions: [] };
    }
  },

  _persist() {
    localStorage.setItem(getStoreKey(), JSON.stringify(this._cache));
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

  getPlayers() {
    this._load();
    return (this._cache.players || []).slice();
  },

  savePlayer(name) {
    this._load();
    this._cache.players = this._cache.players || [];
    this._cache.players.push({ id: uuid(), name: name.trim() });
    this._persist();
  },

  deletePlayer(id) {
    this._load();
    this._cache.players = (this._cache.players || []).filter(p => p.id !== id);
    this._persist();
  },

  getRules() {
    this._load();
    return this._cache.rules || {
      targetScore: 201, gameAmount: 300,
      dropScore: 20, midDropScore: 40, fullCountScore: 80
    };
  },

  saveRules(rules) {
    this._load();
    this._cache.rules = { ...rules };
    this._persist();
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
      knockedOut: [],     // player IDs who have reached the target
      knockedOutRound: {}, // playerId → round index when knocked out
      adjustments: {},    // playerId → score offset applied on rejoin
      quitPlayers: []     // player IDs who voluntarily quit
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
      session.knockedOutRound = session.knockedOutRound || {};
      session.players.forEach(p => {
        if (!ko.includes(p.id) && totals[p.id] >= session.rules.targetScore) {
          ko.push(p.id);
          session.knockedOutRound[p.id] = session.rounds.length;
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
    session.knockedOut  = (session.knockedOut  || []).filter(id => id !== playerId);
    session.quitPlayers = (session.quitPlayers || []).filter(id => id !== playerId);
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
    this._recomputeKnockedOut(session);
    this.saveSession(session);
  },

  updateRound(sessionId, roundId, scores) {
    const session = this.getSession(sessionId);
    if (!session) return;
    const round = session.rounds.find(r => r.id === roundId);
    if (!round) return;
    round.scores = { ...scores };
    this._recomputeKnockedOut(session);
    this.saveSession(session);
  },

  _recomputeKnockedOut(session) {
    if (!session.rules.targetScore) return;
    const totals      = getPlayerTotals(session);
    const koRound     = session.knockedOutRound || {};
    const quitPlayers = session.quitPlayers || [];
    session.knockedOut = (session.knockedOut || []).filter(pid => {
      // Never restore a player who voluntarily quit
      if (quitPlayers.includes(pid)) return true;
      if (totals[pid] < session.rules.targetScore) {
        delete koRound[pid];
        return false;
      }
      return true;
    });
    session.knockedOutRound = koRound;
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
 * Calculate settlement amounts: flat gameAmount.
 * Players with total score < targetScore receive: +gameAmount (positive)
 * Players with total score >= targetScore pay: -gameAmount (negative)
 */
function calcSettlement(session) {
  const totals  = getPlayerTotals(session);
  const gameAmt = (session.rules && session.rules.gameAmount) || 0;
  const target  = (session.rules && session.rules.targetScore) || 201;
  const money   = {};
  session.players.forEach(p => {
    money[p.id] = totals[p.id] < target ? gameAmt : -gameAmt;
  });
  return money;
}

function getWinner(session) {
  if (!session || session.rounds.length === 0) return null;
  return getRankedPlayers(session)[0];
}

function getCurrentDealer(session) {
  const firstDealer = session.rules?.firstDealer;
  if (!firstDealer) return null;
  const players    = session.players;
  const knockedOut = session.knockedOut || [];

  // ── Primary path: use explicitly stored dealer (set after every round submit / rejoin / join)
  if (session.nextDealerId) {
    const stored = players.find(p => p.id === session.nextDealerId);
    if (stored && !knockedOut.includes(stored.id)) return stored;
    // Stored dealer was knocked out this round — advance to next active player
    if (stored) {
      const idx = players.findIndex(p => p.id === stored.id);
      for (let i = 1; i <= players.length; i++) {
        const next = players[(idx + i) % players.length];
        if (!knockedOut.includes(next.id)) return next;
      }
      return null;
    }
  }

  // ── Fallback: simulate from firstDealer (used for old sessions / before first round)
  const knockedOutRound = session.knockedOutRound || {};
  const joinedRound     = session.joinedRound     || {};
  const rejoinedRound   = session.rejoinedRound   || {};
  const startIdx = players.findIndex(p => p.name === firstDealer);
  if (startIdx === -1) return null;

  function eligibleForRound(p, k) {
    const joinR = joinedRound[p.id] ?? 0;
    if (joinR >= k) return false;
    const rejoinR = rejoinedRound[p.id];
    if (rejoinR !== undefined && rejoinR < k) return true;
    const koR = knockedOutRound[p.id];
    if (koR !== undefined && koR < k) return false;
    if (koR === undefined && knockedOut.includes(p.id)) return false;
    return true;
  }

  let dealerIdx = startIdx;
  for (let k = 1; k <= session.rounds.length; k++) {
    for (let i = 1; i <= players.length; i++) {
      const nextIdx = (dealerIdx + i) % players.length;
      if (eligibleForRound(players[nextIdx], k + 1)) { dealerIdx = nextIdx; break; }
    }
  }
  if (knockedOut.includes(players[dealerIdx].id)) {
    for (let i = 1; i <= players.length; i++) {
      const next = (dealerIdx + i) % players.length;
      if (!knockedOut.includes(players[next].id)) return players[next];
    }
    return null;
  }
  return players[dealerIdx];
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
  document.body.classList.remove('game-active');
  const pc = document.getElementById('page-content');
  pc.classList.remove('game-mode');
  pc.innerHTML = html;
}

function setTitle(title) {
  document.getElementById('page-title').innerHTML = title;
}

function showBack(show, href) {
  const btn = document.getElementById('btn-back');
  btn.hidden = !show;
  btn._href = href || '/';
}

function showModal(html, alignTop = false) {
  document.getElementById('modal').innerHTML = html;
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('hidden');
  overlay.style.alignItems = alignTop ? 'flex-start' : '';
  overlay.style.paddingTop = alignTop ? '16px' : '';
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
  if (type === 'error')   haptic([30, 20, 30]);
  else if (type === 'success') haptic(15);
  else if (type === 'warning') haptic([10, 10, 10]);

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

/* ============================================================
   PAGE: SIGN IN / REGISTER
   ============================================================ */
function renderSignIn() {
  document.getElementById('btn-history').hidden = true;
  setTitle('<span style="color:#111">♠</span><span style="color:#dc2626">♥</span> Rummy Score Board <span style="color:#dc2626">♦</span><span style="color:#111">♣</span>');
  showBack(false);
  setContent(`
    <div style="max-width:360px;margin:40px auto 0">
      <div class="form-section">
        <h2 class="section-title" style="text-align:center;margin-bottom:16px">Sign In</h2>
        <div class="form-group">
          <label class="form-label">Username</label>
          <input type="text" class="input" id="auth-email" placeholder="e.g. ravi" autocomplete="username" autocorrect="off" autocapitalize="none">
        </div>
        <div class="form-group">
          <label class="form-label">Password</label>
          <input type="password" class="input" id="auth-password" placeholder="Password" autocomplete="current-password">
        </div>
        <div id="auth-error" style="color:var(--danger);font-size:13px;margin-bottom:8px;display:none"></div>
        <button class="btn btn-primary btn-block" onclick="handleSignIn()" style="margin-bottom:10px">Sign In</button>
        <button class="btn btn-outline btn-block" onclick="showRegisterModal()" style="margin-bottom:10px">Create Account</button>
        <div style="text-align:center">
          <button onclick="showForgotPasswordModal()"
                  style="background:none;border:none;color:var(--primary);font-size:14px;cursor:pointer;padding:4px">
            Forgot Password?
          </button>
        </div>
      </div>
    </div>
  `);
}

function showRegisterModal() {
  showModal(`
    <div class="modal-header">
      <h2>Create Account</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Username</label>
        <input type="text" class="input" id="reg-username" placeholder="e.g. ravi" autocorrect="off" autocapitalize="none"
          oninput="const d=document.getElementById('reg-displayname');if(!d._edited)d.value=this.value">
      </div>
      <div class="form-group">
        <label class="form-label">Display Name <span style="font-weight:normal;color:var(--text-muted)">(shown to others)</span></label>
        <input type="text" class="input" id="reg-displayname" placeholder="e.g. Ravi Kumar" autocomplete="name"
          oninput="this._edited=true">
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input type="password" class="input" id="reg-password" placeholder="Min 6 characters">
      </div>
      <div class="form-group">
        <label class="form-label">
          Recovery Email
          <span style="font-weight:normal;color:var(--text-muted)"> (optional — for password reset)</span>
        </label>
        <input type="email" class="input" id="reg-recovery" placeholder="your@email.com" autocomplete="email">
      </div>
      <div id="reg-error" style="color:var(--danger);font-size:13px;margin-top:8px;display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="handleRegister()">Create Account</button>
    </div>
  `);
}

function showForgotPasswordModal() {
  showModal(`
    <div class="modal-header">
      <h2>Forgot Password</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-muted);font-size:14px;margin-bottom:14px">
        Enter your username. A reset link will be sent to your recovery email.
      </p>
      <div class="form-group">
        <label class="form-label">Username</label>
        <input type="text" class="input" id="forgot-username" placeholder="e.g. ravi" autocorrect="off" autocapitalize="none">
      </div>
      <div id="forgot-error" style="color:var(--danger);font-size:13px;margin-top:8px;display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" onclick="handleForgotPassword()">Send Reset Link</button>
    </div>
  `);
}

async function handleForgotPassword() {
  const username = document.getElementById('forgot-username').value.trim().toLowerCase();
  const errEl    = document.getElementById('forgot-error');
  errEl.style.display = 'none';
  if (!username) { errEl.textContent = 'Enter your username.'; errEl.style.display = 'block'; return; }

  try {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
    const doc = await firebase.firestore(app).collection('recovery').doc(username).get();
    if (!doc.exists || !doc.data().recoveryEmail) {
      errEl.textContent = 'No recovery email found for this username. Contact the group admin.';
      errEl.style.display = 'block';
      return;
    }
    await firebase.auth(app).sendPasswordResetEmail(doc.data().recoveryEmail);
    hideModal();
    showToast('Reset link sent! Check your email.', 'success');
  } catch {
    errEl.textContent = 'Failed to send reset link. Try again.';
    errEl.style.display = 'block';
  }
}

function toFirebaseEmail(username) {
  return username.toLowerCase().replace(/[^a-z0-9._-]/g, '') + '@rummy.app';
}

function displayUsername(email) {
  return email ? email.replace('@rummy.app', '') : '';
}

function handleSignIn() {
  const username = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl    = document.getElementById('auth-error');
  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Enter username and password.'; errEl.style.display = 'block'; return; }
  Auth.signIn(toFirebaseEmail(username), password)
    .then(() => {
      document.getElementById('btn-history').hidden = false;
      CloudSync.init();
      CloudSync.pull().finally(() => { CloudSync.listen(); InactivityTimer.start(); updateUserBar(); Router.init(); });
    })
    .catch(e => {
      errEl.textContent = friendlyAuthError(e.code);
      errEl.style.display = 'block';
    });
}

function handleRegister() {
  const username      = document.getElementById('reg-username').value.trim();
  const displayName   = document.getElementById('reg-displayname').value.trim() || username;
  const password      = document.getElementById('reg-password').value;
  const recoveryEmail = document.getElementById('reg-recovery').value.trim();
  const errEl         = document.getElementById('reg-error');
  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Enter username and password.'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
  Auth.register(toFirebaseEmail(username), password)
    .then(() => {
      const app  = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      const user = firebase.auth(app).currentUser;
      const saves = [user.updateProfile({ displayName })];
      const firestoreData = { displayName, recoveryEmail: recoveryEmail || '' };
      saves.push(firebase.firestore(app).collection('recovery').doc(username.toLowerCase()).set(firestoreData));
      return Promise.all(saves);
    })
    .then(() => {
      hideModal();
      document.getElementById('btn-history').hidden = false;
      CloudSync.init();
      CloudSync.pull().finally(() => { CloudSync.listen(); InactivityTimer.start(); updateUserBar(); Router.init(); });
    })
    .catch(e => {
      errEl.textContent = friendlyAuthError(e.code);
      errEl.style.display = 'block';
    });
}

function updateUserBar() {
  const bar = document.getElementById('user-bar');
  const nameEl = document.getElementById('user-bar-name');
  if (!bar || !nameEl) return;
  if (Auth.email) {
    const name = Auth._user && Auth._user.displayName ? Auth._user.displayName : displayUsername(Auth.email);
    nameEl.textContent = `Signed in as ${name}`;
    bar.hidden = false;
  } else {
    bar.hidden = true;
  }
}

function handleSignOut() {
  const storeKey = getStoreKey();
  InactivityTimer.stop();
  Auth.signOut().then(() => {
    CloudSync.stopListening();
    CloudSync._ready  = false;
    CloudSync._pulled = false;
    CloudSync._docRef = null;
    Store._cache      = null;
    localStorage.removeItem(storeKey);
    updateUserBar();
    renderSignIn();
  });
}

async function showProfileModal() {
  const username    = displayUsername(Auth.email || '');
  const currentName = (Auth._user && Auth._user.displayName) || username;

  // Fetch current recovery email and display name from Firestore
  let currentEmail = '';
  try {
    const app = firebase.apps[0];
    const doc = await firebase.firestore(app).collection('recovery').doc(username).get();
    const stored = doc.exists ? (doc.data().recoveryEmail || '') : '';
    // Only show if it looks like a valid email
    currentEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stored) ? stored : '';
  } catch (e) { /* ignore */ }

  showModal(`
    <div class="modal-header">
      <h2>Profile</h2>
      <button class="btn-icon" style="color:var(--text-muted)" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body" style="padding:12px 16px">
      <div style="margin-bottom:14px">
        <div class="form-label">Username</div>
        <div style="padding:8px 10px;background:var(--bg);border-radius:8px;font-size:15px;font-weight:600;color:var(--text)">${username}</div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:14px;margin-bottom:14px">
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input id="profile-displayname" type="text" class="input" placeholder="Your name" value="${currentName}" autocomplete="name">
        </div>
        <div id="profile-name-error" style="color:var(--danger);font-size:13px;margin-bottom:4px;display:none"></div>
        <button class="btn btn-primary btn-block" onclick="handleUpdateDisplayName()">Update Display Name</button>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:14px;margin-bottom:14px">
        <div class="form-group">
          <label class="form-label">Recovery Email</label>
          <input id="profile-email" type="email" class="input" placeholder="Enter email address" value="${currentEmail}" autocomplete="off">
        </div>
        <div id="profile-email-error" style="color:var(--danger);font-size:13px;margin-bottom:4px;display:none"></div>
        <button class="btn btn-primary btn-block" onclick="handleUpdateEmail()">Update Email</button>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:14px">
        <div class="form-label" style="margin-bottom:10px">Change Password</div>
        <div class="form-group">
          <label class="form-label">Current Password</label>
          <input id="profile-current-pw" type="password" class="input" placeholder="Enter current password">
        </div>
        <div class="form-group">
          <label class="form-label">New Password</label>
          <input id="profile-new-pw" type="password" class="input" placeholder="Min 6 characters">
        </div>
        <div id="profile-error" style="color:var(--danger);font-size:13px;margin-bottom:8px;display:none"></div>
        <button class="btn btn-primary btn-block" onclick="handleChangePassword()">Update Password</button>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Close</button>
    </div>
  `);
}

async function handleUpdateDisplayName() {
  const username    = displayUsername(Auth.email || '');
  const displayName = document.getElementById('profile-displayname').value.trim();
  const errEl       = document.getElementById('profile-name-error');
  errEl.style.display = 'none';

  if (!displayName) { errEl.textContent = 'Enter a display name.'; errEl.style.display = 'block'; return; }

  try {
    const app  = firebase.apps[0];
    const user = firebase.auth(app).currentUser;
    await user.updateProfile({ displayName });
    // Also save to Firestore so it persists
    await firebase.firestore(app).collection('recovery').doc(username).set({ displayName }, { merge: true });
    Auth._user = firebase.auth(app).currentUser;
    updateUserBar();
    showToast('Display name updated!', 'success');
  } catch (err) {
    errEl.textContent = 'Failed to update display name. Try again.';
    errEl.style.display = 'block';
  }
}

async function handleUpdateEmail() {
  const username = displayUsername(Auth.email || '');
  const email    = document.getElementById('profile-email').value.trim();
  const errEl    = document.getElementById('profile-email-error');
  errEl.style.display = 'none';

  if (!email) { errEl.textContent = 'Enter an email address.'; errEl.style.display = 'block'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Enter a valid email address.'; errEl.style.display = 'block'; return; }

  try {
    const app = firebase.apps[0];
    await firebase.firestore(app).collection('recovery').doc(username).set({ recoveryEmail: email }, { merge: true });
    showToast('Email updated successfully!', 'success');
  } catch (err) {
    errEl.textContent = 'Failed to update email. Try again.';
    errEl.style.display = 'block';
  }
}

async function handleChangePassword() {
  const currentPw = document.getElementById('profile-current-pw').value.trim();
  const newPw     = document.getElementById('profile-new-pw').value.trim();
  const errEl     = document.getElementById('profile-error');
  errEl.style.display = 'none';

  if (!currentPw) { errEl.textContent = 'Enter your current password.'; errEl.style.display = 'block'; return; }
  if (!newPw)     { errEl.textContent = 'Enter a new password.'; errEl.style.display = 'block'; return; }
  if (newPw.length < 6) { errEl.textContent = 'New password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
  if (currentPw === newPw) { errEl.textContent = 'New password must be different from current.'; errEl.style.display = 'block'; return; }

  try {
    const app  = firebase.apps[0];
    const user = firebase.auth(app).currentUser;
    const cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPw);
    await user.reauthenticateWithCredential(cred);
    await user.updatePassword(newPw);
    hideModal();
    showToast('Password updated successfully!', 'success');
  } catch (err) {
    errEl.textContent = err.code === 'auth/wrong-password' ? 'Current password is incorrect.' : 'Failed to update password. Try again.';
    errEl.style.display = 'block';
  }
}

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':        'No account found with this username.',
    'auth/wrong-password':        'Incorrect password.',
    'auth/invalid-email':         'Invalid username.',
    'auth/email-already-in-use':  'An account with this username already exists.',
    'auth/weak-password':         'Password must be at least 6 characters.',
    'auth/invalid-credential':         'Incorrect username or password.',
    'auth/invalid-login-credentials':  'Incorrect username or password.',
    'auth/too-many-requests':          'Too many failed attempts. Please try again later.',
    'auth/operation-not-allowed':      'Sign-in is not enabled. Contact the app admin.',
    'auth/network-request-failed':     'Network error. Check your internet connection.',
    'auth/configuration-not-found':    'Sign-in is not configured. Contact the app admin.',
  };
  return map[code] || 'Incorrect username or password. Please try again.';
}

function renderHome() {
  setTitle('<span style="color:#111">♠</span><span style="color:#dc2626">♥</span> Rummy Score Board <span style="color:#dc2626">♦</span><span style="color:#111">♣</span>');
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
        <div style="text-align:center;margin-bottom:4px"><span class="card-tag">Active Game</span></div>
        <div class="card-title" style="text-align:center;font-size:20px;font-weight:900">${formatDateShort(active.date)}</div>
        <div class="card-meta" style="text-align:center">
          ${active.players.map(p => p.name).join(', ')}
          &middot; ${active.rounds.length} round${active.rounds.length !== 1 ? 's' : ''}
        </div>
        ${leader && active.rounds.length > 0
          ? `<div class="card-leader" style="text-align:center">Leading: ${leader.name} (${leader.total})</div>`
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
      <button class="btn btn-primary btn-block" style="margin-bottom:6px" onclick="Router.navigate('/setup')">+ New Game</button>
      <div style="display:flex;gap:8px;margin-bottom:0">
        <button class="btn btn-outline" style="flex:1;background:#e0f0ff;border-color:#b0d4f1" onclick="Router.navigate('/players')">👥 Register Players</button>
        <button class="btn btn-outline" style="flex:1;background:#e0f0ff;border-color:#b0d4f1" onclick="Router.navigate('/rules')">Rules</button>
      </div>
      <div style="margin-top:10px;text-align:center;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px">
        <p style="font-size:12px;color:#92400e;margin:0 0 6px">Enjoying the app? Support the developer!</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <div style="text-align:center">
            <button onclick="buyMeChai()" style="background:#f59e0b;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">☕ Buy me a Chai</button>
            <div style="font-size:10px;color:#92400e;margin-top:3px">India (UPI)</div>
          </div>
          <div style="text-align:center">
            <button onclick="openKofi()" style="background:#29abe0;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">☕ Buy me a Coffee</button>
            <div style="font-size:10px;color:#92400e;margin-top:3px">International</div>
          </div>
        </div>
      </div>
      <!-- AdSense Banner -->
      <div style="margin:12px 0;text-align:center;min-height:60px">
        <ins class="adsbygoogle"
             style="display:block"
             data-ad-client="ca-pub-9537276736960487"
             data-ad-slot="auto"
             data-ad-format="auto"
             data-full-width-responsive="true"></ins>
        <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
      </div>
      ${historyHtml}
      ${emptyHtml}
    </div>
  `);
}

function renderRules() {
  setTitle('Rules');
  showBack(true, '/');

  const r = Store.getRules();
  const inputStyle = 'style="padding:6px 8px;font-size:14px;width:100%"';

  setContent(`
    <div class="form-section">
      <div style="display:flex;gap:12px;margin-bottom:10px">
        <div style="flex:1">
          <label class="drop-score-label">Target Score</label>
          <input type="number" class="input" id="rule-target" value="${r.targetScore}" min="1" max="9999" ${inputStyle}>
        </div>
        <div style="flex:1">
          <label class="drop-score-label">Reward Points</label>
          <input type="number" class="input" id="rule-amount" value="${r.gameAmount}" min="0" ${inputStyle}>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Drop Scores</label>
        <div class="drop-scores-grid">
          <div class="drop-score-item">
            <label class="drop-score-label">D — Drop</label>
            <input type="number" class="input" id="rule-drop" value="${r.dropScore}" min="0" ${inputStyle}>
          </div>
          <div class="drop-score-item">
            <label class="drop-score-label">M — Mid Drop</label>
            <input type="number" class="input" id="rule-mid" value="${r.midDropScore}" min="0" ${inputStyle}>
          </div>
          <div class="drop-score-item">
            <label class="drop-score-label">F — Full Count</label>
            <input type="number" class="input" id="rule-full" value="${r.fullCountScore}" min="0" ${inputStyle}>
          </div>
        </div>
      </div>
      <button class="btn btn-primary btn-block" onclick="saveRulesFromHome()">Save Rules</button>
    </div>
  `);
}

function saveRulesFromHome() {
  Store.saveRules({
    targetScore:    parseInt(document.getElementById('rule-target').value) || 201,
    gameAmount:     parseInt(document.getElementById('rule-amount').value) || 0,
    dropScore:      parseInt(document.getElementById('rule-drop').value)   || 20,
    midDropScore:   parseInt(document.getElementById('rule-mid').value)    || 40,
    fullCountScore: parseInt(document.getElementById('rule-full').value)   || 80,
  });
  showToast('Rules saved!', 'success');
  Router.navigate('/');
}

/* ============================================================
   PAGE: PLAYERS MANAGEMENT
   ============================================================ */

function renderPlayers() {
  setTitle('Players');
  showBack(true, '/');
  document.getElementById('btn-history').hidden = false;

  const players = Store.getPlayers();

  const listHtml = players.length === 0
    ? `<div class="empty-state" style="padding:24px 0">
         <p style="color:var(--text-muted)">No players yet. Add your first player below.</p>
       </div>`
    : players.map(p => `
        <div class="player-row" style="justify-content:space-between">
          <span style="font-size:15px;font-weight:500">${p.name}</span>
          <button class="btn-icon btn-remove" onclick="confirmDeletePlayer('${p.id}','${p.name}')" title="Remove">✕</button>
        </div>`).join('');

  setContent(`
    <div>
      <div class="form-section">
        <h2 class="section-title">Registered Players</h2>
        <div id="players-list">${listHtml}</div>
      </div>
      <div class="form-section">
        <h2 class="section-title">Add Player</h2>
        <div style="display:flex;gap:8px">
          <input type="text" class="input" id="new-player-name"
                 placeholder="Player name" maxlength="20"
                 autocorrect="off"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();addRegisteredPlayer();}">
          <button class="btn btn-primary" onclick="addRegisteredPlayer()" style="white-space:nowrap">+ Add</button>
        </div>
        <div id="add-player-error" style="color:var(--danger);font-size:13px;margin-top:6px;display:none"></div>
      </div>
    </div>
  `);
  setTimeout(() => document.getElementById('new-player-name')?.focus(), 100);

}

function addRegisteredPlayer() {
  const input  = document.getElementById('new-player-name');
  const errEl  = document.getElementById('add-player-error');
  const name   = input.value.trim();
  errEl.style.display = 'none';

  if (!name) { errEl.textContent = 'Enter a player name.'; errEl.style.display = 'block'; return; }

  const existing = Store.getPlayers();
  if (existing.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    errEl.textContent = 'A player with this name already exists.';
    errEl.style.display = 'block';
    return;
  }

  Store.savePlayer(name);
  input.value = '';
  showToast(`${name} added!`, 'success');
  renderPlayers();
  setTimeout(() => document.getElementById('new-player-name')?.focus(), 50);
}

function confirmDeletePlayer(id, name) {
  showModal(`
    <div class="modal-header">
      <h2>Remove Player?</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-muted);font-size:15px">
        Remove <strong>${name}</strong> from the player list?
      </p>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="hideModal()">Cancel</button>
      <button class="btn btn-danger" onclick="deleteRegisteredPlayer('${id}')">Remove</button>
    </div>
  `);
}

function deleteRegisteredPlayer(id) {
  Store.deletePlayer(id);
  hideModal();
  showToast('Player removed', 'info');
  renderPlayers();
}

/* ============================================================
   PAGE: SETUP
   ============================================================ */

/* _setupSelected tracks players chosen for the new game in selection order */
let _setupSelected = [];

function renderSetup() {
  setTitle('New Game');
  showBack(true, '/');

  const allPlayers = Store.getPlayers();
  if (allPlayers.length < 2) {
    setContent(`
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <p>You need at least 2 registered players to start a game.<br>
          <button class="btn btn-primary" onclick="Router.navigate('/players')"
                  style="margin-top:14px">Go to Players</button>
        </p>
      </div>`);
    return;
  }

  _setupSelected = [];

  setContent(`
    <div>
      <div class="form-section">
        <h2 class="section-title">Select Players <span style="font-size:12px;font-weight:normal;color:var(--text-muted)">(min 2, max 7)</span></h2>
        <div id="setup-players"></div>
      </div>
      <button id="btn-start-game" class="btn btn-primary btn-block" style="margin-bottom:16px" onclick="handleSetupSubmit()">Start Game →</button>
    </div>
  `);

  refreshSetupPlayers(allPlayers);
}

function refreshSetupPlayers(allPlayers) {
  const container = document.getElementById('setup-players');
  if (!container) return;
  allPlayers = allPlayers || Store.getPlayers();

  const selectedIds = _setupSelected.map(p => p.id);

  /* Selected players section */
  const selectedHtml = _setupSelected.length === 0 ? '' : `
    <div style="margin-bottom:8px">
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">
        Selected (${_setupSelected.length}) &nbsp;🃏 = First Dealer
      </div>
      ${_setupSelected.map((p, i) => `
        <div class="player-row">
          <input type="radio" name="first-dealer" class="dealer-radio"
                 ${i === _setupSelected.length - 1 ? 'checked' : ''}
                 style="accent-color:var(--primary);width:16px;height:16px;flex-shrink:0;cursor:pointer">
          <span class="player-num">${i + 1}</span>
          <span style="flex:1;font-size:15px;font-weight:500">${p.name}</span>
          <button type="button" class="btn-icon btn-move" onclick="moveSetupPlayer('${p.id}',-1)" title="Move up">▲</button>
          <button type="button" class="btn-icon btn-move" onclick="moveSetupPlayer('${p.id}',1)" title="Move down">▼</button>
          <button type="button" class="btn-icon btn-remove" onclick="toggleSetupPlayer('${p.id}')" title="Remove">✕</button>
        </div>`).join('')}
    </div>`;

  /* Available (unselected) players */
  const available = allPlayers.filter(p => !selectedIds.includes(p.id));
  const availableHtml = available.length === 0 ? '' : `
    <div>
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">
        ${_setupSelected.length > 0 ? 'Add More' : 'Tap to Select'}
      </div>
      ${available.map(p => `
        <div class="player-row" onclick="toggleSetupPlayer('${p.id}')"
             style="cursor:pointer;opacity:${_setupSelected.length >= 7 ? '.4' : '1'}">
          <span style="flex:1;font-size:15px">${p.name}</span>
          <span style="color:var(--primary);font-size:18px;padding-right:4px">+</span>
        </div>`).join('')}
    </div>`;

  container.innerHTML = selectedHtml + availableHtml;
}

function toggleSetupPlayer(id) {
  const idx = _setupSelected.findIndex(p => p.id === id);
  if (idx >= 0) {
    _setupSelected.splice(idx, 1);
  } else {
    if (_setupSelected.length >= 7) { showToast('Maximum 7 players', 'warning'); return; }
    const all = Store.getPlayers();
    const player = all.find(p => p.id === id);
    if (player) _setupSelected.push(player);
  }
  refreshSetupPlayers();
}

function moveSetupPlayer(id, dir) {
  const idx = _setupSelected.findIndex(p => p.id === id);
  const target = idx + dir;
  if (target < 0 || target >= _setupSelected.length) return;
  [_setupSelected[idx], _setupSelected[target]] = [_setupSelected[target], _setupSelected[idx]];
  refreshSetupPlayers();
}

function handleSetupSubmit() {
  if (_setupSelected.length < 2) {
    showToast('Select at least 2 players', 'error'); return;
  }

  const names = _setupSelected.map(p => p.name);

  const rules          = Store.getRules();
  const targetScore    = rules.targetScore;
  const winCondition   = 'lowest';
  const gameAmount     = rules.gameAmount;
  const dropScore      = rules.dropScore;
  const midDropScore   = rules.midDropScore;
  const fullCountScore = rules.fullCountScore;

  const checkedRadio = document.querySelector('#setup-players .dealer-radio:checked');
  const dealerIdx    = checkedRadio
    ? Array.from(document.querySelectorAll('#setup-players .dealer-radio')).indexOf(checkedRadio)
    : _setupSelected.length - 1;
  const firstDealer  = _setupSelected[dealerIdx]?.name || names[names.length - 1];

  const existing = Store.getActiveSession();
  if (existing) Store.completeSession(existing.id);

  const session = Store.createSession(names, { targetScore, winCondition, gameAmount, dropScore, midDropScore, fullCountScore, firstDealer });
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

  const cardTitle = '<span style="color:#111">♠</span><span style="color:#dc2626">♥</span> Rummy Score Board <span style="color:#dc2626">♦</span><span style="color:#111">♣</span>';
  setTitle(isActive ? cardTitle : '<span style="color:#111">♠</span><span style="color:#dc2626">♥</span> Game Summary <span style="color:#dc2626">♦</span><span style="color:#111">♣</span>');
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
        <div class="settlement-title">Settlement</div>
        <div class="settlement-row" style="border-bottom:2px solid var(--border);margin-bottom:2px">
          <span class="settlement-name" style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase">Player</span>
          <span class="settlement-amount" style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase">Net Points</span>
        </div>
        ${session.players.filter(p => effectiveMoney[p.id] !== undefined).map(p => {
          const amt = effectiveMoney[p.id];
          return `
          <div class="settlement-row">
            <span class="settlement-name">${p.name}</span>
            <span class="settlement-amount ${amt >= 0 ? 'amt-positive' : 'amt-negative'}">
              ${amt >= 0 ? '+' : ''}${amt}
            </span>
          </div>`;
        }).join('')}
      </div>` : '';
    completedHtml = `
      <div class="card card-completed">
        <div class="winner-name">🏆 ${winner ? winner.name : '—'}</div>
      </div>
      ${settlementHtml}
      <div style="margin:10px 0;text-align:center;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px">
        <p style="font-size:12px;color:#92400e;margin:0 0 6px">Had a great game? Support the developer!</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <div style="text-align:center">
            <button onclick="buyMeChai()" style="background:#f59e0b;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">☕ Buy me a Chai</button>
            <div style="font-size:10px;color:#92400e;margin-top:3px">India (UPI)</div>
          </div>
          <div style="text-align:center">
            <button onclick="openKofi()" style="background:#29abe0;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">☕ Buy me a Coffee</button>
            <div style="font-size:10px;color:#92400e;margin-top:3px">International</div>
          </div>
        </div>
      </div>`;
  }

  /* Rank list — shows OUT badge and Rejoin button for knocked-out players */
  const rejoined      = Object.keys(session.adjustments || {});
  const newPlayers    = session.newPlayers || [];
  const currentDealer = getCurrentDealer(session);
  const activeRules   = isActive ? Store.getRules() : session.rules;
  const targetScore   = activeRules.targetScore || 201;
  const dropScore     = activeRules.dropScore   || 20;
  const noDropThreshold = targetScore - dropScore;
  // Use original player order, attach totals for display
  const orderedPlayers = session.players.map(p => ({ ...p, total: totals[p.id] ?? 0 }));
  const rankHtml = `
    <div class="rank-list" style="margin-bottom:14px">
      <div style="display:grid;grid-template-columns:1fr 44px 64px 72px 58px;align-items:center;font-size:14px;font-weight:700;color:#fff;background:#4f46e5;padding:4px 8px;border-radius:8px 8px 0 0;gap:0">
        <span style="text-align:center">Player</span>
        <span style="text-align:center;border-left:1px solid rgba(255,255,255,0.4)"></span>
        <span style="text-align:center;border-left:1px solid rgba(255,255,255,0.4)">Total</span>
        <span style="text-align:center;border-left:1px solid rgba(255,255,255,0.4)">Remaining</span>
        <span style="border-left:1px solid rgba(255,255,255,0.4)"></span>
      </div>
      ${orderedPlayers.map((p, i) => {
        const isOut      = knockedOut.includes(p.id);
        const isNew      = newPlayers.includes(p.id);
        const hasRejoined = !isNew && rejoined.includes(p.id);
        const isDealer   = currentDealer && p.id === currentDealer.id;
        const isNoDrop   = !isOut && p.total >= noDropThreshold;
        const remaining  = isOut ? '—' : Math.max(0, targetScore - p.total - 1);
        // Row class: OUT > NoDrop+Dealer(green) > NoDrop(red) > Dealer(green) > normal
        const rowClass   = isOut ? 'rank-out'
                         : (isNoDrop && isDealer) ? 'rank-dealer'
                         : isNoDrop ? 'rank-danger'
                         : isDealer ? 'rank-dealer'
                         : '';
        const badge = isNoDrop
          ? `<span class="badge badge-out" style="${isDealer ? 'background:#dcfce7;color:#15803d;border-color:#86efac' : 'background:#fee2e2;color:var(--danger);border-color:#fca5a5'}">ND</span>`
          : isOut ? `<span class="badge badge-out">OUT</span>`
          : isNew ? `<span class="badge badge-rejoin" style="background:#e0f2fe;color:#0369a1;border-color:#7dd3fc">N</span>`
          : hasRejoined ? `<span class="badge badge-rejoin" style="background:#dcfce7;color:#15803d;border-color:#86efac">R</span>`
          : '';
        const actionBtn = isActive && isOut
          ? `<button class="btn btn-sm" style="background:#16a34a;color:#fff;border:1.5px solid #15803d;font-size:11px;padding:3px 6px;min-width:48px" onclick="rejoinPlayer('${session.id}','${p.id}')">Rejoin</button>`
          : isActive && !isOut
          ? `<button class="btn btn-sm" style="background:#fef08a;color:#854d0e;border:1.5px solid #eab308;font-size:11px;padding:3px 6px;min-width:48px" onclick="quitPlayer('${session.id}','${p.id}')">Quit</button>`
          : '';
        return `
          <div class="rank-item ${rowClass}" style="display:grid;grid-template-columns:1fr 44px 64px 72px 58px;align-items:center;gap:0;padding:4px 8px">
            <span class="rank-name" style="display:flex;align-items:center;gap:6px"><span class="rank-pos">${i + 1}</span>${p.name}</span>
            <span style="text-align:right;border-left:1px solid var(--border);padding-right:4px">${badge}</span>
            <span class="rank-score" style="text-align:right;border-left:1px solid var(--border);padding-right:4px">${p.total}</span>
            <span style="text-align:right;border-left:1px solid var(--border);padding-right:4px;font-size:18px;color:${isOut ? 'var(--text-muted)' : 'var(--primary)'};font-weight:800;font-variant-numeric:tabular-nums">${remaining}</span>
            <span style="text-align:right;border-left:1px solid var(--border);padding-left:4px">${actionBtn}</span>
          </div>`;
      }).join('')}
      ${isActive ? `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;gap:8px;border-top:1px solid var(--border);margin-top:8px">
        <button id="btn-read-scores" onclick="readOutScores('${session.id}')" style="font-size:12px;font-weight:600;color:#fff;background:#6366f1;border:none;border-radius:8px;cursor:pointer;padding:6px 12px;white-space:nowrap">🔊 Read Scores</button>
        <span style="color:var(--text-muted);flex:1;text-align:center;font-size:12px;white-space:nowrap">Dealer <strong style="color:#15803d">${currentDealer ? currentDealer.name : '—'}</strong></span>
        <button onclick="showUpdateDealerModal('${session.id}')" style="font-size:12px;font-weight:600;color:#fff;background:#6366f1;border:none;border-radius:8px;cursor:pointer;padding:6px 12px;white-space:nowrap">Update Dealer</button>
      </div>` : ''}
    </div>`;

  /* Score table */
  const tableHtml = session.rounds.length > 0
    ? buildScoreTable(session, isActive)
    : `<div class="empty-state" style="padding:32px">
         <p>No rounds yet.<br>Tap <strong>Add Round</strong> to add the first!</p>
       </div>`;

  /* Action buttons */

  const onlyOneActive = isActive && activePlayers.length <= 1;

  const legendHtml = `
    <div style="display:flex;flex-wrap:wrap;gap:6px 12px;padding:8px 12px;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);margin-top:8px">
      <span><span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px;background:#e0f2fe;color:#0369a1;border-color:#7dd3fc">N</span> New Player</span>
      <span><span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px;background:#dcfce7;color:#15803d;border-color:#86efac">R</span> Rejoined</span>
      <span><span class="badge badge-out" style="font-size:10px;padding:1px 5px;background:#fee2e2;color:var(--danger);border-color:#fca5a5">ND</span> No Drop</span>
      <span><span class="badge badge-out" style="font-size:10px;padding:1px 5px">OUT</span> Knocked Out</span>
    </div>`;

  setContent(`
    <div class="game-container">
      ${completedHtml}
      <div class="game-rank-section">${rankHtml}</div>
      <div class="game-scroll-area">
        ${isActive ? `<div class="score-table-wrapper">${tableHtml}</div>` : ''}
        ${isActive ? legendHtml : ''}
      </div>
      <div class="game-bottom-bar">${isActive ? `
        <div style="display:flex;align-items:center;gap:6px;padding:8px 12px">
          <button class="btn btn-sm btn-primary" style="flex:1" onclick="showAddPlayerToGameModal('${session.id}')">Add Player</button>
          ${onlyOneActive
            ? `<button class="btn" disabled style="flex:2;opacity:0.5;cursor:not-allowed;font-size:16px;padding:10px 0;background:#16a34a;color:#fff">Add Round</button>`
            : `<button class="btn" style="flex:2;font-size:16px;padding:10px 0;background:#16a34a;color:#fff" onclick="showAddRoundModal('${session.id}')">Add Round</button>`
          }
          <button class="btn btn-sm btn-danger" style="flex:1" onclick="confirmEndGame('${session.id}')">End Game</button>
        </div>` : `
        <div class="game-actions" style="padding:8px 12px">
          <button class="btn btn-outline" onclick="confirmDeleteSession('${session.id}')">Delete Game</button>
        </div>`}
      </div>
    </div>
  `);
  if (isActive) document.body.classList.add('game-active');
}

function buildScoreTable(session, isActive) {
  const totals     = getPlayerTotals(session);
  const knockedOut = session.knockedOut || [];
  const rejoined   = Object.keys(session.adjustments || {});
  const newPlayers = session.newPlayers || [];

  const displayRounds = session.rounds.slice().reverse();

  const headerCells = displayRounds
    .map(r => `<th>R${r.number}${isActive
      ? `<button class="btn-round-edit" title="Edit round" onclick="showEditRoundModal('${session.id}','${r.id}')">✎</button>`
      : ''}</th>`)
    .join('');

  const activeRules2    = isActive ? Store.getRules() : session.rules;
  const targetScore     = activeRules2.targetScore || 201;
  const dropScore       = activeRules2.dropScore   || 20;
  const noDropThreshold = targetScore - dropScore;

  const bodyRows = session.players.map(player => {
    const isOut       = knockedOut.includes(player.id);
    const isNew       = newPlayers.includes(player.id);
    const hasRejoined = !isNew && rejoined.includes(player.id);
    const playerTotal = totals[player.id];
    const isNoDrop    = !isOut && playerTotal >= noDropThreshold;

    const scoreCells = displayRounds.map(round => {
      const score = round.scores[player.id] ?? 0;
      const zeroStyle = score === 0 ? 'background:#dcfce7;color:#15803d;font-weight:800;border-radius:4px;' : '';
      if (isActive) {
        return `<td class="score-cell" style="${zeroStyle}"
                    data-session="${session.id}"
                    data-round="${round.id}"
                    data-player="${player.id}"
                    onclick="startEditScore(this)">${score}</td>`;
      }
      return `<td class="score-cell" style="${zeroStyle}">${score}</td>`;
    }).join('');

    const nameLabel = `${player.name}${isNew ? ' <span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px;background:#e0f2fe;color:#0369a1;border-color:#7dd3fc">N</span>' : hasRejoined ? ' <span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px;background:#dcfce7;color:#15803d;border-color:#86efac">R</span>' : ''}`;

    return `
      <tr class="${isOut ? 'row-out' : isNoDrop ? 'row-nodrop' : ''}">
        <td class="player-col sticky">${nameLabel}</td>
        ${scoreCells}
      </tr>`;
  }).join('');

  return `
    <table class="score-table">
      <thead>
        <tr>
          <th class="player-col sticky">Player</th>
          ${headerCells}
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
                 data-player="${p.id}" data-fullcount="${f}" value="${score}"
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
  const activePlayers = session.players.filter(p => !knockedOut.includes(p.id));
  if (activePlayers.length <= 1) {
    showToast('Only one player left — please end the game', 'warning');
    return;
  }
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
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <label class="form-label" style="margin:0">${p.name}</label>
          <!-- Card scanner button removed
          <button type="button" class="btn btn-sm" style="background:#1e293b;color:#fff;font-size:11px;padding:3px 8px"
                  onclick="openCardScanner('${p.id}','${p.name}')">🃏 Cards</button>
          -->
        </div>
        <div class="score-input-row">
          <input type="number" class="input round-score-input"
                 data-player="${p.id}" data-fullcount="${f}"
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
      <button id="btn-voice-scores" class="btn-mic" onclick="startVoiceScoreEntry('${sessionId}')" title="Tap to start, tap again to stop">🎤</button>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div style="display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)">
      <button class="btn btn-outline" style="flex:1" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:1" onclick="submitRound(null, '${sessionId}')">Save Round</button>
    </div>
    <!-- Joker card row hidden
    <div style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:#fefce8;border-bottom:1px solid var(--border)">
      <span style="font-size:13px;font-weight:600;white-space:nowrap">🃏 Joker Card:</span>
      <input type="text" id="joker-card-input" maxlength="2"
             value="${session.currentJoker || ''}"
             placeholder="e.g. 5 or K"
             style="width:70px;text-align:center;font-weight:700;font-size:14px;text-transform:uppercase"
             class="input" oninput="this.value=this.value.toUpperCase()"
             title="Enter the wild card joker rank (A,2-10,J,Q,K)">
      <span style="font-size:11px;color:var(--text-muted)">All cards of this rank = Joker</span>
    </div>
    -->
    <div style="display:flex;gap:8px;padding:6px 16px;background:#f8fafc;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-muted)">
      <span><button class="btn-quick" style="pointer-events:none;font-size:11px;padding:2px 6px">D</button> Drop</span>
      <span><button class="btn-quick btn-quick-m" style="pointer-events:none;font-size:11px;padding:2px 6px">M</button> Mid Drop</span>
      <span><button class="btn-quick btn-quick-f" style="pointer-events:none;font-size:11px;padding:2px 6px">F</button> Full Count</span>
    </div>
    <div class="modal-body">
      <form id="round-form" onsubmit="submitRound(event, '${sessionId}')">
        ${inputs}
        <button type="submit" style="display:none">Submit</button>
      </form>
    </div>
  `);
}

/* ============================================================
   VOICE SCORE ENTRY
   ============================================================ */
let _voiceRec = null;        // active recognition instance
let _voiceStopped = false;   // true when user deliberately tapped stop

// Convert spoken number words to digits (mobile speech recognition returns words)
function wordsToNumber(word) {
  const map = {
    'zero':0,'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,
    'eight':8,'nine':9,'ten':10,'eleven':11,'twelve':12,'thirteen':13,
    'fourteen':14,'fifteen':15,'sixteen':16,'seventeen':17,'eighteen':18,
    'nineteen':19,'twenty':20,'thirty':30,'forty':40,'fifty':50,
    'sixty':60,'seventy':70,'eighty':80,'ninety':90,'hundred':100,
  };
  return map[word] !== undefined ? map[word] : NaN;
}

// Try to parse a score from one or two consecutive words (e.g. "twenty five" → 25)
function parseSpokenScore(words, idx) {
  const w1 = words[idx];
  const w2 = words[idx + 1];
  const n1 = wordsToNumber(w1);
  const n2 = w2 !== undefined ? wordsToNumber(w2) : NaN;

  if (!isNaN(n1)) {
    if (!isNaN(n2) && n2 < n1 && n2 !== 0) return { value: n1 + n2, consumed: 2 };
    return { value: n1, consumed: 1 };
  }
  const d = parseInt(w1);
  if (!isNaN(d)) return { value: d, consumed: 1 };
  return null;
}

function startVoiceScoreEntry(sessionId) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice not supported in this browser', 'error'); return; }

  const micBtn = document.getElementById('btn-voice-scores');

  // If already listening — user tapped to stop
  if (_voiceRec) {
    _voiceStopped = true;
    _voiceRec.stop();
    return;
  }

  const session = Store.getSession(sessionId);
  if (!session) return;

  let accumulated = '';
  _voiceStopped = false;

  function startRec() {
    const rec = new SR();
    rec.lang            = 'en-IN';
    rec.continuous      = false;  // more reliable on mobile
    rec.interimResults  = false;
    rec.maxAlternatives = 1;

    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) accumulated += ' ' + e.results[i][0].transcript;
      }
      micBtn.title = accumulated.trim();
    };

    rec.onerror = e => {
      if (e.error === 'no-speech') return; // ignore silence, restart below
      showToast('Voice error: ' + e.error, 'error');
      _voiceStopped = true;
    };

    rec.onend = () => {
      if (!_voiceStopped) {
        // Auto-restart to keep listening until user taps stop
        try { startRec(); } catch { finishVoice(); }
        return;
      }
      finishVoice();
    };

    _voiceRec = rec;
    rec.start();
  }

  function finishVoice() {
    _voiceRec = null;
    micBtn.classList.remove('mic-active');
    micBtn.textContent = '🎤';
    micBtn.title = 'Speak scores';
    const transcript = accumulated.trim().toLowerCase();
    if (transcript) {
      showToast(`Heard: "${transcript}"`, 'info');
      parseAndFillScores(transcript, session);
    } else {
      showToast('Nothing heard — try again', 'warning');
    }
  }

  micBtn.classList.add('mic-active');
  micBtn.textContent = '🔴 Tap to stop';
  startRec();
}

function parseAndFillScores(transcript, session) {
  const knockedOut    = session.knockedOut || [];
  const activePlayers = session.players.filter(p => !knockedOut.includes(p.id));
  const d = session.rules.dropScore      ?? 20;
  const m = session.rules.midDropScore   ?? 40;
  const f = session.rules.fullCountScore ?? 80;

  // Build name → playerId lookup (full name and first word)
  const nameLookup = {};
  activePlayers.forEach(p => {
    const lower = p.name.toLowerCase();
    nameLookup[lower] = p.id;
    const first = lower.split(/\s+/)[0];
    if (!nameLookup[first]) nameLookup[first] = p.id;
  });

  // Score keywords
  const keywords = {
    'drop': d, 'd': d,
    'mid drop': m, 'mid': m, 'm': m,
    'full count': f, 'full': f, 'f': f,
    'zero': 0, 'nil': 0,
  };

  const words      = transcript.trim().split(/[\s,]+/);
  const assignments = {};
  let i = 0;

  while (i < words.length) {
    let nameMatched = false;
    // Try 3-word, 2-word, 1-word name matches
    for (let len = 3; len >= 1; len--) {
      if (i + len > words.length) continue;
      const phrase = words.slice(i, i + len).join(' ');
      if (nameLookup[phrase]) {
        const pid = nameLookup[phrase];
        i += len;
        // Try 2-word keyword then 1-word keyword then spoken/digit number
        const two = words.slice(i, i + 2).join(' ');
        if (keywords[two] !== undefined) {
          assignments[pid] = keywords[two]; i += 2;
        } else if (i < words.length && keywords[words[i]] !== undefined) {
          assignments[pid] = keywords[words[i]]; i++;
        } else if (i < words.length) {
          const parsed = parseSpokenScore(words, i);
          if (parsed) { assignments[pid] = parsed.value; i += parsed.consumed; }
        }
        nameMatched = true;
        break;
      }
    }
    if (!nameMatched) i++;
  }

  let filled = 0;
  Object.entries(assignments).forEach(([pid, score]) => {
    const input = document.querySelector(`.round-score-input[data-player="${pid}"]`);
    if (input) { input.value = score; liveValidateRoundScore(input); filled++; }
  });

  if (filled > 0) showToast(`Filled ${filled} player${filled > 1 ? 's' : ''} from voice`, 'success');
  else showToast('No scores recognised — try again', 'warning');
}

function liveValidateRoundScore(changedInput) {
  const inputs = Array.from(document.querySelectorAll('.round-score-input'));
  const val = parseInt(changedInput.value);
  const fullCount = parseInt(changedInput.dataset.fullcount ?? 80);

  // Clear error on current input first
  changedInput.classList.remove('input-error');

  // Rule 3: score cannot exceed full count
  if (!isNaN(val) && val > fullCount) {
    changedInput.value = fullCount;
    showToast(`Max score is full count (${fullCount})`, 'warning');
  }

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
  // Save joker card to session
  const jokerInput = document.getElementById('joker-card-input');
  if (jokerInput && jokerInput.value.trim()) {
    const session = Store.getSession(sessionId);
    if (session) { session.currentJoker = jokerInput.value.trim().toUpperCase(); Store.saveSession(session); }
  }
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

  const beforeKO       = (Store.getSession(sessionId).knockedOut || []).slice();
  const prevDealerId   = Store.getSession(sessionId).nextDealerId;
  Store.addRound(sessionId, scores);
  const session    = Store.getSession(sessionId);
  const knockedOut = session.knockedOut || [];

  // Advance dealer to the next active player after whoever just dealt
  const prevDealerIdx = prevDealerId
    ? session.players.findIndex(p => p.id === prevDealerId)
    : session.players.findIndex(p => p.name === session.rules?.firstDealer);
  if (prevDealerIdx !== -1) {
    for (let i = 1; i <= session.players.length; i++) {
      const next = session.players[(prevDealerIdx + i) % session.players.length];
      if (!knockedOut.includes(next.id)) {
        session.nextDealerId = next.id;
        break;
      }
    }
  } else {
    // First round ever — fall back to simulation to find the next dealer
    const nd = getCurrentDealer(session);
    if (nd) session.nextDealerId = nd.id;
  }
  Store.saveSession(session);

  const newKO = (session.knockedOut || []).filter(id => !beforeKO.includes(id));
  hideModal();
  renderGame([sessionId]);
  if (newKO.length > 0) {
    const names = newKO.map(id => session.players.find(p => p.id === id)?.name).join(', ');
    showToast(`${names} reached the target and is OUT!`, 'warning');
  }
}

function readOutScores(sessionId) {
  const btn = document.getElementById('btn-read-scores');

  // If already speaking, stop
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    if (btn) btn.textContent = '🔊 Read Scores';
    return;
  }

  const session = Store.getSession(sessionId);
  if (!session) return;

  // Use the same totals calculation as the rank table (includes adjustments)
  const totals     = getPlayerTotals(session);
  const knockedOut = session.knockedOut || [];
  // Speak in the same order as the rank table (session.players order)
  const parts = session.players.map(p => {
    const total = totals[p.id] || 0;
    const isOut = knockedOut.includes(p.id);
    return `${p.name} ${total}${isOut ? ', knocked out' : ''}`;
  });

  const text = parts.join('. ');
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.9;
  utt.onend  = () => { if (btn) btn.textContent = '🔊 Read Scores'; };
  utt.onerror = () => { if (btn) btn.textContent = '🔊 Read Scores'; };

  if (btn) btn.textContent = '⏹ Stop';
  window.speechSynthesis.speak(utt);
}

function showUpdateDealerModal(sessionId) {
  const session     = Store.getSession(sessionId);
  if (!session) return;
  const knockedOut  = session.knockedOut || [];
  const activePlayers = session.players.filter(p => !knockedOut.includes(p.id));
  const currentDealer = getCurrentDealer(session);

  const options = activePlayers.map(p =>
    `<option value="${p.id}" ${currentDealer && p.id === currentDealer.id ? 'selected' : ''}>${p.name}</option>`
  ).join('');

  showModal(`
    <div class="modal-header">
      <h2>Update Dealer</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
      <div style="font-size:13px;color:var(--text-muted)">
        Current dealer: <strong style="color:#15803d">${currentDealer ? currentDealer.name : '—'}</strong>
      </div>
      <div class="form-group">
        <label class="form-label">Select New Dealer</label>
        <select id="new-dealer-select" class="input" style="width:100%">
          ${options}
        </select>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline" style="flex:1" onclick="hideModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1" onclick="confirmUpdateDealer('${sessionId}')">Confirm</button>
      </div>
    </div>
  `);
}

function confirmUpdateDealer(sessionId) {
  const session  = Store.getSession(sessionId);
  if (!session) return;
  const playerId = document.getElementById('new-dealer-select')?.value;
  if (!playerId) return;
  const player   = session.players.find(p => p.id === playerId);
  if (!player) return;

  session.nextDealerId = playerId;
  Store.saveSession(session);
  hideModal();
  renderGame([sessionId]);
  showToast(`Dealer updated to ${player.name}`, 'success');
}

function confirmEndGame(sessionId) {
  const session    = Store.getSession(sessionId);
  if (!session) return;
  const knockedOut = session.knockedOut || [];

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
        </div>
        <input type="text" inputmode="numeric" class="input money-input" data-player="${p.id}"
               value="${defaultAmt}" placeholder="0" style="text-align:right"
               onfocus="this.setSelectionRange(this.value.length,this.value.length)">
      </div>`;
  }).join('');

  showModal(`
    <div class="modal-header">
      <h2>Game Settlement</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div style="display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)">
      <button class="btn btn-outline" style="flex:1" onclick="hideModal()">Cancel</button>
      <button class="btn btn-danger" style="flex:1" onclick="endGame('${sessionId}')">End Game</button>
    </div>
    <div class="modal-body">
      <div class="money-list">${playerRows}</div>
    </div>
  `);
}

function quitPlayer(sessionId, playerId) {
  const session = Store.getSession(sessionId);
  if (!session) return;
  const player = session.players.find(p => p.id === playerId);
  showModal(`
    <div class="modal-header">
      <h2>${player?.name ?? 'Player'} Quit</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div style="display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)">
      <button class="btn btn-outline" style="flex:1" onclick="hideModal()">No</button>
      <button class="btn btn-primary" style="flex:1"
              onclick="confirmQuit('${sessionId}','${playerId}')">Yes</button>
    </div>
    <div class="modal-body">
      <p style="color:var(--text-muted);font-size:14px">
        Do you want to Quit? <strong>${player?.name ?? 'Player'}</strong> will be marked as OUT and can Rejoin later.
      </p>
    </div>
  `);
}

/* ============================================================
   CARD SCANNER
   ============================================================ */
let _scanStream = null;

// Card point values for Indian Rummy (used for score verification display)
const CARD_PTS = { A:10, K:10, Q:10, J:10, '10':10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2, 'Joker':0 };

function openCardScanner(playerId, playerName) {
  window._scanPlayerName = playerName;
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) {
    _showGeminiSetup(playerId, playerName);
    return;
  }
  _openCamera(playerId, playerName);
}

function _showGeminiSetup(playerId, playerName) {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="card-scanner-overlay" style="position:fixed;inset:0;background:#0f172a;z-index:500;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#1e293b;color:#fff;flex-shrink:0">
        <span style="font-weight:700;font-size:15px">📷 Card Recognition Setup</span>
        <button onclick="closeCardScanner()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px 16px;color:#fff;display:flex;flex-direction:column;gap:16px">
        <div style="background:#1e293b;border-radius:12px;padding:16px;font-size:14px;line-height:1.6;color:#cbd5e1">
          <div style="font-weight:700;color:#fff;margin-bottom:8px">One-time setup required</div>
          Card recognition uses Google's free Gemini AI to read your cards.
          <ol style="margin:10px 0 0 16px;padding:0;display:flex;flex-direction:column;gap:6px">
            <li>Go to <strong>aistudio.google.com</strong> on your browser</li>
            <li>Sign in with your Google account</li>
            <li>Click <strong>Get API Key</strong> → <strong>Create API Key</strong></li>
            <li>Copy the key and paste it below</li>
          </ol>
        </div>
        <input id="gemini-key-input" type="password"
          placeholder="Paste Gemini API key here"
          style="width:100%;padding:12px;border-radius:8px;border:2px solid #475569;background:#1e293b;color:#fff;font-size:14px;box-sizing:border-box">
        <div style="font-size:11px;color:#64748b">The key is stored only on this device. It is never sent anywhere except Google's API.</div>
        <button onclick="_saveGeminiKey('${playerId}','${playerName}')" class="btn btn-primary" style="width:100%;font-size:16px;padding:14px">
          Save &amp; Start Scanning
        </button>
      </div>
    </div>
  `);
}

function _saveGeminiKey(playerId, playerName) {
  const key = document.getElementById('gemini-key-input')?.value?.trim();
  if (!key) { showToast('Please paste your API key', 'warning'); return; }
  localStorage.setItem('gemini_api_key', key);
  closeCardScanner();
  openCardScanner(playerId, playerName);
}

function _openCamera(playerId, playerName) {
  const joker = document.getElementById('joker-card-input')?.value?.trim()?.toUpperCase() || '';
  document.body.insertAdjacentHTML('beforeend', `
    <div id="card-scanner-overlay" style="position:fixed;inset:0;background:#000;z-index:500;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#1e293b;color:#fff;flex-shrink:0">
        <span style="font-weight:700;font-size:15px">📷 ${playerName} — Scan Cards</span>
        <button onclick="closeCardScanner()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer">✕</button>
      </div>
      ${joker ? `<div style="padding:6px 16px;background:#fefce8;font-size:12px;color:#854d0e;text-align:center;flex-shrink:0">Wild Joker: <strong>${joker}</strong> = 0 pts</div>` : ''}
      <div style="position:relative;flex:1;overflow:hidden">
        <video id="card-scan-video" autoplay playsinline style="width:100%;height:100%;object-fit:cover"></video>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:12px;pointer-events:none">
          <div style="background:rgba(0,0,0,0.55);color:#fff;font-size:12px;padding:4px 12px;border-radius:20px">Lay all unmelded cards flat &amp; capture</div>
        </div>
      </div>
      <div style="padding:12px 16px;background:#1e293b;flex-shrink:0;display:flex;gap:8px">
        <button onclick="closeCardScanner()" class="btn btn-outline" style="flex:1;color:#fff;border-color:#475569">Cancel</button>
        <button onclick="captureCardImage('${playerId}')" class="btn btn-primary" style="flex:2;font-size:16px">📸 Capture &amp; Scan</button>
      </div>
      <canvas id="card-scan-canvas" style="display:none"></canvas>
    </div>
  `);
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
    .then(stream => {
      _scanStream = stream;
      document.getElementById('card-scan-video').srcObject = stream;
    })
    .catch(() => {
      showToast('Camera not available', 'error');
      closeCardScanner();
    });
}

async function captureCardImage(playerId) {
  const video  = document.getElementById('card-scan-video');
  const canvas = document.getElementById('card-scan-canvas');

  // Resize to max 1024px wide to keep API payload small while preserving detail
  const maxW  = 1024;
  const scale = Math.min(1, maxW / video.videoWidth);
  canvas.width  = Math.floor(video.videoWidth  * scale);
  canvas.height = Math.floor(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  if (_scanStream) { _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }

  const imgData     = canvas.toDataURL('image/jpeg', 0.9);
  const imageBase64 = imgData.split(',')[1];

  // Show loading screen with the captured preview
  const overlay = document.getElementById('card-scanner-overlay');
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#1e293b;color:#fff;flex-shrink:0">
      <span style="font-weight:700;font-size:15px">🔍 Recognizing Cards...</span>
    </div>
    <div style="position:relative;flex:1;overflow:hidden">
      <img src="${imgData}" style="width:100%;height:100%;object-fit:contain;background:#000;opacity:0.5">
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#fff">
        <div style="font-size:40px;animation:spin 1s linear infinite">⟳</div>
        <div style="font-size:15px;font-weight:600">Reading card values...</div>
        <div style="font-size:12px;color:#94a3b8">Powered by Gemini AI</div>
      </div>
    </div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  `;

  try {
    const result = await _recognizeCardsWithGemini(imageBase64);
    _showRecognitionResult(playerId, result, imgData);
  } catch (err) {
    const isQuota = err.isQuota;
    const isKey   = err.isKey;
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#1e293b;color:#fff;flex-shrink:0">
        <span style="font-weight:700;font-size:15px">${isQuota ? '⚠️ Quota Exceeded' : '❌ Recognition Failed'}</span>
        <button onclick="closeCardScanner()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer">✕</button>
      </div>
      <div style="flex:1;overflow-y:auto;padding:20px 16px;color:#fff;display:flex;flex-direction:column;gap:14px">
        ${isQuota ? `
          <div style="background:#7c2d12;border-radius:10px;padding:14px;font-size:13px;line-height:1.6;color:#fed7aa">
            <div style="font-weight:700;font-size:14px;color:#fff;margin-bottom:6px">Free tier limit reached</div>
            The Gemini free API key allows ~15 scans per minute and a daily cap.
            <br><br>
            <strong>To fix permanently:</strong>
            <ol style="margin:8px 0 0 16px;padding:0;display:flex;flex-direction:column;gap:4px">
              <li>Go to <strong>console.cloud.google.com</strong></li>
              <li>Select your project → Billing → Enable billing</li>
              <li>Gemini 1.5 Flash costs ~$0.00015 per image — practically free for personal use</li>
            </ol>
          </div>
          <div style="background:#1e293b;border-radius:10px;padding:12px;font-size:13px;color:#94a3b8;text-align:center">
            Or wait a minute and try again — the free quota resets each minute.
          </div>
        ` : `
          <div style="background:#1e293b;border-radius:10px;padding:14px;font-size:13px;color:#fca5a5">
            ${err.message || 'Could not read cards. Try better lighting and lay cards flat.'}
          </div>
        `}
        ${isKey ? `<button onclick="_showGeminiSetup('${playerId}', window._scanPlayerName||'')" class="btn btn-outline" style="color:#fff;border-color:#475569;width:100%">Update API Key</button>` : ''}
      </div>
      <div style="padding:12px 16px;background:#1e293b;flex-shrink:0;display:flex;gap:8px">
        <button onclick="closeCardScanner()" class="btn btn-outline" style="flex:1;color:#fff;border-color:#475569">Cancel</button>
        ${!isQuota ? `<button onclick="_openCamera('${playerId}', window._scanPlayerName||'')" class="btn btn-primary" style="flex:1">Re-take</button>` : ''}
      </div>
    `;
  }
}

async function _recognizeCardsWithGemini(imageBase64) {
  const apiKey = localStorage.getItem('gemini_api_key');
  const joker  = document.getElementById('joker-card-input')?.value?.trim()?.toUpperCase() || '';

  const prompt = `You are analyzing a photo of playing cards from an Indian Rummy game.
${joker ? `The wild joker for this round is: ${joker} (counts as 0 points).` : ''}

Identify every card rank visible in the image. For each card read its rank (A, 2, 3, 4, 5, 6, 7, 8, 9, 10, J, Q, K, or Joker).

Scoring rules:
- A, K, Q, J, 10 = 10 points each
- 9=9, 8=8, 7=7, 6=6, 5=5, 4=4, 3=3, 2=2
- Joker (printed or wild ${joker || ''}) = 0 points

Return ONLY a raw JSON object with no markdown, no explanation, no code fences:
{"cards":["A","K","5","3","Joker"],"total":25,"count":5}`;

  // Try models in order until one works
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-1.5-flash'];
  let resp, usedModel;
  for (const model of models) {
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
          ]}],
          generationConfig: { temperature: 0, maxOutputTokens: 300 }
        })
      }
    );
    if (resp.status !== 404) { usedModel = model; break; }
  }

  if (resp.status === 429) {
    const e = new Error('QUOTA_EXCEEDED');
    e.isQuota = true;
    throw e;
  }
  if (resp.status === 400 || resp.status === 403) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch(_) {}
    const e = new Error(`Invalid API key${detail ? ': ' + detail : ''}. Tap "Update API Key" to fix.`);
    e.isKey = true;
    throw e;
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch(_) {}
    throw new Error(`API error ${resp.status}${detail ? ': ' + detail : ''}. Try re-taking the photo.`);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Strip markdown code fences if present, then parse JSON
  const cleaned = text.replace(/```[a-z]*\n?/gi, '').trim();
  const match   = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not read card values. Try better lighting and lay cards flat.');

  const result = JSON.parse(match[0]);
  if (typeof result.total !== 'number') throw new Error('Unexpected response from AI. Please re-take the photo.');

  // Re-calculate total from the cards array as a sanity check
  result.total = (result.cards || []).reduce((sum, r) => {
    const rank = String(r).replace(/[♠♥♦♣]/g, '').trim();
    const isWild = joker && rank.toUpperCase() === joker;
    return sum + (isWild ? 0 : (CARD_PTS[rank] ?? 0));
  }, 0);

  return result;
}

function _showRecognitionResult(playerId, result, imgData) {
  const overlay = document.getElementById('card-scanner-overlay');
  const cards   = result.cards || [];
  const total   = result.total ?? 0;
  const count   = cards.length;
  const countColor = count === 13 ? '#86efac' : '#fbbf24';

  const cardChips = cards.map(c => {
    const rank = String(c).replace(/[♠♥♦♣]/g, '').trim();
    const pts  = CARD_PTS[rank] ?? 0;
    return `<span style="display:inline-flex;flex-direction:column;align-items:center;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:3px 6px;font-size:12px;color:#fff;min-width:28px">
      <span style="font-weight:700">${rank}</span>
      <span style="font-size:9px;color:#94a3b8">${pts}</span>
    </span>`;
  }).join('');

  overlay.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#1e293b;color:#fff;flex-shrink:0">
      <span style="font-weight:700;font-size:15px">✅ Cards Recognized</span>
      <button onclick="closeCardScanner()" style="background:none;border:none;color:#fff;font-size:22px;cursor:pointer">✕</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:12px">
      <div style="position:relative;border-radius:10px;overflow:hidden;max-height:200px">
        <img src="${imgData}" style="width:100%;object-fit:cover">
      </div>
      <div style="background:#1e40af;border-radius:10px;padding:14px;text-align:center">
        <div style="color:#93c5fd;font-size:12px;margin-bottom:4px">Total Score</div>
        <div style="color:#fff;font-size:40px;font-weight:800;line-height:1">${total}</div>
        <div style="color:#93c5fd;font-size:12px;margin-top:2px">points</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center">
        ${cardChips}
      </div>
      <div style="text-align:center;font-size:12px;color:${countColor}">${count} card${count!==1?'s':''} detected${count===13?' ✅':' — check if all cards are visible'}</div>
    </div>
    <div style="padding:12px 16px;background:#1e293b;flex-shrink:0;display:flex;gap:8px">
      <button onclick="_openCamera('${playerId}', window._scanPlayerName||'')" class="btn btn-outline" style="flex:1;color:#fff;border-color:#475569">Re-take</button>
      <button onclick="_applyCardScore('${playerId}', ${total})" class="btn btn-primary" style="flex:2;font-size:16px">✅ Use ${total} pts</button>
    </div>
  `;
}

function _applyCardScore(playerId, score) {
  const input = document.querySelector(`.round-score-input[data-player="${playerId}"]`);
  closeCardScanner();
  setTimeout(() => {
    if (input) {
      input.value = score;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.style.borderColor = '#22c55e';
      setTimeout(() => { input.style.borderColor = ''; }, 1500);
      showToast(`Score set to ${score} pts ✅`, 'success');
    }
  }, 100);
}

function closeCardScanner() {
  if (_scanStream) { _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
  document.getElementById('card-scanner-overlay')?.remove();
}

function confirmQuit(sessionId, playerId) {
  Store.knockoutPlayer(sessionId, playerId);
  const session = Store.getSession(sessionId);
  session.knockedOutRound = session.knockedOutRound || {};
  session.knockedOutRound[playerId] = session.rounds.length;
  session.quitPlayers = session.quitPlayers || [];
  if (!session.quitPlayers.includes(playerId)) session.quitPlayers.push(playerId);
  Store.saveSession(session);
  hideModal();
  renderGame([sessionId]);
  const player = session.players.find(p => p.id === playerId);
  showToast(`${player?.name ?? 'Player'} has quit`, 'info');
}

function showAddPlayerToGameModal(sessionId) {
  const session        = Store.getSession(sessionId);
  if (!session) return;
  const allRegistered  = Store.getPlayers();
  const inGameNames    = session.players.map(p => p.name.toLowerCase());
  const available      = allRegistered.filter(p => !inGameNames.includes(p.name.toLowerCase()));

  if (available.length === 0) {
    showModal(`
      <div class="modal-header">
        <h2>Add Player</h2>
        <button class="btn-icon" onclick="hideModal()">✕</button>
      </div>
      <div class="modal-body">
        <p style="color:var(--text-muted);font-size:14px;margin-bottom:16px">
          No registered players available to add. Register a new player first, then come back to add them to the game.
        </p>
        <button class="btn btn-primary" style="width:100%;margin-bottom:8px" onclick="hideModal();Router.navigate('/players')">👥 Go to Register Players</button>
        <button class="btn btn-outline" style="width:100%" onclick="hideModal()">Cancel</button>
      </div>
    `);
    return;
  }

  const totals        = getPlayerTotals(session);
  const knockedOut    = session.knockedOut || [];
  const activeTotals  = session.players.filter(p => !knockedOut.includes(p.id)).map(p => totals[p.id]);
  const suggestedScore = activeTotals.length > 0 ? Math.max(...activeTotals) + 1 : 0;

  const options = available.map(p =>
    `<option value="${p.id}">${p.name}</option>`
  ).join('');

  showModal(`
    <div class="modal-header">
      <h2>Add Player</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div style="display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)">
      <button class="btn btn-outline" style="flex:1" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:1"
              onclick="confirmAddPlayerToGame('${sessionId}')">Add</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label class="form-label">Select Player</label>
        <select class="input" id="add-player-select">${options}</select>
      </div>
      <div class="form-group">
        <label class="form-label">Starting Score</label>
        <input type="number" class="input" id="add-player-score"
               value="${suggestedScore}" min="0">
      </div>
    </div>
  `, true);
}

function confirmAddPlayerToGame(sessionId) {
  const session  = Store.getSession(sessionId);
  if (!session) return;
  const select   = document.getElementById('add-player-select');
  const scoreInput = document.getElementById('add-player-score');
  const playerId = select?.value;
  const score    = parseInt(scoreInput?.value);

  if (!playerId) return;
  if (isNaN(score) || score < 0) {
    scoreInput?.classList.add('input-error');
    return;
  }

  const allRegistered = Store.getPlayers();
  const player        = allRegistered.find(p => p.id === playerId);
  if (!player) return;

  // Add player to session — insert just before the current dealer so they deal in the right order
  session.players = session.players || [];
  const currentDealer   = getCurrentDealer(session);
  const dealerIdx       = currentDealer
    ? session.players.findIndex(p => p.id === currentDealer.id)
    : -1;
  const newPlayerObj    = { id: player.id, name: player.name };
  if (dealerIdx !== -1) {
    session.players.splice(dealerIdx, 0, newPlayerObj);
  } else {
    session.players.push(newPlayerObj);
  }

  // Track when they joined so dealer rotation starts from the right round
  session.joinedRound = session.joinedRound || {};
  session.joinedRound[player.id] = session.rounds.length;

  // Keep the existing dealer — new player is NOT the dealer

  // Fill all previous rounds with drop score
  const dropScore = (session.rules.dropScore || 20);
  session.rounds.forEach(r => { r.scores[player.id] = dropScore; });

  // Set adjustment so total = previous rounds sum + adjustment = desired starting score
  const previousTotal = session.rounds.length * dropScore;
  session.adjustments = session.adjustments || {};
  session.adjustments[player.id] = score - previousTotal;

  // Track as newly added (shows N badge, not R)
  session.newPlayers = session.newPlayers || [];
  if (!session.newPlayers.includes(player.id)) session.newPlayers.push(player.id);

  Store.saveSession(session);
  hideModal();
  renderGame([sessionId]);
  showToast(`${player.name} added with score ${score}`, 'success');
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
  const highestActive  = activeTotals.length > 0 ? Math.max(...activeTotals) : totals[playerId];
  const suggestedScore = highestActive + 1;

  const currentRules = Store.getRules();
  const targetScore  = currentRules.targetScore || 201;
  const dropScore    = currentRules.dropScore   || 20;
  if (highestActive + 1 + dropScore >= targetScore) {
    showToast(`Rejoin not allowed — scores too close to target (${targetScore})`, 'error');
    return;
  }

  // Rule 1: block rejoin if more than one round played since knockout
  const knockedOutRound = session.knockedOutRound || {};
  const koRound = knockedOutRound[playerId];
  if (koRound !== undefined && session.rounds.length > koRound) {
    showToast('Rejoin not allowed — one round already played since knockout', 'error');
    return;
  }

  showModal(`
    <div class="modal-header">
      <h2>${player?.name ?? 'Player'} Rejoins</h2>
      <button class="btn-icon" onclick="hideModal()">✕</button>
    </div>
    <div style="display:flex;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);background:var(--surface)">
      <button class="btn btn-outline" style="flex:1" onclick="hideModal()">Cancel</button>
      <button class="btn btn-primary" style="flex:1"
              onclick="confirmRejoin('${sessionId}','${playerId}',${totals[playerId]})">
        Confirm Rejoin
      </button>
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

  // Compute current dealer BEFORE rejoin changes the knockedOut list
  const dealerBeforeRejoin = getCurrentDealer(session);

  Store.rejoinPlayer(sessionId, playerId, adjustment);

  // After rejoin, move player to just before the current dealer in dealing order
  // and record the round they rejoined so the rotation is correct going forward
  const session2 = Store.getSession(sessionId);
  session2.rejoinedRound = session2.rejoinedRound || {};
  session2.rejoinedRound[playerId] = session2.rounds.length;

  // Move rejoining player to just before the current dealer in the array
  const dealerIdx = dealerBeforeRejoin
    ? session2.players.findIndex(p => p.id === dealerBeforeRejoin.id)
    : -1;
  const playerIdx = session2.players.findIndex(p => p.id === playerId);

  if (dealerIdx !== -1 && playerIdx !== -1 && playerIdx !== dealerIdx) {
    const [playerObj] = session2.players.splice(playerIdx, 1);
    const newDealerIdx = session2.players.findIndex(p => p.id === dealerBeforeRejoin.id);
    const insertAt = newDealerIdx !== -1 ? newDealerIdx : session2.players.length;
    session2.players.splice(insertAt, 0, playerObj);
  }

  // Keep the existing dealer — rejoining player is NOT the dealer this round.
  // They are placed before the dealer so they'll deal just before the dealer's next turn.
  Store.saveSession(session2);

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
      <div class="summary-row summary-header">
        <span class="summary-name">Player</span>
        <span class="summary-net">Net Points</span>
      </div>
      ${summaryPlayers.map(([name, net]) => `
        <div class="summary-row">
          <span class="summary-name">${name}</span>
          <span class="summary-net ${net >= 0 ? 'net-positive' : 'net-negative'}">
            ${net >= 0 ? '+' : ''}${net}
          </span>
        </div>`).join('')}
    </div>` : '';

  setContent(`
    <div>
      ${summaryHtml}
      <div style="margin:10px 0;text-align:center;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px">
        <p style="font-size:12px;color:#92400e;margin:0 0 6px">Enjoying the app? Support the developer!</p>
        <div style="display:flex;gap:8px;justify-content:center">
          <div style="text-align:center">
            <button onclick="buyMeChai()" style="background:#f59e0b;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">☕ Buy me a Chai</button>
            <div style="font-size:10px;color:#92400e;margin-top:3px">India (UPI)</div>
          </div>
          <div style="text-align:center">
            <button onclick="openKofi()" style="background:#29abe0;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer">☕ Buy me a Coffee</button>
            <div style="font-size:10px;color:#92400e;margin-top:3px">International</div>
          </div>
        </div>
      </div>
      <!-- AdSense Banner -->
      <div style="margin:12px 0;text-align:center;min-height:60px">
        <ins class="adsbygoogle"
             style="display:block"
             data-ad-client="ca-pub-9537276736960487"
             data-ad-slot="auto"
             data-ad-format="auto"
             data-full-width-responsive="true"></ins>
        <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
      </div>
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
                        ${amt >= 0 ? '+' : ''}${amt}</span>`
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

function openKofi() {
  window.location.href = 'https://ko-fi.com/ravikiran0209';
}

function buyMeChai() {
  const upiId   = 'ravi.nagam.kiran-2@okaxis';
  const name    = 'Rummy Score Board';
  const note    = 'Buy me a chai';
  const upiLink = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&tn=${encodeURIComponent(note)}&cu=INR`;

  // Try UPI deep link (works on Android with any UPI app)
  const a = document.createElement('a');
  a.href = upiLink;
  a.click();
}

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
  Router.on('/players', ()       => renderPlayers());
  Router.on('/rules',   ()       => renderRules());

  /* Init Auth → if signed in, init CloudSync and pull data; else show sign-in page */
  Auth.init().then(user => {
    if (!user) {
      renderSignIn();
      return;
    }
    document.getElementById('btn-history').hidden = false;
    CloudSync.init();
    CloudSync.pull()
      .then(() => {})
      .catch(() => {})
      .finally(() => { CloudSync.listen(); InactivityTimer.start(); updateUserBar(); Router.init(); });
  });

  /* Register service worker for offline support / PWA */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('[SW] Registration failed:', err);
    });
    // When a new SW version activates it posts SW_UPDATED — reload to pick up fresh files
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'SW_UPDATED') {
        window.location.reload();
      }
    });
  }
});
