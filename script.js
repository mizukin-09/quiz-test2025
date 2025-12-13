/*******************************************************
 * script.js（最新版）
 * ・サーバー時間ベースで早押し計測
 * ・正解者ランキング：下位→上位へカウントアップ表示
 * ・最終結果ランキング：参加者全員を下位→上位で表示
 * ・待機フェーズ：背景のみ（question.html）は空画面
 *******************************************************/

const ROOM_ID = "roomA";
let db = null;
let FS = null;

let playerId = localStorage.getItem("playerId");
let playerName = localStorage.getItem("playerName");

/*******************************************************
 * ページ判定
 *******************************************************/
const isIndex    = !!document.getElementById("joinBtn");
const isQuestion = !!document.getElementById("screenQuestionText");
const isAdmin    = !!document.getElementById("adminPanel");

/*******************************************************
 * index 用 DOM
 *******************************************************/
const nameInput   = document.getElementById("nameInput");
const waitingArea = document.getElementById("waitingArea");
const choicesDiv  = document.getElementById("choices");

/*******************************************************
 * question 用（タイマー & ランキング表示）
 *******************************************************/
let countdownInterval = null;
let countdownQuestionId = null;
let countdownLocked = false;

let rankingInterval = null;

/*******************************************************
 * Utility
 *******************************************************/
function makeId(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Firestore Timestamp → number(ms)
function toMillis(t) {
  if (!t) return null;
  if (typeof t === "number") return t;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number" && typeof t.nanoseconds === "number") {
    return t.seconds * 1000 + t.nanoseconds / 1e6;
  }
  return null;
}

/*******************************************************
 * ① index：参加処理
 *******************************************************/
async function joinGame() {
  if (!isIndex) return;
  if (!FS) {
    alert("読み込み中です。少し待ってからもう一度お試しください");
    return;
  }

  const name = nameInput.value.trim();
  if (!name) {
    alert("ニックネームを入力してください");
    return;
  }

  if (!playerId) {
    playerId = makeId();
    localStorage.setItem("playerId", playerId);
  }
  playerName = name;
  localStorage.setItem("playerName", name);

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID, "players", playerId),
    {
      name,
      score: 0,
      participated: 0,
      joinedAt: Date.now()
    },
    { merge: true }
  );

  nameInput.style.display = "none";
  document.getElementById("joinBtn").style.display = "none";
  if (waitingArea) waitingArea.style.display = "block";

  listenState();
}

/*******************************************************
 * ② Firestore state 監視（index & question 共通）
 *******************************************************/
let unState = null;

function listenState() {
  if (!FS) return;
  if (unState) unState();

  unState = FS.onSnapshot(FS.doc(db, "rooms", ROOM_ID), async (snap) => {
    if (!snap.exists()) {
      if (isQuestion) updateScreen({ phase: "waiting" });
      return;
    }
    const st = snap.data().state;
    if (!st) {
      if (isQuestion) updateScreen({ phase: "waiting" });
      return;
    }

    const { phase, currentQuestion, correct } = st;

    /******** index（回答画面） ********/
    if (isIndex) {
      if (phase === "waiting" || phase === "intro") {
        waitingArea.style.display = "block";
        choicesDiv.innerHTML = "";
        return;
      }

      if (phase === "question") {
        waitingArea.style.display = "none";
        renderChoices(currentQuestion);
        return;
      }

      if (phase === "closed") {
        disableChoices();
        return;
      }

      if (phase === "result") {
        showIndexCorrect(correct);
        return;
      }

      if (phase === "votes" || phase === "ranking" || phase === "finalRanking") {
        disableChoices();
        return;
      }
    }

    /******** question（画面共有用） ********/
    if (isQuestion) {
      updateScreen(st);
    }
  });
}

/*******************************************************
 * ③ index：選択肢表示
 *******************************************************/
async function renderChoices(qid) {
  if (!FS) return;
  const qSnap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID, "questions", String(qid)));
  if (!qSnap.exists()) {
    choicesDiv.innerHTML = "<p>問題データがありません</p>";
    return;
  }
  const q = qSnap.data();

  choicesDiv.innerHTML = "";
  (q.options || []).forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = "choiceBtn";
    btn.textContent = `${idx + 1}. ${opt}`;
    btn.onclick = () => answer(idx + 1);
    styleChoice(btn);
    choicesDiv.appendChild(btn);
  });
}

function styleChoice(btn) {
  btn.style.display = "block";
  btn.style.width = "100%";
  btn.style.fontSize = "20px";
  btn.style.padding = "12px";
  btn.style.margin = "8px 0";
  btn.style.borderRadius = "6px";
  btn.style.border = "2px solid #ccc";
  btn.style.background = "#f4f4f4";
  btn.style.color = "#333";
}

/*******************************************************
 * ④ index：回答送信（サーバー時刻で記録）
 *******************************************************/
