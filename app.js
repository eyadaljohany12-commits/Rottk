/* ============================================================================
   Chess 960 (Fischer Random) — app.js
   1. Chess core (legal moves, 960 castling, Scharnagl positions, FEN, SAN)
   2. Engine layer (Stockfish WASM in a Web Worker, built-in fallback engine)
   3. UI (screens, themes, i18n, sounds, drag & drop, profile)
   ========================================================================== */
'use strict';

/* ============================== 1. CORE ================================== */
const FILES = 'abcdefgh';
const sqName = s => FILES[s & 7] + ((s >> 3) + 1);
const colorOf = p => (p ? (p === p.toUpperCase() ? 'w' : 'b') : null);
const other = c => (c === 'w' ? 'b' : 'w');
const KN_D = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
const KG_D = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
const B_D = [[1,1],[1,-1],[-1,1],[-1,-1]];
const R_D = [[1,0],[-1,0],[0,1],[0,-1]];
const KNIGHT_TABLE = [[0,1],[0,2],[0,3],[0,4],[1,2],[1,3],[1,4],[2,3],[2,4],[3,4]];

/* Scharnagl numbering: position id 0..959 -> back rank string (#518 = RNBQKBNR style standard) */
function startPosition(id) {
  const row = Array(8).fill(null);
  let n = id;
  row[[1, 3, 5, 7][n % 4]] = 'B'; n = Math.floor(n / 4);
  row[[0, 2, 4, 6][n % 4]] = 'B'; n = Math.floor(n / 4);
  const q = n % 6; n = Math.floor(n / 6);
  let empty = row.map((v, i) => (v ? -1 : i)).filter(i => i >= 0);
  row[empty[q]] = 'Q';
  empty = row.map((v, i) => (v ? -1 : i)).filter(i => i >= 0);
  const [a, b] = KNIGHT_TABLE[n];
  row[empty[a]] = 'N'; row[empty[b]] = 'N';
  empty = row.map((v, i) => (v ? -1 : i)).filter(i => i >= 0);
  row[empty[0]] = 'R'; row[empty[1]] = 'K'; row[empty[2]] = 'R';
  return row.join('');
}

function newState(id) {
  const rank = startPosition(id);
  const board = Array(64).fill('');
  for (let f = 0; f < 8; f++) {
    board[f] = rank[f]; board[8 + f] = 'P';
    board[48 + f] = 'p'; board[56 + f] = rank[f].toLowerCase();
  }
  const q = rank.indexOf('R'), k = rank.lastIndexOf('R');
  return { board, turn: 'w', castle: { w: { q, k }, b: { q, k } }, ep: -1, half: 0, full: 1 };
}

function cloneState(s) {
  return {
    board: s.board.slice(), turn: s.turn,
    castle: { w: { k: s.castle.w.k, q: s.castle.w.q }, b: { k: s.castle.b.k, q: s.castle.b.q } },
    ep: s.ep, half: s.half, full: s.full
  };
}

function fromFEN(fen) {
  const [pl, tn, cs, ep, hm, fm] = fen.trim().split(/\s+/);
  const board = Array(64).fill('');
  pl.split('/').forEach((row, i) => {
    const r = 7 - i; let f = 0;
    for (const ch of row) { if (/\d/.test(ch)) f += +ch; else board[r * 8 + f++] = ch; }
  });
  const castle = { w: { k: -1, q: -1 }, b: { k: -1, q: -1 } };
  const ksq = { w: board.indexOf('K') & 7, b: board.indexOf('k') & 7 };
  if (cs && cs !== '-') for (const ch of cs) {
    const c = ch === ch.toUpperCase() ? 'w' : 'b';
    const f = FILES.indexOf(ch.toLowerCase());
    if (f >= 0) castle[c][f > ksq[c] ? 'k' : 'q'] = f;
  }
  return { board, turn: tn, castle, ep: ep && ep !== '-' ? FILES.indexOf(ep[0]) + (+ep[1] - 1) * 8 : -1, half: +hm || 0, full: +fm || 1 };
}

function toFEN(s) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let str = '', e = 0;
    for (let f = 0; f < 8; f++) {
      const p = s.board[r * 8 + f];
      if (!p) e++; else { if (e) { str += e; e = 0; } str += p; }
    }
    if (e) str += e;
    rows.push(str);
  }
  let cs = '';
  if (s.castle.w.k >= 0) cs += FILES[s.castle.w.k].toUpperCase();
  if (s.castle.w.q >= 0) cs += FILES[s.castle.w.q].toUpperCase();
  if (s.castle.b.k >= 0) cs += FILES[s.castle.b.k];
  if (s.castle.b.q >= 0) cs += FILES[s.castle.b.q];
  const ep = s.ep >= 0 ? sqName(s.ep) : '-';
  return `${rows.join('/')} ${s.turn} ${cs || '-'} ${ep} ${s.half} ${s.full}`;
}

function attacked(board, sq, by) {
  const f = sq & 7, r = sq >> 3;
  const up = t => (by === 'w' ? t : t.toLowerCase());
  const pr = by === 'w' ? r - 1 : r + 1;
  if (pr >= 0 && pr < 8) {
    const P = up('P');
    if (f > 0 && board[pr * 8 + f - 1] === P) return true;
    if (f < 7 && board[pr * 8 + f + 1] === P) return true;
  }
  const N = up('N');
  for (const [dr, df] of KN_D) {
    const nr = r + dr, nf = f + df;
    if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && board[nr * 8 + nf] === N) return true;
  }
  const K = up('K');
  for (const [dr, df] of KG_D) {
    const nr = r + dr, nf = f + df;
    if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8 && board[nr * 8 + nf] === K) return true;
  }
  const Q = up('Q'), B = up('B'), R = up('R');
  for (const [dr, df] of B_D) {
    let nr = r + dr, nf = f + df;
    while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
      const p = board[nr * 8 + nf];
      if (p) { if (p === B || p === Q) return true; break; }
      nr += dr; nf += df;
    }
  }
  for (const [dr, df] of R_D) {
    let nr = r + dr, nf = f + df;
    while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
      const p = board[nr * 8 + nf];
      if (p) { if (p === R || p === Q) return true; break; }
      nr += dr; nf += df;
    }
  }
  return false;
}

function pseudoMoves(s) {
  const me = s.turn, opp = other(me), b = s.board, out = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = b[sq];
    if (!p || colorOf(p) !== me) continue;
    const t = p.toUpperCase(), f = sq & 7, r = sq >> 3;
    if (t === 'P') {
      const dir = me === 'w' ? 1 : -1, start = me === 'w' ? 1 : 6, last = me === 'w' ? 7 : 0;
      const r1 = r + dir;
      if (r1 < 0 || r1 > 7) continue;
      const add = (to, flag) => {
        if (r1 === last) for (const pr of ['q', 'r', 'b', 'n']) out.push({ from: sq, to, flag, promo: pr });
        else out.push({ from: sq, to, flag });
      };
      if (!b[r1 * 8 + f]) {
        add(r1 * 8 + f, 'n');
        if (r === start && !b[(r + 2 * dir) * 8 + f]) out.push({ from: sq, to: (r + 2 * dir) * 8 + f, flag: 'd' });
      }
      for (const df of [-1, 1]) {
        const nf = f + df; if (nf < 0 || nf > 7) continue;
        const to = r1 * 8 + nf;
        if (b[to] && colorOf(b[to]) === opp) add(to, 'c');
        else if (to === s.ep && !b[to]) out.push({ from: sq, to, flag: 'e' });
      }
    } else if (t === 'N' || t === 'K') {
      for (const [dr, df] of (t === 'N' ? KN_D : KG_D)) {
        const nr = r + dr, nf = f + df;
        if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
        const to = nr * 8 + nf, q = b[to];
        if (!q) out.push({ from: sq, to, flag: 'n' });
        else if (colorOf(q) === opp) out.push({ from: sq, to, flag: 'c' });
      }
      if (t === 'K') castleMoves(s, sq, out);
    } else {
      const dirs = t === 'B' ? B_D : t === 'R' ? R_D : KG_D;
      for (const [dr, df] of dirs) {
        let nr = r + dr, nf = f + df;
        while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
          const to = nr * 8 + nf, q = b[to];
          if (!q) out.push({ from: sq, to, flag: 'n' });
          else { if (colorOf(q) === opp) out.push({ from: sq, to, flag: 'c' }); break; }
          nr += dr; nf += df;
        }
      }
    }
  }
  return out;
}

