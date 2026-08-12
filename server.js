const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const COLORS = ["red", "yellow", "green", "blue", "white"];
const rooms = new Map();

const RECONNECT_GRACE_MS = 5 * 60 * 1000;
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;

function makePlayerToken() {
  return crypto.randomBytes(24).toString("hex");
}

function touchRoom(room) {
  room.updatedAt = Date.now();
}

function publicPlayer(player) {
  return {
    name: player.name,
    connected: Boolean(player.socketId)
  };
}

function scheduleRoomExpiry(room, playerIndex) {
  const player = room.players[playerIndex];
  if (!player) return;

  clearTimeout(player.disconnectTimer);
  player.disconnectTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);
    if (!currentRoom) return;
    const currentPlayer = currentRoom.players[playerIndex];

    if (currentPlayer && !currentPlayer.socketId) {
      rooms.delete(room.code);
    }
  }, RECONNECT_GRACE_MS);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - (room.updatedAt || room.createdAt || now) > ROOM_IDLE_MS) {
      rooms.delete(code);
    }
  }
}, 15 * 60 * 1000).unref();

const GOALS = [
  { id:"red3", type:"race", points:10, title:"빨간칸 3장", desc:"빨간 탐험지에 카드 3장을 가장 먼저 놓기" },
  { id:"yellow3", type:"race", points:10, title:"노란칸 3장", desc:"노란 탐험지에 카드 3장을 가장 먼저 놓기" },
  { id:"green3", type:"race", points:10, title:"초록칸 3장", desc:"초록 탐험지에 카드 3장을 가장 먼저 놓기" },
  { id:"blue3", type:"race", points:10, title:"파란칸 3장", desc:"파란 탐험지에 카드 3장을 가장 먼저 놓기" },
  { id:"white3", type:"race", points:10, title:"흰칸 3장", desc:"흰 탐험지에 카드 3장을 가장 먼저 놓기" },
  { id:"threeColors", type:"race", points:10, title:"3개 탐험지 시작", desc:"서로 다른 탐험지 3곳에 카드를 먼저 1장 이상 놓기" },
  { id:"threeWagers", type:"race", points:10, title:"투자 3장", desc:"투자카드를 색상 무관 총 3장 먼저 놓기" },
  { id:"high7", type:"race", points:10, title:"7 이상 카드", desc:"숫자 7 이상의 카드를 가장 먼저 놓기" },
  { id:"moreStarted", type:"end", points:10, title:"개척왕", desc:"게임 종료 시 카드가 놓인 탐험지가 더 많기" },
  { id:"moreProfitable", type:"end", points:10, title:"신중한 탐험가", desc:"게임 종료 시 0점 이상인 탐험지가 더 많기" },
  { id:"moreWagers", type:"end", points:10, title:"대형 투자자", desc:"게임 종료 시 투자카드 총 개수가 더 많기" }
];

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// Flat GitHub-friendly client layout: no public/ folder required.
// v7.11: no-store on the core HTML/JS/CSS so a redeploy is never masked by a
// stale browser cache (this caused one player to silently run old client
// code while the other ran the latest — looked like a random gameplay bug).
function noStore(res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
}
app.get("/", (_req, res) => {
  noStore(res);
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/game.js", (_req, res) => {
  noStore(res);
  res.sendFile(path.join(__dirname, "game.js"));
});
app.get("/style.css", (_req, res) => {
  noStore(res);
  res.sendFile(path.join(__dirname, "style.css"));
});
app.use("/assets", express.static(path.join(__dirname, "assets")));

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck() {
  const deck = [];
  let id = 1;
  for (const color of COLORS) {
    for (let i = 0; i < 3; i++) deck.push({ id: id++, color, kind: "wager", value: 0 });
    for (let value = 2; value <= 10; value++) deck.push({ id: id++, color, kind: "number", value });
  }
  return shuffle(deck);
}

function emptyExpeditions() {
  return Object.fromEntries(COLORS.map(c => [c, []]));
}
function emptyDiscards() {
  return Object.fromEntries(COLORS.map(c => [c, []]));
}
function expeditionScore(cards) {
  if (!cards.length) return 0;
  const wagers = cards.filter(c => c.kind === "wager").length;
  const sum = cards.filter(c => c.kind === "number").reduce((s, c) => s + c.value, 0);
  let score = (sum - 20) * (wagers + 1);
  if (cards.length >= 8) score += 20;
  return score;
}
function baseScores(game) {
  return [0, 1].map(p => {
    const byColor = {};
    let total = 0;
    for (const c of COLORS) {
      byColor[c] = expeditionScore(game.expeditions[p][c]);
      total += byColor[c];
    }
    return { byColor, baseTotal: total, goalPoints: 0, total };
  });
}
function started(exp) {
  return COLORS.filter(c => exp[c].length > 0).length;
}
function wagerCount(exp) {
  return COLORS.reduce((n, c) => n + exp[c].filter(card => card.kind === "wager").length, 0);
}
function nonNegativeCount(exp) {
  return COLORS.reduce((n, c) => n + (exp[c].length > 0 && expeditionScore(exp[c]) >= 0 ? 1 : 0), 0);
}