async function answer(optIdx) {
  if (!FS) return;

  const stSnap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID));
  const st = stSnap.data().state;
  if (!st || st.phase !== "question") {
    alert("回答時間が終了しています");
    disableChoices();
    return;
  }

  disableChoices();

  document.querySelectorAll(".choiceBtn").forEach((btn, idx) => {
    if (idx + 1 === optIdx) {
      btn.style.border = "4px solid #0066ff";
      btn.style.background = "#eef4ff";
      btn.style.color = "#000";
    } else {
      btn.style.opacity = "0.3";
      btn.style.color = "#999";
    }
  });

  const qid = st.currentQuestion;

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)),
    {
      [playerId]: {
        option: optIdx,
        time: FS.serverTimestamp()
      }
    },
    { merge: true }
  );
}

function disableChoices() {
  document.querySelectorAll(".choiceBtn").forEach((b) => (b.disabled = true));
}

/*******************************************************
 * ⑤ index：正解発表
 *******************************************************/
function showIndexCorrect(correct) {
  document.querySelectorAll(".choiceBtn").forEach((btn, idx) => {
    if (idx + 1 === correct) {
      btn.style.border = "4px solid #ff3333";
      btn.style.background = "#ffecec";
      btn.style.opacity = "1";
      btn.style.color = "#000";
    } else {
      btn.style.opacity = "0.2";
      btn.style.color = "#aaa";
    }
  });
}

/*******************************************************
 * ⑥ question：画面更新
 *******************************************************/
async function updateScreen(st) {
  if (!FS) return;
  const { currentQuestion, phase, votes, correct, deadline, ranking, finalRanking } = st;

  const qt        = document.getElementById("screenQuestionText");
  const list      = document.getElementById("screenChoices");
  const timerEl   = document.getElementById("screenTimer");
  const imgEl     = document.getElementById("screenImage");
  const rankingEl = document.getElementById("screenRanking");

  // 待機フェーズ：背景のみ
  if (phase === "waiting") {
    if (qt) qt.textContent = "";
    if (list) list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";
    if (rankingEl) rankingEl.innerHTML = "";
    stopCountdown();
    stopRankingAnimation();
    return;
  }

  // ランキング以外ではランキングを消す
  if (rankingEl && phase !== "ranking" && phase !== "finalRanking") {
    stopRankingAnimation();
    rankingEl.innerHTML = "";
  }

  // 最終結果
  if (phase === "finalRanking") {
    if (qt) qt.textContent = "最終結果発表";
    if (list) list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";
    showFinalRanking(finalRanking || []);
    return;
  }

  // 各問の正解者ランキング
  if (phase === "ranking") {
    if (qt) qt.textContent = "正解者ランキング（上位10名）";
    if (list) list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";
    startRankingAnimation(ranking || []);
    return;
  }

  // ここから intro / question / closed / votes / result
  const qSnap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID, "questions", String(currentQuestion)));
  if (!qSnap.exists()) {
    if (qt) qt.textContent = "問題データがありません";
    if (list) list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";
    stopCountdown();
    return;
  }
  const q = qSnap.data();

  if (qt) qt.textContent = q.text || "";
  if (list) list.innerHTML = "";

  if (imgEl) {
    if (q.imageUrl) {
      imgEl.src = q.imageUrl;
      imgEl.style.display = "block";
    } else {
      imgEl.style.display = "none";
    }
  }

  // ★ intro フェーズ：タイマー表示は空のまま（「レディーゴー」文言を出さない）
  if (phase === "intro") {
    if (timerEl) timerEl.textContent = "";
    stopCountdown();
    return;
  }

  if (phase === "question" && typeof deadline === "number") {
    startCountdown(currentQuestion, deadline);
  } else {
    stopCountdown();
    if (timerEl) {
      if (phase === "closed") timerEl.textContent = "時間終了！";
      else timerEl.textContent = "";
    }
  }

  (q.options || []).forEach((opt, idx) => {
    const div = document.createElement("div");
    div.className = "screenChoice";
    div.textContent = `${idx + 1}. ${opt}`;
    div.style.padding = "12px";
    div.style.border = "2px solid #888";
    div.style.margin = "10px 0";
    div.style.fontSize = "28px";
    div.style.background = "rgba(255,255,255,0.9)";
    div.style.opacity = "1";

    if (phase === "votes" && votes) {
      div.textContent = `${idx + 1}. ${opt}（${votes[idx + 1] || 0}票）`;
      div.style.opacity = "0.7";
    }

    if (phase === "result") {
      if (correct === idx + 1) {
        div.style.border = "4px solid #ff3333";
        div.style.background = "#ffecec";
        div.style.opacity = "1";
      } else {
        div.style.opacity = "0.2";
      }
    }

    list.appendChild(div);
  });
}