/* Chess960 castling. Internal encoding: king "captures" own rook (to = rook square),
   exactly like UCI_Chess960. kdest / rdest hold the final squares (c/g and d/f files). */
function castleMoves(s, kingSq, out) {
  const me = s.turn, opp = other(me), rank = me === 'w' ? 0 : 7;
  if ((kingSq >> 3) !== rank) return;
  const kf = kingSq & 7, rookCh = me === 'w' ? 'R' : 'r';
  for (const side of ['k', 'q']) {
    const rf = s.castle[me][side];
    if (rf < 0) continue;
    const rsq = rank * 8 + rf;
    if (s.board[rsq] !== rookCh) continue;
    const kd = side === 'k' ? 6 : 2, rd = side === 'k' ? 5 : 3;
    const lo = Math.min(kf, rf, kd, rd), hi = Math.max(kf, rf, kd, rd);
    let ok = true;
    for (let f = lo; f <= hi; f++) {
      if (f === kf || f === rf) continue;
      if (s.board[rank * 8 + f]) { ok = false; break; }
    }
    if (!ok) continue;
    const tmp = s.board.slice(); tmp[kingSq] = '';
    for (let f = Math.min(kf, kd); f <= Math.max(kf, kd); f++) {
      if (attacked(tmp, rank * 8 + f, opp)) { ok = false; break; }
    }
    if (!ok) continue;
    out.push({ from: kingSq, to: rsq, flag: 'C', side, kdest: rank * 8 + kd, rdest: rank * 8 + rd });
  }
}

function makeMove(s, m) {
  const n = cloneState(s), b = n.board, me = s.turn;
  const piece = b[m.from], t = piece.toUpperCase();
  const capture = m.flag === 'e' || (m.flag !== 'C' && !!b[m.to]);
  n.ep = -1;
  if (m.flag === 'C') {
    const rook = b[m.to];
    b[m.from] = ''; b[m.to] = '';
    b[m.kdest] = piece; b[m.rdest] = rook;
    n.castle[me] = { k: -1, q: -1 };
  } else {
    if (m.flag === 'e') b[m.to + (me === 'w' ? -8 : 8)] = '';
    b[m.to] = m.promo ? (me === 'w' ? m.promo.toUpperCase() : m.promo) : piece;
    b[m.from] = '';
    if (m.flag === 'd') n.ep = (m.from + m.to) / 2;
    if (t === 'K') n.castle[me] = { k: -1, q: -1 };
    for (const c of ['w', 'b']) {
      const rk = c === 'w' ? 0 : 7;
      for (const sd of ['k', 'q']) {
        const rf = n.castle[c][sd];
        if (rf >= 0 && (m.from === rk * 8 + rf || m.to === rk * 8 + rf)) n.castle[c][sd] = -1;
      }
    }
  }
  n.half = (t === 'P' || capture) ? 0 : s.half + 1;
  if (me === 'b') n.full++;
  n.turn = other(me);
  return n;
}

const kingSq = (b, c) => b.indexOf(c === 'w' ? 'K' : 'k');
const inCheck = (s, c = s.turn) => attacked(s.board, kingSq(s.board, c), other(c));

function legalMoves(s) {
  const res = [];
  for (const m of pseudoMoves(s)) {
    const n = makeMove(s, m);
    if (!attacked(n.board, kingSq(n.board, s.turn), n.turn)) res.push(m);
  }
  return res;
}

function perft(s, d) {
  if (d === 0) return 1;
  const ms = legalMoves(s);
  if (d === 1) return ms.length;
  let n = 0;
  for (const m of ms) n += perft(makeMove(s, m), d - 1);
  return n;
}

function toSAN(s, m, legal) {
  let str;
  const p = s.board[m.from], t = p.toUpperCase();
  if (m.flag === 'C') str = m.side === 'k' ? 'O-O' : 'O-O-O';
  else {
    const cap = !!s.board[m.to] || m.flag === 'e';
    if (t === 'P') {
      str = (cap ? FILES[m.from & 7] + 'x' : '') + sqName(m.to);
      if (m.promo) str += '=' + m.promo.toUpperCase();
    } else {
      str = t;
      const amb = legal.filter(o => o !== m && o.flag !== 'C' && s.board[o.from] === p && o.to === m.to);
      if (amb.length) {
        const sameF = amb.some(o => (o.from & 7) === (m.from & 7));
        const sameR = amb.some(o => (o.from >> 3) === (m.from >> 3));
        if (!sameF) str += FILES[m.from & 7]; else if (!sameR) str += (m.from >> 3) + 1; else str += sqName(m.from);
      }
      if (cap) str += 'x';
      str += sqName(m.to);
    }
  }
  const n = makeMove(s, m);
  if (inCheck(n)) str += legalMoves(n).length ? '+' : '#';
  return str;
}

function insufficient(b) {
  const minors = [];
  for (let i = 0; i < 64; i++) {
    const p = b[i]; if (!p) continue;
    const t = p.toLowerCase();
    if (t === 'k') continue;
    if (t === 'n' || t === 'b') minors.push({ t, sq: i }); else return false;
  }
  if (minors.length <= 1) return true;
  if (minors.every(x => x.t === 'b')) {
    const col = x => ((x.sq & 7) + (x.sq >> 3)) & 1;
    return minors.every(x => col(x) === col(minors[0]));
  }
  return false;
}

const posKey = s => s.board.map(p => p || '.').join('') + s.turn +
  ['w', 'b'].map(c => s.castle[c].k + ',' + s.castle[c].q).join(';') + (s.ep >= 0 ? s.ep : '');

function gameStatus(s, keys) {
  const lm = legalMoves(s);
  if (!lm.length) return inCheck(s) ? { over: true, type: 'mate', winner: other(s.turn) } : { over: true, type: 'stalemate' };
  if (insufficient(s.board)) return { over: true, type: 'insufficient' };
  if (s.half >= 100) return { over: true, type: 'fifty' };
  const k = posKey(s);
  if (keys && keys.filter(x => x === k).length >= 3) return { over: true, type: 'repetition' };
  return { over: false };
}

const moveToUci = m => sqName(m.from) + sqName(m.to) + (m.promo || '');
function findMove(s, uci) {
  if (!uci) return null;
  const lm = legalMoves(s);
  let m = lm.find(x => moveToUci(x) === uci);
  if (!m) m = lm.find(x => x.flag === 'C' && sqName(x.from) + sqName(x.kdest) === uci);
  return m || null;
}

/* ===================== 2. ENGINE (Stockfish WASM + fallback) ============== */
/* Put stockfish.js (+ stockfish.wasm) next to index.html for fully offline use.
   If it is missing the CDN copies are tried, then the built-in engine takes over. */
