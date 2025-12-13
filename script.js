/*******************************************************
 * script.js（クイズ用・得点/ランキング/最終結果 修正版）
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
 * question 用（カウントダウン & ランキングアニメ）
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

/*******************************************************
 * ① index：参加処理
 *******************************************************/
async function joinGame() {
  if (!isIndex) return;
  if (!FS) { alert("読み込み中です。1秒後にもう一度お試しください"); return; }

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

  // 参加時にスコアと参加回数をリセット
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
  waitingArea.style.display = "block";

  listenState();
}

/*******************************************************
 * ② Firestore state 監視（index & question）
 *******************************************************/
let unState = null;

function listenState() {
  if (!FS) return;
  if (unState) unState();

  unState = FS.onSnapshot(FS.doc(db, "rooms", ROOM_ID), async (snap) => {
    if (!snap.exists()) return;
    const st = snap.data().state;
    if (!st) return;

    const { phase, currentQuestion, votes, correct, deadline, ranking, finalRanking } = st;

    /******** index（スマホ回答用） ********/
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
 * ③ index：選択肢だけ表示
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
 * ④ index：回答送信（回答時間も保存）
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

  // 自分の選択肢を青枠で強調
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

  // 回答内容を保存（正解/不正解に関わらず）
  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)),
    {
      [playerId]: {
        option: optIdx,
        time: Date.now()
      }
    },
    { merge: true }
  );
}

function disableChoices() {
  document.querySelectorAll(".choiceBtn").forEach((b) => (b.disabled = true));
}

/*******************************************************
 * ⑤ index：正解発表（見た目だけ）
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

  // ランキング系以外ではランキング表示を消す
  if (rankingEl && phase !== "ranking" && phase !== "finalRanking") {
    stopRankingAnimation();
    rankingEl.innerHTML = "";
  }

  // 完全待機
  if (phase === "waiting") {
    qt.textContent = "問題を待っています…";
    list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";
    stopCountdown();
    return;
  }

  // 最終結果ランキング
  if (phase === "finalRanking") {
    qt.textContent = "最終結果発表";
    list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";
    if (rankingEl) {
      showFinalRanking(finalRanking || []);
    }
    return;
  }

  // 各問題の正解者ランキング
  if (phase === "ranking") {
    qt.textContent = "正解者ランキング（上位10名）";
    list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";

    if (rankingEl) {
      startRankingAnimation(ranking || []);
    }
    return;
  }

  // ここから intro / question / closed / votes / result 用
  const qSnap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID, "questions", String(currentQuestion)));
  if (!qSnap.exists()) {
    qt.textContent = "問題データがありません";
    list.innerHTML = "";
    if (timerEl) timerEl.textContent = "";
    if (imgEl) imgEl.style.display = "none";
    stopCountdown();
    return;
  }
  const q = qSnap.data();

  qt.textContent = q.text || "";
  list.innerHTML = "";

  // 画像
  if (imgEl) {
    if (q.imageUrl) {
      imgEl.src = q.imageUrl;
      imgEl.style.display = "block";
    } else {
      imgEl.style.display = "none";
    }
  }

  // intro
  if (phase === "intro") {
    if (timerEl) timerEl.textContent = "レディーゴーの合図を待っています…";
    stopCountdown();
    return;
  }

  // タイマー
  if (phase === "question" && typeof deadline === "number") {
    startCountdown(currentQuestion, deadline);
  } else {
    stopCountdown();
    if (timerEl) {
      if (phase === "closed") timerEl.textContent = "時間終了！";
      else timerEl.textContent = "";
    }
  }

  // 選択肢
  (q.options || []).forEach((opt, idx) => {
    const div = document.createElement("div");
    div.className = "screenChoice";
    div.textContent = `${idx + 1}. ${opt}`;
    div.style.padding = "12px";
    div.style.border = "2px solid #888";
    div.style.margin = "10px 0";
    div.style.fontSize = "28px";
    div.style.background = "#f4f4f4";
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
 * question：各問 正解者ランキング（10位→1位）
 *******************************************************/
function startRankingAnimation(ranking) {
  const rankingEl = document.getElementById("screenRanking");
  if (!rankingEl) return;

  stopRankingAnimation();

  if (!Array.isArray(ranking) || ranking.length === 0) {
    rankingEl.innerHTML = "<h2>正解者は0人でした…</h2>";
    return;
  }

  const items = ranking.slice().sort((a, b) => b.rank - a.rank); // 10位→1位

  rankingEl.innerHTML = "<h2>正解者ランキング（上位10名）</h2><ol id='rankingList'></ol>";
  const listEl = document.getElementById("rankingList");

  let idx = 0;
  function step() {
    if (idx >= items.length) {
      stopRankingAnimation();
      return;
    }
    const p = items[idx++];
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
 * question：最終結果ランキング（総合得点）
 *******************************************************/
function showFinalRanking(finalRanking) {
  const rankingEl = document.getElementById("screenRanking");
  if (!rankingEl) return;

  stopRankingAnimation();

  if (!Array.isArray(finalRanking) || finalRanking.length === 0) {
    rankingEl.innerHTML = "<h2>最終結果：スコアデータがありません</h2>";
    return;
  }

  let html = "<h2>最終結果ランキング</h2><ol>";
  finalRanking.forEach((p) => {
    html += `<li>${p.rank}位：${p.name}（${p.totalScore}点）</li>`;
  });
  html += "</ol>";
  rankingEl.innerHTML = html;
}

/*******************************************************
 * ⑦ admin：出題 / 選択肢表示 / 投票数表示 / 正解発表
 *******************************************************/

// 出題（映像・音だけ）
async function admin_showIntro(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  await FS.setDoc(FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)), {});

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID),
    {
      state: {
        phase: "intro",
        currentQuestion: qid,
        correct: null,
        votes: null,
        deadline: null
      }
    },
    { merge: true }
  );
}

