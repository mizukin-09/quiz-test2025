/* ======================================================
   script.js（完全版）
   - admin / index / question 共通
   - フェーズ: idle → intro(出題) → question(回答) → votes → result → ranking → final
   - 回答締切は「index側で時間判定」（自動で投票不可）
   - スコア: 正解+10 / 早押し上位3名に +5,+3,+1
   - ランキング表示は「下位→上位を下から積み上げ」
====================================================== */

(() => {
  "use strict";

  /* ====== 設定 ====== */
  const ROOM_ID = "roomA";
  const ANSWER_LIMIT_MS = 10_000;     // 回答時間 10秒
  const RANK_ANIM_INTERVAL = 900;     // ランキング積み上げ間隔(ms)

  /* ====== Firebase 注入（HTML側で window に入ってる想定） ====== */
  let db = null;
  let FS = null;

  /* ====== ローカル保持 ====== */
  let playerId = localStorage.getItem("playerId") || null;
  let playerName = localStorage.getItem("playerName") || null;

  // Index側で state を都度 getDoc しないため、最新stateを保持
  let currentState = null;

  // Snapshot解除
  let unsubRoom = null;

  // Question側 タイマー/ランキング用
  let questionTimer = null;
  let rankTimer = null;

  /* ======================================================
     Util
  ====================================================== */
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
    const v = Math.max(0, ms) / 1000;
    return v.toFixed(2);
  }

  function clearTimer(t) {
    if (t) clearInterval(t);
  }
  function clearTimeoutSafe(t) {
    if (t) clearTimeout(t);
  }

  function isIndexPage() {
    return !!document.getElementById("joinBtn");
  }
  function isQuestionPage() {
    return !!document.getElementById("screen");
  }

  /* ======================================================
     Firestore Refs
  ====================================================== */
  const roomRef = () => FS.doc(db, "rooms", ROOM_ID);
  const questionRef = (qid) => FS.doc(db, "rooms", ROOM_ID, "questions", String(qid));
  const answersRef = (qid) => FS.doc(db, "rooms", ROOM_ID, "answers", String(qid));
  const playersCol = () => FS.collection(db, "rooms", ROOM_ID, "players");
  const playerRef = (pid) => FS.doc(db, "rooms", ROOM_ID, "players", pid);

  async function readRoomState() {
    const snap = await FS.getDoc(roomRef());
    if (!snap.exists()) return null;
    const data = snap.data() || {};
    return data.state || null;
  }

  /* ======================================================
     Index UI
  ====================================================== */
  function idxEls() {
    return {
      joinArea: document.getElementById("joinArea"),
      nameInput: document.getElementById("nameInput"),
      joinBtn: document.getElementById("joinBtn"),
      waitingArea: document.getElementById("waitingArea"),
      choices: document.getElementById("choices"),
    };
  }

  function idxShowWaiting(msg) {
    const el = idxEls();
    if (!el.waitingArea) return;
    el.waitingArea.style.display = "block";
    el.waitingArea.textContent = msg || "司会の合図があるまでお待ちください…";
  }

  function idxHideChoices() {
    const el = idxEls();
    if (!el.choices) return;
    el.choices.innerHTML = "";
  }

  function idxRenderChoices(options, enabled) {
    const el = idxEls();
    if (!el.choices) return;

    el.choices.innerHTML = "";

    (options || []).forEach((opt, idx) => {
      const btn = document.createElement("button");
      btn.className = "choiceBtn";
      btn.textContent = `${idx + 1}. ${opt}`;
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.margin = "10px 0";
      btn.style.padding = "14px 12px";
      btn.style.fontSize = "18px";
      btn.style.borderRadius = "10px";
      btn.style.border = "2px solid #333";
      btn.style.background = "#fff";
      btn.style.cursor = "pointer";

      btn.disabled = !enabled;

      btn.onclick = () => answer(idx + 1);

      el.choices.appendChild(btn);
    });
  }

  function idxHighlightChoice(optIdx) {
    const btns = document.querySelectorAll(".choiceBtn");
    btns.forEach((b, i) => {
      const n = i + 1;
      if (n === optIdx) {
        b.style.border = "4px solid #1e5bff";
        b.style.background = "#eaf1ff";
        b.style.opacity = "1";
      } else {
        b.style.opacity = "0.35";
      }
    });
  }

  function idxDisableAllChoices() {
    document.querySelectorAll(".choiceBtn").forEach(b => (b.disabled = true));
  }

  /* ======================================================
     Question UI
  ====================================================== */
  function qEls() {
    return {
      screenQuestionText: document.getElementById("screenQuestionText"),
      screenTimer: document.getElementById("screenTimer"),
      screenImage: document.getElementById("screenImage"),
      screenChoices: document.getElementById("screenChoices"),

      screenRanking: document.getElementById("screenRanking"),
      rankingTitle: document.getElementById("rankingTitle"),
      rankingList: document.getElementById("rankingList"),
    };
  }

  function qHideAll() {
    const el = qEls();

    // timers
    clearTimer(questionTimer);
    questionTimer = null;
    clearTimeoutSafe(rankTimer);
    rankTimer = null;

    // main
    if (el.screenQuestionText) {
      el.screenQuestionText.style.display = "none";
      el.screenQuestionText.textContent = "";
    }
    if (el.screenTimer) {
      el.screenTimer.style.display = "none";
      el.screenTimer.textContent = "";
    }
    if (el.screenImage) {
      el.screenImage.style.display = "none";
      el.screenImage.src = "";
    }
    if (el.screenChoices) {
      el.screenChoices.style.display = "none";
      el.screenChoices.innerHTML = "";
    }

    // ranking overlay
    if (el.screenRanking) el.screenRanking.style.display = "none";
    if (el.rankingTitle) el.rankingTitle.textContent = "";
    if (el.rankingList) el.rankingList.innerHTML = "";
  }

  async function loadQuestion(qid) {
    const snap = await FS.getDoc(questionRef(qid));
    return snap.exists() ? snap.data() : null;
  }

  function qRenderIntro(q) {
    // 1枚目イメージ：問題文（＋画像）が中央、選択肢・タイマー無し
    const el = qEls();
    qHideAll();

    if (el.screenQuestionText) {
      el.screenQuestionText.style.display = "block";
      el.screenQuestionText.textContent = q?.text || "";
    }

    if (q?.imageUrl && el.screenImage) {
      el.screenImage.style.display = "block";
      el.screenImage.src = q.imageUrl;
    }
  }

  function qRenderQuestion(q, st) {
    // 2枚目イメージ：問題文＋（画像）＋選択肢＋タイマー
    const el = qEls();
    qHideAll();

    if (el.screenQuestionText) {
      el.screenQuestionText.style.display = "block";
      el.screenQuestionText.textContent = q?.text || "";
    }

    if (q?.imageUrl && el.screenImage) {
      el.screenImage.style.display = "block";
      el.screenImage.src = q.imageUrl;
    }

    // choices
    if (el.screenChoices) {
      el.screenChoices.style.display = "block";
      el.screenChoices.innerHTML = "";
      (q?.options || []).forEach((opt, idx) => {
        const div = document.createElement("div");
        div.className = "screenChoice";
        div.dataset.idx = String(idx + 1);
        div.textContent = `${idx + 1}. ${opt}`;
        el.screenChoices.appendChild(div);
      });
    }

    // timer
    if (el.screenTimer) {
      el.screenTimer.style.display = "inline-block";
      const deadlineMs = st?.deadlineMs || 0;

      questionTimer = setInterval(() => {
        const remain = Math.max(0, deadlineMs - nowMs());
        const sec = Math.ceil(remain / 1000);
        el.screenTimer.textContent = remain > 0 ? `残り ${sec} 秒` : `時間切れ`;
        if (remain <= 0) {
          clearTimer(questionTimer);
          questionTimer = null;
        }
      }, 100);
    }
  }

  function qRenderVotes(q, votes) {
    const el = qEls();
    const nodes = el.screenChoices?.querySelectorAll(".screenChoice") || [];
    nodes.forEach((node, idx) => {
      const key = String(idx + 1);
      const v = votes?.[key] ?? votes?.[idx + 1] ?? 0;
      const base = q?.options?.[idx] ?? "";
      node.textContent = `${idx + 1}. ${base}（${v}票）`;
    });
  }

  function qRenderResult(correct) {
    const el = qEls();
    const nodes = el.screenChoices?.querySelectorAll(".screenChoice") || [];
    nodes.forEach((node, idx) => {
      const n = idx + 1;
      if (n === correct) {
        node.style.border = "4px solid #ff2b2b";
        node.style.background = "rgba(255,230,230,0.95)";
        node.style.opacity = "1";
      } else {
        node.style.opacity = "0.18";
      }
    });
  }

  function qStartRankingAnimation(title, entries, mode) {
    // entries は rank昇順（1位→…）で受け取る
    // 表示は「下位→上位を積み上げ」なので、最後から出して「上に追加」
    const el = qEls();
    qHideAll();

    if (!el.screenRanking) return;

    el.screenRanking.style.display = "flex";
    el.rankingTitle.textContent = title || "";
    el.rankingList.innerHTML = "";

    clearTimeoutSafe(rankTimer);
    rankTimer = null;

    const arr = (entries || []).slice(); // 1..N
    let i = arr.length - 1;              // 下位から

    const step = () => {
      if (i < 0) return;

      const e = arr[i];

      const li = document.createElement("li");
      if (mode === "time") {
        li.textContent = `${e.rank}位：${e.name}（${fmtSec(e.timeMs)}秒）`;
      } else {
        li.textContent = `${e.rank}位：${e.name}（${e.score}点）`;
      }

      // ★ 上に積み上げたいので "prepend"
      el.rankingList.prepend(li);

      i--;
      rankTimer = setTimeout(step, RANK_ANIM_INTERVAL);
    };

    step();
  }

  /* ======================================================
     Room Snapshot
  ====================================================== */
  function listenRoom() {
    if (unsubRoom) unsubRoom();

    unsubRoom = FS.onSnapshot(roomRef(), async (snap) => {
      if (!snap.exists()) return;

      const data = snap.data() || {};
      const st = data.state || { phase: "idle" };

      currentState = st;

      // Index
      if (isIndexPage()) {
        await handleIndexState(st);
      }

      // Question
      if (isQuestionPage()) {
        await handleQuestionState(st);
      }
    });
  }

  async function handleIndexState(st) {
    const el = idxEls();
    if (!el.waitingArea) return;

    // 参加前は触らない（joinGameで listener 開始）
    if (!playerId || !playerName) return;

    // phase に応じて「回答欄だけ」出す
    if (st.phase === "question" && st.currentQuestion) {
      const q = await loadQuestion(st.currentQuestion);

      // 締切判定（index側で止める）
      const enabled = (st.deadlineMs && nowMs() <= st.deadlineMs);

      idxShowWaiting("");      // waitingAreaは消さずに空にする（レイアウト保持）
      idxRenderChoices(q?.options || [], enabled);

      if (!enabled) {
        idxDisableAllChoices();
      } else {
        // deadline後に自動で押せなくする（ボタン操作不要）
        const remain = Math.max(0, st.deadlineMs - nowMs());
        setTimeout(() => idxDisableAllChoices(), remain + 50);
      }
      return;
    }

    // それ以外は回答欄非表示
    idxHideChoices();

    if (st.phase === "intro") {
      idxShowWaiting("司会の合図を待っています…");
      return;
    }
    if (st.phase === "votes" || st.phase === "result" || st.phase === "ranking") {
      idxShowWaiting("集計中…");
      return;
    }
    if (st.phase === "final") {
      idxShowWaiting("最終結果発表中…");
      return;
    }

    // idle / waiting
    idxShowWaiting("司会の合図があるまでお待ちください…");
  }

  async function handleQuestionState(st) {
    // idle は「背景のみ」
    if (!st || st.phase === "idle") {
      qHideAll();
      return;
    }

    const qid = st.currentQuestion;
    const q = qid ? await loadQuestion(qid) : null;

    if (st.phase === "intro") {
      qRenderIntro(q);
      return;
    }

    if (st.phase === "question") {
      qRenderQuestion(q, st);
      return;
    }

    if (st.phase === "votes") {
      // 投票数は choice の上に票数を足す
      qRenderQuestion(q, st);
      // timerは不要なので非表示
      const el = qEls();
      if (el.screenTimer) el.screenTimer.style.display = "none";
      qRenderVotes(q, st.votes);
      return;
    }

    if (st.phase === "result") {
      qRenderQuestion(q, st);
      const el = qEls();
      if (el.screenTimer) el.screenTimer.style.display = "none";
      // votes も残っているなら表示してから正解強調
      if (st.votes) qRenderVotes(q, st.votes);
      qRenderResult(st.correct);
      return;
    }

    if (st.phase === "ranking") {
      qStartRankingAnimation("正解者ランキング（上位10名）", st.ranking || [], "time");
      return;
    }

    if (st.phase === "final") {
      qStartRankingAnimation("最終結果ランキング", st.finalRanking || [], "score");
      return;
    }
  }

  /* ======================================================
     Index: Join / Answer
  ====================================================== */
  async function joinGame() {
    if (!FS || !db) {
      alert("Firestore の準備中です。少し待ってから再度お試しください。");
      return;
    }

    const el = idxEls();
    const name = el.nameInput?.value?.trim();
    if (!name) {
      alert("ニックネームを入力してください");
      return;
    }

    // playerId 作成
    if (!playerId) {
      playerId = makeId(12);
      localStorage.setItem("playerId", playerId);
    }
    playerName = name;
    localStorage.setItem("playerName", name);

    // 既存 score を壊さないように：存在確認
    const pRef = playerRef(playerId);
    const pSnap = await FS.getDoc(pRef);

    if (!pSnap.exists()) {
      await FS.setDoc(pRef, {
        name,
        score: 0,
        joinedAt: FS.serverTimestamp ? FS.serverTimestamp() : new Date().toISOString(),
        lastSeenAt: FS.serverTimestamp ? FS.serverTimestamp() : new Date().toISOString(),
      });
    } else {
      await FS.setDoc(pRef, {
        name,
        lastSeenAt: FS.serverTimestamp ? FS.serverTimestamp() : new Date().toISOString(),
      }, { merge: true });
    }

    // UI
    if (el.joinArea) el.joinArea.style.display = "none";
    idxShowWaiting("司会の合図があるまでお待ちください…");

    // listen start
    listenRoom();
  }

  async function answer(optIdx) {
    if (!playerId) return;

    // state を保持しているので getDoc しない
    const st = currentState;
    if (!st || st.phase !== "question" || !st.currentQuestion) return;

    // index側で締切判定（自動）
    if (st.deadlineMs && nowMs() > st.deadlineMs) {
      idxDisableAllChoices();
      idxShowWaiting("時間切れです（投票できません）");
      return;
    }

    // UI: 選んだ選択肢を分かるように
    idxHighlightChoice(optIdx);
    idxDisableAllChoices();

    const qid = st.currentQuestion;

    // answers/{qid} に pid: {opt, atMs} を保存（merge）
    await FS.setDoc(
      answersRef(qid),
      { [playerId]: { opt: optIdx, atMs: nowMs() } },
      { merge: true }
    );

    // lastSeen
    await FS.setDoc(playerRef(playerId), {
      lastSeenAt: FS.serverTimestamp ? FS.serverTimestamp() : new Date().toISOString(),
    }, { merge: true });
  }

  /* ======================================================
     Admin Functions
     ※ admin.html の onclick から呼ばれるので window に生やす
  ====================================================== */

  async function admin_resetScreen() {
    if (!FS) return alert("読み込み中です");
    await FS.setDoc(roomRef(), {
      state: {
        phase: "idle",
        currentQuestion: null,
        startedAtMs: null,
        deadlineMs: null,
        votes: null,
        correct: null,
        ranking: null,
        finalRanking: null,
        scoredQid: null,
      }
    }, { merge: true });
  }

  async function admin_showIntro(qid) {
    if (!FS) return alert("読み込み中です");
    await FS.setDoc(roomRef(), {
      state: {
        phase: "intro",
        currentQuestion: qid,
        votes: null,
        correct: null,
        ranking: null,
      }
    }, { merge: true });
  }

  async function admin_startQuestion(qid) {
    if (!FS) return alert("読み込み中です");
    const startedAtMs = nowMs();
    const deadlineMs = startedAtMs + ANSWER_LIMIT_MS;

    await FS.setDoc(roomRef(), {
      state: {
        phase: "question",
        currentQuestion: qid,
        startedAtMs,
        deadlineMs,
        votes: null,
        correct: null,
        ranking: null,
      }
    }, { merge: true });
  }

  async function admin_showVotes(qid) {
    if (!FS) return alert("読み込み中です");

    // 選択肢数を知るため question 読む
    const q = await loadQuestion(qid);
    const optLen = (q?.options || []).length || 4;

    // answers 読む
    const aSnap = await FS.getDoc(answersRef(qid));
    const data = aSnap.exists() ? (aSnap.data() || {}) : {};

    // counts
    const counts = {};
    for (let i = 1; i <= optLen; i++) counts[String(i)] = 0;

    for (const pid in data) {
      const v = data[pid];
      let opt = null;
      if (typeof v === "number") opt = v;
      if (typeof v === "object" && v && typeof v.opt === "number") opt = v.opt;
      if (opt != null && counts[String(opt)] !== undefined) counts[String(opt)]++;
    }

    await FS.setDoc(roomRef(), {
      state: {
        phase: "votes",
        currentQuestion: qid,
        votes: counts
      }
    }, { merge: true });
  }

  async function admin_reveal(qid, correct) {
    if (!FS) return alert("読み込み中です");

    // すでに採点済みなら二重加算しない
    const st = await readRoomState();
    if (!st) return;

    // scoring必要か？
    const alreadyScored = (st.scoredQid === qid);

    // votes が無いならついでに計算して残しておく（任意）
    let votes = st.votes || null;
    if (!votes) {
      const q = await loadQuestion(qid);
      const optLen = (q?.options || []).length || 4;
      const aSnap = await FS.getDoc(answersRef(qid));
      const data = aSnap.exists() ? (aSnap.data() || {}) : {};
      votes = {};
      for (let i = 1; i <= optLen; i++) votes[String(i)] = 0;
      for (const pid in data) {
        const v = data[pid];
        let opt = null;
        if (typeof v === "number") opt = v;
        if (typeof v === "object" && v && typeof v.opt === "number") opt = v.opt;
        if (opt != null && votes[String(opt)] !== undefined) votes[String(opt)]++;
      }
    }

    if (!alreadyScored) {
      await scoreQuestionOnce(qid, correct, st.startedAtMs, st.deadlineMs);
      await FS.setDoc(roomRef(), { state: { scoredQid: qid } }, { merge: true });
    }

    await FS.setDoc(roomRef(), {
      state: {
        phase: "result",
        currentQuestion: qid,
        correct,
        votes,
      }
    }, { merge: true });
  }

  async function scoreQuestionOnce(qid, correct, startedAtMs, deadlineMs) {
    // answers
    const aSnap = await FS.getDoc(answersRef(qid));
    const answers = aSnap.exists() ? (aSnap.data() || {}) : {};

    // players（現在いる全員）
    const pSnap = await FS.getDocs(playersCol());
    const players = [];
    pSnap.forEach(doc => {
      const d = doc.data() || {};
      players.push({
        id: doc.id,
        name: d.name || doc.id,
        score: typeof d.score === "number" ? d.score : 0,
      });
    });

    // 正解者の timeMs を計算
    const correctOnes = [];
    for (const p of players) {
      const a = answers[p.id];
      let opt = null;
      let atMs = null;

      if (typeof a === "number") {
        opt = a;
      } else if (typeof a === "object" && a) {
        if (typeof a.opt === "number") opt = a.opt;
        if (typeof a.atMs === "number") atMs = a.atMs;
      }

      if (opt === correct) {
        // timeMs（無ければ大きい値）
        let timeMs = 9_999_999;
        if (typeof atMs === "number" && typeof startedAtMs === "number") {
          timeMs = Math.max(0, atMs - startedAtMs);
        }
        // deadline超えを正解扱いしない場合はここで除外も可
        if (typeof deadlineMs === "number" && typeof atMs === "number" && atMs > deadlineMs) {
          continue; // 締切後は無効
        }
        correctOnes.push({ pid: p.id, timeMs });
      }
    }

    // 正解者全員 +10
    const addMap = new Map(); // pid -> addScore
    for (const c of correctOnes) addMap.set(c.pid, (addMap.get(c.pid) || 0) + 10);

    // 早押し上位3名 +5,+3,+1
    correctOnes.sort((a, b) => a.timeMs - b.timeMs);
    const bonus = [5, 3, 1];
    for (let i = 0; i < Math.min(3, correctOnes.length); i++) {
      const pid = correctOnes[i].pid;
      addMap.set(pid, (addMap.get(pid) || 0) + bonus[i]);
    }

    // update
    for (const p of players) {
      const add = addMap.get(p.id) || 0;
      if (add === 0) continue;
      await FS.updateDoc(playerRef(p.id), { score: p.score + add });
    }
  }

  async function admin_showRanking(qid, correct) {
    if (!FS) return alert("読み込み中です");

    const st = await readRoomState();
    const startedAtMs = st?.startedAtMs;
    const deadlineMs = st?.deadlineMs;

    const aSnap = await FS.getDoc(answersRef(qid));
    const answers = aSnap.exists() ? (aSnap.data() || {}) : {};

    const pSnap = await FS.getDocs(playersCol());
    const nameMap = new Map();
    pSnap.forEach(doc => {
      const d = doc.data() || {};
      nameMap.set(doc.id, d.name || doc.id);
    });

    // 正解者
    const correctOnes = [];
    for (const [pid, a] of Object.entries(answers)) {
      let opt = null;
      let atMs = null;

      if (typeof a === "number") opt = a;
      else if (typeof a === "object" && a) {
        if (typeof a.opt === "number") opt = a.opt;
        if (typeof a.atMs === "number") atMs = a.atMs;
      }

      if (opt !== correct) continue;

      if (typeof deadlineMs === "number" && typeof atMs === "number" && atMs > deadlineMs) {
        continue; // 締切後は無効
      }

      let timeMs = 9_999_999;
      if (typeof atMs === "number" && typeof startedAtMs === "number") {
        timeMs = Math.max(0, atMs - startedAtMs);
      }
      correctOnes.push({ pid, timeMs });
    }

    correctOnes.sort((a, b) => a.timeMs - b.timeMs);
    const top = correctOnes.slice(0, 10).map((x, i) => ({
      rank: i + 1,
      name: nameMap.get(x.pid) || x.pid,
      timeMs: x.timeMs,
    }));

    await FS.setDoc(roomRef(), {
      state: {
        phase: "ranking",
        currentQuestion: qid,
        ranking: top
      }
    }, { merge: true });
  }

  async function admin_showFinalRanking() {
    if (!FS) return alert("読み込み中です");

    const pSnap = await FS.getDocs(playersCol());
    const arr = [];
    pSnap.forEach(doc => {
      const d = doc.data() || {};
      arr.push({
        pid: doc.id,
        name: d.name || doc.id,
        score: typeof d.score === "number" ? d.score : 0,
      });
    });

    // score desc
    arr.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const ranked = arr.map((x, i) => ({
      rank: i + 1,
      name: x.name,
      score: x.score,
    }));

    await FS.setDoc(roomRef(), {
      state: {
        phase: "final",
        finalRanking: ranked
      }
    }, { merge: true });
  }

  /* ======================================================
     init
  ====================================================== */
  function initWhenReady() {
    db = window.firebaseDB;
    FS = window.firebaseFirestoreFuncs;

    if (!db || !FS) return false;

    // admin/index から呼べるように
    window.joinGame = joinGame;
    window.answer = answer;

    window.admin_resetScreen = admin_resetScreen;
    window.admin_showIntro = admin_showIntro;
    window.admin_startQuestion = admin_startQuestion;
    window.admin_showVotes = admin_showVotes;
    window.admin_reveal = admin_reveal;
    window.admin_showRanking = admin_showRanking;
    window.admin_showFinalRanking = admin_showFinalRanking;

    // question は参加不要なので常時 listen
    if (isQuestionPage()) {
      listenRoom();
    }

    // index は join 後に listen を開始する（ただし、名前入力の復元だけ）
    if (isIndexPage()) {
      const el = idxEls();
      if (playerName && el.nameInput) el.nameInput.value = playerName;
    }

    return true;
  }

  window.addEventListener("load", () => {
    // Firebase 注入は module なので、ちょい待つことがある
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (initWhenReady()) {
        clearInterval(timer);
      } else if (tries > 50) {
        clearInterval(timer);
        console.error("Firebase init timeout: window.firebaseDB / funcs が見つかりません");
      }
    }, 100);
  });

})();



