const ENGINE_SOURCES = [
  { url: './stockfish.js', local: true },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js' },
  { url: 'https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/stockfish.js' }
];
const SKILL = [0, 1, 3, 5, 7, 10, 13, 16, 18, 20];
const DEPTH = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
const MOVETIME = [100, 150, 200, 300, 400, 500, 650, 800, 1000, 1400];
const LEVEL_ELO = [800, 950, 1100, 1250, 1400, 1550, 1750, 1950, 2200, 2500];

const PVAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

function evalRel(s) {
  let sc = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = s.board[sq]; if (!p) continue;
    const t = p.toLowerCase(), f = sq & 7, r = sq >> 3, w = p === p.toUpperCase();
    let v = PVAL[t];
    if (t === 'p') v += (w ? r : 7 - r) * 6;
    else if (t === 'n' || t === 'b' || t === 'q') v += (3.5 - Math.hypot(f - 3.5, r - 3.5)) * 4;
    sc += w ? v : -v;
  }
  return s.turn === 'w' ? sc : -sc;
}

function builtinSearch(state, level) {
  const maxDepth = level <= 3 ? 1 : level <= 7 ? 2 : 3;
  const noise = level <= 2 ? 160 : level <= 4 ? 70 : level <= 6 ? 25 : 0;
  const deadline = Date.now() + (level >= 8 ? 2500 : 1500);
  let aborted = false;
  const order = (s, m) => {
    let v = m.promo ? 800 : 0;
    if (m.flag !== 'C' && s.board[m.to]) v += PVAL[s.board[m.to].toLowerCase()] * 10 - PVAL[s.board[m.from].toLowerCase()];
    return v;
  };
  function nm(s, d, a, b, ply) {
    if (Date.now() > deadline) { aborted = true; return 0; }
    const ms = legalMoves(s);
    if (!ms.length) return inCheck(s) ? -30000 + ply : 0;
    if (d === 0) return evalRel(s);
    ms.sort((x, y) => order(s, y) - order(s, x));
    let best = -Infinity;
    for (const m of ms) {
      const v = -nm(makeMove(s, m), d - 1, -b, -a, ply + 1);
      if (aborted) return 0;
      if (v > best) best = v;
      if (v > a) a = v;
      if (a >= b) break;
    }
    return best;
  }
  const roots = legalMoves(state);
  if (!roots.length) return { best: null, cp: 0 };
  let result = { best: roots[Math.floor(Math.random() * roots.length)], cp: 0 };
  for (let d = 1; d <= maxDepth; d++) {
    let bestM = null, bestV = -Infinity;
    for (const m of roots) {
      const v = -nm(makeMove(state, m), d - 1, -Infinity, Infinity, 1) + Math.random() * noise;
      if (aborted) break;
      if (v > bestV) { bestV = v; bestM = m; }
    }
    if (aborted) break;
    result = { best: bestM, cp: Math.round(bestV) };
  }
  return { best: moveToUci(result.best), cp: result.cp };
}

class Engine {
  constructor() {
    this.mode = 'init'; this.worker = null; this.busy = false; this.cur = null; this.queued = null; this.last = null;
    this.ready = null;
  }
  init() {
    this.ready = (async () => {
      for (const src of ENGINE_SOURCES) {
        const w = await this._tryWorker(src);
        if (w) {
          this.worker = w; this.mode = 'stockfish';
          w.onmessage = e => this._onLine(typeof e.data === 'string' ? e.data : '');
          w.onerror = () => { this.mode = 'builtin'; this.busy = false; };
          this.send('setoption name UCI_Chess960 value true');
          this.send('isready');
          return;
        }
      }
      this.mode = 'builtin';
    })();
    return this.ready;
  }
  send(cmd) { if (this.worker) this.worker.postMessage(cmd); }
  _tryWorker(src) {
    return new Promise(resolve => {
      let w, done = false, timer, ping;
      const finish = ok => {
        if (done) return; done = true; clearTimeout(timer); clearInterval(ping);
        if (!ok && w) { try { w.terminate(); } catch (e) { /* ignore */ } }
        resolve(ok ? w : null);
      };
      try {
        if (src.local) w = new Worker(src.url);
        else {
          const blob = new Blob(['importScripts(' + JSON.stringify(src.url) + ');'], { type: 'text/javascript' });
          w = new Worker(URL.createObjectURL(blob));
        }
      } catch (e) { return resolve(null); }
      w.onerror = () => finish(false);
      w.onmessage = e => { if (typeof e.data === 'string' && e.data.includes('uciok')) finish(true); };
      timer = setTimeout(() => finish(false), 9000);
      ping = setInterval(() => { try { w.postMessage('uci'); } catch (e) { finish(false); } }, 1200);
      w.postMessage('uci');
    });
  }
  newGame() { this.cancel(); if (this.mode === 'stockfish') { this.send('ucinewgame'); this.send('isready'); } }
  cancel() {
    if (this.queued) { this.queued.res({ best: null, cancelled: true }); this.queued = null; }
    if (this.busy && this.mode === 'stockfish') this.send('stop');
  }
  async go(opt) {
    await this.ready;
    return new Promise(res => {
      const job = { opt, res };
      if (this.mode !== 'stockfish') {
        setTimeout(() => {
          const r = builtinSearch(opt.state, opt.kind === 'analyze' ? 2 : opt.level);
          res({ best: r.best, score: { type: 'cp', v: r.cp }, turn: opt.state.turn });
        }, 40);
        return;
      }
      if (this.queued) this.queued.res({ best: null, cancelled: true });
      this.queued = job;
      if (this.busy) this.send('stop'); else this._next();
    });
  }
  _next() {
    const job = this.queued; if (!job) return;
    this.queued = null; this.busy = true; this.cur = job; this.last = null;
    const o = job.opt, lv = Math.min(10, Math.max(1, o.level || 5));
    this.send('setoption name Skill Level value ' + (o.kind === 'analyze' ? 20 : SKILL[lv - 1]));
    this.send('position fen ' + o.fen);
    if (o.kind === 'analyze') this.send('go movetime ' + (o.movetime || 350));
    else this.send('go depth ' + DEPTH[lv - 1] + ' movetime ' + MOVETIME[lv - 1]);
  }
  _onLine(l) {
    if (l.startsWith('info') && l.includes(' score ') && !/bound/.test(l)) {
      const m = l.match(/score (cp|mate) (-?\d+)/);
      if (m) this.last = { type: m[1], v: +m[2] };
    } else if (l.startsWith('bestmove')) {
      const job = this.cur; this.busy = false; this.cur = null;
      const best = l.split(' ')[1];
      if (job) job.res({ best: best === '(none)' ? null : best, score: this.last, turn: job.opt.state.turn });
      if (this.queued) this._next();
    }
  }
}

/* =============================== 3. UI =================================== */
const GLYPH = { K: '\u265A\uFE0E', Q: '\u265B\uFE0E', R: '\u265C\uFE0E', B: '\u265D\uFE0E', N: '\u265E\uFE0E', P: '\u265F\uFE0E' };
const INIT_COUNT = { P: 8, N: 2, B: 2, R: 2, Q: 1 };

