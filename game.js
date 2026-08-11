
const socket = io();

// v6.3: desktop and mobile share tap/click selection controls.
function isMobileInteraction() { return true; }
const COLORS = ["red", "yellow", "green", "blue", "white"];
const COLOR_NAMES = { red: "빨강", yellow: "노랑", green: "초록", blue: "파랑", white: "흰색" };

let state = null;
const SESSION_KEY = "lostCitiesOnlineSession";

function saveOnlineSession(code, token, name) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    code,
    token,
    name: name || "",
    savedAt: Date.now()
  }));
}

function loadOnlineSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function clearOnlineSession() {
  localStorage.removeItem(SESSION_KEY);
}

function updateShareUrl(code) {
  if (!code) return;
  const url = new URL(window.location.href);
  url.searchParams.set("room", code);
  history.replaceState(null, "", url);
}

function prefillRoomFromUrl() {
  const code = new URLSearchParams(window.location.search).get("room");
  if (code && $("roomInput")) $("roomInput").value = code.toUpperCase().slice(0, 4);
}


let selectedCardId = null;
let draggedCardId = null;
let mobileSelectedCardId = null;
let mobileSelectedDiscardColor = null;
function isMobileMode(){
  return isMobileInteraction()
    || window.matchMedia("(orientation: landscape) and (max-height: 520px) and (max-width: 980px)").matches;
}


function normalizeIncomingState(raw) {
  if (!raw) return raw;
  const s = { ...raw };

  if (s.me == null && s.playerIndex != null) s.me = s.playerIndex;
  if (s.playerIndex == null && s.me != null) s.playerIndex = s.me;

  const deckValue =
    s.deckCount ??
    s.deckRemaining ??
    s.deckLeft ??
    s.remainingDeck ??
    0;

  s.deckCount = Number.isFinite(Number(deckValue)) ? Number(deckValue) : 0;

  if (typeof s.myTurn !== "boolean") {
    s.myTurn = s.me != null && s.currentPlayer != null
      ? Number(s.currentPlayer) === Number(s.me)
      : false;
  }

  if (typeof s.canPlayCard !== "boolean") {
    s.canPlayCard = s.myTurn && s.phase === "play" && !s.finished;
  }

  if (typeof s.canDrawCard !== "boolean") {
    s.canDrawCard = s.myTurn && s.phase === "draw" && !s.finished;
  }

  return s;
}

function isMyTurn() {
  return Boolean(state && state.myTurn);
}

const $ = id => document.getElementById(id);

function showToast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.add("hidden"), 2200);
}

function cardLabel(card) {
  return card.kind === "wager" ? "×" : String(card.value);
}

function cardEl(card, small = false, draggable = false) {
  const div = document.createElement("div");
  div.className = `card ${card.color}${small ? " small" : ""}`;
  div.textContent = cardLabel(card);
  div.title = `${COLOR_NAMES[card.color]} ${card.kind === "wager" ? "투자" : card.value}`;

  if (draggable) {
    div.draggable = true;

    div.addEventListener("dragstart", e => {
      draggedCardId = card.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(card.id));
      requestAnimationFrame(() => div.classList.add("dragging"));
    });

    div.addEventListener("dragend", () => {
      draggedCardId = null;
      div.classList.remove("dragging");
      document.querySelectorAll(".dragOver").forEach(el => el.classList.remove("dragOver"));
    });
  }

  if (draggable) {
    div.addEventListener("click", e => {
      if (!isMobileMode() || !state || state.finished) return;
      e.preventDefault(); e.stopPropagation();
      mobileSelectedCardId = mobileSelectedCardId === card.id ? null : card.id;
      renderMobileInteractionState();
    });
  }
  return div;
}

function wireDropTarget(el, handler) {
  el.classList.add("dropTarget");

  el.addEventListener("dragover", e => {
    if (!draggedCardId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("dragOver");
  });

  el.addEventListener("dragleave", e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("dragOver");
  });

  el.addEventListener("drop", e => {
    e.preventDefault();
    el.classList.remove("dragOver");
    const cardId = Number(e.dataTransfer.getData("text/plain") || draggedCardId);
    if (cardId) handler(cardId);
  });
}


