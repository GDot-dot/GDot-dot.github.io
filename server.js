const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- 遊戲設定常量 ---
const GRID_SIZE = 12;
const MINE_COUNT_PER_PLAYER = 4;
const HIGHLAND_CELL_COUNT = 40;
const WORMHOLE_COUNT = 5;
const STAIRWAY_COUNT = 5;
const INITIAL_CARDS = 4;

const CARDS = {
    'Double Jeopardy': { name: "雙重危機", type: "attack", description: "對手下回合必須踩兩個格子", immediate: true },
    'Blackout': { name: "黑暗視野", type: "attack", description: "使對手的下個回合在完全黑暗中進行", immediate: true },
    'Shield': { name: "護盾", type: "support", description: "抵銷下一次踩到的地雷，使用後結束本回合", immediate: true },
    'Premonition': { name: "神之預感", type: "support", description: "安全地查看一個格子的內容 (使用後本回合可繼續行動)", target: "cell" },
    'Relocate': { name: "轉移陣地", type: "support", description: "清除自己的一個標記，並重新佔領一個格子，之後結束本回合", target: "own_cell" },
    'Skip': { name: "跳過回合", type: "support", description: "直接結束你的回合", immediate: true },
    'Mine Shift': { name: "地雷遷移", type: "chaos", description: "隨機一個地雷與一個安全格交換位置 (使用後本回合可繼續行動)", immediate: true },
    'Decoy': { name: "假情報", type: "chaos", description: "在一個未揭示的格子上放置假地雷，之後結束本回合", target: "cell" }
};
const CARD_DECK = Object.keys(CARDS);
const CARDS_THAT_END_TURN_IMMEDIATELY = ['Shield', 'Skip', 'Double Jeopardy', 'Blackout'];

app.use(express.static('public'));
let gameRooms = {};

function broadcastState(roomId, state) {
    if (gameRooms[roomId]) {
        io.to(roomId).emit('gameStateUpdate', state);
    }
}

io.on('connection', (socket) => {
    console.log(`一個玩家已連接: ${socket.id}`);
    let roomId = Object.keys(gameRooms).find(id => gameRooms[id] && gameRooms[id].players.length === 1 && !gameRooms[id].isFull);
    if (roomId) {
        const room = gameRooms[roomId];
        room.players.push({ id: socket.id, role: 'B' });
        room.isFull = true;
        socket.join(roomId);
        console.log(`玩家 ${socket.id} 加入房間 ${roomId} (玩家 B)`);
        room.state = createNewGameState();
        io.to(roomId).emit('gameStart', {
            state: room.state,
            players: room.players.map(p => ({ id: p.id, role: p.role }))
        });
    } else {
        roomId = `room-${socket.id}`;
        gameRooms[roomId] = {
            players: [{ id: socket.id, role: 'A' }],
            state: null,
            isFull: false
        };
        socket.join(roomId);
        console.log(`玩家 ${socket.id} 建立房間 ${roomId} (玩家 A)`);
        socket.emit('waitingForOpponent');
    }
    socket.data.roomId = roomId;

    socket.on('playerAction', (action) => {
        const currentRoomId = socket.data.roomId;
        const room = gameRooms[currentRoomId];
        if (!room || !room.state || room.state.isProcessing) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;
        handlePlayerAction(currentRoomId, player.role, action);
    });

    socket.on('restartRequest', () => {
        const currentRoomId = socket.data.roomId;
        const room = gameRooms[currentRoomId];
        if (!room || room.players.length < 2) return;
        room.state = createNewGameState();
        io.to(currentRoomId).emit('gameStart', {
            state: room.state,
            players: room.players.map(p => ({ id: p.id, role: p.role }))
        });
    });

    socket.on('disconnect', () => {
        console.log(`一個玩家已斷線: ${socket.id}`);
        const currentRoomId = socket.data.roomId;
        if (gameRooms[currentRoomId]) {
            io.to(currentRoomId).emit('opponentDisconnected');
            delete gameRooms[currentRoomId];
            console.log(`房間 ${currentRoomId} 已銷毀`);
        }
    });
});