const THEMES = [
  { id: 'white-red',      ar: 'أبيض وأحمر',     en: 'White & Red',      light: '#f7ecec', dark: '#c4414a', accent: '#ff5468', tint: 'rgba(190,40,60,.40)',  bg1: '#5a1420', bg2: '#1c070b', hi: 'rgba(255,230,120,.55)' },
  { id: 'green-white',    ar: 'أخضر وأبيض',     en: 'Green & White',    light: '#eef4ea', dark: '#3f9a63', accent: '#34d17f', tint: 'rgba(30,150,90,.40)',  bg1: '#0f4a2e', bg2: '#06170e', hi: 'rgba(255,240,120,.55)' },
  { id: 'blue-white',     ar: 'أزرق وأبيض',     en: 'Blue & White',     light: '#e9f1fb', dark: '#3b79b8', accent: '#4aa8ff', tint: 'rgba(30,90,180,.42)',  bg1: '#0f3566', bg2: '#050f1f', hi: 'rgba(255,235,120,.55)' },
  { id: 'black-white',    ar: 'أسود وأبيض',     en: 'Black & White',    light: '#ececec', dark: '#3c3c42', accent: '#b5bcc8', tint: 'rgba(20,20,26,.55)',   bg1: '#2a2b31', bg2: '#0a0a0c', hi: 'rgba(255,214,90,.55)' },
  { id: 'brown-black',    ar: 'بني وأسود',      en: 'Brown & Black',    light: '#a8774e', dark: '#2a1c14', accent: '#e09a45', tint: 'rgba(70,40,20,.55)',   bg1: '#3b2414', bg2: '#0d0805', hi: 'rgba(255,214,90,.45)' },
  { id: 'red-blue-black', ar: 'أحمر وأزرق وأسود', en: 'Red, Blue & Black', light: '#4a6cc0', dark: '#1a1a20', accent: '#ef3b4e', tint: 'rgba(60,40,110,.48)', bg1: '#2a1a4a', bg2: '#0a0712', hi: 'rgba(239,59,78,.5)' },
  { id: 'brown-white',    ar: 'بني وأبيض',      en: 'Brown & White',    light: '#f0dcb8', dark: '#a9703f', accent: '#f0a030', tint: 'rgba(200,130,40,.34)', bg1: '#4a2e14', bg2: '#1a0f08', hi: 'rgba(255,214,90,.5)' }
];

const I18N = {
  ar: {
    title: 'شطرنج 960', subtitle: 'العب ضد الحاسوب', engine: 'المحرك', level: 'المستوى', levelShort: 'م',
    start: 'ابدأ اللعبة', reset: 'إعادة ضبط', position: 'وضعية 960', playAs: 'العب بـ', white: 'أبيض', black: 'أسود', random: 'عشوائي',
    settings: 'الإعدادات', language: 'اللغة', mode: 'النمط الافتراضي', modeCpu: 'ضد الحاسوب', modeTwo: 'لاعبان',
    evalBar: 'تقييم المحرك', sounds: 'الأصوات', effects: 'المؤثرات', themes: 'الثيمات', themeList: 'قائمة الثيمات',
    changeTheme: 'تغيير الثيم', soundControls: 'التحكم بالصوت', sndMove: 'أصوات النقلات', sndCheck: 'صوت الكش', sndCapture: 'صوت الأسر',
    upload: 'اضغط على الكاميرا لتغيير الصورة', undo: 'تراجع', hint: 'تلميح', flip: 'قلب', restart: 'إعادة', resign: 'استسلام',
    yourTurn: 'دورك', whiteTurn: 'دور الأبيض', blackTurn: 'دور الأسود', thinking: 'يفكر', checkTxt: 'كش!',
    mate: 'كش مات', stalemate: 'تعادل (طريق مسدود)', fifty: 'تعادل (قاعدة 50 نقلة)', repetition: 'تعادل (تكرار)', insufficient: 'تعادل (مادة غير كافية)',
    youWin: 'لقد فزت! 🎉', youLose: 'خسرت هذه المرة', whiteWins: 'فاز الأبيض', blackWins: 'فاز الأسود', drawTxt: 'تعادل',
    again: 'العب مجدداً', home: 'الرئيسية', promote: 'ترقية البيدق', resignConfirm: 'هل تريد الاستسلام؟', computer: 'الحاسوب',
    engineSF: 'Stockfish WASM', engineBuiltin: 'محرك مدمج (بدون Stockfish)', engineLoad: 'جارٍ تحميل المحرك…', approx: 'تقريباً', resigned: 'استسلام'
  },
  en: {
    title: 'Chess 960', subtitle: 'Play against the Computer', engine: 'Engine', level: 'Level', levelShort: 'Lv',
    start: 'Start Game', reset: 'Randomize', position: '960 Position', playAs: 'Play as', white: 'White', black: 'Black', random: 'Random',
    settings: 'Settings', language: 'Language', mode: 'Default mode', modeCpu: 'vs Computer', modeTwo: 'Two players',
    evalBar: 'Engine evaluation', sounds: 'Sounds', effects: 'Effects', themes: 'Themes', themeList: 'Themes',
    changeTheme: 'Change theme', soundControls: 'Sound controls', sndMove: 'Move sounds', sndCheck: 'Check sound', sndCapture: 'Capture sound',
    upload: 'Tap the camera to change your picture', undo: 'Undo', hint: 'Hint', flip: 'Flip', restart: 'Restart', resign: 'Resign',
    yourTurn: 'Your turn', whiteTurn: 'White to move', blackTurn: 'Black to move', thinking: 'Thinking', checkTxt: 'Check!',
    mate: 'Checkmate', stalemate: 'Draw (stalemate)', fifty: 'Draw (50-move rule)', repetition: 'Draw (repetition)', insufficient: 'Draw (insufficient material)',
    youWin: 'You won! 🎉', youLose: 'You lost this one', whiteWins: 'White wins', blackWins: 'Black wins', drawTxt: 'Draw',
    again: 'Play again', home: 'Home', promote: 'Promote pawn', resignConfirm: 'Resign this game?', computer: 'Computer',
    engineSF: 'Stockfish WASM', engineBuiltin: 'Built-in engine (no Stockfish)', engineLoad: 'Loading engine…', approx: 'approx.', resigned: 'resigned'
  }
};

const DEFAULTS = {
  lang: 'ar', theme: 'brown-white', evalBar: true, sounds: true, fx: true, sMove: true, sCheck: true, sCapture: true,
  engineOn: true, side: 'w', level: 4, name: 'زياد', elo: 1400, avatar: '', pos: 518, slots: [518, 356, 87, 704, 233], slot: 0
};
let S = Object.assign({}, DEFAULTS);
function loadSettings() { try { Object.assign(S, JSON.parse(localStorage.getItem('c960') || '{}')); } catch (e) { /* ignore */ } }
function saveSettings() { try { localStorage.setItem('c960', JSON.stringify(S)); } catch (e) { /* ignore */ } }

const $ = id => document.getElementById(id);
const t = k => (I18N[S.lang] && I18N[S.lang][k]) || I18N.en[k] || k;
const mmss = ms => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let engine = null;
let G = null;              // current game
let sqEls = [];            // 64 square elements (index = square)
let pieceEls = [];         // 64 piece elements mirroring the board
let drag = null;
let promoOpen = false;
let rafPending = false;

