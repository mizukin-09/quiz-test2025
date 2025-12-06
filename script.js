/* ------------------------------------------------------
   script.js（2025完全安定版）
------------------------------------------------------ */

const ROOM_ID = "roomA";
let db = null;
let FS = null;

// プレイヤー情報
let playerId = localStorage.getItem("playerId");
let playerName = localStorage.getItem("playerName");

// DOM
const nameInput = document.getElementById("nameInput");
const joinBtn = document.getElementById("joinBtn");
const waitingArea = document.getElementById("waitingArea");
const questionArea = document.getElementById("questionArea");
const questionText = document.getElementById("questionText");
const choicesDiv = document.getElementById("choices");

/* -------------------------
   Utility
------------------------- */
function makeId(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/* ------------------------------------------------------
   ① 参加処理
------------------------------------------------------ */
async function joinGame() {
  const name = nameInput.value.trim();
  if (!name) return alert("ニックネームを入力してください");

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
    },
    { merge: true }
  );

  nameInput.style.display = "none";
  joinBtn.style.display = "none";
  waitingArea.style.display = "block";

  listenState();
}

/* ------------------------------------------------------
   ② Firestore state 監視
------------------------------------------------------ */
let unState = null;

function listenState() {
  if (unState) unState();

  unState = FS.onSnapshot(FS.doc(db, "rooms", ROOM_ID), async (snap) => {
    if (!snap.exists()) return;

    const st = snap.data().state;
    if (!st) return;

    const { phase, currentQuestion, correct, votes } = st;

    if (phase === "waiting") {
      waitingArea.style.display = "block";
      questionArea.style.display = "none";
      return;
    }

    if (phase === "question") {
      waitingArea.style.display = "none";
      questionArea.style.display = "block";
      renderQuestion(currentQuestion);
      return;
    }

    if (phase === "votes") {
      showVotes(votes);
      return;
    }

    if (phase === "result") {
      showCorrect(correct);
      return;
    }
  });
}

/* ------------------------------------------------------
   ③ 質問表示
------------------------------------------------------ */
async function renderQuestion(qid) {
  const qSnap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID, "questions", String(qid)));
  if (!qSnap.exists()) {
    questionText.textContent = "問題データがありません";
    return;
  }

  const q = qSnap.data();
  questionText.textContent = q.text;
  choicesDiv.innerHTML = "";

  q.options.forEach((opt, idx) => {
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
  btn.style.border = "2px solid #333";
}

/* ------------------------------------------------------
   ④ 回答送信
------------------------------------------------------ */
async function answer(optIdx) {
  disableChoices();
  highlightChoice(optIdx);

  const snap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID));
  const qid = snap.data().state.currentQuestion;

  await FS.setDoc(
    FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)),
    { [playerId]: optIdx },
    { merge: true }
  );
}

function disableChoices() {
  document.querySelectorAll(".choiceBtn").forEach((btn) => (btn.disabled = true));
}

function highlightChoice(optIdx) {
  document.querySelectorAll(".choiceBtn").forEach((btn, idx) => {
    if (idx + 1 === optIdx) {
      btn.style.border = "4px solid blue";
      btn.style.background = "#eef";
    } else {
      btn.style.opacity = "0.4";
    }
  });
}

/* ------------------------------------------------------
   ⑤ 投票数表示
------------------------------------------------------ */
function showVotes(votes) {
  document.querySelectorAll(".choiceBtn").forEach((btn, idx) => {
    const v = votes[idx + 1] || 0;
    btn.textContent = btn.textContent + `（${v}票）`;
    btn.style.opacity = "0.4";
  });
}

/* ------------------------------------------------------
   ⑥ 正解発表
------------------------------------------------------ */
function showCorrect(correct) {
  document.querySelectorAll(".choiceBtn").forEach((btn, idx) => {
    if (idx + 1 === correct) {
      btn.style.border = "4px solid red";
      btn.style.opacity = "1";
      btn.style.background = "#fee";
    } else {
      btn.style.opacity = "0.3";
    }
  });
}

/* ------------------------------------------------------
   ⑦ 管理者：問題開始
------------------------------------------------------ */
async function admin_startQuestion(qid) {
  // ★ answersを完全クリア
  await FS.setDoc(FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)), {});

  await FS.updateDoc(FS.doc(db, "rooms", ROOM_ID), {
    state: {
      phase: "question",
      currentQuestion: qid,
      correct: null,
      votes: { 1: 0, 2: 0, 3: 0, 4: 0 },
    },
  });
}

/* ------------------------------------------------------
   ⑧ 管理者：投票数表示
------------------------------------------------------ */
async function admin_showVotes(qid) {
  const snap = await FS.getDoc(FS.doc(db, "rooms", ROOM_ID, "answers", String(qid)));
  const data = snap.exists() ? snap.data() : {};

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };

  for (let pid in data) {
    const v = data[pid];
    if (counts[v] !== undefined) counts[v]++;
  }

  await FS.updateDoc(FS.doc(db, "rooms", ROOM_ID), {
    state: {
      phase: "votes",
      currentQuestion: qid,
      votes: counts,
      correct: null,
    },
  });
}

/* ------------------------------------------------------
   ⑨ 管理者：正解発表
------------------------------------------------------ */
async function admin_reveal(qid, correct) {
  await FS.updateDoc(FS.doc(db, "rooms", ROOM_ID), {
    state: {
      phase: "result",
      currentQuestion: qid,
      correct,
    },
  });
}

/* ------------------------------------------------------
   ページロード
------------------------------------------------------ */
window.addEventListener("load", () => {
  db = window.firebaseDB;
  FS = window.firebaseFirestoreFuncs;

  if (playerName && nameInput) {
    nameInput.value = playerName;
  }
});


