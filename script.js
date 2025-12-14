/*******************************************************
 * script.js（フルコード：最終結果ランキング計算 & 表示修正版）
 *  - index.html   : 参加者用（スマホ）
 *  - question.html: 画面共有用
 *  - admin.html   : 司会・進行用
 *******************************************************/

const ROOM_ID = "roomA";

// Firebase 参照（各 HTML の <script type="module"> でセット）
let db = null;
let FS = null;

// 参加者の情報（ブラウザに保存）
let playerId = localStorage.getItem("playerId");
let playerName = localStorage.getItem("playerName");

// どの画面か判定
const isIndex    = !!document.getElementById("joinBtn");
const isQuestion = !!document.getElementById("screenQuestionText");
const isAdmin    = !!document.getElementById("adminPanel");

// index 用 DOM
const nameInput   = document.getElementById("nameInput");
const waitingArea = document.getElementById("waitingArea");
const choicesDiv  = document.getElementById("choices");

// タイマー関連
let countdownInterval   = null;
let countdownQuestionId = null;
let countdownLocked     = false;

// ランキング表示用
let rankingInterval = null;

/*******************************************************
 * 共通ユーティリティ
 *******************************************************/
function makeId(len = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
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
    alert("読み込み中です。数秒待ってから再度お試しください。");
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

  // プレイヤー登録（初回以降は merge）
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

  // 参加 UI を隠して待機エリア表示
  const joinArea = document.getElementById("joinArea");
  if (joinArea) joinArea.style.display = "none";
  if (waitingArea) waitingArea.style.display = "block";

  listenState();
}

/*******************************************************
 * ② 全画面共通：state を監視
 *******************************************************/
let unState = null;

function listenState() {
  if (!FS) return;
  if (unState) unState();

  const roomRef = FS.doc(db, "rooms", ROOM_ID);

  unState = FS.onSnapshot(roomRef, async (snap) => {
    if (!snap.exists()) {
      if (isQuestion) updateScreen({ phase: "waiting" });
      return;
    }
    const state = snap.data().state;
    if (!state) {
      if (isQuestion) updateScreen({ phase: "waiting" });
      return;
    }

    const { phase, currentQuestion, correct } = state;

    // 参加者画面の挙動
    if (isIndex) {
      if (phase === "waiting" || phase === "intro") {
        if (waitingArea) waitingArea.style.display = "block";
        if (choicesDiv) choicesDiv.innerHTML = "";
        return;
      }

      if (phase === "question") {
        if (waitingArea) waitingArea.style.display = "none";
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

    // 画面共有（question.html）の挙動
    if (isQuestion) {
      updateScreen(state);
    }
  });
}

/*******************************************************
 * ③ index：選択肢表示
 *******************************************************/
async function renderChoices(qid) {
  if (!FS) return;
  const qRef = FS.doc(db, "rooms", ROOM_ID, "questions", String(qid));
  const qSnap = await FS.getDoc(qRef);
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

    // スマホでも押しやすいように少し大きめ
    btn.style.display = "block";
    btn.style.width = "100%";
    btn.style.fontSize = "18px";
    btn.style.padding = "10px 12px";
    btn.style.margin = "8px 0";
    btn.style.borderRadius = "6px";
    btn.style.border = "2px solid #ccc";
    btn.style.background = "#f4f4f4";
    btn.style.color = "#333";

    choicesDiv.appendChild(btn);
  });
}

/*******************************************************
 * ④ index：回答送信
 *******************************************************/
async function answer(optIdx) {
  if (!FS) return;

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const stSnap  = await FS.getDoc(roomRef);
  const st      = stSnap.exists() ? stSnap.data().state : null;

  if (!st || st.phase !== "question") {
    alert("回答時間が終了しています");
    disableChoices();
    return;
  }

  disableChoices();

  // 自分が押した選択肢を青枠・その他を薄く
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
  document.querySelectorAll(".choiceBtn").forEach((b) => {
    b.disabled = true;
  });
}

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
 * ⑤ question：画面更新
 *******************************************************/
