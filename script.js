/*******************************************************
 * script.js（完成版）
 * - index.html : 参加＆回答（スマホは解答のみ）
 * - question.html : 出題画面(問題だけ) / 回答画面(選択肢+タイマー) / 投票数 / 正解 / ランキング / 最終結果
 * - admin.html : 待機 / 出題(intro) / 回答開始(question) / 投票(votes) / 正解(result) / ランキング(ranking) / 最終結果(final)
 *
 * ✅重要：古い回答が混ざらないように「questionKey = qid_runId」を使います
 *******************************************************/

const ROOM_ID = "roomA";
const ANSWER_SECONDS = 10;

// Firebase（HTMLの module script から注入される）
let db = null;
let FS = null;

// Player（index用）
let playerId = localStorage.getItem("playerId");
let playerName = localStorage.getItem("playerName");

// ページ判定（defer 前提：DOMが出来てから判定できる）
let isIndex = false;
let isQuestion = false;
let isAdmin = false;

// --- index DOM ---
let nameInput, joinBtn, joinArea, waitingArea, indexChoices, indexHint;

// --- question DOM ---
let layoutIntro, layoutQA, qIntroText, qIntroMedia;
let qaMedia, qaText, qaChoices, qaTimerBig, qaTimerLabel;
let overlayRanking, overlayTitle, overlayList, overlayBox;

// --- Firestore snapshot unsub ---
let unRoom = null;

// --- state cache ---
let lastPhase = null;
let lastQuestionKey = null;
let lastQid = null;
let cachedQuestion = null;

// index：回答状態
let myAnsweredKey = null;
let mySelectedOpt = null;

// question：タイマー描画
let timerTick = null;