function expeditionScoreForLive(cards) {
  if (!cards.length) return 0;
  const wagers = cards.filter(c => c.kind === "wager").length;
  const numberSum = cards.filter(c => c.kind === "number").reduce((sum, c) => sum + c.value, 0);
  let score = (numberSum - 20) * (wagers + 1);
  if (cards.length >= 8) score += 20;
  return score;
}


function selectedMobileCard(){if(!state||mobileSelectedCardId==null)return null;return state.hand.find(c=>c.id===mobileSelectedCardId)||null}
function clearMobileSelection(){
  mobileSelectedCardId=null;
  mobileSelectedDiscardColor=null;
  renderMobileInteractionState();
}
function renderMobileInteractionState(){
  if(!isMobileMode()||!state)return;

  const selected=selectedMobileCard();
  document.querySelectorAll('.card.mobileSelected').forEach(el=>el.classList.remove('mobileSelected'));
  document.querySelectorAll('.mobileCompatibleTarget').forEach(el=>el.classList.remove('mobileCompatibleTarget'));
  document.querySelectorAll('.discardPile.mobileDiscardSelected').forEach(el=>el.classList.remove('mobileDiscardSelected'));

  if(selected){
    const sorted=state.hand.slice().sort((a,b)=>COLORS.indexOf(a.color)-COLORS.indexOf(b.color)||a.value-b.value);
    const handCards=[...document.querySelectorAll('#hand .card')];
    const idx=sorted.findIndex(c=>c.id===selected.id);
    if(handCards[idx])handCards[idx].classList.add('mobileSelected');
  }

  if(mobileSelectedDiscardColor){
    const pile=document.querySelector(`#discardPiles .discardPile[data-color="${mobileSelectedDiscardColor}"]`);
    if(pile)pile.classList.add('mobileDiscardSelected');
  }

  const txt=$('mobileSelectedText');
  const leftBtn=$('mobileDiscardButton');
  const rightBtn=$('mobileDrawButton');
  const dock=$('mobileActionDock');
  if(!dock)return;

  dock.classList.remove('hidden');
  const myTurn=isMyTurn()&&!state.finished;

  if(state.finished){
    txt.textContent='게임 종료';
    leftBtn.textContent='종료';
    leftBtn.disabled=true;
    rightBtn.textContent='새 게임 시작';
    rightBtn.disabled=false;
    return;
  }

  if(!myTurn){
    txt.textContent='상대방 턴입니다';
    leftBtn.disabled=true;
    rightBtn.disabled=true;
    return;
  }

  if(state.phase==='play'){
    mobileSelectedDiscardColor=null;
    txt.textContent=selected
      ? `${COLOR_NAMES[selected.color]} ${selected.kind==='wager'?'투자':selected.value} 선택됨`
      : '손패에서 카드를 선택하세요';
    leftBtn.textContent='선택 카드 버리기';
    leftBtn.disabled=!selected;
    rightBtn.textContent='내 탐험에 놓기';
    rightBtn.disabled=!selected;
  } else {
    mobileSelectedCardId=null;
    const hasDiscard=mobileSelectedDiscardColor && state.discards?.[mobileSelectedDiscardColor];
    txt.textContent=mobileSelectedDiscardColor
      ? `${COLOR_NAMES[mobileSelectedDiscardColor]} 버림패 선택됨`
      : '가져올 버림패를 선택하거나 덱에서 뽑으세요';
    leftBtn.textContent='버림패에서 가져오기';
    leftBtn.disabled=!hasDiscard;
    rightBtn.textContent=`덱에서 뽑기 · ${Number(state.deckCount || 0)}장`;
    rightBtn.disabled=false;
  }
}

