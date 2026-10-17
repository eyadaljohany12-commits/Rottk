// State Management
const state = {
    currentScreen: 'screen-splash',
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
    state.currentScreen = screenId;
}

// --- Theme Management ---
function setTheme(themeName) {
    document.body.setAttribute('data-theme', themeName);
    state.theme = themeName;
    localStorage.setItem('chess960_theme', themeName);
    navigate('screen-menu');
}

// --- Chess 960 Generation (Lichess Standard) ---
function generate960FEN() {
    const pieces = new Array(8).fill(null);
    const emptyIndices = [0, 1, 2, 3, 4, 5, 6, 7];
    
    function getRandom(arr) {
        const i = Math.floor(Math.random() * arr.length);
        return arr.splice(i, 1)[0];
    }

    // 1. Bishops on opposite colors
    const lightSquares = [0, 2, 4, 6];
    const darkSquares = [1, 3, 5, 7];
    pieces[getRandom(lightSquares)] = 'B';
    pieces[getRandom(darkSquares)] = 'B';

    // 2. Queen on remaining empty square
    const remaining1 = pieces.map((p, i) => p === null ? i : null).filter(val => val !== null);
    pieces[getRandom(remaining1)] = 'Q';

    // 3. Knights on remaining empty squares
    const remaining2 = pieces.map((p, i) => p === null ? i : null).filter(val => val !== null);
    pieces[getRandom(remaining2)] = 'N';
    pieces[getRandom(remaining2)] = 'N';

    // 4. Rooks and King (King must be between rooks)
    const remaining3 = pieces.map((p, i) => p === null ? i : null).filter(val => val !== null);
    pieces[remaining3[0]] = 'R';
    pieces[remaining3[1]] = 'K';
    pieces[remaining3[2]] = 'R';

    const placement = pieces.join('').toLowerCase();
    // Castling rights in 960 use the files of the rooks and king
    const rook1File = String.fromCharCode(65 + pieces.indexOf('R'));
    const kingFile = String.fromCharCode(65 + pieces.indexOf('K'));
    const rook2File = String.fromCharCode(65 + pieces.lastIndexOf('R'));
    
    return `${placement}/pppppppp/8/8/8/8/PPPPPPPP/${placement.toUpperCase()} w ${rook1File}${kingFile}${rook2File}${rook1File}${kingFile}${rook2File} - 0 1`;
}

function randomize960() {
    if (!state.game) state.game = new Chess();
    const fen = generate960FEN();
    state.game.load(fen);
    renderBoard();
}

// --- Game Initialization ---
function startGame() {
    state.game = new Chess(); // Standard chess.js lacks full 960, so we use it for movement rules
    const fen = generate960FEN();
    state.game.load(fen);
    navigate('screen-game');
    renderBoard();
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
            
            // Map algebraic to indices (for click detection)
            const file = String.fromCharCode(97 + cIndex); // a-h
            const rank = 8 - rIndex;
            squareDiv.dataset.square = `${file}${rank}`;
            
            if (piece) {
                const color = piece.color === 'w' ? 'w' : 'b';
                const type = piece.type.toUpperCase();
                // Unicode pieces
                const symbols = { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' };
                squareDiv.innerText = color === 'w' ? symbols[type] : symbols[type].replace(/[\u265F-\u265A]/g, c => String.fromCharCode(c.charCodeAt(0) + 6));
                // Fix Unicode mapping for specific pieces to ensure white and black match standard layouts
                if(color === 'w') {
                    const whiteSymbols = { p: '♙', r: '♖', n: '♘', b: '♗', q: '♕', k: '♔' };
                    squareDiv.innerText = whiteSymbols[type];
                } else {
                    const blackSymbols = { p: '♟', r: '♜', n: '♞', b: '♝', q: '♛', k: '♚' };
                    squareDiv.innerText = blackSymbols[type];
                }
            }

            squareDiv.onclick = () => handleSquareClick(squareDiv.dataset.square);
            state.boardElement.appendChild(squareDiv);
        });
    });
}

