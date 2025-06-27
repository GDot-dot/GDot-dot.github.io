// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 遊戲設定 (從你的 HTML 檔案中複製過來) ---
const GRID_SIZE = 10, MINE_COUNT_PER_PLAYER = 3, HIGHLAND_CELL_COUNT = 30, WORMHOLE_COUNT = 4, STAIRWAY_COUNT = 4, INITIAL_CARDS = 4;
const CARDS = {
    'Double Jeopardy': { name: "雙重危機", type: "attack", description: "對手下回合必須踩兩個格子", immediate: true },
    'Blackout': { name: "黑暗視野", type: "attack", description: "對手下回合視野將被黑暗籠罩，只能看見滑鼠周圍的區域", immediate: true },
    'Shield': { name: "護盾", type: "support", description: "抵銷下一次踩到的地雷", immediate: true },
    'Premonition': { name: "神之預感", type: "support", description: "安全地查看一個格子的內容 (使用後本回合可繼續行動)", target: "cell" },
    'Relocate': { name: "轉移陣地", type: "support", description: "清除自己的一個標記，並重新踩一個格子", target: "own_cell" },
    'Skip': { name: "跳過回合", type: "support", description: "直接結束你的回合", immediate: true },
    'Mine Shift': { name: "地雷遷移", type: "chaos", description: "隨機一個地雷與一個安全格交換位置", immediate: true },
    'Decoy': { name: "假情報", type: "chaos", description: "在一個未揭示的格子上放置假地雷", target: "cell" }
};
const CARD_DECK = Object.keys(CARDS);
// ----------------------------------------------------

app.use(express.static('public'));

let gameRooms = {}; // 存放所有遊戲房間的狀態

io.on('connection', (socket) => {
    console.log(`一個玩家已連接: ${socket.id}`);

    // --- 尋找或建立遊戲房間 ---
    let roomId = null;
    for (const id in gameRooms) {
        if (gameRooms[id].players.length === 1) {
            roomId = id;
            break;
        }
    }

    if (roomId) {
        // 加入現有房間
        const room = gameRooms[roomId];
        room.players.push({ id: socket.id, role: 'B' });
        socket.join(roomId);
        console.log(`玩家 ${socket.id} 加入房間 ${roomId}，擔任玩家 B`);

        // 開始遊戲
        room.state = createNewGameState();
        io.to(roomId).emit('gameStart', {
            state: room.state,
            players: room.players.map(p => p.id)
        });
    } else {
        // 建立新房間
        roomId = `room-${socket.id}`;
        gameRooms[roomId] = {
            players: [{ id: socket.id, role: 'A' }],
            state: null // 遊戲狀態等 B 玩家加入後再建立
        };
        socket.join(roomId);
        console.log(`玩家 ${socket.id} 建立房間 ${roomId}，擔任玩家 A`);
        socket.emit('waitingForOpponent');
    }

    // 將 socket 與 roomId 關聯，方便斷線時處理
    socket.data.roomId = roomId;

    // --- 監聽玩家操作 ---
    socket.on('cellClick', (data) => {
        const room = gameRooms[socket.data.roomId];
        if (!room || !room.state) return;

        const playerRole = room.players.find(p => p.id === socket.id).role;
        handleAction(room, playerRole, 'cellClick', data);
    });
    
    socket.on('playCard', (data) => {
        const room = gameRooms[socket.data.roomId];
        if (!room || !room.state) return;

        const playerRole = room.players.find(p => p.id === socket.id).role;
        handleAction(room, playerRole, 'playCard', data);
    });

    socket.on('restartRequest', () => {
        const room = gameRooms[socket.data.roomId];
        if (!room || room.players.length < 2) return;
        
        room.state = createNewGameState();
        io.to(socket.data.roomId).emit('gameStart', {
            state: room.state,
            players: room.players.map(p => p.id)
        });
    });


    // --- 玩家斷線處理 ---
    socket.on('disconnect', () => {
        console.log(`一個玩家已斷線: ${socket.id}`);
        const roomId = socket.data.roomId;
        if (gameRooms[roomId]) {
            // 通知另一個玩家
            io.to(roomId).emit('opponentDisconnected');
            // 銷毀房間
            delete gameRooms[roomId];
            console.log(`房間 ${roomId} 已銷毀`);
        }
    });
});

// --- 核心遊戲邏輯 (從你的 HTML 移植並修改) ---
// 伺服器是唯一權威，所有狀態修改都在這裡進行