async function updateScreen(state) {
  if (!FS) return;

  const {
    currentQuestion,
    phase,
    votes,
    correct,
    deadline,
    ranking,
    finalRanking
  } = state;

  const qt        = document.getElementById("screenQuestionText");
  const list      = document.getElementById("screenChoices");
  const timerEl   = document.getElementById("screenTimer");
  const imgEl     = document.getElementById("screenImage");
  const rankingEl = document.getElementById("screenRanking");

  // ランキング用要素（なければここで作る）
  let titleEl = document.getElementById("rankingTitle");
  let listEl  = document.getElementById("rankingList");
  if (rankingEl && (!titleEl || !listEl)) {
    rankingEl.innerHTML = "";
    titleEl = document.createElement("div");
    titleEl.id = "rankingTitle";
    titleEl.style.fontSize = "32px";
    titleEl.style.marginBottom = "16px";
    titleEl.style.textAlign = "center";

    listEl = document.createElement("ol");
    listEl.id = "rankingList";
    listEl.style.listStyle = "none";
    listEl.style.padding = "0";
    listEl.style.margin = "0";
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.justifyContent = "flex-end";

    rankingEl.appendChild(titleEl);
    rankingEl.appendChild(listEl);
  }

  // 待機画面：背景だけ
  if (phase === "waiting") {
    if (qt)      { qt.textContent = ""; qt.style.display = "none"; }
    if (list)    { list.innerHTML = ""; list.style.display = "none"; }
    if (timerEl) { timerEl.textContent = ""; timerEl.style.display = "none"; }
    if (imgEl)   { imgEl.style.display = "none"; }
    if (rankingEl) {
      rankingEl.style.display = "none";
      if (titleEl) titleEl.textContent = "";
      if (listEl)  listEl.innerHTML = "";
    }
    stopCountdown();
    stopRankingAnimation();
    return;
  }

  // ランキング以外ではランキング枠を消す
  if (rankingEl && phase !== "ranking" && phase !== "finalRanking") {
    stopRankingAnimation();
    rankingEl.style.display = "none";
    if (titleEl) titleEl.textContent = "";
    if (listEl)  listEl.innerHTML = "";
  }

  // 最終結果
  if (phase === "finalRanking") {
    if (qt)      { qt.textContent = ""; qt.style.display = "none"; } // 左上タイトルを非表示
    if (list)    { list.innerHTML = ""; list.style.display = "none"; }
    if (timerEl) { timerEl.textContent = ""; timerEl.style.display = "none"; }
    if (imgEl)   { imgEl.style.display = "none"; }
    if (rankingEl) rankingEl.style.display = "flex";
    showFinalRanking(finalRanking || []);
    return;
  }

  // 各問の正解者ランキング
  if (phase === "ranking") {
    if (qt)      { qt.textContent = "正解者ランキング（上位10名）"; qt.style.display = "block"; }
    if (list)    { list.innerHTML = ""; list.style.display = "none"; }
    if (timerEl) { timerEl.textContent = ""; timerEl.style.display = "none"; }
    if (imgEl)   { imgEl.style.display = "none"; }
    if (rankingEl) rankingEl.style.display = "flex";
    startRankingAnimation(ranking || []);
    return;
  }

  // ここからは intro / question / closed / votes / result
  const qRef  = FS.doc(db, "rooms", ROOM_ID, "questions", String(currentQuestion));
  const qSnap = await FS.getDoc(qRef);
  if (!qSnap.exists()) {
    if (qt)      { qt.textContent = "問題データがありません"; qt.style.display = "block"; }
    if (list)    { list.innerHTML = ""; list.style.display = "none"; }
    if (timerEl) { timerEl.textContent = ""; timerEl.style.display = "none"; }
    if (imgEl)   { imgEl.style.display = "none"; }
    stopCountdown();
    return;
  }
  const q = qSnap.data();

  if (qt)      { qt.textContent = q.text || ""; qt.style.display = "block"; }
  if (list)    { list.innerHTML = ""; list.style.display = "block"; }
  if (timerEl) timerEl.style.display = "block";

  if (imgEl) {
    if (q.imageUrl) {
      imgEl.src = q.imageUrl;
      imgEl.style.display = "block";
    } else {
      imgEl.style.display = "none";
    }
  }

  // intro：カウントダウンなし
  if (phase === "intro") {
    if (timerEl) timerEl.textContent = "";
    stopCountdown();
    return;
  }

  // question：カウントダウン開始
  if (phase === "question" && typeof deadline === "number") {
    startCountdown(currentQuestion, deadline);
  } else {
    stopCountdown();
    if (timerEl) {
      if (phase === "closed") timerEl.textContent = "時間終了！";
      else timerEl.textContent = "";
    }
  }

  // 選択肢表示
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
      const v = votes[idx + 1] || 0;
      div.textContent = `${idx + 1}. ${opt}（${v}票）`;
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
 * ⑥ question：10秒カウントダウン
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
    const now      = Date.now();
    const remainMs = deadlineMs - now;
    const sec      = Math.max(0, Math.ceil(remainMs / 1000));
    timerEl.textContent = `残り ${sec} 秒`;

    if (remainMs <= 0) {
      timerEl.textContent = "時間終了！";
      stopCountdown();

      // 一度だけ phase を closed にする
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
 * ⑦ question：正解者ランキング（10位→1位 アニメ）
 *******************************************************/
function startRankingAnimation(ranking) {
  const overlay = document.getElementById("screenRanking");
  if (!overlay) return;

  // タイトル＆リスト要素を確保
  let titleEl = document.getElementById("rankingTitle");
  let listEl  = document.getElementById("rankingList");
  if (!titleEl || !listEl) {
    overlay.innerHTML = "";
    titleEl = document.createElement("div");
    titleEl.id = "rankingTitle";
    titleEl.style.fontSize = "32px";
    titleEl.style.marginBottom = "16px";
    titleEl.style.textAlign = "center";

    listEl = document.createElement("ol");
    listEl.id = "rankingList";
    listEl.style.listStyle = "none";
    listEl.style.padding = "0";
    listEl.style.margin = "0";
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.justifyContent = "flex-end";

    overlay.appendChild(titleEl);
    overlay.appendChild(listEl);
  }

  stopRankingAnimation();

  if (!Array.isArray(ranking) || ranking.length === 0) {
    overlay.style.display = "flex";
    titleEl.textContent = "正解者は0人でした…";
    listEl.innerHTML = "";
    return;
  }

  // rank 昇順（1位〜）にソート
  const sorted = ranking.slice().sort((a, b) => a.rank - b.rank);

  // 一番下の順位から表示
  let idx = sorted.length - 1;

  overlay.style.display = "flex";
  titleEl.textContent = "正解者ランキング（上位10名）";
  listEl.innerHTML = "";

  function step() {
    if (idx < 0) {
      stopRankingAnimation();
      return;
    }
    const p   = sorted[idx--]; // 下位 → 上位
    const sec = ((p.timeMs || 0) / 1000).toFixed(2);

    const li  = document.createElement("li");
    li.textContent = `${p.rank}位：${p.name}（${sec}秒）`;

    listEl.appendChild(li);
  }

  step();                    // 最初の1件
  rankingInterval = setInterval(step, 1000);
}

function stopRankingAnimation() {
  if (rankingInterval) {
    clearInterval(rankingInterval);
    rankingInterval = null;
  }
}

/*******************************************************
 * ⑧ question：最終結果表示（全員分を表示 ・ 1位が一番上）
 *******************************************************/
function showFinalRanking(finalRanking) {
  const overlay = document.getElementById("screenRanking");
  if (!overlay) return;

  // タイトル＆リスト要素を確保
  let titleEl = document.getElementById("rankingTitle");
  let listEl  = document.getElementById("rankingList");
  if (!titleEl || !listEl) {
    overlay.innerHTML = "";
    titleEl = document.createElement("div");
    titleEl.id = "rankingTitle";
    titleEl.style.fontSize = "32px";
    titleEl.style.marginBottom = "16px";
    titleEl.style.textAlign = "center";

    listEl = document.createElement("ol");
    listEl.id = "rankingList";
    listEl.style.listStyle = "none";
    listEl.style.padding = "0";
    listEl.style.margin = "0";
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.justifyContent = "flex-end";

    overlay.appendChild(titleEl);
    overlay.appendChild(listEl);
  }

  stopRankingAnimation();

  overlay.style.display = "flex";
  listEl.innerHTML = "";

  if (!Array.isArray(finalRanking) || finalRanking.length === 0) {
    titleEl.textContent = "最終結果：スコアデータがありません";
    return;
  }

  titleEl.textContent = "最終結果ランキング";

  // rank が 1位〜 の昇順で、そのまま上から 1位,2位,... と表示
  const sorted = finalRanking.slice().sort((a, b) => a.rank - b.rank);

  sorted.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = `${p.rank}位：${p.name}（${p.totalScore}点）`;
    listEl.appendChild(li);
  });
}