// =====================================================
// Utility
// =====================================================
function makeId(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function nowMs() {
  return Date.now();
}

function fmtSec(ms) {
  const s = ms / 1000;
  return s.toFixed(2);
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// 既存回答データ形式（number / {opt, at}）両対応
function extractOpt(val) {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && typeof val.opt === "number") return val.opt;
  return null;
}
function extractAt(val) {
  if (val && typeof val === "object" && typeof val.at === "number") return val.at;
  return null;
}

async function waitFirebaseReady(maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (window.firebaseDB && window.firebaseFirestoreFuncs) {
      db = window.firebaseDB;
      FS = window.firebaseFirestoreFuncs;
      return true;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return false;
}

function roomRef() {
  return FS.doc(db, "rooms", ROOM_ID);
}
function qDocRef(qid) {
  return FS.doc(db, "rooms", ROOM_ID, "questions", String(qid));
}
function answersDocRef(questionKey) {
  return FS.doc(db, "rooms", ROOM_ID, "answers", String(questionKey));
}
function playersColRef() {
  return FS.collection(db, "rooms", ROOM_ID, "players");
}
function playerDocRef(pid) {
  return FS.doc(db, "rooms", ROOM_ID, "players", pid);
}

// =====================================================
// Common: listen room state
// =====================================================
function startListenRoom() {
  if (unRoom) unRoom();
  unRoom = FS.onSnapshot(roomRef(), async (snap) => {
    if (!snap.exists()) return;
    const state = (snap.data() || {}).state || {};
    await applyState(state);
  });
}

async function applyState(state) {
  const phase = state.phase || "idle";
  const qid = state.currentQuestion ?? null;
  const questionKey = state.questionKey || null;

  // Questionデータの読み込み（qidが変わったら）
  if (qid !== null && qid !== lastQid) {
    cachedQuestion = await loadQuestion(qid);
    lastQid = qid;
  }

  // phaseが変わったら各ページでUI更新
  if (phase !== lastPhase || questionKey !== lastQuestionKey) {
    lastPhase = phase;
    lastQuestionKey = questionKey;

    if (isIndex) {
      await indexApplyPhase(state);
    }
    if (isQuestion) {
      await questionApplyPhase(state);
    }
  }

  // phaseが同じでも、votes/ranking/final などのデータが更新されるので更新
  if (isQuestion) {
    await questionApplyLive(state);
  }
  if (isIndex) {
    await indexApplyLive(state);
  }
}

async function loadQuestion(qid) {
  try {
    const snap = await FS.getDoc(qDocRef(qid));
    if (!snap.exists()) return null;
    return snap.data();
  } catch (e) {
    console.error("loadQuestion failed", e);
    return null;
  }
}

// =====================================================
// INDEX (参加＆回答だけ)
// =====================================================
async function joinGame() {
  if (!FS) {
    alert("Firestore の準備中です。少し待ってからもう一度お試しください。");
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

  // 参加登録（scoreは既存があれば維持）
  await FS.setDoc(
    playerDocRef(playerId),
    { name, joinedAt: new Date().toISOString() },
    { merge: true }
  );

  joinArea.style.display = "none";
  waitingArea.style.display = "block";
  indexHint.style.display = "block";

  startListenRoom();
}

function indexResetAnswerUI() {
  myAnsweredKey = null;
  mySelectedOpt = null;
  indexChoices.innerHTML = "";
  indexHint.textContent = "司会の合図があるまでお待ちください…";
}

function indexBuildButtons(optionCount) {
  indexChoices.innerHTML = "";
  for (let i = 1; i <= optionCount; i++) {
    const btn = document.createElement("button");
    btn.className = "idxChoiceBtn";
    btn.textContent = `選択肢${i}`;
    btn.onclick = () => indexAnswer(i);
    indexChoices.appendChild(btn);
  }
}

function indexSetSelected(opt) {
  const btns = indexChoices.querySelectorAll(".idxChoiceBtn");
  btns.forEach((b, idx) => {
    const n = idx + 1;
    if (n === opt) {
      b.classList.add("selected");
      b.classList.remove("dim");
    } else {
      b.classList.remove("selected");
      b.classList.add("dim");
    }
  });
}

function indexDisableAll() {
  indexChoices.querySelectorAll(".idxChoiceBtn").forEach(b => (b.disabled = true));
}
function indexEnableAll() {
  indexChoices.querySelectorAll(".idxChoiceBtn").forEach(b => (b.disabled = false));
}

async function indexAnswer(opt) {
  // 既に回答済みなら無視
  if (!playerId) return alert("参加してから回答してください");
  if (!lastQuestionKey) return;
  if (myAnsweredKey === lastQuestionKey) return;

  // stateを取り直して締切判定
  const snap = await FS.getDoc(roomRef());
  const state = (snap.data() || {}).state || {};
  if ((state.phase || "idle") !== "question") return;

  const deadlineMs = safeNum(state.deadlineMs, 0);
  if (deadlineMs && nowMs() > deadlineMs) {
    indexHint.textContent = "時間切れです（回答できません）";
    indexDisableAll();
    return;
  }

  // UI
  mySelectedOpt = opt;
  indexSetSelected(opt);
  indexDisableAll();
  indexHint.textContent = "回答を送信しました！";

  // Firestoreへ回答（questionKeyごと）
  const qKey = state.questionKey;
  myAnsweredKey = qKey;

  await FS.setDoc(
    answersDocRef(qKey),
    {
      [playerId]: {
        opt,
        at: nowMs()
      }
    },
    { merge: true }
  );
}

async function indexApplyPhase(state) {
  const phase = state.phase || "idle";

  // intro は「問題表示のみ」なので、スマホは待機のまま
  if (phase === "idle" || phase === "intro") {
    waitingArea.style.display = "block";
    indexChoices.innerHTML = "";
    indexHint.textContent = "司会の合図があるまでお待ちください…";
    return;
  }

  if (phase === "question") {
    waitingArea.style.display = "none";

    // 選択肢数（質問データから）
    const optCount = (cachedQuestion?.options?.length) || 4;
    indexBuildButtons(optCount);

    // 新しい問題なら回答状態リセット
    if (myAnsweredKey !== state.questionKey) {
      mySelectedOpt = null;
      indexEnableAll();
      indexHint.textContent = "選択肢をタップして回答してください";
    }
    return;
  }

  // votes/result/ranking/final はスマホは回答画面を出さない（解答のみでOK）
  waitingArea.style.display = "block";
  indexChoices.innerHTML = "";
  indexHint.textContent = "結果発表中です…";
}

async function indexApplyLive(state) {
  // question中は締切を超えたら自動でボタン無効化（B方式：index側判定）
  const phase = state.phase || "idle";
  if (phase !== "question") return;

  const deadlineMs = safeNum(state.deadlineMs, 0);
  if (!deadlineMs) return;

  const remain = deadlineMs - nowMs();
  if (remain <= 0) {
    indexHint.textContent = "時間切れです";
    indexDisableAll();
  } else {
    // 回答前は残り時間を表示（任意）
    if (myAnsweredKey !== state.questionKey) {
      indexHint.textContent = `残り ${Math.ceil(remain / 1000)} 秒`;
    }
  }
}

// =====================================================
// QUESTION (画面共有用：intro / question / votes / result / ranking / final)
// =====================================================
function questionHideAllLayouts() {
  layoutIntro.style.display = "none";
  layoutQA.style.display = "none";
  overlayRanking.style.display = "none";

  // “背景のみ”にするため、要素自体は隠す
  qIntroText.textContent = "";
  qIntroMedia.innerHTML = "";
  qaText.textContent = "";
  qaMedia.innerHTML = "";
  qaChoices.innerHTML = "";
  qaTimerBig.textContent = "";
  qaTimerLabel.textContent = "";
  overlayTitle.textContent = "";
  overlayList.innerHTML = "";

  if (timerTick) {
    clearInterval(timerTick);
    timerTick = null;
  }
}

function questionRenderMedia(container, q) {
  container.innerHTML = "";
  if (!q) return;

  // 画像だけ対応（動画もやりたい場合は後で拡張可能）
  if (q.imageUrl) {
    const img = document.createElement("img");
    img.src = q.imageUrl;
    img.alt = "問題画像";
    img.className = "qMediaImg";
    container.appendChild(img);
  }
}

function questionRenderChoices(q, state) {
  qaChoices.innerHTML = "";
  const opts = q?.options || ["選択肢①", "選択肢②", "選択肢③", "選択肢④"];

  // 2択なら2ボタン、4択なら4ボタン。表示レイアウトはCSSで整える
  opts.forEach((t, idx) => {
    const optNum = idx + 1;
    const btn = document.createElement("div");
    btn.className = "scrChoice";
    btn.dataset.opt = String(optNum);
    btn.innerHTML = `<span class="scrChoiceLabel">選択肢${optNum}</span><span class="scrChoiceText">${t}</span>`;
    qaChoices.appendChild(btn);
  });
}

function questionApplyVoteCounts(votes) {
  if (!votes) return;
  const items = qaChoices.querySelectorAll(".scrChoice");
  items.forEach((el) => {
    const opt = Number(el.dataset.opt);
    const v = votes[String(opt)] ?? votes[opt] ?? 0;
    let badge = el.querySelector(".voteBadge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "voteBadge";
      el.appendChild(badge);
    }
    badge.textContent = ` ${v}票`;
  });
}

function questionApplyCorrect(correctOpt) {
  const items = qaChoices.querySelectorAll(".scrChoice");
  items.forEach((el) => {
    const opt = Number(el.dataset.opt);
    if (opt === correctOpt) {
      el.classList.add("correct");
      el.classList.remove("dim");
    } else {
      el.classList.add("dim");
      el.classList.remove("correct");
    }
  });
}

function questionStartCountdown(deadlineMs) {
  if (timerTick) clearInterval(timerTick);

  const update = () => {
    const remain = deadlineMs - nowMs();
    const sec = Math.max(0, Math.ceil(remain / 1000));
    qaTimerBig.textContent = `${sec}`;
    qaTimerLabel.textContent = "制限時間";
  };

  update();
  timerTick = setInterval(update, 200);
}

function overlayShowRanking(title, entries) {
  // entries: [{rank, name, valueText}]  ※ rank昇順(1が上位)で渡してOK
  overlayRanking.style.display = "flex";
  overlayTitle.textContent = title;
  overlayList.innerHTML = "";

  // 下位から上に積み上げる：最後(下位)→最初(上位)で「prepend」
  const arr = Array.isArray(entries) ? entries.slice() : [];
  const fromBottom = arr.slice().reverse();

  let i = 0;
  const stepMs = 700;

  const tick = () => {
    if (i >= fromBottom.length) return;

    const e = fromBottom[i];
    const row = document.createElement("div");
    row.className = "rankRow";
    row.innerHTML = `<span class="rankNo">${e.rank}位</span><span class="rankName">${e.name}</span><span class="rankVal">${e.valueText}</span>`;

    // prependで上に積み上がっていく
    overlayList.prepend(row);

    i++;
    if (i < fromBottom.length) setTimeout(tick, stepMs);
  };
  tick();
}

async function questionApplyPhase(state) {
  const phase = state.phase || "idle";
  questionHideAllLayouts();

  // idle：背景のみ（何も出さない）
  if (phase === "idle") return;

  // intro：問題だけ
  if (phase === "intro") {
    layoutIntro.style.display = "block";
    qIntroText.textContent = cachedQuestion?.text || "（問題文）";
    questionRenderMedia(qIntroMedia, cachedQuestion);
    return;
  }

  // question/votes/result：選択肢画面
  if (phase === "question" || phase === "votes" || phase === "result") {
    layoutQA.style.display = "grid";
    qaText.textContent = cachedQuestion?.text || "（問題文）";
    questionRenderMedia(qaMedia, cachedQuestion);
    questionRenderChoices(cachedQuestion, state);

    // countdown
    if (phase === "question" && state.deadlineMs) {
      questionStartCountdown(state.deadlineMs);
    } else {
      qaTimerBig.textContent = "";
      qaTimerLabel.textContent = "";
    }
    return;
  }

  // ranking / final は overlay
  if (phase === "ranking") {
    overlayShowRanking("正解者ランキング（上位10名）", (state.ranking || []).map(x => ({
      rank: x.rank,
      name: x.name,
      valueText: `(${fmtSec(x.timeMs)}秒)`
    })));
    return;
  }

  if (phase === "final") {
    overlayShowRanking("最終結果ランキング", (state.finalRanking || []).map(x => ({
      rank: x.rank,
      name: x.name,
      valueText: `(${x.score}点)`
    })));
    return;
  }
}

async function questionApplyLive(state) {
  const phase = state.phase || "idle";

  if (phase === "votes") {
    questionApplyVoteCounts(state.votes || {});
  }
  if (phase === "result") {
    const correct = safeNum(state.correct, 0);
    if (correct) questionApplyCorrect(correct);
  }
  // ranking/finalは phase切替時に描画済み
}

// =====================================================
// ADMIN
// =====================================================
async function admin_resetScreen() {
  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "idle",
        currentQuestion: null,
        questionKey: null,
        runId: 0,
        startMs: null,
        deadlineMs: null,
        votes: null,
        correct: null,
        ranking: null,
        finalRanking: null,
        scored: {}
      }
    },
    { merge: true }
  );
}