/* ---------- audio (synthesised, no assets needed) ---------- */
let AC = null;
function ac() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* ignore */ } }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function noiseClick(freq, vol, dur) {
  const a = ac(); if (!a) return;
  const n = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 1.2;
  const g = a.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(a.destination); src.start();
}
function tone(freq, dur, vol = 0.15, delay = 0, type = 'sine') {
  const a = ac(); if (!a) return;
  const at = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g); g.connect(a.destination); o.start(at); o.stop(at + dur + 0.02);
}
function playSound(kind) {
  if (!S.sounds) return;
  if (kind === 'move') { if (!S.sMove) return; noiseClick(900, 0.9, 0.07); tone(140, 0.08, 0.12); }
  else if (kind === 'capture') { if (!S.sCapture) return; noiseClick(1400, 1, 0.09); setTimeout(() => noiseClick(700, 0.8, 0.08), 45); tone(110, 0.12, 0.18); }
  else if (kind === 'check') { if (!S.sCheck) return; tone(740, 0.14, 0.16, 0, 'triangle'); tone(988, 0.2, 0.16, 0.12, 'triangle'); }
  else if (kind === 'end') { tone(523, 0.25, 0.14); tone(659, 0.25, 0.14, 0.15); tone(784, 0.45, 0.14, 0.3); }
  else if (kind === 'ui') tone(620, 0.05, 0.05);
}

/* ---------- theme / language / settings plumbing ---------- */
function applyTheme() {
  const th = THEMES.find(x => x.id === S.theme) || THEMES[6], r = document.documentElement.style;
  r.setProperty('--sq-light', th.light); r.setProperty('--sq-dark', th.dark); r.setProperty('--accent', th.accent);
  r.setProperty('--tint', th.tint); r.setProperty('--bg1', th.bg1); r.setProperty('--bg2', th.bg2); r.setProperty('--hi', th.hi);
  const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = th.bg2;
}
function applyLang() {
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.title = t('title');
  document.querySelectorAll('#langSeg button').forEach(b => b.classList.toggle('on', b.dataset.lang === S.lang));
  renderThemes(); renderHome();
  if (G) renderAll();
}
function syncSettings() {
  document.querySelectorAll('[data-setting]').forEach(i => { i.checked = !!S[i.dataset.setting]; });
  document.body.classList.toggle('no-fx', !S.fx);
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'cpu') === S.engineOn));
  document.querySelectorAll('#sideSeg button').forEach(b => b.classList.toggle('on', b.dataset.side === S.side));
  $('sideSeg').classList.toggle('disabled', !S.engineOn);
  $('homeStepper').style.opacity = S.engineOn ? 1 : .4;
  $('homeStepper').style.pointerEvents = S.engineOn ? 'auto' : 'none';
  $('evalBar').hidden = !S.evalBar || !S.engineOn && false;
  if (G) { $('gStepper').hidden = !S.engineOn; renderEval(); renderCards(); }
}
function setLevel(n) {
  S.level = Math.min(10, Math.max(1, n)); saveSettings(); renderHome();
  $('gLvlVal').textContent = S.level;
  if (G) renderCards();
}

/* ---------- home screen ---------- */
function setAvatarEl(el, big) {
  if (S.avatar) { el.style.backgroundImage = `url(${S.avatar})`; el.textContent = ''; }
  else { el.style.backgroundImage = 'none'; el.textContent = big ? (S.name || '?').trim().charAt(0).toUpperCase() : ''; }
}
function renderHome() {
  $('lvlVal').textContent = S.level; $('gLvlVal').textContent = S.level;
  $('lvlElo').textContent = `${t('level')} ${S.level} · ${t('approx')} ELO ${LEVEL_ELO[S.level - 1]}`;
  $('posNum').textContent = S.pos; $('gPos').textContent = G ? G.pos : S.pos;
  if (document.activeElement !== $('posInput')) $('posInput').value = S.pos;
  const rank = startPosition(S.pos);
  $('posPreview').innerHTML = [...rank].map(c => `<span>${GLYPH[c]}</span>`).join('');
  $('slotGrid').innerHTML = S.slots.map((p, i) => `<button class="${i === S.slot ? 'on' : ''}" data-slot="${i}" title="№${p}">${i + 1}</button>`).join('');
  $('nameInput').value = S.name; $('eloBadge').textContent = S.elo;
  setAvatarEl($('avatarImg'), true);
  syncSettings();
}
function setPos(n) {
  S.pos = Math.min(959, Math.max(0, Math.floor(+n) || 0)); S.slots[S.slot] = S.pos; saveSettings(); renderHome();
}
function updateEngineBadge() {
  const el = $('gEngineBadge'); if (!engine) return;
  if (engine.mode === 'init') el.textContent = t('engineLoad');
  else el.textContent = engine.mode === 'stockfish' ? t('engineSF') : t('engineBuiltin');
}

/* ---------- overlays ---------- */
function openOv(id) { document.querySelectorAll('.overlay.open').forEach(o => { if (o.id !== id && o.id !== 'ov-promo' && o.id !== 'ov-result') o.classList.remove('open'); }); $(id).classList.add('open'); playSound('ui'); }
function closeOv(id) { $(id).classList.remove('open'); }
function renderThemes() {
  const th = THEMES.find(x => x.id === S.theme) || THEMES[6];
  $('themeList').innerHTML = THEMES.map(x =>
    `<button class="theme-item ${x.id === S.theme ? 'on' : ''}" data-theme="${x.id}" style="--c1:${x.light};--c2:${x.dark}">
       <span class="sw"><span></span><span class="d"></span><span class="d"></span><span></span></span>
       <span class="nm">${S.lang === 'ar' ? x.ar : x.en}</span><span class="ck">✓</span></button>`).join('');
  const mb = $('miniBoard'); mb.style.setProperty('--c1', th.light); mb.style.setProperty('--c2', th.dark);
  mb.innerHTML = Array.from({ length: 16 }, (_, i) => `<span class="${((i >> 2) + (i & 3)) % 2 ? 'd' : ''}"></span>`).join('');
  $('tpName').textContent = S.lang === 'ar' ? th.ar : th.en;
  $('themePreview').style.setProperty('--tint', th.tint);
}
function setTheme(id) { S.theme = id; saveSettings(); applyTheme(); renderThemes(); playSound('ui'); }

/* ---------- views ---------- */
function showView(name) {
  $('view-home').classList.toggle('active', name === 'home');
  $('view-game').classList.toggle('active', name === 'game');
}

/* ---------- game lifecycle ---------- */
const cur = () => G.states[G.states.length - 1];
const canMove = () => G && !G.over && !G.thinking && !promoOpen && (!S.engineOn || cur().turn === G.human);

function startGame() {
  ac();
  const state = newState(S.pos);
  const human = S.side === 'r' ? (Math.random() < .5 ? 'w' : 'b') : S.side;
  G = {
    pos: S.pos, states: [state], moves: [], sans: [], keys: [posKey(state)], human,
    orient: S.engineOn ? human : 'w', over: false, thinking: false, token: 0,
    clock: { w: 0, b: 0 }, tickAt: performance.now(), lastMove: null, sel: -1, targets: new Map(), hint: null,
    eval: null
  };
  closeOv('ov-result');
  engine.newGame();
  showView('game');
  renderSquares(); rebuildPieces(); renderAll();
  if (S.engineOn && state.turn !== human) engineTurn();
  else if (S.engineOn && S.evalBar) analyzeCurrent();
}

function leaveGame() {
  if (G) { G.token++; G.thinking = false; engine.cancel(); }
  showView('home'); renderHome();
}

async function engineTurn() {
  if (!G || G.over) return;
  const token = ++G.token, s = cur();
  G.thinking = true; renderStatus(); renderCards();
  const t0 = performance.now();
  const r = await engine.go({ kind: 'play', state: s, fen: toFEN(s), level: S.level });
  const dt = performance.now() - t0;
  if (dt < 380) await sleep(380 - dt);
  if (!G || token !== G.token || G.over || r.cancelled) return;
  G.thinking = false;
  let m = findMove(s, r.best);
  if (!m) { const lm = legalMoves(s); m = lm[Math.floor(Math.random() * lm.length)]; }
  if (r.score) pushEval(r.score, s.turn);
  if (m) playMove(m);
}