/*******************************************************
 * ⑨ admin：出題系（intro / question / votes / result）
 *******************************************************/
async function admin_showIntro(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  // 回答リセット
  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)),
    {}
  );

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap    = await FS.getDoc(roomRef);
  const state   = snap.exists() ? (snap.data().state || {}) : {};

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

  // 回答リセット
  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)),
    {}
  );

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap    = await FS.getDoc(roomRef);
  const state   = snap.exists() ? (snap.data().state || {}) : {};

  const newState = {
    ...state,
    phase: "question",
    currentQuestion: qid,
    correct: null,
    votes: { 1: 0, 2: 0, 3: 0, 4: 0 },
    startTime: FS.serverTimestamp(),
    deadline: Date.now() + 10000   // 10秒後
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

async function admin_showVotes(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  const ansRef = FS.doc(db, "rooms", ROOM_ID, "answers", String(qid));
  const ansSnap = await FS.getDoc(ansRef);
  const data = ansSnap.exists() ? ansSnap.data() : {};

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const pid in data) {
    const entry = data[pid];
    if (!entry || typeof entry !== "object") continue;
    const v = entry.option;
    if (counts[v] != null) counts[v]++;
  }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap    = await FS.getDoc(roomRef);
  const state   = snap.exists() ? (snap.data().state || {}) : {};

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
  const snap    = await FS.getDoc(roomRef);
  const state   = snap.exists() ? (snap.data().state || {}) : {};

  const newState = {
    ...state,
    phase: "result",
    currentQuestion: qid,
    correct
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

/*******************************************************
 * ⑩ admin：正解者ランキング ＋ 得点加算
 *******************************************************/
async function admin_showRanking(qid, correct) {
  if (!FS) { alert("読み込み中です"); return; }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const roomSnap = await FS.getDoc(roomRef);
  const roomData = roomSnap.exists() ? roomSnap.data() : {};
  const state    = roomData.state || {};
  const startTimeMs = toMillis(state.startTime);
  const scoredQuestions = state.scoredQuestions || {};
  const alreadyScored   = !!scoredQuestions[qid];

  // 回答一覧
  const ansRef  = FS.doc(db, "rooms", ROOM_ID, "answers", String(qid));
  const ansSnap = await FS.getDoc(ansRef);
  const answers = ansSnap.exists() ? ansSnap.data() : {};

  // プレイヤー一覧
  const playersSnap = await FS.getDocs(
    FS.collection(db, "rooms", ROOM_ID, "players")
  );
  const players = {};
  playersSnap.forEach(pdoc => {
    const pdata = pdoc.data();
    players[pdoc.id] = {
      name: pdata.name || "名無し",
      score: typeof pdata.score === "number" ? pdata.score : 0,
      participated: typeof pdata.participated === "number" ? pdata.participated : 0
    };
  });

  // 正解者だけ抽出
  const correctList = [];
  for (const pid in answers) {
    const entry = answers[pid];
    if (!entry || typeof entry !== "object") continue;
    if (entry.option !== correct) continue;

    const t = toMillis(entry.time);
    if (t == null || startTimeMs == null) continue;

    correctList.push({
      pid,
      name: players[pid] ? players[pid].name : "名無し",
      timeMs: Math.max(0, t - startTimeMs)
    });
  }

  // 早い順にソート
  correctList.sort((a, b) => a.timeMs - b.timeMs);

  // 上位10名までランキング配列を作る
  const ranking = correctList.slice(0, 10).map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    timeMs: p.timeMs
  }));

  // まだ得点計算していなければ得点を反映
  if (!alreadyScored) {
    // 参加フラグ（回答した人すべて）
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

    // 正解者への点数（全員＋10点、先着 1〜3位 にボーナス）
    for (let i = 0; i < correctList.length; i++) {
      const p = correctList[i];
      const pInfo = players[p.pid] || { score: 0 };
      let add = 10;

      if (i === 0) add += 5;      // 1位 +5
      else if (i === 1) add += 3; // 2位 +3
      else if (i === 2) add += 1; // 3位 +1

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
 * ⑪ admin：最終結果ランキング（answers から集計し直す）
 *******************************************************/
async function admin_showFinalRanking() {
  if (!FS) { alert("読み込み中です"); return; }

  const roomRef  = FS.doc(db, "rooms", ROOM_ID);
  const roomSnap = await FS.getDoc(roomRef);
  const roomData = roomSnap.exists() ? roomSnap.data() : {};
  const state    = roomData.state || {};

  // 参加者一覧を先に取得しておく
  const playersSnap = await FS.getDocs(
    FS.collection(db, "rooms", ROOM_ID, "players")
  );
  const players = {};
  playersSnap.forEach(pdoc => {
    const pdata = pdoc.data();
    players[pdoc.id] = {
      name: pdata.name || "名無し",
      totalScore: 0
    };
  });

  // 指定した最大問題数までを集計（必要に応じて変更）
  const MAX_QID = 10;

  for (let qid = 1; qid <= MAX_QID; qid++) {
    const qRef  = FS.doc(db, "rooms", ROOM_ID, "questions", String(qid));
    const qSnap = await FS.getDoc(qRef);
    if (!qSnap.exists()) continue;
    const qData   = qSnap.data();
    const correct = qData.correct;
    if (typeof correct !== "number") continue;

    const ansRef  = FS.doc(db, "rooms", ROOM_ID, "answers", String(qid));
    const ansSnap = await FS.getDoc(ansRef);
    const answers = ansSnap.exists() ? ansSnap.data() : {};

    // この問題の正解者だけを抽出し、回答時間でソート
    const correctList = [];
    for (const pid in answers) {
      const entry = answers[pid];
      if (!entry || typeof entry !== "object") continue;
      if (entry.option !== correct) continue;

      const t = toMillis(entry.time);
      if (t == null) continue;

      // 参加者一覧に存在しないIDの場合も念のため登録
      if (!players[pid]) {
        players[pid] = { name: "名無し", totalScore: 0 };
      }

      correctList.push({
        pid,
        timeMs: t
      });
    }

    // 早押し順（時間が小さい = 早い）
    correctList.sort((a, b) => a.timeMs - b.timeMs);

    // 全正解者に +10点、先着 1〜3位にボーナス
    correctList.forEach((p, idx) => {
      let add = 10;
      if (idx === 0) add += 5;      // 1位 +5
      else if (idx === 1) add += 3; // 2位 +3
      else if (idx === 2) add += 1; // 3位 +1

      players[p.pid].totalScore += add;
    });
  }

  // ランキング配列を作成
  const rankingArray = Object.keys(players).map((pid) => ({
    pid,
    name: players[pid].name,
    totalScore: players[pid].totalScore
  }));

  if (rankingArray.length === 0) {
    await FS.setDoc(
      roomRef,
      { state: { phase: "finalRanking", finalRanking: [] } },
      { merge: true }
    );
    return;
  }

  // スコアの降順（高得点が上位）
  rankingArray.sort((a, b) => b.totalScore - a.totalScore);

  const finalRanking = rankingArray.map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    totalScore: p.totalScore
  }));

  // players コレクション側の score も最終結果で上書きしておく
  for (const p of rankingArray) {
    try {
      await FS.updateDoc(
        FS.doc(db, "rooms", ROOM_ID, "players", p.pid),
        { score: p.totalScore }
      );
    } catch (e) {
      console.warn("update player score failed for", p.pid, e);
    }
  }

  const newState = {
    ...state,
    phase: "finalRanking",
    finalRanking
  };

  await FS.setDoc(roomRef, { state: newState }, { merge: true });
}

/*******************************************************
 * ⑫ admin：待機画面（背景のみ表示）に戻す
 *******************************************************/
async function admin_resetScreen() {
  if (!FS) { alert("読み込み中です"); return; }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const snap    = await FS.getDoc(roomRef);
  const state   = snap.exists() ? (snap.data().state || {}) : {};

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
 * ⑬ Firebase 初期化を受け取って開始
 *******************************************************/
window.addEventListener("load", () => {
  db = window.firebaseDB;
  FS = window.firebaseFirestoreFuncs;

  if (!db || !FS) {
    console.error("Firebase が初期化されていません");
    return;
  }

  // question 画面は常に state を監視
  if (isQuestion) {
    listenState();
  }

  // 参加画面は、前に参加した名前があれば自動セット
  if (isIndex) {
    if (playerName && nameInput) {
      nameInput.value = playerName;
    }
  }
});


