/*******************************************************
 * question：カウントダウン（10秒）
 *******************************************************/
function startCountdown(qid, deadlineMs) {
  const timerEl = document.getElementById("screenTimer");
  if (!timerEl) return;

  if (countdownQuestionId !== qid) {
    stopCountdown();
    countdownQuestionId = qid;
    countdownLocked = false;
  }

  if (countdownInterval) return;

  function tick() {
    const now = Date.now();
    const remainMs = deadlineMs - now;
    const sec = Math.max(0, Math.ceil(remainMs / 1000));
    timerEl.textContent = `残り ${sec} 秒`;

    if (remainMs <= 0) {
      timerEl.textContent = "時間終了！";
      stopCountdown();

      if (!countdownLocked && FS) {
        countdownLocked = true;
        FS.setDoc(
          FS.doc(db, "rooms", ROOM_ID),
          { state: { phase: "closed", currentQuestion: qid } },
          { merge: true }
        );
      }
    }
  }

  tick();
  countdownInterval = setInterval(tick, 300);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

/*******************************************************
 * question：正解者ランキング（10位→1位）
 *******************************************************/
function startRankingAnimation(ranking) {
  const rankingEl = document.getElementById("screenRanking");
  if (!rankingEl) return;

  stopRankingAnimation();

  if (!Array.isArray(ranking) || ranking.length === 0) {
    rankingEl.innerHTML = "<h2>正解者は0人でした…</h2>";
    return;
  }

  const sorted = ranking.slice().sort((a, b) => a.rank - b.rank);
  let idx = sorted.length - 1;  // 最下位から

  rankingEl.innerHTML = "<h2>正解者ランキング（上位10名）</h2><ol id='rankingList'></ol>";
  const listEl = document.getElementById("rankingList");

  function step() {
    if (idx < 0) {
      stopRankingAnimation();
      return;
    }
    const p = sorted[idx--];
    const sec = ((p.timeMs || 0) / 1000).toFixed(2);
    const li = document.createElement("li");
    li.textContent = `${p.rank}位：${p.name}（${sec}秒）`;
    listEl.appendChild(li);
  }

  step();
  rankingInterval = setInterval(step, 1000);
}

function stopRankingAnimation() {
  if (rankingInterval) {
    clearInterval(rankingInterval);
    rankingInterval = null;
  }
}

/*******************************************************
 * question：最終結果ランキング（下位→上位）
 *******************************************************/
function showFinalRanking(finalRanking) {
  const rankingEl = document.getElementById("screenRanking");
  if (!rankingEl) return;

  stopRankingAnimation();

  if (!Array.isArray(finalRanking) || finalRanking.length === 0) {
    rankingEl.innerHTML = "<h2>最終結果：スコアデータがありません</h2>";
    return;
  }

  const sorted = finalRanking.slice().sort((a, b) => a.rank - b.rank);

  let html = "<h2>最終結果ランキング</h2><ol>";
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    html += `<li>${p.rank}位：${p.name}（${p.totalScore}点）</li>`;
  }
  html += "</ol>";
  rankingEl.innerHTML = html;
}

/*******************************************************
 * ⑦ admin：出題関連
 *******************************************************/