async function admin_showIntro(qid) {
  // introは表示のみ（回答はまだ開始しない）
  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "intro",
        currentQuestion: qid
      }
    },
    { merge: true }
  );
}

async function admin_startQuestion(qid) {
  // runId を増やして questionKey を作る（古い回答を混ぜない）
  const rs = await FS.getDoc(roomRef());
  const st = (rs.data() || {}).state || {};
  const nextRun = safeNum(st.runId, 0) + 1;
  const qKey = `${qid}_${nextRun}`;

  const startMs = nowMs();
  const deadlineMs = startMs + ANSWER_SECONDS * 1000;

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "question",
        currentQuestion: qid,
        runId: nextRun,
        questionKey: qKey,
        startMs,
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
  const rs = await FS.getDoc(roomRef());
  const st = (rs.data() || {}).state || {};
  const qKey = st.questionKey;
  if (!qKey) return alert("回答開始（選択肢表示）を先に押してください");

  const snap = await FS.getDoc(answersDocRef(qKey));
  const data = snap.exists() ? snap.data() : {};

  const counts = {};
  // 選択肢数は質問から
  const q = await loadQuestion(qid);
  const optCount = (q?.options?.length) || 4;
  for (let i = 1; i <= optCount; i++) counts[String(i)] = 0;

  for (const pid in data) {
    const opt = extractOpt(data[pid]);
    if (opt && counts[String(opt)] !== undefined) counts[String(opt)]++;
  }

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "votes",
        currentQuestion: qid,
        questionKey: qKey,
        votes: counts
      }
    },
    { merge: true }
  );
}