function handlePlayerAction(roomId, playerRole, action) {
    const state = gameRooms[roomId].state;
    if (state.isProcessing || state.gameState === 'GAMEOVER' || state.gameState === 'TIE' || state.turn !== playerRole) return;
    state.isProcessing = true;
    state.prompt = null;
    try {
        switch (action.type) {
            case 'cellClick':
                const cell = state.board[action.payload.id];
                if (state.actionState.type === 'targeting') handleCardTarget(state, cell);
                else if (state.actionState.type === 'relocating') handleRelocateStep2(state, cell);
                else if (state.gameState === 'PLACING') handleMinePlacement(state, cell);
                else if (state.gameState === 'TURN' && !cell.isRevealed) stepOnCell(state, cell);
                break;
            case 'playCard':
                if (state.actionState.type === 'none') onCardPlay(state, playerRole, action.payload.cardName);
                break;
        }
    } catch (error) {
        console.error("伺服器處理操作時出錯:", error);
    } finally {
        if (!state.isWormholeActive) {
            state.isProcessing = false;
        }
        broadcastState(roomId, state);
    }
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
            if (state.blackoutFor === state.turn) {
                state.blackoutFor = null;
            }
            endTurn(state);
        }
    } else {
        state.actionState = {
            type: 'targeting',
            card: cardName,
            player: player,
            message: `玩家 ${player} 使用 ${card.name}，請選擇目標`
        };
    }
}

function executeImmediateCard(state, player, cardName) {
    const opponent = player === 'A' ? 'B' : 'A';
    switch (cardName) {
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
                const mineToMove = mines[Math.floor(Math.random() * mines.length)];
                const safeToSwap = safe[Math.floor(Math.random() * safe.length)];
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
            state.blackoutFor = opponent;
            break;
    }
}