function startGame(room) {
  const deck = createDeck();
  room.game = {
    deck,
    hands: [[], []],
    expeditions: [emptyExpeditions(), emptyExpeditions()],
    discards: emptyDiscards(),
    currentPlayer: Math.floor(Math.random() * 2),
    phase: "play",
    lastDiscard: null,
    finished: false,
    scores: null,
    winner: null,
    goals: shuffle(GOALS).slice(0, 5).map(g => ({ ...g, claimedBy: null, resolvedBy: null }))
  };
  for (let i = 0; i < 8; i++) {
    room.game.hands[0].push(room.game.deck.pop());
    room.game.hands[1].push(room.game.deck.pop());
  }
}

function claimRaceGoals(game, playerIndex, card) {
  const exp = game.expeditions[playerIndex];
  for (const goal of game.goals) {
    if (goal.type !== "race" || goal.claimedBy !== null) continue;
    if (goal.id === `${card.color}3` && exp[card.color].length >= 3) goal.claimedBy = playerIndex;
    else if (goal.id === "threeColors" && started(exp) >= 3) goal.claimedBy = playerIndex;
    else if (goal.id === "threeWagers" && wagerCount(exp) >= 3) goal.claimedBy = playerIndex;
    else if (goal.id === "high7" && card.kind === "number" && card.value >= 7) goal.claimedBy = playerIndex;
  }
}

function resolveGoals(game) {
  const scores = baseScores(game);

  for (const goal of game.goals) {
    if (goal.type === "race") {
      goal.resolvedBy = goal.claimedBy;
      if (goal.claimedBy !== null) scores[goal.claimedBy].goalPoints += goal.points;
      continue;
    }

    let a = 0, b = 0;
    if (goal.id === "moreStarted") {
      a = started(game.expeditions[0]); b = started(game.expeditions[1]);
    } else if (goal.id === "moreProfitable") {
      a = nonNegativeCount(game.expeditions[0]); b = nonNegativeCount(game.expeditions[1]);
    } else if (goal.id === "moreWagers") {
      a = wagerCount(game.expeditions[0]); b = wagerCount(game.expeditions[1]);
    }

    if (a > b) {
      goal.resolvedBy = 0; scores[0].goalPoints += goal.points;
    } else if (b > a) {
      goal.resolvedBy = 1; scores[1].goalPoints += goal.points;
    } else {
      goal.resolvedBy = null;
    }
  }

  for (const score of scores) score.total = score.baseTotal + score.goalPoints;
  return scores;
}

function goalStatus(goal, room) {
  const game = room.game;
  const names = room.players.map(p => p.name);
  const won = idx => `${names[idx]} +${goal.points}점`;

  if (goal.type === "race") {
    if (goal.claimedBy !== null) return { state: "claimed", text: won(goal.claimedBy) };
    if (goal.id === "threeColors") return { state: "pending", text: `${names[0]} ${started(game.expeditions[0])}/3 · ${names[1]} ${started(game.expeditions[1])}/3` };
    if (goal.id === "threeWagers") return { state: "pending", text: `${names[0]} ${wagerCount(game.expeditions[0])}/3 · ${names[1]} ${wagerCount(game.expeditions[1])}/3` };
    return { state: "pending", text: "아직 미달성" };
  }

  let a = 0, b = 0;
  if (goal.id === "moreStarted") {
    a = started(game.expeditions[0]); b = started(game.expeditions[1]);
  } else if (goal.id === "moreProfitable") {
    a = nonNegativeCount(game.expeditions[0]); b = nonNegativeCount(game.expeditions[1]);
  } else if (goal.id === "moreWagers") {
    a = wagerCount(game.expeditions[0]); b = wagerCount(game.expeditions[1]);
  }

  if (game.finished) {
    return goal.resolvedBy === null
      ? { state: "void", text: "동점 · 보너스 없음" }
      : { state: "claimed", text: won(goal.resolvedBy) };
  }

  const lead = a === b ? "동점" : `${a > b ? names[0] : names[1]} 우세`;
  return { state: "compare", text: `${names[0]} ${a} · ${names[1]} ${b} · ${lead}` };
}