async function admin_reveal(qid, correctOpt) {
  const rs = await FS.getDoc(roomRef());
  const st = (rs.data() || {}).state || {};
  const qKey = st.questionKey;
  if (!qKey) return alert("回答開始（選択肢表示）を先に押してください");

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "result",
        currentQuestion: qid,
        questionKey: qKey,
        correct: correctOpt
      }
    },
    { merge: true }
  );
}

async function admin_showRanking(qid, correctOpt) {
  const rs = await FS.getDoc(roomRef());
  const st = (rs.data() || {}).state || {};
  const qKey = st.questionKey;
  if (!qKey) return alert("回答開始（選択肢表示）を先に押してください");

  // 1) 回答取得
  const ansSnap = await FS.getDoc(answersDocRef(qKey));
  const answers = ansSnap.exists() ? ansSnap.data() : {};

  // 2) プレイヤー名取得
  const playersSnap = await FS.getDocs(playersColRef());
  const players = {};
  playersSnap.forEach(doc => {
    players[doc.id] = doc.data();
  });

  // 3) 正解者のタイム計算（state.startMs 기준）
  const startMs = safeNum(st.startMs, nowMs());
  const correctList = [];

  for (const pid in answers) {
    const opt = extractOpt(answers[pid]);
    if (opt !== correctOpt) continue;

    const at = extractAt(answers[pid]);
    const t = (at ? Math.max(0, at - startMs) : 999999);
    const name = players[pid]?.name || "Unknown";
    correctList.push({ pid, name, timeMs: t });
  }

  correctList.sort((a, b) => a.timeMs - b.timeMs);

  // 4) 上位10
  const top = correctList.slice(0, 10).map((x, idx) => ({
    rank: idx + 1,
    name: x.name,
    timeMs: x.timeMs,
    pid: x.pid
  }));

  // 5) スコア加算（同じqid/runIdで二重加算しない）
  const scored = st.scored || {};
  const scoreKey = String(qKey); // qid_runId で管理（同じ問題をやり直しても別扱い）
  const already = !!scored[scoreKey];

  if (!already) {
    // 正解者全員 +10
    for (const x of correctList) {
      const p = players[x.pid] || {};
      const prev = safeNum(p.score, 0);
      await FS.setDoc(playerDocRef(x.pid), { score: prev + 10 }, { merge: true });
    }
    // 早押し上位3名ボーナス
    const bonus = [5, 3, 1];
    for (let i = 0; i < Math.min(3, correctList.length); i++) {
      const pid = correctList[i].pid;
      const pSnap = await FS.getDoc(playerDocRef(pid));
      const prev = pSnap.exists() ? safeNum(pSnap.data().score, 0) : 0;
      await FS.setDoc(playerDocRef(pid), { score: prev + bonus[i] }, { merge: true });
    }

    scored[scoreKey] = true;
    await FS.setDoc(roomRef(), { state: { scored } }, { merge: true });
  }

  // 6) stateへランキング出力（question画面が表示）
  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "ranking",
        currentQuestion: qid,
        questionKey: qKey,
        ranking: top
      }
    },
    { merge: true }
  );
}