function setupMobileTapTargets(){
  if(!isMobileMode()||!state)return;

  /* Mobile uses buttons to confirm actions. Expedition taps do not play cards. */
  document.querySelectorAll('#myExpeditions .expedition').forEach(el=>{
    el.onclick=null;
  });

  /* In draw phase, tapping a discard pile only selects it. */
  document.querySelectorAll('#discardPiles .discardPile').forEach(el=>{
    const color=el.dataset.color;
    el.onclick=(e)=>{
      if(!state||state.finished||!isMyTurn()||state.phase!=='draw')return;
      e.preventDefault();
      e.stopPropagation();
      if(!state.discards?.[color]){
        showToast('이 색의 버림패가 비어 있습니다.');
        return;
      }
      mobileSelectedDiscardColor = mobileSelectedDiscardColor===color ? null : color;
      renderMobileInteractionState();
    };
  });
}

function renderMobileGoalProgress(){if(!isMobileMode()||!$('mobileGoalProgress'))return;const goals=state?.goals||[];$('mobileGoalProgress').textContent=`${goals.filter(g=>g.status?.state==='claimed').length}/${goals.length||5}`}

function renderGoalSidebar() {
  const list = $("goalList");
  if (!list) return;

  list.innerHTML = "";
  (state.goals || []).forEach(goal => {
    const item = document.createElement("div");
    const done = goal.status?.state === "claimed";
    const compare = goal.status?.state === "compare";
    item.className = `goalItem${done ? " done" : ""}${compare ? " compare" : ""}`;
    item.innerHTML = `
      <div class="goalItemTitle">
        <span>${goal.title}</span>
        <span class="goalPoint">+${goal.points}</span>
      </div>
      <div class="goalDesc">${goal.desc}</div>
      <div class="goalStatus">${goal.status?.text || ""}</div>
    `;
    list.appendChild(item);
  });

  const byColor = {};
  let liveTotal = 0;
  for (const color of COLORS) {
    byColor[color] = expeditionScoreForLive(state.expeditions[state.me][color]);
    liveTotal += byColor[color];
  }
  if ($("myExpeditionTotal")) {
    const totalEl = $("myExpeditionTotal");
    totalEl.textContent = liveTotal;
    totalEl.classList.remove("scorePositive","scoreNegative","scoreZero");
    totalEl.classList.add(liveTotal > 0 ? "scorePositive" : liveTotal < 0 ? "scoreNegative" : "scoreZero");
  }
  if ($("myLiveTotal")) $("myLiveTotal").textContent = liveTotal;
  if ($("myLiveByColor")) $("myLiveByColor").innerHTML = COLORS.map(color =>
    `<div class="myLiveRow"><span>${COLOR_NAMES[color]}</span><strong>${byColor[color]}</strong></div>`
  ).join("");

  const history = state.history || [];
  $("historyList").innerHTML = history.length
    ? history.map(h => {
        const result = h.winner === "draw" ? "무승부" : `${h.names[h.winner]} 승`;
        return `<div class="historyCompactItem"><strong>${result}</strong> · ${h.scores[0]} : ${h.scores[1]}</div>`;
      }).join("")
    : `<div>아직 기록 없음</div>`;
}

function renderFinalSideScore() {
  const panel = $("finalScoreSide");
  if (!panel) return;

  if (!state.finished || !state.scores) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  const mine = state.scores[state.me];
  const opp = state.scores[1 - state.me];
  const myName = state.players[state.me].name;
  const oppName = state.players[1 - state.me].name;

  $("finalResultText").textContent = state.winner === "draw"
    ? "무승부"
    : (state.winner === state.me ? "승리" : "패배");

  const rows = COLORS.map(color =>
    `<tr><td>${COLOR_NAMES[color]}</td><td>${mine.byColor[color]}</td><td>${opp.byColor[color]}</td></tr>`
  ).join("");

  $("finalScoreContent").innerHTML = `
    <table class="finalMiniTable">
      <thead><tr><th>탐험</th><th>${myName}</th><th>${oppName}</th></tr></thead>
      <tbody>
        ${rows}
        <tr><th>기본</th><th>${mine.baseTotal}</th><th>${opp.baseTotal}</th></tr>
        <tr><th>목표</th><th>+${mine.goalPoints}</th><th>+${opp.goalPoints}</th></tr>
        <tr><th>최종</th><th>${mine.total}</th><th>${opp.total}</th></tr>
      </tbody>
    </table>
  `;
}