function sanitizedState(room, playerIndex) {
  const game = room.game;
  if (!game) {
    return {
      roomCode: room.code,
      players: room.players.map(publicPlayer),
      waiting: true,
      history: room.history
    };
  }

  return {
    roomCode: room.code,
    players: room.players.map(publicPlayer),
    waiting: false,
    me: playerIndex,
    playerIndex,
    currentPlayer: game.currentPlayer,
    myTurn: game.currentPlayer === playerIndex,
    canPlayCard: game.currentPlayer === playerIndex && game.phase === "play" && !game.finished,
    canDrawCard: game.currentPlayer === playerIndex && game.phase === "draw" && !game.finished,
    phase: game.phase,
    deckCount: game.deck.length,
    deckRemaining: game.deck.length,
    hand: game.hands[playerIndex],
    opponentHandCount: game.hands[1 - playerIndex].length,
    opponentFinalHand: game.finished ? game.hands[1 - playerIndex] : [],
    expeditions: game.expeditions,
    discards: Object.fromEntries(COLORS.map(c => [c, game.discards[c].length ? game.discards[c][game.discards[c].length - 1] : null])),
    discardCounts: Object.fromEntries(COLORS.map(c => [c, game.discards[c].length])),
    finished: game.finished,
    scores: game.scores,
    winner: game.winner,
    goals: game.goals.map(goal => ({ ...goal, status: goalStatus(goal, room) })),
    history: room.history
  };
}