async function admin_showFinalRanking() {
  const playersSnap = await FS.getDocs(playersColRef());
  const list = [];
  playersSnap.forEach(doc => {
    const d = doc.data();
    list.push({
      name: d.name || "Unknown",
      score: safeNum(d.score, 0)
    });
  });

  if (list.length === 0) {
    alert("プレイヤーがいません");
    return;
  }

  // スコア高い順（1位が最高点）
  list.sort((a, b) => b.score - a.score);

  const ranked = list.map((x, idx) => ({
    rank: idx + 1,
    name: x.name,
    score: x.score
  }));

  await FS.setDoc(
    roomRef(),
    {
      state: {
        phase: "final",
        finalRanking: ranked
      }
    },
    { merge: true }
  );
}

// =====================================================
// Boot
// =====================================================
window.addEventListener("load", async () => {
  // DOM判定
  isIndex = !!document.getElementById("joinBtn");
  isQuestion = !!document.getElementById("layoutIntro");
  isAdmin = !!document.getElementById("adminPanel");

  // Firebase ready wait
  const ok = await waitFirebaseReady();
  if (!ok) {
    console.error("Firebase init timeout");
    return;
  }

  // DOM bind
  if (isIndex) {
    nameInput = document.getElementById("nameInput");
    joinBtn = document.getElementById("joinBtn");
    joinArea = document.getElementById("joinArea");
    waitingArea = document.getElementById("waitingArea");
    indexChoices = document.getElementById("indexChoices");
    indexHint = document.getElementById("indexHint");

    if (playerName) nameInput.value = playerName;

    // 既に参加済みなら join UIを出したまま（手動参加にする）
    indexResetAnswerUI();
  }

  if (isQuestion) {
    layoutIntro = document.getElementById("layoutIntro");
    layoutQA = document.getElementById("layoutQA");

    qIntroText = document.getElementById("qIntroText");
    qIntroMedia = document.getElementById("qIntroMedia");

    qaMedia = document.getElementById("qaMedia");
    qaText = document.getElementById("qaText");
    qaChoices = document.getElementById("qaChoices");
    qaTimerBig = document.getElementById("qaTimerBig");
    qaTimerLabel = document.getElementById("qaTimerLabel");

    overlayRanking = document.getElementById("overlayRanking");
    overlayTitle = document.getElementById("overlayTitle");
    overlayList = document.getElementById("overlayList");
    overlayBox = document.getElementById("overlayBox");

    questionHideAllLayouts();
    startListenRoom();
  }

  if (isAdmin) {
    startListenRoom();
  }

  // グローバル公開（HTMLのonclick用）
  window.joinGame = joinGame;
  window.admin_resetScreen = admin_resetScreen;
  window.admin_showIntro = admin_showIntro;
  window.admin_startQuestion = admin_startQuestion;
  window.admin_showVotes = admin_showVotes;
  window.admin_reveal = admin_reveal;
  window.admin_showRanking = admin_showRanking;
  window.admin_showFinalRanking = admin_showFinalRanking;
});



