function pushEval(score, turn) {
  const sign = turn === 'w' ? 1 : -1;
  G.eval = score.type === 'mate' ? { mate: score.v * sign, cp: null } : { cp: score.v * sign, mate: null };
  renderEval();
}
async function analyzeCurrent() {
  if (!S.evalBar || !G || G.over) return;
  const token = G.token, n = G.states.length, s = cur();
  const r = await engine.go({ kind: 'analyze', state: s, fen: toFEN(s), movetime: 300 });
  if (!G || r.cancelled || token !== G.token || n !== G.states.length || !r.score) return;
  pushEval(r.score, s.turn);
}
async function doHint() {
  if (!canMove()) return;
  const s = cur(), n = G.states.length, token = G.token;
  $('btnHint').disabled = true;
  const r = await engine.go({ kind: 'analyze', state: s, fen: toFEN(s), movetime: 700 });
  $('btnHint').disabled = false;
  if (!G || r.cancelled || token !== G.token || n !== G.states.length) return;
  const m = findMove(s, r.best);
  if (m) { G.hint = { from: m.from, to: m.flag === 'C' ? m.kdest : m.to }; refreshMarks(); }
  if (r.score) pushEval(r.score, s.turn);
}

function playMove(m) {
  const s = cur(), legal = legalMoves(s), san = toSAN(s, m, legal), n = makeMove(s, m);
  const wasCap = m.flag !== 'C' && (!!s.board[m.to] || m.flag === 'e');
  G.states.push(n); G.moves.push(m); G.sans.push(san); G.keys.push(posKey(n));
  G.lastMove = { from: m.from, to: m.flag === 'C' ? m.kdest : m.to };
  G.sel = -1; G.targets = new Map(); G.hint = null;
  animateMove(m, s);
  const st = gameStatus(n, G.keys), chk = inCheck(n);
  if (chk) playSound('check'); else if (wasCap) playSound('capture'); else playSound('move');
  if (wasCap && S.fx) burst(m.flag === 'e' ? m.to + (s.turn === 'w' ? -8 : 8) : m.to);
  renderAll();
  if (st.over) return finish(st);
  if (S.engineOn) {
    if (n.turn !== G.human) engineTurn();
    else if (S.evalBar) analyzeCurrent();
  } else if (S.evalBar) analyzeCurrent();
}

function finish(st, resignedBy) {
  G.over = true; G.token++; G.thinking = false; engine.cancel();
  let title, sub = '', icon = '♚\uFE0E', winner = st.winner;
  if (resignedBy) { winner = other(resignedBy); st = { type: 'resign' }; }
  if (winner) {
    if (S.engineOn) { title = winner === G.human ? t('youWin') : t('youLose'); }
    else title = winner === 'w' ? t('whiteWins') : t('blackWins');
    sub = st.type === 'mate' ? t('mate') : t('resigned');
  } else { title = t('drawTxt'); sub = t(st.type); icon = '♔\uFE0E'; }
  renderAll();
  playSound('end');
  setTimeout(() => {
    $('resIcon').textContent = icon; $('resTitle').textContent = title; $('resSub').textContent = sub;
    $('ov-result').classList.add('open');
  }, 650);
}

function undo() {
  if (!G || G.moves.length === 0) return;
  G.token++; G.thinking = false; engine.cancel();
  let n = 1;
  if (S.engineOn) n = cur().turn === G.human ? 2 : 1;
  n = Math.min(n, G.moves.length);
  for (let i = 0; i < n; i++) { G.states.pop(); G.moves.pop(); G.sans.pop(); G.keys.pop(); }
  G.over = false; G.sel = -1; G.targets = new Map(); G.hint = null;
  const lm = G.moves[G.moves.length - 1];
  G.lastMove = lm ? { from: lm.from, to: lm.flag === 'C' ? lm.kdest : lm.to } : null;
  closeOv('ov-result');
  rebuildPieces(); renderAll();
  if (S.engineOn && cur().turn !== G.human) engineTurn(); else if (S.evalBar) analyzeCurrent();
}

/* ---------- board rendering ---------- */
function dispToSq(x, y) { return G.orient === 'w' ? (7 - y) * 8 + x : y * 8 + (7 - x); }
function sqToDisp(sq) { const f = sq & 7, r = sq >> 3; return G.orient === 'w' ? { x: f, y: 7 - r } : { x: 7 - f, y: r }; }

function renderSquares() {
  const host = $('squares'); host.textContent = ''; sqEls = Array(64).fill(null);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const sq = dispToSq(x, y), d = document.createElement('div');
    d.className = 'sq' + (((sq & 7) + (sq >> 3)) % 2 === 0 ? ' d' : '');
    if (y === 7) { const i = document.createElement('i'); i.className = 'fl'; i.textContent = FILES[sq & 7]; d.appendChild(i); }
    if (x === 0) { const i = document.createElement('i'); i.className = 'rk'; i.textContent = (sq >> 3) + 1; d.appendChild(i); }
    host.appendChild(d); sqEls[sq] = d;
  }
}
function pieceEl(p) {
  const d = document.createElement('div');
  d.className = 'piece ' + (p === p.toUpperCase() ? 'w' : 'b');
  d.textContent = GLYPH[p.toUpperCase()];
  return d;
}
function placeEl(el, sq) { const { x, y } = sqToDisp(sq); el.style.transform = `translate3d(${x * 100}%,${y * 100}%,0)`; }
function rebuildPieces() {
  const host = $('pieces'); host.textContent = ''; pieceEls = Array(64).fill(null);
  cur().board.forEach((p, sq) => { if (!p) return; const el = pieceEl(p); placeEl(el, sq); host.appendChild(el); pieceEls[sq] = el; });
}
function repositionPieces() { pieceEls.forEach((el, sq) => { if (el) placeEl(el, sq); }); }

function animateMove(m, prev) {
  if (m.flag === 'C') {
    const k = pieceEls[m.from], r = pieceEls[m.to];
    pieceEls[m.from] = null; pieceEls[m.to] = null;
    pieceEls[m.kdest] = k; pieceEls[m.rdest] = r;
    placeEl(k, m.kdest); placeEl(r, m.rdest);
    return;
  }
  const el = pieceEls[m.from];
  let capSq = -1;
  if (m.flag === 'e') capSq = m.to + (prev.turn === 'w' ? -8 : 8); else if (pieceEls[m.to]) capSq = m.to;
  if (capSq >= 0 && pieceEls[capSq]) {
    const ce = pieceEls[capSq]; pieceEls[capSq] = null;
    ce.classList.add('gone'); setTimeout(() => ce.remove(), 280);
  }
  pieceEls[m.from] = null; pieceEls[m.to] = el;
  el.style.zIndex = 9; setTimeout(() => { el.style.zIndex = ''; }, 300);
  placeEl(el, m.to);
  if (m.promo) el.textContent = GLYPH[m.promo.toUpperCase()];
}

function burst(sq) {
  const { x, y } = sqToDisp(sq), host = $('fxLayer'), size = 12.5;
  for (let i = 0; i < 9; i++) {
    const p = document.createElement('div'), a = Math.random() * Math.PI * 2, d = 4 + Math.random() * 6;
    p.className = 'fx-particle';
    p.style.left = (x * size + size / 2) + '%'; p.style.top = (y * size + size / 2) + '%';
    p.style.setProperty('--dx', (Math.cos(a) * d) + 'cqw'); p.style.setProperty('--dy', (Math.sin(a) * d) + 'cqw');
    host.appendChild(p); setTimeout(() => p.remove(), 600);
  }
}