async function admin_showIntro(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  await FS.setDoc(FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)), {});

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap = await FS.getDoc(roomRef);
  const state = snap.exists() ? (snap.data().state || {}) : {};

  const newState = {
    ...state,
    phase: "intro",
    currentQuestion: qid,
    correct: null,
    votes: null,
    deadline: null,
    startTime: null
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

async function admin_startQuestion(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  await FS.setDoc(FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)), {});

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap = await FS.getDoc(roomRef);
  const state = snap.exists() ? (snap.data().state || {}) : {};

  const newState = {
    ...state,
    phase: "question",
    currentQuestion: qid,
    correct: null,
    votes: { 1: 0, 2: 0, 3: 0, 4: 0 },
    startTime: FS.serverTimestamp(),
    deadline: Date.now() + 10000
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

async function admin_showVotes(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  const answersSnap = await FS.getDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid))
  );
  const data = answersSnap.exists() ? answersSnap.data() : {};

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let pid in data) {
    const entry = data[pid];
    if (!entry || typeof entry !== "object") continue;
    const v = entry.option;
    if (counts[v] != null) counts[v]++;
  }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap = await FS.getDoc(roomRef);
  const state = snap.exists() ? (snap.data().state || {}) : {};

  const newState = {
    ...state,
    phase: "votes",
    currentQuestion: qid,
    votes: counts,
    correct: null
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

async function admin_reveal(qid, correct) {
  if (!FS) { alert("読み込み中です"); return; }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap = await FS.getDoc(roomRef);
  const state = snap.exists() ? (snap.data().state || {}) : {};

  const newState = {
    ...state,
    phase: "result",
    currentQuestion: qid,
    correct
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

/*******************************************************
 * ⑧ admin：正解者ランキング & 得点加算
 *******************************************************/
async function admin_showRanking(qid, correct) {
  if (!FS) { alert("読み込み中です"); return; }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const roomSnap = await FS.getDoc(roomRef);
  const roomData = roomSnap.exists() ? roomSnap.data() : {};
  const state = roomData.state || {};
  const startTimeMs = toMillis(state.startTime);
  const scoredQuestions = state.scoredQuestions || {};

  const alreadyScored = !!scoredQuestions[qid];

  const answersSnap = await FS.getDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid))
  );
  const answers = answersSnap.exists() ? answersSnap.data() : {};

  const playersSnap = await FS.getDocs(
    FS.collection(db, "rooms", ROOM_ID, "players")
  );
  const players = {};
  playersSnap.forEach(pdoc => {
    const pdata = pdoc.data();
    players[pdoc.id] = {
      name: pdata.name || "名無し",
      score: pdata.score || 0,
      participated: pdata.participated || 0
    };
  });

  const tmpList = [];
  for (const pid in answers) {
    const entry = answers[pid];
    if (!entry || typeof entry !== "object") continue;
    if (entry.option !== correct) continue;

    const ansMs = toMillis(entry.time);
    if (ansMs == null || startTimeMs == null) continue;

    const elapsedMs = Math.max(0, ansMs - startTimeMs);

    tmpList.push({
      pid,
      name: players[pid] ? players[pid].name : "名無し",
      timeMs: elapsedMs
    });
  }

  tmpList.sort((a, b) => a.timeMs - b.timeMs);

  const ranking = tmpList.slice(0, 10).map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    timeMs: p.timeMs
  }));

  if (!alreadyScored) {
    for (const pid in answers) {
      const pInfo = players[pid];
      if (!pInfo) continue;
      const newParticipated = (pInfo.participated || 0) + 1;
      players[pid].participated = newParticipated;

      await FS.updateDoc(
        FS.doc(db, "rooms", ROOM_ID, "players", pid),
        { participated: newParticipated }
      );
    }

    for (let i = 0; i < tmpList.length; i++) {
      const p = tmpList[i];
      const pInfo = players[p.pid] || { score: 0 };
      let add = 10;

      if (i === 0) add += 5;
      else if (i === 1) add += 3;
      else if (i === 2) add += 1;

      const newScore = (pInfo.score || 0) + add;
      players[p.pid].score = newScore;

      await FS.updateDoc(
        FS.doc(db, "rooms", ROOM_ID, "players", p.pid),
        { score: newScore }
      );
    }
  }

  const newScored = { ...scoredQuestions, [qid]: true };

  const newState = {
    ...state,
    phase: "ranking",
    currentQuestion: qid,
    correct,
    ranking,
    scoredQuestions: newScored
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

/*******************************************************
 * ⑨ admin：最終結果ランキング
 *******************************************************/
async function admin_showFinalRanking() {
  if (!FS) { alert("読み込み中です"); return; }

  const playersSnap = await FS.getDocs(
    FS.collection(db, "rooms", ROOM_ID, "players")
  );

  const list = [];
  playersSnap.forEach(pdoc => {
    const pdata = pdoc.data();
    const participated = pdata.participated || 0;
    if (participated <= 0) return;

    list.push({
      name: pdata.name || "名無し",
      totalScore: pdata.score || 0
    });
  });

  if (list.length === 0) {
    await FS.setDoc(
      FS.doc(db, "rooms", ROOM_ID),
      {
        state: {
          phase: "finalRanking",
          finalRanking: []
        }
      },
      { merge: true }
    );
    return;
  }

  list.sort((a, b) => b.totalScore - a.totalScore);

  const finalRanking = list.map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    totalScore: p.totalScore
  }));

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID),
    {
      state: {
        phase: "finalRanking",
        finalRanking
      }
    },
    { merge: true }
  );
}

/*******************************************************
 * ⑩ admin：待機画面へ戻す
 *******************************************************/
async function admin_resetScreen() {
  if (!FS) { alert("読み込み中です"); return; }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap = await FS.getDoc(roomRef);
  const state = snap.exists() ? (snap.data().state || {}) : {};

  const newState = {
    ...state,
    phase: "waiting",
    currentQuestion: null,
    correct: null,
    votes: null,
    ranking: [],
    finalRanking: []
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

/*******************************************************
 * Firebase 受け取り
 *******************************************************/
window.addEventListener("load", () => {
  db = window.firebaseDB;
  FS = window.firebaseFirestoreFuncs;

  if (!db || !FS) {
    console.error("Firebase が初期化されていません");
    return;
  }

  if (isIndex && playerName && nameInput) {
    nameInput.value = playerName;
  }

  if (isQuestion) {
    listenState();
  }
});