function handleCardTarget(state, targetCell) {
    const { card, player } = state.actionState;
    const resetAction = () => { state.actionState = { type: 'none' }; };
    switch (card) {
        case 'Premonition':
            const isDangerous = targetCell.isMine || targetCell.isWormhole;
            state.prompt = `預感：該格...${isDangerous ? '非常危險' : '似乎安全'}。`;
            resetAction();
            break;
        case 'Decoy':
            if (!targetCell.isRevealed) {
                targetCell.isDecoy = true;
                state.prompt = `假情報已設置！`;
                endTurn(state);
            } else {
                state.prompt = `無法在已揭示的格子設置！`;
                resetAction();
            }
            break;
        case 'Relocate':
            if (targetCell.isRevealed && targetCell.revealedBy === player) {
                targetCell.isRevealed = false;
                targetCell.revealedBy = null;
                state.actionState = {
                    type: 'relocating',
                    player: player,
                    message: `玩家 ${player} 請選擇新位置部署`
                };
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
    setRevealed(targetCell, state.turn);
    state.prompt = `玩家 ${state.turn} 已成功轉移陣地！`;
    endTurn(state);
}

const setRevealed = (cell, by) => {
    cell.isRevealed = true;
    cell.revealedBy = by;
};

function stepOnCell(state, cell) {
    if (cell.isWormhole) {
        handleWormhole(state, cell);
        return;
    }
    if (cell.isMine) {
        if (state.players[state.turn].shield > 0) {
            state.players[state.turn].shield--;
            setRevealed(cell, 'shield');
            state.prompt = `玩家 ${state.turn} 的護盾擋下了一劫！`;
            processStepCompletion(state);
        } else {
            setRevealed(cell, state.turn);
            gameOver(state, state.turn === 'A' ? 'B' : 'A');
        }
    } else if (cell.isDecoy) {
        setRevealed(cell, state.turn);
        state.prompt = "哈！這只是一個假地雷！";
        cell.isDecoy = false;
        processStepCompletion(state);
    } else {
        setRevealed(cell, state.turn);
        if (cell.isStairway) {
            state.prompt = `通過樓梯前往${cell.layer === 'ground' ? '高地' : '地面'}！`;
        }
        processStepCompletion(state);
    }
    checkTieCondition(state);
}

function handleWormhole(state, cell) {
    // 1. 先處理即時效果：揭示格子、發牌、設置提示
    setRevealed(cell, state.turn);
    drawCard(state, state.turn);
    state.prompt = '你勇敢地跳入蟲洞，並獲得了一張新卡牌作為獎勵！正在穿越...';
    
    // 2. 鎖定操作狀態
    state.isWormholeActive = true; 
    
    const roomId = Object.keys(gameRooms).find(id => gameRooms[id] && gameRooms[id].state === state);
    if (!roomId) {
        // 如果找不到房間，安全退出
        state.isWormholeActive = false;
        state.isProcessing = false;
        return;
    }

    // 3. ✅ 核心修正：只廣播一次“正在穿越”的中間狀態，讓玩家看到提示和新牌
    broadcastState(roomId, state);

    // 4. 設置延遲，模擬穿越過程
    setTimeout(() => {
        const unrevealed = state.board.filter(c => !c.isRevealed && c.id !== cell.id);
        
        if (unrevealed.length > 0) {
            const targetCell = unrevealed[Math.floor(Math.random() * unrevealed.length)];
            // 5. 在延遲後處理降落邏輯
            landOnCell(state, targetCell); 
        } else {
            // 如果沒有地方可降落，直接結束回合
            processStepCompletion(state);
        }

        // 6. 解除鎖定
        state.isWormholeActive = false;
        state.isProcessing = false;
        
        // 7. ✅ 核心修正：在所有異步操作完成後，再廣播一次最終的、回合已結束的狀態
        broadcastState(roomId, state);

    }, 2000); // 稍微加長一點延遲，讓體驗更清晰
}


function landOnCell(state, cell) {
    if (cell.isMine) {
        if (state.players[state.turn].shield > 0) {
            state.players[state.turn].shield--;
            setRevealed(cell, 'shield');
            state.prompt = `幸運！你的護盾在傳送終點擋下了一個地雷！`;
        } else {
            setRevealed(cell, state.turn);
            gameOver(state, state.turn === 'A' ? 'B' : 'A');
            return;
        }
    } else {
        setRevealed(cell, state.turn);
        state.prompt = `你降落在一個${cell.isStairway ? '樓梯' : '看似安全'}的地點...`;
    }
    processStepCompletion(state);
}

function processStepCompletion(state) {
    if (state.blackoutFor === state.turn) {
        state.blackoutFor = null;
    }
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
}

function gameOver(state, winner) {
    state.gameState = 'GAMEOVER';
    state.turn = winner;
    state.board.forEach(cell => {
        if (cell.isMine) setRevealed(cell, 'mine');
    });
}

function checkTieCondition(state) {
    const unrevealedSafeCells = state.board.filter(c => !c.isMine && !c.isRevealed).length;
    if (unrevealedSafeCells === 0 && state.gameState === 'TURN') {
        state.gameState = 'TIE';
    }
}

function drawCard(state, player) {
    if (state.players[player].hand.length < 5) {
        state.players[player].hand.push(CARD_DECK[Math.floor(Math.random() * CARD_DECK.length)]);
    }
}

function createNewGameState() {
    const state = {
        isProcessing: false,
        isWormholeActive: false,
        gameState: 'PLACING',
        turn: 'A',
        actionState: { type: 'none' },
        doubleJeopardyState: { active: false, steps: 0 },
        blackoutFor: null,
        minePlacementCount: 0,
        board: Array(GRID_SIZE * GRID_SIZE).fill().map((_, i) => ({
            id: i,
            row: Math.floor(i / GRID_SIZE),
            col: i % GRID_SIZE,
            layer: 'ground',
            isMine: false,
            isWormhole: false,
            isDecoy: false,
            isStairway: false,
            isRevealed: false,
            revealedBy: null
        })),
        players: { A: { hand: [], shield: 0 }, B: { hand: [], shield: 0 } },
        prompt: null,
    };

    const shuffled = [...state.board].sort(() => 0.5 - Math.random());
    shuffled.slice(0, HIGHLAND_CELL_COUNT).forEach(c => c.layer = 'highland');
    
    const potentialStairwayCells = state.board.filter(c => c.layer === 'ground' || c.layer === 'highland');
    potentialStairwayCells.sort(() => 0.5 - Math.random()).slice(0, STAIRWAY_COUNT).forEach(c => c.isStairway = true);

    const potentialWormholeCells = state.board.filter(c => !c.isStairway);
    potentialWormholeCells.sort(() => 0.5 - Math.random()).slice(0, WORMHOLE_COUNT).forEach(c => c.isWormhole = true);
    
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