function computeTargets(sel) {
  const mv = legalMoves(cur()).filter(m => m.from === sel), map = new Map();
  for (const m of mv) if (m.flag !== 'C') {
    if (!map.has(m.to)) map.set(m.to, { kind: m.flag === 'c' || m.flag === 'e' ? 'cap' : 'tgt', moves: [] });
    map.get(m.to).moves.push(m);
  }
  for (const m of mv) if (m.flag === 'C') {
    map.set(m.to, { kind: 'rook', moves: [m] });
    if (m.kdest !== m.from && !map.has(m.kdest)) map.set(m.kdest, { kind: 'tgt', moves: [m] });
  }
  return map;
}

function refreshMarks() {
  sqEls.forEach(e => e && e.classList.remove('sel', 'last', 'chk', 'tgt', 'cap', 'rook', 'hint'));
  if (!G) return;
  if (G.lastMove) { sqEls[G.lastMove.from].classList.add('last'); sqEls[G.lastMove.to].classList.add('last'); }
  if (G.hint) { sqEls[G.hint.from].classList.add('hint'); sqEls[G.hint.to].classList.add('hint'); }
  const s = cur();
  if (inCheck(s)) sqEls[kingSq(s.board, s.turn)].classList.add('chk');
  if (G.sel >= 0) {
    sqEls[G.sel].classList.add('sel');
    G.targets.forEach((v, sq) => sqEls[sq].classList.add(v.kind));
  }
}

function capturedBy(color) {
  // pieces of the opponent that have been captured by `color`
  const enemy = other(color), counts = {};
  for (const p of cur().board) if (p && colorOf(p) === enemy) counts[p.toUpperCase()] = (counts[p.toUpperCase()] || 0) + 1;
  const list = []; let val = 0;
  for (const k of ['Q', 'R', 'B', 'N', 'P']) {
    const miss = Math.max(0, INIT_COUNT[k] - (counts[k] || 0));
    for (let i = 0; i < miss; i++) list.push(k);
    val += miss * PVAL[k.toLowerCase()];
  }
  return { list, val };
}

function renderCards() {
  if (!G) return;
  const top = other(G.orient), bot = G.orient;
  const info = c => {
    if (S.engineOn) {
      return c === G.human
        ? { name: S.name, sub: 'ELO ' + S.elo, me: true }
        : { name: t('computer'), sub: `${t('level')} ${S.level}`, me: false };
    }
    return { name: c === 'w' ? t('white') : t('black'), sub: '', me: c === bot };
  };
  const set = (pre, c) => {
    const i = info(c), av = $(pre + 'Avatar');
    $(pre + 'Name').textContent = i.name; $(pre + 'Sub').textContent = i.sub;
    if (S.engineOn && c !== G.human) { av.style.backgroundImage = 'none'; av.textContent = '♞\uFE0E'; }
    else if (S.engineOn) setAvatarEl(av, false);
    else { av.style.backgroundImage = 'none'; av.textContent = c === 'w' ? '♔\uFE0E' : '♚\uFE0E'; }
    const mine = capturedBy(c), theirs = capturedBy(other(c));
    const diff = Math.round((mine.val - theirs.val) / 100);
    const cls = other(c) === 'w' ? 'w' : 'b';
    $(pre + 'Cap').innerHTML = `<span class="${cls}" style="color:${cls === 'w' ? '#fff' : '#222'};-webkit-text-stroke:.5px ${cls === 'w' ? '#222' : '#aaa'}">${mine.list.map(k => GLYPH[k]).join('')}</span>${diff > 0 ? `<em>+${diff}</em>` : ''}`;
  };
  set(G.orient === 'w' ? 'top' : 'top', top); set('bot', bot);
  $('cardTop').classList.toggle('active', !G.over && cur().turn === top);
  $('cardBottom').classList.toggle('active', !G.over && cur().turn === bot);
  $('cardTop').classList.toggle('thinking', G.thinking && cur().turn === top);
  $('cardBottom').classList.toggle('thinking', G.thinking && cur().turn === bot);
  $('gLvlVal').textContent = S.level;
  $('gStepper').hidden = !S.engineOn;
  $('btnHint').disabled = false;
}
function renderMoves() {
  const host = $('moveStrip'); let h = '';
  G.sans.forEach((s, i) => {
    if (i % 2 === 0) h += `<span class="n">${i / 2 + 1}.</span>`;
    h += `<span class="${i === G.sans.length - 1 ? 'cur' : ''}">${s}</span>`;
  });
  host.innerHTML = h || '&nbsp;'; host.scrollLeft = host.scrollWidth;
}
function renderStatus() {
  if (!G) return;
  const s = cur(); let txt;
  if (G.over) txt = '';
  else if (G.thinking) txt = t('thinking') + ' …';
  else if (inCheck(s)) txt = t('checkTxt');
  else if (S.engineOn) txt = s.turn === G.human ? t('yourTurn') : t('thinking');
  else txt = s.turn === 'w' ? t('whiteTurn') : t('blackTurn');
  $('statusLine').textContent = txt;
}
function renderEval() {
  const bar = $('evalBar'), txt = $('evalText');
  bar.hidden = !S.evalBar; txt.hidden = !S.evalBar;
  if (!G || !S.evalBar) return;
  const e = G.eval || { cp: 0, mate: null };
  let p, label;
  if (e.mate !== null) { p = e.mate > 0 ? 1 : 0; label = (e.mate > 0 ? '+' : '-') + 'M' + Math.abs(e.mate); }
  else { p = 0.5 + 0.5 * Math.tanh(e.cp / 450); const v = e.cp / 100; label = (v > 0 ? '+' : '') + v.toFixed(1); }
  const fill = $('evalFill');
  fill.style.transformOrigin = G.orient === 'w' ? '50% 100%' : '50% 0%';
  fill.style.transform = `scaleY(${p.toFixed(3)})`;
  txt.textContent = label;
}
function renderAll() {
  if (!G) return;
  refreshMarks(); renderCards(); renderMoves(); renderStatus(); renderEval(); updateEngineBadge();
  $('gPos').textContent = G.pos;
}
function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; refreshMarks(); }); }

/* ---------- clock loop (requestAnimationFrame) ---------- */
let lastClockTxt = ['', ''];
function tick(now) {
  if (G) {
    const dt = Math.min(now - G.tickAt, 1000); G.tickAt = now;
    if (!G.over) G.clock[cur().turn] += dt;
    const top = other(G.orient), a = mmss(G.clock[top]), b = mmss(G.clock[G.orient]);
    if (a !== lastClockTxt[0]) { $('topClock').textContent = a; lastClockTxt[0] = a; }
    if (b !== lastClockTxt[1]) { $('botClock').textContent = b; lastClockTxt[1] = b; }
  }
  requestAnimationFrame(tick);
}