function emitRoom(room) {
  room.players.forEach((player, idx) => {
    if (player.socketId) {
      io.to(player.socketId).emit("state", sanitizedState(room, idx));
    }
  });
}
function getMembership(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return null;

  const playerIndex = room.players.findIndex(p =>
    p.token === socket.data.playerToken || p.socketId === socket.id
  );
  return playerIndex < 0 ? null : { room, playerIndex };
}
function canPlay(expedition, card) {
  const nums = expedition.filter(c => c.kind === "number");
  if (card.kind === "wager") return nums.length === 0;
  return !nums.length || card.value >= nums[nums.length - 1].value;
}
function finishIfNeeded(room) {
  const game = room.game;
  if (game.finished || game.deck.length > 0) return;

  game.finished = true;
  game.scores = resolveGoals(game);
  game.winner = game.scores[0].total === game.scores[1].total
    ? "draw"
    : (game.scores[0].total > game.scores[1].total ? 0 : 1);

  room.history.unshift({
    names: room.players.map(p => p.name),
    scores: [game.scores[0].total, game.scores[1].total],
    winner: game.winner
  });
  room.history = room.history.slice(0, 8);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }, cb) => {
    const code = makeRoomCode();
    const cleanName = String(name || "Player 1").trim().slice(0, 20) || "Player 1";
    const token = makePlayerToken();

    const room = {
      code,
      players: [{ socketId: socket.id, token, name: cleanName, disconnectTimer: null }],
      game: null,
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.data.playerToken = token;

    cb?.({ ok: true, code, token });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) return cb?.({ ok: false, message: "존재하지 않는 방입니다." });
    if (room.players.length >= 2) return cb?.({ ok: false, message: "이미 두 명이 참가한 방입니다." });

    const token = makePlayerToken();
    room.players.push({
      socketId: socket.id,
      token,
      name: String(name || "Player 2").trim().slice(0, 20) || "Player 2",
      disconnectTimer: null
    });

    socket.data.roomCode = code;
    socket.data.playerToken = token;
    touchRoom(room);

    startGame(room);
    cb?.({ ok: true, code, token });
    emitRoom(room);
  });

  socket.on("reconnectRoom", ({ code, token }, cb) => {
    code = String(code || "").toUpperCase().trim();
    token = String(token || "").trim();

    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, reason: "room_not_found", message: "이전 방이 만료되었습니다." });

    const playerIndex = room.players.findIndex(p => p.token === token);
    if (playerIndex < 0) {
      return cb?.({ ok: false, reason: "invalid_token", message: "재접속 정보가 올바르지 않습니다." });
    }

    const player = room.players[playerIndex];
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.socketId = socket.id;

    socket.data.roomCode = code;
    socket.data.playerToken = token;
    touchRoom(room);

    cb?.({ ok: true, code, playerIndex });
    emitRoom(room);

    const other = room.players[1 - playerIndex];
    if (other?.socketId) {
      io.to(other.socketId).emit("notice", `${player.name}이(가) 다시 연결되었습니다.`);
    }
  });

  socket.on("playCard", ({ cardId, action }, cb) => {
    const m = getMembership(socket);
    if (!m) return cb?.({ ok: false, message: "방 정보를 찾을 수 없습니다." });

    const { room, playerIndex } = m;
    const game = room.game;
    if (!game || game.finished) return cb?.({ ok: false, message: "게임이 진행 중이 아닙니다." });
    if (game.currentPlayer !== playerIndex) return cb?.({ ok: false, message: "상대방의 턴입니다." });
    if (game.phase !== "play") return cb?.({ ok: false, message: "카드를 뽑을 차례입니다." });

    const idx = game.hands[playerIndex].findIndex(c => c.id === cardId);
    if (idx < 0) return cb?.({ ok: false, message: "손에 없는 카드입니다." });

    const card = game.hands[playerIndex][idx];

    if (action === "expedition") {
      if (!canPlay(game.expeditions[playerIndex][card.color], card)) {
        return cb?.({ ok: false, message: "이 탐험에는 해당 카드를 놓을 수 없습니다." });
      }
      game.hands[playerIndex].splice(idx, 1);
      game.expeditions[playerIndex][card.color].push(card);
      claimRaceGoals(game, playerIndex, card);
      game.lastDiscard = null;
    } else if (action === "discard") {
      game.hands[playerIndex].splice(idx, 1);
      game.discards[card.color].push(card);
      game.lastDiscard = { playerIndex, cardId: card.id };
    } else {
      return cb?.({ ok: false, message: "잘못된 행동입니다." });
    }

    game.phase = "draw";
    touchRoom(room);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("drawCard", ({ source, color }, cb) => {
    const m = getMembership(socket);
    if (!m) return cb?.({ ok: false, message: "방 정보를 찾을 수 없습니다." });

    const { room, playerIndex } = m;
    const game = room.game;
    if (!game || game.finished) return cb?.({ ok: false, message: "게임이 진행 중이 아닙니다." });
    if (game.currentPlayer !== playerIndex) return cb?.({ ok: false, message: "상대방의 턴입니다." });
    if (game.phase !== "draw") return cb?.({ ok: false, message: "먼저 카드를 내거나 버리세요." });

    let card = null;
    if (source === "deck") {
      if (!game.deck.length) return cb?.({ ok: false, message: "덱이 비었습니다." });
      card = game.deck.pop();
    } else if (source === "discard") {
      if (!COLORS.includes(color) || !game.discards[color].length) {
        return cb?.({ ok: false, message: "해당 버림패가 비어 있습니다." });
      }
      const top = game.discards[color][game.discards[color].length - 1];
      if (game.lastDiscard && game.lastDiscard.playerIndex === playerIndex && game.lastDiscard.cardId === top.id) {
        return cb?.({ ok: false, message: "방금 버린 카드는 다시 가져올 수 없습니다." });
      }
      card = game.discards[color].pop();
    } else {
      return cb?.({ ok: false, message: "잘못된 드로우입니다." });
    }

    game.hands[playerIndex].push(card);
    finishIfNeeded(room);

    if (!game.finished) {
      game.currentPlayer = 1 - game.currentPlayer;
      game.phase = "play";
      game.lastDiscard = null;
    }

    touchRoom(room);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on("restartGame", (_, cb) => {
    const m = getMembership(socket);
    if (!m) return cb?.({ ok: false, message: "방 정보를 찾을 수 없습니다." });
    startGame(m.room);
    touchRoom(m.room);
    cb?.({ ok: true });
    emitRoom(m.room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const playerIndex = room.players.findIndex(p =>
      p.token === socket.data.playerToken || p.socketId === socket.id
    );
    if (playerIndex < 0) return;

    const player = room.players[playerIndex];
    player.socketId = null;
    touchRoom(room);
    scheduleRoomExpiry(room, playerIndex);

    emitRoom(room);

    const other = room.players[1 - playerIndex];
    if (other?.socketId) {
      io.to(other.socketId).emit("notice", `${player.name}의 연결이 끊겼습니다. 5분 동안 재접속을 기다립니다.`);
    }
  });
});

function printAddresses(port) {
  console.log(`
Lost Cities online server running on port ${port}
`);
  console.log(`Local: http://localhost:${port}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`LAN:   http://${net.address}:${port}`);
      }
    }
  }
}

function startLocalWithFallback(port) {
  const onError = err => {
    server.removeListener("listening", onListening);
    if (err.code === "EADDRINUSE") startLocalWithFallback(port + 1);
    else throw err;
  };
  const onListening = () => {
    server.removeListener("error", onError);
    printAddresses(port);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "0.0.0.0");
}

if (process.env.PORT) {
  server.listen(PORT, "0.0.0.0", () => printAddresses(PORT));
} else {
  startLocalWithFallback(PORT);
}
