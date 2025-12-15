/*******************************************************
 * script.js（B方式：Firestore自動更新なし）
 * - index.html    : 参加者(スマホ) 解答のみ（deadlineで自動締切）
 * - question.html : 画面共有 表示のみ（Firestoreは書き換えない）
 * - admin.html    : 司会 操作（intro→question→votes→result→ranking→final）
 *
 * 修正点：
 * 1) admin_resetScreen() を追加（待機に戻るボタンが動く）
 * 2) admin_showFinalRanking() を追加（admin.html と一致）
 * 3) 「回答開始した瞬間に時間切れ」対策：
 *    - 端末時計ズレ/反映遅延があっても、受信時刻基準で10秒に自動補正
 *******************************************************/

const ROOM_ID = "roomA";
const DEFAULT_SECONDS = 10;

// Firebase（各HTMLの module で window に注入）
let db = null;
let FS = null;

// プレイヤー情報（indexのみ使用）
let playerId = localStorage.getItem("playerId");
let playerName = localStorage.getItem("playerName");

// 画面判定
const isIndex = !!document.getElementById("joinBtn");
const isQuestion = !!document.getElementById("screenQuestionText");

// index DOM
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const waitingArea = document.getElementById("waitingArea");
const choicesDiv = document.getElementById("choices");

// question DOM
const qQuestionText = document.getElementById("screenQuestionText");
const qTimer = document.getElementById("screenTimer");
const qImage = document.getElementById("screenImage");
const qChoices = document.getElementById("screenChoices");
const qRankingWrap = document.getElementById("screenRanking");
const qRankingTitle = document.getElementById("rankingTitle");
const qRankingList = document.getElementById("rankingList");

