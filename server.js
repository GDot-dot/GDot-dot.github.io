// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { // 允許跨域連線，方便本地開發或前後端分離部署
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- 遊戲設定常量 ---
const GRID_SIZE = 10;
const MINE_COUNT_PER_PLAYER = 3;
const HIGHLAND_CELL_COUNT = 30;
const WORMHOLE_COUNT = 4;
const STAIRWAY_COUNT = 4;
const INITIAL_CARDS = 4;

const CARDS = {
    'Double Jeopardy': { name: "雙重危機", type: "attack", description: "對手下回合必須踩兩個格子", immediate: true },
    'Blackout': { name: "黑暗視野", type: "attack", description: "對手下回合視野將被黑暗籠罩，無法進行任何操作", immediate: true },
    'Shield': { name: "護盾", type: "support", description: "抵銷下一次踩到的地雷，使用後結束本回合", immediate: true },
    'Premonition': { name: "神之預感", type: "support", description: "安全地查看一個格子的內容 (使用後本回合可繼續行動)", target: "cell" },
    'Relocate': { name: "轉移陣地", type: "support", description: "清除自己的一個標記，並重新佔領一個格子，之後結束本回合", target: "own_cell" },
    'Skip': { name: "跳過回合", type: "support", description: "直接結束你的回合", immediate: true },
    'Mine Shift': { name: "地雷遷移", type: "chaos", description: "隨機一個地雷與一個安全格交換位置 (使用後本回合可繼續行動)", immediate: true },
    'Decoy': { name: "假情報", type: "chaos", description: "在一個未揭示的格子上放置假地雷，之後結束本回合", target: "cell" }
};
const CARD_DECK = Object.keys(CARDS);
const CARDS_THAT_END_TURN_IMMEDIATELY = ['Shield', 'Skip', 'Double Jeopardy', 'Blackout'];

// --- 伺服器狀態 ---
app.use(express.static('public'));
let gameRooms = {}; // 存放所有遊戲房間的狀態

// --- Socket.IO 連線處理 ---
io.on('connection', (socket) => {
    console.log(`一個玩家已連接: ${socket.id}`);

    // --- 尋找或建立遊戲房間 ---
    let roomId = Object.keys(gameRooms).find(id => gameRooms[id] && gameRooms[id].players.length === 1);

    if (roomId) {
        // 加入現有房間
        const room = gameRooms[roomId];
        room.players.push({ id: socket.id, role: 'B' });
        socket.join(roomId);
        console.log(`玩家 ${socket.id} 加入房間 ${roomId} (玩家 B)`);

        // 初始化遊戲狀態並開始遊戲
        room.state = createNewGameState();
        io.to(roomId).emit('gameStart', {
            state: room.state,
            players: room.players.map(p => ({ id: p.id, role: p.role }))
        });
    } else {
        // 建立新房間
        roomId = `room-${socket.id}`;
        gameRooms[roomId] = {
            players: [{ id: socket.id, role: 'A' }],
            state: null
        };
        socket.join(roomId);
        console.log(`玩家 ${socket.id} 建立房間 ${roomId} (玩家 A)`);
        socket.emit('waitingForOpponent');
    }

    socket.data.roomId = roomId;

    // --- 監聽玩家操作 ---
    socket.on('playerAction', (action) => {
        const room = gameRooms[socket.data.roomId];
        if (!room || !room.state) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        
        // 核心操作處理函數
        handlePlayerAction(room, player.role, action);
    });

    socket.on('restartRequest', () => {
        const room = gameRooms[socket.data.roomId];
        if (!room || room.players.length < 2) return;
        
        room.state = createNewGameState();
        io.to(socket.data.roomId).emit('gameStart', {
            state: room.state,
            players: room.players.map(p => ({ id: p.id, role: p.role }))
        });
    });

    socket.on('disconnect', () => {
        console.log(`一個玩家已斷線: ${socket.id}`);
        const roomId = socket.data.roomId;
        if (gameRooms[roomId]) {
            io.to(roomId).emit('opponentDisconnected');
            delete gameRooms[roomId];
            console.log(`房間 ${roomId} 已銷毀`);
        }
    });
});

// --- 核心遊戲邏輯函數 ---

function handlePlayerAction(room, playerRole, action) {
    const state = room.state;
    
    // 驗證操作合法性
    if (state.gameState === 'GAMEOVER' || state.gameState === 'TIE') return;
    if (state.turn !== playerRole) return; // 不是你的回合

    // 清除上一條提示
    state.prompt = null;
    
    switch (action.type) {
        case 'cellClick':
            if (state.actionState.type === 'targeting') {
                handleCardTarget(state, state.board[action.payload.id]);
            } else if (state.actionState.type === 'relocating') {
                handleRelocateStep2(state, state.board[action.payload.id]);
            } else if (state.gameState === 'PLACING') {
                handleMinePlacement(state, state.board[action.payload.id]);
            } else if (state.gameState === 'TURN') {
                const cell = state.board[action.payload.id];
                if (!cell.isRevealed) {
                    stepOnCell(state, cell);
                }
            }
            break;
        case 'playCard':
            if (state.actionState.type === 'none') {
                onCardPlay(state, playerRole, action.payload.cardName);
            }
            break;
    }
    
    // 操作完成後，廣播最新的遊戲狀態
    io.to(room.players.map(p => p.id)).emit('gameStateUpdate', state);
}