// --- Move Handling ---
function handleSquareClick(square) {
    if (state.selectedSquare) {
        // Attempt move
        const move = state.game.move({
            from: state.selectedSquare,
            to: square,
            promotion: 'q' // Always promote to queen for simplicity
        });

        if (move) {
            if (state.soundEnabled) playSound('move');
            state.selectedSquare = null;
            renderBoard();
            checkGameOver();
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
    renderBoard(); // Reset board
    const moves = state.game.moves({ square: square, verbose: true });
    
    // Highlight selected
    document.querySelectorAll(`[data-square="${square}"]`)[0].classList.add('selected');
    
    // Highlight valid moves
    moves.forEach(move => {
        const targetSquare = document.querySelector(`[data-square="${move.to}"]`);
        if (targetSquare) {
            targetSquare.classList.add(move.captured ? 'capture-move' : 'valid-move');
        }
    });
}

// --- Stockfish WASM Integration ---
function initStockfish() {
    if (state.stockfish) return;
    
    try {
        // Load stockfish from CDN via Web Worker
        state.stockfish = new Worker('https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js');
        
        state.stockfish.onmessage = function(event) {
            const msg = event.data;
            if (msg.startsWith('bestmove')) {
                const bestMove = msg.split(' ')[1];
                if (bestMove) {
                    const from = bestMove.substring(0, 2);
                    const to = bestMove.substring(2, 4);
                    const promotion = bestMove.length > 4 ? bestMove[4] : 'q';
                    
                    // Execute engine move
                    setTimeout(() => {
                        state.game.move({ from, to, promotion });
                        if (state.soundEnabled) playSound('move');
                        renderBoard();
                        checkGameOver();
                    }, 300);
                }
            }
        };
        
        // Initialize UCI protocol
        state.stockfish.postMessage('uci');
        state.stockfish.postMessage('setoption name Skill Level value ' + state.engineLevel);
        state.stockfish.postMessage('isready');
    } catch (e) {
        console.error("Stockfish failed to load. Check CORS or network.", e);
        document.getElementById('engine-status').innerText = "المحرك غير متصل";
    }
}

function askStockfish() {
    if (!state.stockfish || state.game.game_over()) return;
    
    document.getElementById('engine-status').innerText = "جاري التفكير...";
    state.stockfish.postMessage('position fen ' + state.game.fen());
    
    // Calculate depth based on level
    const depth = Math.min(15, Math.floor(state.engineLevel / 2) + 3);
    state.stockfish.postMessage(`go depth ${depth}`);
}

// --- Utility & Settings ---
function changeLevel(dir) {
    state.engineLevel = Math.max(1, Math.min(20, state.engineLevel + dir));
    document.getElementById('engine-level').innerText = state.engineLevel;
    if (state.stockfish) {
        state.stockfish.postMessage('setoption name Skill Level value ' + state.engineLevel);
    }
}

function toggleSound(val) {
    state.soundEnabled = val;
}

function playSound(type) {
    // Simple AudioContext beep for move validation
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if(type === 'move') {
        osc.frequency.setValueAtTime(400, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.1);
    } else if (type === 'capture') {
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.15);
    }
    
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
}

function checkGameOver() {
    if (state.game.game_over()) {
        let msg = "انتهت اللعبة";
        if (state.game.in_checkmate()) msg = state.game.turn() === 'w' ? "كش مات! الأسود فاز" : "كش مات! الأبيض فاز";
        else if (state.game.in_draw()) msg = "تعادل";
        alert(msg);
    }
}

// --- Avatar Upload Logic ---
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
    // Restore Theme
    const savedTheme = localStorage.getItem('chess960_theme');
    if (savedTheme) {
        document.body.setAttribute('data-theme', savedTheme);
    }
    
    // Restore Avatar
    const savedAvatar = localStorage.getItem('chess960_avatar');
    if (savedAvatar) {
        document.getElementById('profile-avatar').src = savedAvatar;
        document.getElementById('menu-avatar').src = savedAvatar;
    }

    // Pre-generate a game instance
    state.game = new Chess();
    state.game.load(generate960FEN());
};
