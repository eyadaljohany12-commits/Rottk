// --- State Management ---
const state = {
    theme: 'wood',
    engineLevel: 10,
    soundEnabled: true,
    game: null,
    boardElement: document.getElementById('chessboard'),
    selectedSquare: null,
    stockfish: null
};

// --- UI Navigation ---
function navigate(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

// --- Theme Management ---
function setTheme(themeName) {
    document.body.setAttribute('data-theme', themeName);
    localStorage.setItem('chess960_theme', themeName);
    navigate('screen-menu');
}

// --- Chess 960 Generation (Fischer Random) ---
function generate960FEN() {
    const pieces = new Array(8).fill(null);
    const empty = [0, 1, 2, 3, 4, 5, 6, 7];
    
    // Helper function to pick random and remove
    const pickRandom = (arr) => {
        const i = Math.floor(Math.random() * arr.length);
        return arr.splice(i, 1)[0];
    };

    // 1. Bishops on opposite colors
    const lightSq = [0, 2, 4, 6];
    const darkSq = [1, 3, 5, 7];
    pieces[pickRandom(lightSq)] = 'b';
    pieces[pickRandom(darkSq)] = 'b';

    // 2. Queen on remaining
    const avail1 = pieces.map((p, i) => p === null ? i : null).filter(v => v !== null);
    pieces[pickRandom(avail1)] = 'q';

    // 3. Knights on remaining
    const avail2 = pieces.map((p, i) => p === null ? i : null).filter(v => v !== null);
    pieces[pickRandom(avail2)] = 'n';
    pieces[pickRandom(avail2)] = 'n';

    // 4. Rooks and King (King must be between rooks)
    const avail3 = pieces.map((p, i) => p === null ? i : null).filter(v => v !== null);
    pieces[avail3[0]] = 'r';
    pieces[avail3[1]] = 'k';
    pieces[avail3[2]] = 'r';

    const placement = pieces.join('');
    // Return standard FEN for chess.js compatibility (ignores 960 castling rights for stability)
    return `${placement}/pppppppp/8/8/8/8/PPPPPPPP/${placement.toUpperCase()} w KQkq - 0 1`;
}

function randomize960() {
    state.game = new Chess();
    state.game.load(generate960FEN());
    renderBoard();
    document.getElementById('fen-display').innerText = state.game.fen();
}

// --- Game Initialization ---
function startGame() {
    state.game = new Chess();
    state.game.load(generate960FEN());
    navigate('screen-game');
    renderBoard();
    document.getElementById('fen-display').innerText = state.game.fen();
    initStockfish();
}

// --- Board Rendering ---
function renderBoard() {
    state.boardElement.innerHTML = '';
    const board = state.game.board();
    
    board.forEach((row, rIndex) => {
        row.forEach((piece, cIndex) => {
            const squareDiv = document.createElement('div');
            const isLight = (rIndex + cIndex) % 2 === 0;
            squareDiv.className = `square ${isLight ? 'light' : 'dark'}`;
            
            const file = String.fromCharCode(97 + cIndex);
            const rank = 8 - rIndex;
            squareDiv.dataset.square = `${file}${rank}`;
            
            if (piece) {
                const color = piece.color;
                const type = piece.type;
                const symbols = { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' };
                const whiteSymbols = { p: '♙', r: '♖', n: '♘', b: '♗', q: '♕', k: '♔' };
                squareDiv.innerText = color === 'w' ? whiteSymbols[type] : symbols[type];
            }

            squareDiv.onclick = () => handleSquareClick(squareDiv.dataset.square);
            state.boardElement.appendChild(squareDiv);
        });
    });
}

// --- Move Handling ---
function handleSquareClick(square) {
    // If a piece is already selected, try to move
    if (state.selectedSquare) {
        const move = state.game.move({
            from: state.selectedSquare,
            to: square,
            promotion: 'q'
        });

        if (move) {
            if (state.soundEnabled) playSound('move');
            state.selectedSquare = null;
            renderBoard();
            document.getElementById('fen-display').innerText = state.game.fen();
            
            if (checkGameOver()) return;
            askStockfish();
            return;
        }
    }

    // Select piece
    const piece = state.game.get(square);
    if (piece && piece.color === state.game.turn()) {
        state.selectedSquare = square;
        highlightMoves(square);
    } else {
        state.selectedSquare = null;
        renderBoard();
    }
}

function highlightMoves(square) {
    renderBoard();
    const moves = state.game.moves({ square: square, verbose: true });
    document.querySelector(`[data-square="${square}"]`).classList.add('selected');
    
    moves.forEach(move => {
        const target = document.querySelector(`[data-square="${move.to}"]`);
        if (target) target.classList.add(move.captured ? 'capture-move' : 'valid-move');
    });
}

// --- Stockfish WASM Integration ---
function initStockfish() {
    if (state.stockfish) return;
    document.getElementById('engine-status').innerText = "جاري تحميل المحرك...";
    
    try {
        // Load Stockfish via Web Worker
        // Using a reliable CDN that supports cross-origin workers
        state.stockfish = new Worker('https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js');
        
        state.stockfish.onmessage = function(event) {
            const msg = event.data;
            if (msg.startsWith('bestmove')) {
                const bestMove = msg.split(' ')[1];
                if (bestMove && bestMove !== '(none)') {
                    const from = bestMove.substring(0, 2);
                    const to = bestMove.substring(2, 4);
                    const promotion = bestMove.length > 4 ? bestMove[4] : 'q';
                    
                    setTimeout(() => {
                        state.game.move({ from, to, promotion });
                        if (state.soundEnabled) playSound('move');
                        renderBoard();
                        document.getElementById('fen-display').innerText = state.game.fen();
                        document.getElementById('engine-status').innerText = "جاهز";
                        checkGameOver();
                    }, 300);
                }
            }
        };
        
        state.stockfish.postMessage('uci');
        state.stockfish.postMessage('setoption name Skill Level value ' + state.engineLevel);
        state.stockfish.postMessage('isready');
        document.getElementById('engine-status').innerText = "جاهز";
    } catch (e) {
        console.error("Stockfish failed to load:", e);
        document.getElementById('engine-status').innerText = "المحرك غير متصل";
    }
}

function askStockfish() {
    if (!state.stockfish || state.game.game_over()) return;
    
    document.getElementById('engine-status').innerText = "جاري التفكير...";
    state.stockfish.postMessage('position fen ' + state.game.fen());
    const depth = Math.min(15, Math.floor(state.engineLevel / 2) + 3);
    state.stockfish.postMessage(`go depth ${depth}`);
}

// --- Utilities ---
function changeLevel(dir) {
    state.engineLevel = Math.max(1, Math.min(20, state.engineLevel + dir));
    document.getElementById('engine-level').innerText = state.engineLevel;
    if (state.stockfish) {
        state.stockfish.postMessage('setoption name Skill Level value ' + state.engineLevel);
    }
}

function toggleSound(val) {
    if(typeof val === 'boolean') state.soundEnabled = val;
    else state.soundEnabled = !state.soundEnabled;
}

function playSound(type) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.frequency.setValueAtTime(type === 'move' ? 400 : 250, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
    } catch(e) { console.log("Audio not supported"); }
}

function checkGameOver() {
    if (state.game.game_over()) {
        let msg = "انتهت اللعبة";
        if (state.game.in_checkmate()) msg = state.game.turn() === 'w' ? "كش مات! الأسود فاز" : "كش مات! الأبيض فاز";
        else if (state.game.in_draw()) msg = "تعادل";
        setTimeout(() => alert(msg), 100);
        return true;
    }
    return false;
}

// --- Avatar Upload ---
document.getElementById('avatar-upload').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(event) {
            const base64Image = event.target.result;
            document.getElementById('profile-avatar').src = base64Image;
            document.getElementById('menu-avatar').src = base64Image;
            localStorage.setItem('chess960_avatar', base64Image);
        };
        reader.readAsDataURL(file);
    }
});

// --- Initialization on Load ---
window.onload = () => {
    const savedTheme = localStorage.getItem('chess960_theme');
    if (savedTheme) document.body.setAttribute('data-theme', savedTheme);
    
    const savedAvatar = localStorage.getItem('chess960_avatar');
    if (savedAvatar) {
        document.getElementById('profile-avatar').src = savedAvatar;
        document.getElementById('menu-avatar').src = savedAvatar;
    }
};