function renderOpponentFinalHand() {
  const wrap = $("opponentFinalHandWrap");
  const cards = $("opponentFinalHandCards");
  if (!wrap || !cards) return;

  if (!state.finished) {
    wrap.classList.add("hidden");
    cards.innerHTML = "";
    return;
  }

  wrap.classList.remove("hidden");
  cards.innerHTML = "";
  (state.opponentFinalHand || [])
    .slice()
    .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.value - b.value)
    .forEach(card => cards.appendChild(cardEl(card, true, false)));
}


function renderExpeditions(container, expeditions, isMine = false) {
  container.innerHTML = "";

  for (const color of COLORS) {
    const box = document.createElement("div");
    box.className = "expedition";
    box.dataset.color = color;

    const title = document.createElement("div");
    title.className = "expeditionTitle";
    if (isMine) {
      const liveScore = expeditionScoreForLive(expeditions[color]);
      const scoreClass = liveScore > 0 ? "scorePositive" : liveScore < 0 ? "scoreNegative" : "scoreZero";
      title.innerHTML = `
        <span>${COLOR_NAMES[color]}</span>
        <span class="expeditionMeta">
          <span class="expeditionCount">${expeditions[color].length}장</span>
          <span class="expeditionDivider">|</span>
          <strong class="expeditionLiveScore ${scoreClass}">점수: ${liveScore}</strong>
        </span>`;
    } else {
      title.innerHTML = `<span>${COLOR_NAMES[color]}</span><span>${expeditions[color].length}장</span>`;
    }

    const stack = document.createElement("div");
    stack.className = "stack";
    expeditions[color].forEach(card => stack.appendChild(cardEl(card, true)));

    box.append(title, stack);

    if (isMine && !state.finished) {
      wireDropTarget(box, cardId => {
        const card = state.hand.find(c => c.id === cardId);
        if (!card) return;
        if (card.color !== color) {
          showToast(`${COLOR_NAMES[card.color]} 카드는 ${COLOR_NAMES[color]} 탐험에 놓을 수 없습니다.`);
          return;
        }
        playById(cardId, "expedition");
      });
    }

    container.appendChild(box);
  }
}

function renderDiscards() {
  const container = $("discardPiles");
  container.innerHTML = "";

  for (const color of COLORS) {
    const pile = document.createElement("div");
    pile.className = "discardPile";
    pile.dataset.color = color;

    const top = state.discards[color];
    if (top) pile.appendChild(cardEl(top, true));

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = `${state.discardCounts[color]}장`;
    pile.appendChild(count);

    if (!state.finished) {
      wireDropTarget(pile, cardId => playById(cardId, "discard"));
      if (!isMobileMode()) {
        pile.addEventListener("click", () => draw("discard", color));
      }
    }
    container.appendChild(pile);
  }
}

