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
  const firstDealer = session.rules && session.rules.firstDealer;
  if (!firstDealer) return null;
  const players    = session.players;
  const knockedOut = session.knockedOut || [];
  const startIdx   = players.findIndex(p => p.name === firstDealer);
  if (startIdx === -1) return null;

  // Rotate through rounds, skipping knocked-out players
  let roundsLeft = session.rounds.length;
  let idx        = startIdx;
  while (roundsLeft > 0) {
    idx = (idx + 1) % players.length;
    if (!knockedOut.includes(players[idx].id)) roundsLeft--;
  }
  // If computed dealer is knocked out, find next active player
  if (knockedOut.includes(players[idx].id)) {
    for (let i = 1; i <= players.length; i++) {
      const next = (idx + i) % players.length;
      if (!knockedOut.includes(players[next].id)) return players[next];
    }
    return null;
  }
  return players[idx];
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
  setTitle('Rummy Score Board');
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
        <input type="text" class="input" id="reg-username" placeholder="e.g. ravi" autocorrect="off" autocapitalize="none">
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
      CloudSync.pull().finally(() => Router.init());
    })
    .catch(e => {
      errEl.textContent = friendlyAuthError(e.code);
      errEl.style.display = 'block';
    });
}

function handleRegister() {
  const username      = document.getElementById('reg-username').value.trim();
  const password      = document.getElementById('reg-password').value;
  const recoveryEmail = document.getElementById('reg-recovery').value.trim();
  const errEl         = document.getElementById('reg-error');
  errEl.style.display = 'none';
  if (!username || !password) { errEl.textContent = 'Enter username and password.'; errEl.style.display = 'block'; return; }
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.style.display = 'block'; return; }
  Auth.register(toFirebaseEmail(username), password)
    .then(() => {
      // Save recovery email to Firestore for password reset
      if (recoveryEmail) {
        const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
        firebase.firestore(app).collection('recovery').doc(username.toLowerCase())
          .set({ recoveryEmail });
      }
      hideModal();
      document.getElementById('btn-history').hidden = false;
      CloudSync.init();
      CloudSync.pull().finally(() => Router.init());
    })
    .catch(e => {
      errEl.textContent = friendlyAuthError(e.code);
      errEl.style.display = 'block';
    });
}

function handleSignOut() {
  const storeKey = getStoreKey();
  Auth.signOut().then(() => {
    CloudSync._ready  = false;
    CloudSync._pulled = false;
    CloudSync._docRef = null;
    Store._cache      = null;
    localStorage.removeItem(storeKey);
    renderSignIn();
  });
}

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':        'No account found with this username.',
    'auth/wrong-password':        'Incorrect password.',
    'auth/invalid-email':         'Invalid username.',
    'auth/email-already-in-use':  'An account with this username already exists.',
    'auth/weak-password':         'Password must be at least 6 characters.',
    'auth/invalid-credential':    'Incorrect username or password.',
    'auth/too-many-requests':     'Too many attempts. Try again later.',
    'auth/operation-not-allowed': 'Email/Password sign-in is not enabled. Enable it in Firebase Console → Authentication → Sign-in method.',
    'auth/network-request-failed':'Network error. Check your internet connection.',
    'auth/configuration-not-found':'Firebase Auth is not configured. Enable Email/Password in Firebase Console.',
  };
  return map[code] || `Error (${code}). Please try again.`;
}