// 選択肢表示（回答開始）
async function admin_startQuestion(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  await FS.setDoc(FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)), {});

  const deadline = Date.now() + 10000; // 10秒

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID),
    {
      state: {
        phase: "question",
        currentQuestion: qid,
        correct: null,
        votes: { 1: 0, 2: 0, 3: 0, 4: 0 },
        deadline
      }
    },
    { merge: true }
  );
}

// 投票数表示
async function admin_showVotes(qid) {
  if (!FS) { alert("読み込み中です"); return; }

  const snap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)));
  const data = snap.exists() ? snap.data() : {};

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let pid in data) {
    const entry = data[pid];
    if (!entry || typeof entry !== "object") continue;
    const v = entry.option;
    if (counts[v] != null) counts[v]++;
  }

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID),
    {
      state: {
        phase: "votes",
        currentQuestion: qid,
        correct: null,
        votes: counts
      }
    },
    { merge: true }
  );
}

// 正解発表（見た目だけ）
async function admin_reveal(qid, correct) {
  if (!FS) { alert("読み込み中です"); return; }

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID),
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

/*******************************************************
 * ⑧ admin：各問題のランキング + 得点加算（1問につき1回だけ）
 *******************************************************/
async function admin_showRanking(qid, correct) {
  if (!FS) { alert("読み込み中です"); return; }

  const roomRef = FS.doc(db, "rooms", ROOM_ID);
  const roomSnap = await FS.getDoc(roomRef);
  const roomData = roomSnap.exists() ? roomSnap.data() : {};
  const state = roomData.state || {};
  const deadline = state.deadline || null;
  const startTime = deadline ? (deadline - 10000) : null;
  const scoredQuestions = state.scoredQuestions || {};

  const alreadyScored = !!scoredQuestions[qid];

  // 回答データ
  const answersSnap = await FS.getDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid))
  );
  const answers = answersSnap.exists() ? answersSnap.data() : {};

  // プレイヤー一覧（名前＋現在スコア＋参加回数）
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

  // 正解者だけ抽出
  const resultList = [];
  for (const pid in answers) {
    const entry = answers[pid];
    if (!entry || typeof entry !== "object") continue;
    if (entry.option === correct) {
      const rawTime = entry.time || 0;
      let elapsedMs = rawTime;
      if (startTime) {
        elapsedMs = Math.max(0, rawTime - startTime);
      }
      resultList.push({
        pid,
        name: players[pid] ? players[pid].name : "名無し",
        timeMs: elapsedMs
      });
    }
  }

  // 早い順にソート
  resultList.sort((a, b) => a.timeMs - b.timeMs);

  // ランキング表示用に上位10名
  const ranking = resultList.slice(0, 10).map((p, idx) => ({
    rank: idx + 1,
    name: p.name,
    timeMs: p.timeMs
  }));

  // ★★ まだ得点加算していない場合だけ処理する ★★
  if (!alreadyScored) {
    // その問題に回答した全員を「参加者」としてカウント
    for (const pid in answers) {
      const pInfo = players[pid];
      if (!pInfo) continue;
      const participated = pInfo.participated || 0;
      pInfo.participated = participated + 1;
      await FS.updateDoc(
        FS.doc(db, "rooms", ROOM_ID, "players", pid),
        { participated: pInfo.participated }
      );
    }

    // 正解者に点数を付与
    for (let i = 0; i < resultList.length; i++) {
      const p = resultList[i];
      const pInfo = players[p.pid] || { score: 0, participated: 0 };
      let add = 10; // 正解ボーナス

      if (i === 0) add += 5;      // 1位
      else if (i === 1) add += 3; // 2位
      else if (i === 2) add += 1; // 3位

      const newScore = pInfo.score + add;
      players[p.pid].score = newScore;

      await FS.updateDoc(
        FS.doc(db, "rooms", ROOM_ID, "players", p.pid),
        { score: newScore }
      );
    }
  }

  // この問題はスコア計算済みとしてマーク
  const newScored = { ...scoredQuestions, [qid]: true };

  const newState = {
    ...state,
    phase: "ranking",
    currentQuestion: qid,
    correct,
    ranking,
    scoredQuestions: newScored
  };
  // deadline, votes は不要なので消しておく（表示に影響しないが整理用）
  delete newState.deadline;
  delete newState.votes;

  await FS.setDoc(
    roomRef,
    { state: newState },
    { merge: true }
  );
}

/*******************************************************
 * ⑨ admin：最終結果ランキング（総合得点）
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

    // 1問も参加していない（古いテストデータなど）は除外
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

  // スコアの高い順
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
 * ⑩ admin：画像2択問題を登録して出題（任意）
 *******************************************************/
async function admin_setupImageQuestion1() {
  if (!FS) { alert("読み込み中です"); return; }

  const qid = 4; // 画像問題のID（必要に応じて変更）

  const questionData = {
    id: qid,
    text: "この画像はどちら？",
    options: ["犬", "猫"],
    correct: 2,
    imageUrl: "picture_quiz/q4.png"
  };

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID, "questions", String(qid)),
    questionData
  );

  await admin_startQuestion(qid);
  alert("画像2択問題を出題しました（imageUrl を必要に応じて変更してください）");
}

/*******************************************************
 * ⑪ Firebase inject on load
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