function createNewGameState() {
    const state = {
        gameState: 'PLACING',
        turn: 'A',
        actionState: { type: 'none' },
        doubleJeopardyState: { active: false, steps: 0 },
        minePlacementCount: 0,
        board: Array(GRID_SIZE * GRID_SIZE).fill().map((_, i) => ({
            id: i, row: Math.floor(i / GRID_SIZE), col: i % GRID_SIZE,
            layer: 'ground', isMine: false, isWormhole: false, isDecoy: false,
            isStairway: false, isRevealed: false, revealedBy: null
        })),
        players: { A: { hand: [], shield: 0 }, B: { hand: [], shield: 0 } },
        prompt: null, // 用於向客戶端顯示提示
        blackoutFor: null // 觸發黑暗視野的玩家
    };

    // setup layers and terrains
    const shuffled = [...state.board].sort(() => 0.5 - Math.random());
    shuffled.slice(0, HIGHLAND_CELL_COUNT).forEach(c => c.layer = 'highland');
    const groundCells = state.board.filter(c => c.layer === 'ground'), highlandCells = state.board.filter(c => c.layer === 'highland');
    const shuffledGround = groundCells.sort(() => 0.5 - Math.random()), shuffledHighland = highlandCells.sort(() => 0.5 - Math.random());
    for(let i=0; i < STAIRWAY_COUNT; i++) {
        if (shuffledGround[i]) shuffledGround[i].isStairway = true;
        if (shuffledHighland[i]) shuffledHighland[i].isStairway = true;
    }
    const nonSpecialCells = state.board.filter(c => !c.isStairway).sort(() => 0.5 - Math.random());
    nonSpecialCells.slice(0, WORMHOLE_COUNT).forEach(c => c.isWormhole = true);

    // deal cards
    for (let i = 0; i < INITIAL_CARDS; i++) {
        drawCard(state, "A");
        drawCard(state, "B");
    }
    return state;
}

function drawCard(state, player) {
    state.players[player].hand.push(CARD_DECK[Math.floor(Math.random() * CARD_DECK.length)]);
}

function handleAction(room, playerRole, type, data) {
    const state = room.state;

    // 驗證是否輪到該玩家操作
    if (state.gameState === 'PLACING' && state.turn !== playerRole) return;
    if (state.gameState === 'TURN' && state.turn !== playerRole && state.actionState.type === 'none') return;
    
    // 清除上一條提示
    state.prompt = null;
    
    if (type === 'cellClick') {
        const cell = state.board[data.id];
        if (state.actionState.type === 'targeting' && state.actionState.player === playerRole) {
            handleCardTarget(state, cell);
        } else if (state.actionState.type === 'relocating' && state.actionState.player === playerRole) {
            handleRelocateStep2(state, cell);
        } else if (state.gameState === 'PLACING') {
            if (cell.isWormhole || cell.isStairway) {
                state.prompt = "不能將地雷埋在特殊地形上！";
            } else if (!cell.isMine) {
                cell.isMine = true;
                state.minePlacementCount++;
                if (state.minePlacementCount >= MINE_COUNT_PER_PLAYER * 2) {
                    state.gameState = 'TURN';
                    state.turn = 'A';
                } else {
                    state.turn = (state.turn === 'A') ? 'B' : 'A';
                }
            }
        } else if (state.gameState === 'TURN') {
            if (!cell.isRevealed) {
                stepOnCell(state, cell);
            }
        }
    } else if (type === 'playCard') {
        onCardPlay(state, playerRole, data.cardName);
    }
    
    // 操作完成後，廣播最新的遊戲狀態
    io.to(room.players.map(p => p.id)).emit('gameStateUpdate', state);
}

function stepOnCell(state, cell) {
    // 這裡的邏輯幾乎與原版相同，只是操作的對象是 state 物件
    if (cell.isWormhole) { handleWormhole(state, cell); return; }
    cell.isRevealed = true;
    if (cell.isMine) {
        if (state.players[state.turn].shield > 0) {
            state.players[state.turn].shield--; cell.revealedBy = 'shield';
            state.prompt = `玩家 ${state.turn} 的護盾擋下了一劫！`;
            processStepCompletion(state);
        } else {
            cell.revealedBy = state.turn; gameOver(state, state.turn === 'A' ? 'B' : 'A');
        }
    } else if (cell.isDecoy) {
        cell.revealedBy = state.turn; state.prompt = "哈！這只是一個假地雷！";
        cell.isDecoy = false; processStepCompletion(state);
    } else {
        cell.revealedBy = state.turn;
        if (cell.isStairway) { state.prompt = `通過樓梯前往${cell.layer === 'ground' ? '高地' : '地面'}！`; }
        processStepCompletion(state);
    }
    checkTieCondition(state);
}