/* ---------- board interaction (tap + drag, pointer events) ---------- */
function sqFromEvent(e) {
  const r = $('board').getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * 8), y = Math.floor((e.clientY - r.top) / r.height * 8);
  if (x < 0 || x > 7 || y < 0 || y > 7) return -1;
  return dispToSq(x, y);
}
function tryMove(target) {
  const entry = G.targets.get(target); if (!entry) return false;
  if (entry.moves.length > 1) openPromo(entry.moves, m => playMove(m));
  else playMove(entry.moves[0]);
  return true;
}
function openPromo(moves, cb) {
  promoOpen = true;
  const color = cur().turn, host = $('promoRow');
  host.innerHTML = ['q', 'r', 'b', 'n'].map(p =>
    `<button data-p="${p}" style="color:${color === 'w' ? '#fff' : '#1d1d22'};-webkit-text-stroke:1px ${color === 'w' ? '#222' : '#ccc'}">${GLYPH[p.toUpperCase()]}</button>`).join('');
  host.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    const m = moves.find(x => x.promo === b.dataset.p);
    promoOpen = false; closeOv('ov-promo'); host.onclick = null; cb(m);
  };
  $('ov-promo').classList.add('open');
}

function onDown(e) {
  if (!G || !canMove() || e.button > 0) return;
  const sq = sqFromEvent(e); if (sq < 0) return;
  const s = cur(), p = s.board[sq];
  if (G.sel >= 0 && G.targets.has(sq) && !(p && colorOf(p) === s.turn && G.targets.get(sq).kind !== 'rook')) { tryMove(sq); return; }
  if (p && colorOf(p) === s.turn) {
    const was = G.sel === sq;
    G.sel = sq; G.targets = computeTargets(sq); G.hint = null; refreshMarks();
    const el = pieceEls[sq];
    const rect = $('board').getBoundingClientRect();
    drag = { sq, el, was, moved: false, sx: e.clientX, sy: e.clientY, rect, id: e.pointerId, raf: 0, x: 0, y: 0 };
    try { $('board').setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  } else { G.sel = -1; G.targets = new Map(); refreshMarks(); }
}
function onMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) { drag.moved = true; drag.el.classList.add('drag'); }
  if (!drag.moved) return;
  const size = drag.rect.width / 8;
  drag.x = e.clientX - drag.rect.left - size / 2; drag.y = e.clientY - drag.rect.top - size / 2;
  if (!drag.raf) drag.raf = requestAnimationFrame(() => {
    if (!drag) return;
    drag.raf = 0; drag.el.style.transform = `translate3d(${drag.x}px,${drag.y}px,0) scale(1.12)`;
  });
}
function onUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag; drag = null;
  if (d.raf) cancelAnimationFrame(d.raf);
  try { $('board').releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (d.moved) {
    d.el.classList.remove('drag');
    const target = sqFromEvent(e);
    if (target >= 0 && target !== d.sq && G.targets.has(target)) {
      const entry = G.targets.get(target);
      if (entry.moves.length === 1 && entry.moves[0].flag !== 'C') {
        // place instantly under the finger, then let playMove slide it the rest of the way
        placeEl(d.el, d.sq);
      } else placeEl(d.el, d.sq);
      tryMove(target);
    } else placeEl(d.el, d.sq);
  } else if (d.was) { G.sel = -1; G.targets = new Map(); refreshMarks(); }
}

/* ---------- avatar upload ---------- */
function handleAvatar(file) {
  if (!file) return;
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'), n = 256; c.width = c.height = n;
      const side = Math.min(img.width, img.height), sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      c.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, n, n);
      S.avatar = c.toDataURL('image/jpeg', 0.86); saveSettings(); renderHome(); if (G) renderCards();
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

/* ---------- init ---------- */
function initUI() {
  loadSettings(); applyTheme();
  engine = new Engine();
  engine.init().then(() => { updateEngineBadge(); });

  // overlays
  document.querySelectorAll('.overlay').forEach(o => o.addEventListener('pointerdown', e => {
    if (e.target === o && o.id !== 'ov-promo' && o.id !== 'ov-result') closeOv(o.id);
  }));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeOv(b.closest('.overlay').id)));
  $('openSettings').onclick = $('gSettings').onclick = () => openOv('ov-settings');
  $('openThemes').onclick = () => openOv('ov-themes');
  $('openSounds').onclick = () => openOv('ov-sounds');
  $('goThemes').onclick = () => openOv('ov-themes');
  $('goSounds').onclick = () => openOv('ov-sounds');

  // generic toggles
  document.querySelectorAll('[data-setting]').forEach(inp => inp.addEventListener('change', () => {
    const key = inp.dataset.setting; S[key] = inp.checked; saveSettings(); syncSettings();
    if (key === 'sounds' && S.sounds) { ac(); playSound('ui'); }
    if (key === 'evalBar') { renderEval(); if (G && S.evalBar) analyzeCurrent(); }
    if (key === 'engineOn' && G && !G.over) {
      if (S.engineOn && cur().turn !== G.human && !G.thinking) engineTurn();
      else if (!S.engineOn && G.thinking) { G.token++; G.thinking = false; engine.cancel(); }
      renderAll();
    }
  }));
  $('langSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.lang = b.dataset.lang; saveSettings(); applyLang(); };
  $('modeSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.engineOn = b.dataset.mode === 'cpu'; saveSettings(); syncSettings();
    if (G && !G.over) { if (S.engineOn && cur().turn !== G.human && !G.thinking) engineTurn(); renderAll(); }
  };
  $('sideSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.side = b.dataset.side; saveSettings(); syncSettings(); };

  // level
  $('lvlMinus').onclick = $('gLvlMinus').onclick = () => setLevel(S.level - 1);
  $('lvlPlus').onclick = $('gLvlPlus').onclick = () => setLevel(S.level + 1);

  // position selector
  $('slotGrid').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.slot = +b.dataset.slot; S.pos = S.slots[S.slot]; saveSettings(); renderHome(); };
  $('posInput').onchange = () => setPos($('posInput').value);
  $('resetBtn').onclick = () => { setPos(Math.floor(Math.random() * 960)); playSound('ui'); };
  $('startBtn').onclick = startGame;

  // themes
  $('themeList').onclick = e => { const b = e.target.closest('button'); if (b) setTheme(b.dataset.theme); };
  $('themeNext').onclick = () => { const i = THEMES.findIndex(x => x.id === S.theme); setTheme(THEMES[(i + 1) % THEMES.length].id); };

  // profile
  $('avatarInput').onchange = e => handleAvatar(e.target.files[0]);
  $('nameInput').oninput = () => { S.name = $('nameInput').value; saveSettings(); setAvatarEl($('avatarImg'), true); };

  // game controls
  $('gBack').onclick = leaveGame;
  $('btnUndo').onclick = undo;
  $('btnHint').onclick = doHint;
  $('btnFlip').onclick = () => {
    if (!G) return; G.orient = other(G.orient); renderSquares(); repositionPieces(); renderAll();
  };
  $('btnRestart').onclick = startGame;
  $('btnResign').onclick = () => { if (G && !G.over && confirm(t('resignConfirm'))) finish({ type: 'resign' }, S.engineOn ? G.human : cur().turn); };
  $('resAgain').onclick = startGame;
  $('resHome').onclick = () => { closeOv('ov-result'); leaveGame(); };

  // board
  const b = $('board');
  b.addEventListener('pointerdown', onDown);
  b.addEventListener('pointermove', onMove);
  b.addEventListener('pointerup', onUp);
  b.addEventListener('pointercancel', onUp);
  b.addEventListener('contextmenu', e => e.preventDefault());

  applyLang(); syncSettings();
  requestAnimationFrame(tick);
  if (engine.ready) engine.ready.then(updateEngineBadge);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUI); else initUI();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { startPosition, newState, fromFEN, toFEN, legalMoves, makeMove, perft, toSAN, gameStatus, inCheck, builtinSearch, findMove, posKey, sqName };
}