function handleMinePlacement(state, cell) {
    if (cell.isWormhole || cell.isStairway || cell.isMine) {
        state.prompt = "不能將地雷埋在特殊地形或已埋設地雷的格子！";
        return;
    }
    cell.isMine = true;
    state.minePlacementCount++;
    if (state.minePlacementCount >= MINE_COUNT_PER_PLAYER * 2) {
        state.gameState = 'TURN';
        state.turn = 'A';
    } else {
        state.turn = (state.turn === 'A') ? 'B' : 'A';
    }
}

function onCardPlay(state, player, cardName) {
    const cardIndex = state.players[player].hand.indexOf(cardName);
    if (cardIndex === -1) return;
    state.players[player].hand.splice(cardIndex, 1);
    
    const card = CARDS[cardName];
    if (card.immediate) {
        executeImmediateCard(state, player, cardName);
        if (CARDS_THAT_END_TURN_IMMEDIATELY.includes(cardName)) {
             endTurn(state);
        }
    } else { // 需要目標的卡牌
        state.actionState = { type: 'targeting', card: cardName, player: player, message: `玩家 ${player} 使用 ${card.name}，請選擇目標` };
    }
}

function executeImmediateCard(state, player, cardName) {
    const opponent = player === 'A' ? 'B' : 'A';
    switch(cardName) {
        case 'Shield':
            state.players[player].shield++;
            state.prompt = `玩家 ${player} 獲得了護盾！`;
            break;
        case 'Skip':
            state.prompt = `玩家 ${player} 跳過了此回合。`;
            break;
        case 'Mine Shift':
            const mines = state.board.filter(c => !c.isRevealed && c.isMine);
            const safe = state.board.filter(c => !c.isRevealed && !c.isMine && !c.isWormhole && !c.isStairway);
            if (mines.length > 0 && safe.length > 0) {
                const mineToMove = mines[0];
                const safeToSwap = safe[0];
                mineToMove.isMine = false;
                safeToSwap.isMine = true;
                state.prompt = "地雷位置已暗中改變！";
            } else {
                state.prompt = "場上沒有可遷移的地雷或安全格！";
            }
            break;
        case 'Double Jeopardy':
            state.doubleJeopardyState = { active: true, player: opponent, steps: 2 };
            state.prompt = `玩家 ${opponent} 下回合將面臨雙重危機！`;
            break;
        case 'Blackout':
            state.prompt = `黑暗壟罩！玩家 ${opponent} 的下個回合將被跳過！`;
            state.blackoutFor = opponent;
            break;
    }
}

function handleCardTarget(state, targetCell) {
    const { card, player } = state.actionState;
    const resetAction = () => { state.actionState = { type: 'none' }; };

    switch(card) {
        case 'Premonition':
            const isDangerous = targetCell.isMine || targetCell.isWormhole;
            state.prompt = `預感：該格...${isDangerous ? '非常危險' : '似乎安全'}。`;
            resetAction(); // 預感不結束回合
            break;
        case 'Decoy':
            if (!targetCell.isRevealed) {
                targetCell.isDecoy = true;
                state.prompt = `假情報已設置！`;
                endTurn(state); // 結束回合
            } else {
                state.prompt = `無法在已揭示的格子設置！`;
                resetAction();
            }
            break;
        case 'Relocate':
            if (targetCell.isRevealed && targetCell.revealedBy === player) {
                targetCell.isRevealed = false;
                targetCell.revealedBy = null;
                state.actionState = { type: 'relocating', player: player, message: `玩家 ${player} 請選擇新位置部署` };
            } else {
                state.prompt = "只能選擇自己的標記！";
                resetAction();
            }
            break;
    }
}

function handleRelocateStep2(state, targetCell) {
    if (targetCell.isRevealed) {
        state.prompt = "不能部署在已揭示的格子！";
        state.actionState.message = `玩家 ${state.turn} 請選擇一個未揭示的格子部署`;
        return;
    }
    targetCell.isRevealed = true;
    targetCell.revealedBy = state.turn;
    state.prompt = `玩家 ${state.turn} 已成功轉移陣地！`;
    endTurn(state); // 結束回合
}

function stepOnCell(state, cell) {
    if (cell.isWormhole) { handleWormhole(state, cell); return; }
    
    cell.isRevealed = true;
    if (cell.isMine) {
        if (state.players[state.turn].shield > 0) {
            state.players[state.turn].shield--;
            cell.revealedBy = 'shield';
            state.prompt = `玩家 ${state.turn} 的護盾擋下了一劫！`;
            processStepCompletion(state);
        } else {
            cell.revealedBy = state.turn;
            gameOver(state, state.turn === 'A' ? 'B' : 'A');
        }
    } else if (cell.isDecoy) {
        cell.revealedBy = state.turn;
        state.prompt = "哈！這只是一個假地雷！";
        cell.isDecoy = false;
        processStepCompletion(state);
    } else {
        cell.revealedBy = state.turn;
        if (cell.isStairway) {
            state.prompt = `通過樓梯前往${cell.layer === 'ground' ? '高地' : '地面'}！`;
        }
        processStepCompletion(state);
    }
    checkTieCondition(state);
}