// --------------------- 共通ユーティリティ ---------------------
function makeId(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Firestore Timestamp / number を ms に
function toMillis(t) {
  if (t == null) return null;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") return t.seconds * 1000 + (t.nanoseconds || 0) / 1e6;
  return null;
}

function roomRef() {
  return FS.doc(db, "rooms", ROOM_ID);
}
function questionRef(qid) {
  return FS.doc(db, "rooms", ROOM_ID, "questions", String(qid));
}
function answersRef(qid) {
  return FS.doc(db, "rooms", ROOM_ID, "answers", String(qid));
}
function playerRef(pid) {
  return FS.doc(db, "rooms", ROOM_ID, "players", pid);
}

async function ensureRoomDoc() {
  const snap = await FS.getDoc(roomRef());
  if (!snap.exists()) {
    await FS.setDoc(roomRef(), { state: { phase: "waiting" } }, { merge: true });
  }
}

// --------------------- state監視 ---------------------
let unState = null;
let latestState = null;

// index用：表示中の設問
let indexShownQid = null;
let indexDisableTimer = null;
let indexAnsweredForQid = null;
let indexQuestionReceivedAtMs = null;

// question用：表示中の設問
let questionShownQid = null;
let questionReceivedAtMs = null;

function listenState() {
  if (!FS) return;
  if (unState) unState();

  unState = FS.onSnapshot(roomRef(), async (snap) => {
    if (!snap.exists()) {
      latestState = { phase: "waiting" };
      if (isQuestion) renderQuestionScreen(latestState);
      if (isIndex) renderIndexScreen(latestState);
      return;
    }

    const data = snap.data() || {};
    latestState = data.state || { phase: "waiting" };

    if (isQuestion) renderQuestionScreen(latestState);
    if (isIndex) renderIndexScreen(latestState);
  });
}

// --------------------- deadline補正（重要） ---------------------
// adminのdeadlineMsが端末の時計ズレで「過去」扱いになると即タイムアップになるため、
// 「この端末が質問フェーズを受信した時刻」基準で seconds 分は必ず猶予を確保する。
function getSecondsFromState(state) {
  const s = state?.seconds;
  if (typeof s === "number" && s >= 1 && s <= 120) return s;
  return DEFAULT_SECONDS;
}

function calcClientDeadlineMs(state, receivedAtMs) {
  const seconds = getSecondsFromState(state);

  // まずは state.deadlineMs を使う
  let deadlineMs = (typeof state?.deadlineMs === "number") ? state.deadlineMs : null;

  // startAt（server）と startAtMs（adminローカル）から補正（admin時計がズレてても少しマシにする）
  const startAtServer = toMillis(state?.startAt);
  const startAtLocal = (typeof state?.startAtMs === "number") ? state.startAtMs : null;
  if (deadlineMs != null && startAtServer != null && startAtLocal != null) {
    const delta = startAtServer - startAtLocal;
    deadlineMs = deadlineMs + delta;
  }

  // ★最重要：受信時刻より前なら「受信時刻+seconds」に補正（即タイムアップ対策）
  if (receivedAtMs != null) {
    const minDeadline = receivedAtMs + seconds * 1000;
    if (deadlineMs == null || deadlineMs < minDeadline) {
      deadlineMs = minDeadline;
    }
  }

  return deadlineMs;
}

// --------------------- index: 参加 ---------------------
async function joinGame() {
  if (!FS) {
    alert("Firestore準備中です。少し待って再度お試しください");
    return;
  }

  const name = (nameInput?.value || "").trim();
  if (!name) return alert("ニックネームを入力してください");

  if (!playerId) {
    playerId = makeId();
    localStorage.setItem("playerId", playerId);
  }
  playerName = name;
  localStorage.setItem("playerName", name);

  // ★ score を毎回0で上書きしない（重要）
  const pSnap = await FS.getDoc(playerRef(playerId));
  if (!pSnap.exists()) {
    await FS.setDoc(playerRef(playerId), {
      name,
      score: 0,
      joinedAtMs: Date.now()
    });
  } else {
    await FS.updateDoc(playerRef(playerId), { name });
  }

  // UI切替
  document.getElementById("joinArea")?.setAttribute("style", "display:none;");
  if (nameInput) nameInput.style.display = "none";
  if (joinBtn) joinBtn.style.display = "none";
  if (waitingArea) waitingArea.style.display = "block";

  // 監視開始
  listenState();
}

// index: stateに応じた表示
async function renderIndexScreen(state) {
  const phase = state?.phase || "waiting";

  // 待機系
  if (phase === "waiting" || phase === "idle" || phase === "intro" || !phase) {
    if (waitingArea) {
      waitingArea.style.display = "block";
      waitingArea.textContent = "準備ができるまでお待ちください";
    }
    if (choicesDiv) choicesDiv.innerHTML = "";
    indexShownQid = null;
    indexAnsweredForQid = null;
    indexQuestionReceivedAtMs = null;
    clearIndexDisableTimer();
    return;
  }

  // 出題中（解答受付中）
  if (phase === "question") {
    if (waitingArea) waitingArea.style.display = "none";

    const qid = state.currentQuestion;
    const now = Date.now();

    // 問題が切り替わった瞬間を「受信時刻」として記録（補正用）
    if (qid != null && qid !== indexShownQid) {
      indexShownQid = qid;
      indexAnsweredForQid = null;
      indexQuestionReceivedAtMs = now;
      await renderIndexChoices(qid);
    }

    const deadlineMs = calcClientDeadlineMs(state, indexQuestionReceivedAtMs ?? now);

    // deadlineで自動締切（手動不要）
    scheduleIndexDisable(deadlineMs);
    if (Date.now() >= deadlineMs) disableIndexChoices(true);
    else disableIndexChoices(false);

    return;
  }

  // それ以外のフェーズでは解答不可
  disableIndexChoices(true);
}

// index: 選択肢描画
async function renderIndexChoices(qid) {
  if (!FS || !choicesDiv) return;

  const qSnap = await FS.getDoc(questionRef(qid));
  if (!qSnap.exists()) {
    choicesDiv.innerHTML = "<p>問題データがありません</p>";
    return;
  }

  const q = qSnap.data();
  const options = Array.isArray(q.options) ? q.options : [];

  choicesDiv.innerHTML = "";
  options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${idx + 1}. ${opt}`;
    btn.onclick = () => answer(idx + 1);

    // スマホ押しやすい
    btn.style.display = "block";
    btn.style.width = "100%";
    btn.style.fontSize = "18px";
    btn.style.padding = "12px 14px";
    btn.style.margin = "10px 0";
    btn.style.borderRadius = "10px";
    btn.style.border = "2px solid rgba(0,0,0,0.25)";
    btn.style.background = "rgba(255,255,255,0.92)";
    btn.style.color = "#111";

    choicesDiv.appendChild(btn);
  });

  disableIndexChoices(false);
}

// index: 回答
async function answer(optIdx) {
  if (!FS) return;
  if (!latestState || latestState.phase !== "question") {
    alert("回答時間が終了しています");
    disableIndexChoices(true);
    return;
  }

  const qid = latestState.currentQuestion;
  const now = Date.now();
  const deadlineMs = calcClientDeadlineMs(latestState, indexQuestionReceivedAtMs ?? now);

  // deadline判定（二重ガード）
  if (Date.now() > deadlineMs) {
    alert("回答時間が終了しています");
    disableIndexChoices(true);
    return;
  }

  // 同一問題で二度押し防止（UI上）
  if (indexAnsweredForQid === qid) return;
  indexAnsweredForQid = qid;

  // UI：選んだもの青枠、他は薄く
  document.querySelectorAll(".choiceBtn").forEach((btn, idx) => {
    if (idx + 1 === optIdx) {
      btn.style.border = "4px solid #0066ff";
      btn.style.background = "#eef4ff";
      btn.style.opacity = "1";
    } else {
      btn.style.opacity = "0.25";
    }
    btn.disabled = true;
  });

  await FS.setDoc(
    answersRef(qid),
    {
      [playerId]: {
        option: optIdx,
        answeredAt: FS.serverTimestamp(),
        answeredAtMs: Date.now()
      }
    },
    { merge: true }
  );
}

function disableIndexChoices(disabled) {
  document.querySelectorAll(".choiceBtn").forEach((b) => (b.disabled = !!disabled));
}

function clearIndexDisableTimer() {
  if (indexDisableTimer) {
    clearTimeout(indexDisableTimer);
    indexDisableTimer = null;
  }
}

function scheduleIndexDisable(deadlineMs) {
  clearIndexDisableTimer();
  const ms = Math.max(0, deadlineMs - Date.now());
  indexDisableTimer = setTimeout(() => {
    disableIndexChoices(true);
  }, ms);
}

// --------------------- question: 表示専用（Firestore書き換え無し） ---------------------
let questionCountdownInterval = null;
let questionCountdownForQid = null;
let rankingInterval = null;

function qHideAll() {
  if (qQuestionText) qQuestionText.style.display = "none";
  if (qTimer) qTimer.style.display = "none";
  if (qImage) qImage.style.display = "none";
  if (qChoices) qChoices.style.display = "none";
  if (qRankingWrap) qRankingWrap.style.display = "none";
  if (qRankingTitle) qRankingTitle.textContent = "";
  if (qRankingList) qRankingList.innerHTML = "";
  stopQuestionCountdown();
  stopRankingAnimation();
}

async function renderQuestionScreen(state) {
  if (!FS) return;

  const phase = state?.phase || "waiting";
  const qid = state?.currentQuestion;

  // 待機：背景のみ
  if (phase === "waiting" || phase === "idle" || !phase) {
    qHideAll();
    questionShownQid = null;
    questionReceivedAtMs = null;
    return;
  }

  // ランキング／最終結果：中央パネルのみ
  if (phase === "ranking") {
    qHideAll();
    qRankingWrap.style.display = "flex";
    startStackRanking(state.ranking || [], "正解者ランキング（上位10名）", "time");
    return;
  }

  if (phase === "final") {
    qHideAll();
    qRankingWrap.style.display = "flex";
    startStackRanking(state.finalRanking || [], "最終結果ランキング", "score");
    return;
  }

  // ここから intro / question / votes / result
  if (qid == null) {
    qHideAll();
    return;
  }

  const now = Date.now();
  if (qid !== questionShownQid) {
    questionShownQid = qid;
    questionReceivedAtMs = now;
  }

  const qSnap = await FS.getDoc(questionRef(qid));
  if (!qSnap.exists()) {
    qHideAll();
    if (qQuestionText) {
      qQuestionText.style.display = "block";
      qQuestionText.textContent = "問題データがありません";
    }
    return;
  }

  const q = qSnap.data();
  const options = Array.isArray(q.options) ? q.options : [];
  const correct = state.correct;

  // 問題文
  if (qQuestionText) {
    qQuestionText.style.display = "block";
    qQuestionText.textContent = q.text || "";
  }

  // 画像
  if (qImage) {
    if (q.imageUrl) {
      qImage.src = q.imageUrl;
      qImage.style.display = "block";
    } else {
      qImage.style.display = "none";
    }
  }

  // intro
  if (phase === "intro") {
    if (qTimer) qTimer.style.display = "none";
    if (qChoices) qChoices.style.display = "none";
    stopQuestionCountdown();
    return;
  }

  // question（表示だけ）
  if (phase === "question") {
    if (qChoices) qChoices.style.display = "block";
    if (qTimer) qTimer.style.display = "block";

    if (qChoices) {
      qChoices.innerHTML = "";
      options.forEach((opt, idx) => {
        const div = document.createElement("div");
        div.className = "screenChoice";
        div.textContent = `${idx + 1}. ${opt}`;
        qChoices.appendChild(div);
      });
    }

    const deadlineMs = calcClientDeadlineMs(state, questionReceivedAtMs ?? now);
    startQuestionCountdown(qid, deadlineMs);
    return;
  }

  // votes
  if (phase === "votes") {
    stopQuestionCountdown();
    if (qTimer) {
      qTimer.style.display = "none";
      qTimer.textContent = "";
    }
    if (qChoices) qChoices.style.display = "block";
    const votes = state.votes || {};
    if (qChoices) {
      qChoices.innerHTML = "";
      options.forEach((opt, idx) => {
        const v = votes[idx + 1] || 0;
        const div = document.createElement("div");
        div.className = "screenChoice";
        div.textContent = `${idx + 1}. ${opt}（${v}票）`;
        qChoices.appendChild(div);
      });
    }
    return;
  }

  // result
  if (phase === "result") {
    stopQuestionCountdown();
    if (qTimer) {
      qTimer.style.display = "none";
      qTimer.textContent = "";
    }
    if (qChoices) qChoices.style.display = "block";
    if (qChoices) {
      qChoices.innerHTML = "";
      options.forEach((opt, idx) => {
        const div = document.createElement("div");
        div.className = "screenChoice";
        div.textContent = `${idx + 1}. ${opt}`;
        if (correct === idx + 1) {
          div.style.border = "4px solid #ff3333";
          div.style.background = "#ffecec";
          div.style.opacity = "1";
        } else {
          div.style.opacity = "0.2";
        }
        qChoices.appendChild(div);
      });
    }
    return;
  }

  qHideAll();
}

function startQuestionCountdown(qid, deadlineMs) {
  if (!qTimer) return;

  if (questionCountdownForQid !== qid) {
    stopQuestionCountdown();
    questionCountdownForQid = qid;
  }
  if (questionCountdownInterval) return;

  const tick = () => {
    const remain = deadlineMs - Date.now();
    const sec = Math.max(0, Math.ceil(remain / 1000));
    qTimer.textContent = remain > 0 ? `残り ${sec} 秒` : "時間終了！";
    if (remain <= 0) stopQuestionCountdown();
  };

  tick();
  questionCountdownInterval = setInterval(tick, 200);
}

function stopQuestionCountdown() {
  if (questionCountdownInterval) {
    clearInterval(questionCountdownInterval);
    questionCountdownInterval = null;
  }
}

// --------------------- ランキング：下位→上位を下から積み上げ ---------------------
function startStackRanking(entries, title, mode) {
  if (!qRankingWrap || !qRankingTitle || !qRankingList) return;

  stopRankingAnimation();

  qRankingWrap.style.display = "flex";
  qRankingTitle.textContent = title;
  qRankingList.innerHTML = "";

  if (!Array.isArray(entries) || entries.length === 0) {
    const item = document.createElement("div");
    item.className = "rankItem";
    item.textContent = "データがありません";
    qRankingList.appendChild(item);
    return;
  }

  const sortedAsc = entries.slice().sort((a, b) => a.rank - b.rank);
  const displayOrder = sortedAsc.slice().reverse(); // 下位→上位

  let i = 0;
  const step = () => {
    if (i >= displayOrder.length) {
      stopRankingAnimation();
      return;
    }
    const p = displayOrder[i++];
    const item = document.createElement("div");
    item.className = "rankItem";

    if (mode === "time") {
      const sec = ((p.timeMs || 0) / 1000).toFixed(2);
      item.textContent = `${p.rank}位：${p.name}（${sec}秒）`;
    } else {
      item.textContent = `${p.rank}位：${p.name}（${p.totalScore ?? 0}点）`;
    }
    qRankingList.appendChild(item);
  };

  step();
  rankingInterval = setInterval(step, 1000);
}

function stopRankingAnimation() {
  if (rankingInterval) {
    clearInterval(rankingInterval);
    rankingInterval = null;
  }
}

// --------------------- admin API（admin.htmlから呼ぶ） ---------------------
async function admin_setWaiting() {
  if (!FS) return alert("読み込み中です");
  await ensureRoomDoc();
  await FS.setDoc(roomRef(), { state: { phase: "waiting" } }, { merge: true });
}

// ★ admin.html の待機ボタン用（互換）
async function admin_resetScreen() {
  return admin_setWaiting();
}

async function admin_showIntro(qid) {
  if (!FS) return alert("読み込み中です");
  await ensureRoomDoc();

  await FS.setDoc(answersRef(qid), {}); // 前回回答リセット

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "intro",
        currentQuestion: qid,
        votes: null,
        correct: null,
        ranking: null,
        finalRanking: null
      }
    },
    { merge: true }
  );
}

// 選択肢表示＆回答開始（secondsは state にも保存）
async function admin_startQuestion(qid, seconds = DEFAULT_SECONDS) {
  if (!FS) return alert("読み込み中です");
  await ensureRoomDoc();

  await FS.setDoc(answersRef(qid), {}); // 回答リセット

  const startAtMs = Date.now();
  const deadlineMs = startAtMs + seconds * 1000;

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "question",
        currentQuestion: qid,
        seconds,
        startAt: FS.serverTimestamp(),
        startAtMs,
        deadlineMs,
        votes: null,
        correct: null,
        ranking: null,
        finalRanking: null
      }
    },
    { merge: true }
  );
}

async function admin_showVotes(qid) {
  if (!FS) return alert("読み込み中です");
  await ensureRoomDoc();

  const qSnap = await FS.getDoc(questionRef(qid));
  const optLen = qSnap.exists() && Array.isArray(qSnap.data().options) ? qSnap.data().options.length : 4;

  const ansSnap = await FS.getDoc(answersRef(qid));
  const data = ansSnap.exists() ? ansSnap.data() : {};

  const counts = {};
  for (let i = 1; i <= optLen; i++) counts[i] = 0;

  for (const pid in data) {
    const entry = data[pid];
    const v = entry?.option;
    if (counts[v] != null) counts[v]++;
  }

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "votes",
        currentQuestion: qid,
        votes: counts
      }
    },
    { merge: true }
  );
}

// admin.html から (qid, correct) で呼ばれても壊れないように第2引数を受け取る
async function admin_reveal(qid /*, correctFromHtml */) {
  if (!FS) return alert("読み込み中です");
  await ensureRoomDoc();

  const qSnap = await FS.getDoc(questionRef(qid));
  const correct = qSnap.exists() ? qSnap.data().correct : null;

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "result",
        currentQuestion: qid,
        correct
      }
    },
    { merge: true }
  );
}

// 正解者ランキング＋得点計算（採点済み管理は doc 直下に保持）
async function admin_showRanking(qid /*, correctFromHtml */) {
  if (!FS) return alert("読み込み中です");
  await ensureRoomDoc();

  const roomSnap = await FS.getDoc(roomRef());
  const roomData = roomSnap.exists() ? roomSnap.data() : {};
  const state = roomData.state || {};

  const scoredQuestions = roomData.scoredQuestions || {};
  const alreadyScored = !!scoredQuestions[String(qid)];

  const qSnap = await FS.getDoc(questionRef(qid));
  const qData = qSnap.exists() ? qSnap.data() : {};
  const correct = qData.correct;

  const startAtMs =
    toMillis(state.startAt) || (typeof state.startAtMs === "number" ? state.startAtMs : null);

  const ansSnap = await FS.getDoc(answersRef(qid));
  const answers = ansSnap.exists() ? ansSnap.data() : {};

  // players
  const pSnap = await FS.getDocs(FS.collection(db, "rooms", ROOM_ID, "players"));
  const players = {};
  pSnap.forEach((doc) => {
    const d = doc.data() || {};
    players[doc.id] = {
      name: d.name || "名無し",
      score: typeof d.score === "number" ? d.score : 0
    };
  });

  // 正解者抽出
  const correctList = [];
  for (const pid in answers) {
    const entry = answers[pid];
    if (!entry || entry.option !== correct) continue;

    const ansMs = toMillis(entry.answeredAt) || entry.answeredAtMs || null;
    if (ansMs == null || startAtMs == null) continue;

    correctList.push({
      pid,
      name: players[pid]?.name || "名無し",
      timeMs: Math.max(0, ansMs - startAtMs)
    });
  }

  correctList.sort((a, b) => a.timeMs - b.timeMs);

  const ranking = correctList.slice(0, 10).map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    timeMs: p.timeMs
  }));

  // 得点計算（未スコアリング時のみ）
  if (!alreadyScored) {
    for (let i = 0; i < correctList.length; i++) {
      const p = correctList[i];
      let add = 10;
      if (i === 0) add += 5;
      else if (i === 1) add += 3;
      else if (i === 2) add += 1;

      const newScore = (players[p.pid]?.score || 0) + add;
      players[p.pid].score = newScore;
      await FS.updateDoc(playerRef(p.pid), { score: newScore });
    }

    const newScored = { ...(scoredQuestions || {}), [String(qid)]: true };
    await FS.setDoc(roomRef(), { scoredQuestions: newScored }, { merge: true });
  }

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "ranking",
        currentQuestion: qid,
        correct,
        ranking
      }
    },
    { merge: true }
  );
}

// 最終結果（admin.html のボタン名に合わせて両方用意）
async function admin_showFinalRanking() {
  if (!FS) return alert("読み込み中です");
  await ensureRoomDoc();

  const playersSnap = await FS.getDocs(FS.collection(db, "rooms", ROOM_ID, "players"));
  const players = [];
  playersSnap.forEach((doc) => {
    const d = doc.data() || {};
    players.push({
      name: d.name || "名無し",
      totalScore: typeof d.score === "number" ? d.score : 0
    });
  });

  players.sort((a, b) => b.totalScore - a.totalScore);

  const finalRanking = players.map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    totalScore: p.totalScore
  }));

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "final",
        finalRanking
      }
    },
    { merge: true }
  );
}

// 旧名互換
async function admin_showFinal() {
  return admin_showFinalRanking();
}

// --------------------- windowへ公開（onclick用） ---------------------
window.joinGame = joinGame;

window.admin_setWaiting = admin_setWaiting;
window.admin_resetScreen = admin_resetScreen;

window.admin_showIntro = admin_showIntro;
window.admin_startQuestion = admin_startQuestion;
window.admin_showVotes = admin_showVotes;
window.admin_reveal = admin_reveal;
window.admin_showRanking = admin_showRanking;

window.admin_showFinalRanking = admin_showFinalRanking;
window.admin_showFinal = admin_showFinal;

// --------------------- 起動（firebase注入待ち） ---------------------
async function initFirebaseWait() {
  for (let i = 0; i < 200; i++) {
    if (window.firebaseDB && window.firebaseFirestoreFuncs) {
      db = window.firebaseDB;
      FS = window.firebaseFirestoreFuncs;
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

window.addEventListener("load", async () => {
  const ok = await initFirebaseWait();
  if (!ok) {
    console.error("Firebaseが初期化されていません");
    return;
  }

  // index：名前復元
  if (isIndex && playerName && nameInput) nameInput.value = playerName;

  // index：joinボタン
  if (isIndex && joinBtn) joinBtn.onclick = joinGame;

  // question：常時監視
  if (isQuestion) {
    await ensureRoomDoc();
    listenState();
  }
});



