function renderHand() {
  const hand = $("hand");
  hand.innerHTML = "";

  const canMove = Boolean(state.canPlayCard);

  state.hand
    .slice()
    .sort((a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || a.value - b.value)
    .forEach(card => {
      // v6.4: hand interaction is selection-based on both desktop and mobile.
      const el = cardEl(card, false, false);
      if (canMove) {
        el.classList.add("selectableCard");
        el.addEventListener("click", e => {
          if (!state || state.finished || !isMyTurn() || state.phase !== "play") return;
          e.preventDefault();
          e.stopPropagation();
          mobileSelectedCardId = mobileSelectedCardId === card.id ? null : card.id;
          renderMobileInteractionState();
        });
      }
      hand.appendChild(el);
    });
}

function renderStatus() {
  const banner = $("statusBanner");
  banner.classList.remove("myTurn", "waitingTurn", "finished");

  if (state.finished) {
    banner.classList.add("finished");
    $("statusMain").textContent = "게임 종료";
    $("statusSub").textContent = "최종 점수를 계산했습니다.";
    return;
  }

  if (state.currentPlayer !== state.me) {
    banner.classList.add("waitingTurn");
    $("statusMain").textContent = "상대방 턴";
    $("statusSub").textContent = `${state.players[state.currentPlayer].name}이(가) 진행 중입니다.`;
    return;
  }

  banner.classList.add("myTurn");

  if (state.phase === "play") {
    $("statusMain").textContent = "내 턴 · 카드 놓기";
    $("statusSub").textContent = "손패를 탐험열 또는 버림패로 드래그하세요.";
  } else {
    $("statusMain").textContent = "내 턴 · 카드 뽑기";
    $("statusSub").textContent = "덱 또는 버림패의 맨 위 카드를 클릭하세요.";
  }
}

function renderScores() {
  renderFinalSideScore();
}

function applyTurnBackground() {
  document.body.classList.remove("turn-me", "turn-opponent", "turn-finished");

  if (!state || state.waiting) return;

  if (state.finished) {
    document.body.classList.add("turn-finished");
  } else if (isMyTurn()) {
    document.body.classList.add("turn-me");
  } else {
    document.body.classList.add("turn-opponent");
  }
}

function render() {
  if (!state) return;

  if (state.waiting) {
    document.body.classList.remove("turn-me", "turn-opponent", "turn-finished");
    $("lobby").classList.add("hidden");
    $("game").classList.add("hidden");
    $("waiting").classList.remove("hidden");
    $("waitingCode").textContent = state.roomCode;
    return;
  }

  $("lobby").classList.add("hidden");
  $("waiting").classList.add("hidden");
  $("game").classList.remove("hidden");

  const me = state.me;
  const opp = 1 - me;

  $("roomCodeLabel").textContent = state.roomCode;
  $("deckCount").textContent = Number(state.deckCount || 0);

  const drawButton = $("drawDeck");
  const drawFace = $("deckFaceCount");
  const drawLabel = $("drawActionLabel");
  const drawHint = $("drawActionHint");

  if (state.finished) {
    drawFace.textContent = "↻";
    drawFace.classList.remove("danger");
    drawLabel.textContent = "재시작";
    drawHint.textContent = "클릭해서 새 게임";
    drawButton.classList.add("restartMode");
  } else {
    drawFace.textContent = Number(state.deckCount || 0);
    drawFace.classList.toggle("danger", Number(state.deckCount || 0) <= 10);
    drawLabel.textContent = "뽑기 더미";
    drawHint.textContent = "클릭해서 1장 뽑기";
    drawButton.classList.remove("restartMode");
  }
  $("myName").textContent = state.players[me].name;
  $("opponentName").textContent = state.players[opp].name;
  $("opponentHand").textContent = state.finished ? `마지막 손패 ${state.opponentFinalHand.length}장` : `손패 ${state.opponentHandCount}장`;

  $("phaseText").textContent = state.finished
    ? "종료"
    : isMyTurn()
      ? (state.phase === "play" ? "카드를 놓을 차례" : "카드를 뽑을 차례")
      : "상대방 진행 중";

  applyTurnBackground();
  renderStatus();
  renderExpeditions($("myExpeditions"), state.expeditions[me], true);
  renderExpeditions($("opponentExpeditions"), state.expeditions[opp], false);
  renderDiscards();
  renderHand();
  renderGoalSidebar();
  renderOpponentFinalHand();
  renderScores();
  setupMobileTapTargets();
  renderMobileInteractionState();
  renderMobileGoalProgress();
}

function playById(cardId, action) {
  if (!state || state.finished) return;

  if (!state.canPlayCard) {
    showToast(!isMyTurn() ? "지금은 상대방 턴입니다." : "지금은 카드를 뽑을 차례입니다.");
    return;
  }

  socket.emit("playCard", { cardId, action }, res => {
    if (!res?.ok) showToast(res?.message || "처리할 수 없습니다.");
  });
}

function draw(source, color = null) {
  if (!state || state.finished) return;

  if (!state.canDrawCard) {
    showToast(!isMyTurn() ? "상대방의 턴입니다." : "먼저 카드를 내거나 버리세요.");
    return;
  }

  socket.emit("drawCard", { source, color }, res => {
    if (!res?.ok) showToast(res?.message || "카드를 뽑을 수 없습니다.");
  });
}

$("createBtn").onclick = () => {
  socket.emit("createRoom", { name: $("nameInput").value }, res => {
    if (!res?.ok) {
      $("lobbyMessage").textContent = res?.message || "방 생성 실패";
      return;
    }
    saveOnlineSession(res.code, res.token, $("nameInput").value);
    updateShareUrl(res.code);
  });
};

$("joinBtn").onclick = () => {
  socket.emit("joinRoom", { code: $("roomInput").value, name: $("nameInput").value }, res => {
    if (!res?.ok) {
      $("lobbyMessage").textContent = res?.message || "방 참가 실패";
      return;
    }
    saveOnlineSession(res.code, res.token, $("nameInput").value);
    updateShareUrl(res.code);
  });
};

$("drawDeck").onclick = () => {
  if (state?.finished) {
    socket.emit("restartGame", {}, res => {
      if (!res?.ok) showToast(res?.message || "다시 시작할 수 없습니다.");
    });
  } else {
    draw("deck");
  }
};

$("restartBtn").onclick = () => {
  socket.emit("restartGame", {}, res => {
    if (!res?.ok) showToast(res?.message || "다시 시작할 수 없습니다.");
  });
};


socket.on("connect", () => {
  const previous = loadOnlineSession();
  prefillRoomFromUrl();

  if (!previous?.code || !previous?.token) return;

  socket.emit("reconnectRoom", {
    code: previous.code,
    token: previous.token
  }, res => {
    if (res?.ok) {
      updateShareUrl(previous.code);
      if ($("lobbyMessage")) $("lobbyMessage").textContent = "이전 게임에 다시 연결했습니다.";
      return;
    }

    if (res?.reason === "room_not_found" || res?.reason === "invalid_token") {
      clearOnlineSession();
    }
  });
});

socket.on("state", newState => {
  state = normalizeIncomingState(newState);
  if (
    !state ||
    state.finished ||
    !state.canPlayCard ||
    (mobileSelectedCardId != null && !state.hand?.some(c => c.id === mobileSelectedCardId))
  ) {
    mobileSelectedCardId = null;
  }
  if (!state?.canDrawCard) mobileSelectedDiscardColor = null;
  render();
});


if($('mobileGoalToggle'))$('mobileGoalToggle').onclick=()=>$('goalSidebar').classList.toggle('mobileOpen');
if($('mobileCancelSelection'))$('mobileCancelSelection').onclick=clearMobileSelection;
if($('mobileDiscardButton'))$('mobileDiscardButton').onclick=()=>{
  if(!state||state.finished||!isMyTurn())return;

  if(state.phase==='play'){
    const s=selectedMobileCard();
    if(!s)return;
    playById(s.id,'discard');
    mobileSelectedCardId=null;
  } else if(state.phase==='draw'){
    if(!mobileSelectedDiscardColor)return;
    draw('discard',mobileSelectedDiscardColor);
    mobileSelectedDiscardColor=null;
  }
};

if($('mobileDrawButton'))$('mobileDrawButton').onclick=()=>{
  if(!state)return;

  if(state.finished){
    socket.emit('restartGame',{},res=>{
      if(!res?.ok)showToast(res?.message||'다시 시작할 수 없습니다.');
    });
    return;
  }

  if(state.phase==='play'){
    const s=selectedMobileCard();
    if(!s||!state.canPlayCard)return;
    playById(s.id,'expedition');
    mobileSelectedCardId=null;
  } else if(state.canDrawCard){
    draw('deck');
    mobileSelectedDiscardColor=null;
  }
};
window.addEventListener('resize',()=>{if(!isMobileMode()){$('goalSidebar')?.classList.remove('mobileOpen');mobileSelectedCardId=null}renderMobileInteractionState()});

socket.on("notice", showToast);


prefillRoomFromUrl();

window.addEventListener("orientationchange",()=>{
  setTimeout(()=>{
    $("goalSidebar")?.classList.remove("mobileOpen");
    render();
  },120);
});