// ... 將你 HTML 中的所有遊戲邏輯函數 (如 onCardPlay, handleWormhole, endTurn, gameOver 等)
// ... 全部搬移到這裡，並修改它們，使其操作 `state` 物件，而不是 DOM。
// ... 例如，`showPrompt(text)` 應該變成 `state.prompt = text`。

function processStepCompletion(state) {
    if (state.doubleJeopardyState.active && state.doubleJeopardyState.player === state.turn) {
        state.doubleJeopardyState.steps--;
        if (state.doubleJeopardyState.steps <= 0) {
            state.doubleJeopardyState.active = false; endTurn(state);
        }
    } else {
        endTurn(state);
    }
}

function endTurn(state) {
    // 重置黑暗視野
    if(state.blackoutFor) state.blackoutFor = null;
    
    // 輪到下一個玩家
    state.turn = (state.turn === 'A') ? 'B' : 'A';

    // 如果輪到的玩家正處於黑暗視野狀態，設定標記
    if (state.blackoutListenerPlayer === state.turn) {
        state.blackoutFor = state.turn;
        state.blackoutListenerPlayer = null; // 用過一次就清除
    }
}

function onCardPlay(state, player, cardName) {
    const cardIndex = state.players[player].hand.indexOf(cardName);
    if (cardIndex === -1) return; // 防止作弊
    state.players[player].hand.splice(cardIndex, 1);
    
    const card = CARDS[cardName];
    if (card.immediate) {
        executeImmediateCard(state, player, cardName);
        if (card.name === '跳過回合' || card.name === '雙重危機' || card.name === '黑暗視野') {
             endTurn(state);
        }
    } else {
        state.actionState = { type: 'targeting', card: cardName, player: player, message: `玩家 ${player} 使用 ${card.name}，請選擇目標` };
    }
}

function executeImmediateCard(state, player, cardName) {
    const opponent = player === 'A' ? 'B' : 'A';
    switch(cardName) {
        case 'Shield': state.players[player].shield++; state.prompt = `玩家 ${player} 獲得了護盾！`; break;
        case 'Skip': break;
        case 'Mine Shift':
            const mines = state.board.filter(c => !c.isRevealed && c.isMine), safe = state.board.filter(c => !c.isRevealed && !c.isMine && !c.isWormhole && !c.isStairway);
            if (mines.length > 0 && safe.length > 0) {
                const mineToMove = mines[0], safeToSwap = safe[0];
                mineToMove.isMine = false; safeToSwap.isMine = true; state.prompt = "地雷位置已暗中改變！";
            }
            break;
        case 'Double Jeopardy': state.doubleJeopardyState = { active: true, player: opponent, steps: 2 }; break;
        case 'Blackout':
            state.prompt = `黑暗視野！玩家 ${opponent} 的回合將被黑暗籠罩！`;
            state.blackoutListenerPlayer = opponent; // 標記下一個受影響的玩家
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
            resetAction();
            break;
        case 'Decoy':
            if (!targetCell.isRevealed) {
                targetCell.isDecoy = true;
                state.prompt = `假情报已設置！`;
                endTurn(state);
            } else {
                state.prompt = `無法在已揭示的格子設置！`;
                resetAction();
            }
            break;
        case 'Relocate':
            if (targetCell.isRevealed && targetCell.revealedBy === player) {
                targetCell.isRevealed = false; targetCell.revealedBy = null;
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
        return;
    }
    state.actionState = { type: 'none' };
    stepOnCell(state, targetCell);
}

function handleWormhole(state, cell) {
    cell.isRevealed = true;
    cell.revealedBy = state.turn;
    drawCard(state, state.turn);
    state.prompt = '你勇敢地跳入蟲洞，並獲得了一張新卡牌作為獎勵！';
    
    // 傳送邏輯
    const unrevealed = state.board.filter(c => !c.isRevealed && c.id !== cell.id);
    if (unrevealed.length > 0) {
        const targetCell = unrevealed[Math.floor(Math.random() * unrevealed.length)];
        // 客戶端會處理切換視圖，我們只需直接降落
        landOnCell(state, targetCell);
    } else {
        processStepCompletion(state);
    }
}

function landOnCell(state, cell) {
    if (cell.isMine) {
        if (state.players[state.turn].shield > 0) {
            state.players[state.turn].shield--; cell.revealedBy = 'shield';
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


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器正在 http://localhost:${PORT} 上運行`);
});