function handleWormhole(state, cell) {
    cell.isRevealed = true;
    cell.revealedBy = state.turn;
    drawCard(state, state.turn);
    state.prompt = '你勇敢地跳入蟲洞，並獲得了一張新卡牌作為獎勵！';
    
    const unrevealed = state.board.filter(c => !c.isRevealed && c.id !== cell.id);
    if (unrevealed.length > 0) {
        const targetCell = unrevealed[Math.floor(Math.random() * unrevealed.length)];
        // 伺服器延遲一下再處理降落，讓客戶端有時間顯示蟲洞動畫
        setTimeout(() => {
            landOnCell(state, targetCell);
            io.to(Object.keys(gameRooms).find(id => gameRooms[id] && gameRooms[id].state === state)).emit('gameStateUpdate', state);
        }, 1500);
    } else {
        processStepCompletion(state);
    }
}

function landOnCell(state, cell) {
    if (cell.isMine) {
        if (state.players[state.turn].shield > 0) {
            state.players[state.turn].shield--;
            cell.revealedBy = 'shield';
            state.prompt = `幸運！你的護盾在傳送終點擋下了一個地雷！`;
        } else {
            cell.revealedBy = state.turn;
            gameOver(state, state.turn === 'A' ? 'B' : 'A');
            return;
        }
    } else {
        cell.revealedBy = state.turn;
        state.prompt = `你降落在一個${cell.isStairway ? '樓梯' : '看似安全'}的地點...`;
    }
    processStepCompletion(state);
}

function processStepCompletion(state) {
    if (state.doubleJeopardyState.active && state.doubleJeopardyState.player === state.turn) {
        state.doubleJeopardyState.steps--;
        if (state.doubleJeopardyState.steps <= 0) {
            state.doubleJeopardyState.active = false;
            endTurn(state);
        } else {
            state.prompt = `雙重危機！玩家 ${state.turn} 還需再走一步！`;
        }
    } else {
        endTurn(state);
    }
}

function endTurn(state) {
    state.actionState = { type: 'none' };
    state.turn = (state.turn === 'A') ? 'B' : 'A';

    // 檢查新回合的玩家是否處於黑暗壟罩狀態
    if (state.blackoutFor === state.turn) {
        state.prompt = `玩家 ${state.turn} 因黑暗壟罩，回合被跳過！`;
        state.blackoutFor = null; // 效果生效一次後就清除
        // 再次結束回合，輪到下一個玩家
        endTurn(state);
    }
}

function gameOver(state, winner) {
    state.gameState = 'GAMEOVER';
    state.turn = winner;
    state.board.forEach(cell => { if (cell.isMine) cell.isRevealed = true; });
}

function checkTieCondition(state) {
    const unrevealedSafeCells = state.board.filter(c => !c.isMine && !c.isRevealed).length;
    if (unrevealedSafeCells === 0 && state.gameState === 'TURN') {
        state.gameState = 'TIE';
    }
}

function drawCard(state, player) {
    if (state.players[player].hand.length < 5) { // 手牌上限
        state.players[player].hand.push(CARD_DECK[Math.floor(Math.random() * CARD_DECK.length)]);
    }
}

function createNewGameState() {
    const state = {
        gameState: 'PLACING',
        turn: 'A',
        actionState: { type: 'none' },
        doubleJeopardyState: { active: false, steps: 0 },
        blackoutFor: null,
        minePlacementCount: 0,
        board: Array(GRID_SIZE * GRID_SIZE).fill().map((_, i) => ({
            id: i, layer: 'ground', isMine: false, isWormhole: false, isDecoy: false,
            isStairway: false, isRevealed: false, revealedBy: null
        })),
        players: { A: { hand: [], shield: 0 }, B: { hand: [], shield: 0 } },
        prompt: null,
    };

    // setup layers and terrains
    const shuffled = [...state.board].sort(() => 0.5 - Math.random());
    shuffled.slice(0, HIGHLAND_CELL_COUNT).forEach(c => c.layer = 'highland');
    const groundCells = state.board.filter(c => c.layer === 'ground');
    const highlandCells = state.board.filter(c => c.layer === 'highland');
    [...groundCells, ...highlandCells].sort(() => 0.5 - Math.random()).slice(0, STAIRWAY_COUNT * 2).forEach(c => c.isStairway = true);
    state.board.filter(c => !c.isStairway).sort(() => 0.5 - Math.random()).slice(0, WORMHOLE_COUNT).forEach(c => c.isWormhole = true);
    
    // deal cards
    for (let i = 0; i < INITIAL_CARDS; i++) {
        drawCard(state, "A");
        drawCard(state, "B");
    }
    return state;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器正在 http://localhost:${PORT} 上運行`);
});