function renderHome() {
  setTitle('Rummy Score Board');
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
      <button class="btn btn-primary btn-block" style="margin-bottom:6px" onclick="Router.navigate('/setup')">+ New Game</button>
      <div style="display:flex;gap:8px;margin-bottom:0">
        <button class="btn btn-outline" style="flex:1;background:#e0f0ff;border-color:#b0d4f1" onclick="Router.navigate('/players')">👥 Players</button>
        <button class="btn btn-outline" style="flex:1;background:#e0f0ff;border-color:#b0d4f1" onclick="Router.navigate('/rules')">Rules</button>
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
      ${Auth.email ? `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding:8px 12px;background:var(--surface);border-radius:var(--radius-sm);font-size:13px;color:var(--text-muted)">
        <span>Signed in as <strong>${displayUsername(Auth.email)}</strong></span>
        <button class="btn btn-sm btn-outline btn-danger" onclick="handleSignOut()">Sign Out</button>
      </div>` : ''}
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
              ${amt >= 0 ? '+' : ''}${amt}
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
      <div style="display:grid;grid-template-columns:1fr 44px 64px 72px 58px;align-items:center;font-size:13px;font-weight:700;color:#fff;background:#4f46e5;padding:6px 10px;border-radius:8px 8px 0 0;gap:0">
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
          : hasRejoined ? `<span class="badge badge-rejoin">R</span>`
          : '';
        const actionBtn = isActive && isOut
          ? `<button class="btn btn-sm btn-outline" onclick="rejoinPlayer('${session.id}','${p.id}')">Rejoin</button>`
          : isActive && !isOut
          ? `<button class="btn btn-sm" style="background:#fef08a;color:#854d0e;border:1.5px solid #eab308" onclick="quitPlayer('${session.id}','${p.id}')">Q</button>`
          : '';
        return `
          <div class="rank-item ${rowClass}" style="display:grid;grid-template-columns:1fr 44px 64px 72px 58px;align-items:center;gap:0;padding:6px 10px">
            <span class="rank-name" style="display:flex;align-items:center;gap:6px"><span class="rank-pos">${i + 1}</span>${p.name}</span>
            <span style="text-align:right;border-left:1px solid var(--border);padding-right:4px">${badge}</span>
            <span class="rank-score" style="text-align:right;border-left:1px solid var(--border);padding-right:4px">${p.total}</span>
            <span style="text-align:right;border-left:1px solid var(--border);padding-right:4px;font-size:18px;color:${isOut ? 'var(--text-muted)' : 'var(--primary)'};font-weight:800;font-variant-numeric:tabular-nums">${remaining}</span>
            <span style="text-align:right;border-left:1px solid var(--border);padding-left:4px">${actionBtn}</span>
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

  const onlyOneActive = isActive && activePlayers.length <= 1;
  const bottomActionsHtml = isActive ? `
    <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid var(--border);background:var(--surface);position:sticky;bottom:0">
      <button class="btn btn-sm btn-primary" style="flex:1" onclick="showAddPlayerToGameModal('${session.id}')">Add Player</button>
      ${onlyOneActive
        ? `<button class="btn" disabled style="flex:2;opacity:0.5;cursor:not-allowed;font-size:16px;padding:10px 0;background:#16a34a;color:#fff">Add Round</button>`
        : `<button class="btn" style="flex:2;font-size:16px;padding:10px 0;background:#16a34a;color:#fff" onclick="showAddRoundModal('${session.id}')">Add Round</button>`
      }
      <button class="btn btn-sm btn-danger" style="flex:1" onclick="confirmEndGame('${session.id}')">End Game</button>
    </div>` : `
    <div class="game-actions">
      <button class="btn btn-outline"
              onclick="confirmDeleteSession('${session.id}')">Delete Game</button>
    </div>`;

  const legendHtml = `
    <div style="display:flex;flex-wrap:wrap;gap:6px 12px;padding:8px 12px;font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);margin-top:8px">
      <span><span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px;background:#e0f2fe;color:#0369a1;border-color:#7dd3fc">N</span> New Player</span>
      <span><span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px">R</span> Rejoined</span>
      <span><span class="badge badge-out" style="font-size:10px;padding:1px 5px;background:#fee2e2;color:var(--danger);border-color:#fca5a5">ND</span> No Drop</span>
      <span><span class="badge badge-out" style="font-size:10px;padding:1px 5px">OUT</span> Knocked Out</span>
      <span><span class="badge badge-out" style="font-size:10px;padding:1px 5px;background:#fef08a;color:#854d0e;border-color:#eab308">Q</span> Quit</span>
    </div>`;

  setContent(`
    <div>
      ${completedHtml}
      ${rankHtml}
      <div class="score-table-wrapper">${tableHtml}</div>
      ${legendHtml}
      ${bottomActionsHtml}
    </div>
  `);
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

    const nameLabel = `${player.name}${isNew ? ' <span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px;background:#e0f2fe;color:#0369a1;border-color:#7dd3fc">N</span>' : hasRejoined ? ' <span class="badge badge-rejoin" style="font-size:10px;padding:1px 5px">R</span>' : ''}`;

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
        <label class="form-label">${p.name}</label>
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
      <h2>Game Settlement 💰</h2>
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
        <p style="color:var(--text-muted);font-size:14px">
          No registered players available. Please register a new player first and then come back to add them.
        </p>
        <button class="btn btn-outline" style="width:100%;margin-top:8px" onclick="hideModal()">OK</button>
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
  `);
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

  // Add player to session
  session.players = session.players || [];
  session.players.push({ id: player.id, name: player.name });

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
      <div class="summary-row summary-header">
        <span class="summary-name">Name</span>
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
      .then(synced => { if (synced) showToast('☁ Data synced', 'success'); })
      .catch(() => {})
      .finally(() => Router.init());
  });

  /* Register service worker for offline support / PWA */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('[SW] Registration failed:', err);
    });
  }
});
