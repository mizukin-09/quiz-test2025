/* ======================================================
   script.js（完全版）
   - admin / index / question の3画面をこの1ファイルで制御
   - Firestore state を見て画面を切り替える
   - 回答受付は index 側が deadlineMs を見て自動で投票不可にする
====================================================== */

(() => {
  const ROOM_ID = "roomA";
  const ANSWER_DURATION_MS = 10000; // 10秒

  // Firebase（HTMLの module script から注入される）
  let db = null;
  let FS = null;

  // 共通：Firestore参照
  const roomRef = () => FS.doc(db, "rooms", ROOM_ID);
  const playerRef = (pid) => FS.doc(db, "rooms", ROOM_ID, "players", pid);
  const playersCol = () => FS.collection(db, "rooms", ROOM_ID, "players");
  const questionRef = (qid) => FS.doc(db, "rooms", ROOM_ID, "questions", String(qid));
  const answersRef = (qKey) => FS.doc(db, "rooms", ROOM_ID, "answers", String(qKey));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowMs = () => Date.now();

  function makeId(len = 12) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  async function waitForFirebaseReady() {
    for (let i = 0; i < 80; i++) {
      if (window.firebaseDB && window.firebaseFirestoreFuncs) {
        db = window.firebaseDB;
        FS = window.firebaseFirestoreFuncs;
        return true;
      }
      await sleep(50);
    }
    console.error("Firebase が window に用意されませんでした");
    return false;
  }

  // state を「丸ごと置き換え」する（古いキー残りを防止）
  async function setRoomState(stateObj) {
    await FS.setDoc(roomRef(), { state: stateObj }, { merge: true });
  }

  async function getRoomState() {
    const snap = await FS.getDoc(roomRef());
    if (!snap.exists()) return null;
    return snap.data().state || null;
  }

  // 質問を読む（なければダミー）
  async function fetchQuestion(qid) {
    const snap = await FS.getDoc(questionRef(qid));
    if (!snap.exists()) {
      return {
        id: qid,
        text: `Q${qid}`,
        options: ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
        correct: 1,
      };
    }
    const q = snap.data();
    return {
      id: qid,
      text: q.text ?? `Q${qid}`,
      options: Array.isArray(q.options) ? q.options : ["選択肢1", "選択肢2", "選択肢3", "選択肢4"],
      correct: typeof q.correct === "number" ? q.correct : 1,
      imageUrl: q.imageUrl || "",
      videoUrl: q.videoUrl || "",
    };
  }

  // answers の中身は { pid: { option, answeredAtMs } } または { pid: number } の両方を許容
  function normalizeAnswerValue(v) {
    if (typeof v === "number") {
      return { option: v, answeredAtMs: null };
    }
    if (v && typeof v === "object") {
      return {
        option: typeof v.option === "number" ? v.option : null,
        answeredAtMs: typeof v.answeredAtMs === "number" ? v.answeredAtMs : null,
      };
    }
    return { option: null, answeredAtMs: null };
  }

  async function loadAnswers(qKey) {
    const snap = await FS.getDoc(answersRef(qKey));
    return snap.exists() ? (snap.data() || {}) : {};
  }

  /* ======================================================
     INDEX（参加者）
  ====================================================== */
  let playerId = localStorage.getItem("playerId") || null;
  let playerName = localStorage.getItem("playerName") || "";

  let idxJoined = false;
  let idxState = null;

  let idxCurrentQuestionKey = null;
  let idxSelectedOption = null;

  let idxTimerInterval = null;
  let idxUnsubRoom = null;

  // 参加者側で初回に見えた瞬間から最大10秒に制限（端末時刻ズレ対策）
  let idxLocalDeadlineMs = null;

  function initIndexPage() {
    const joinArea = document.getElementById("joinArea");
    if (!joinArea) return;

    window.joinGame = joinGame;

    const nameInput = document.getElementById("nameInput");
    if (nameInput && playerName) nameInput.value = playerName;

    // 初期は joinArea 表示のまま
  }

  async function joinGame() {
    if (!FS) {
      alert("Firestore準備中です。少し待ってからもう一度押してください。");
      return;
    }

    const nameInput = document.getElementById("nameInput");
    const name = (nameInput?.value || "").trim();
    if (!name) return alert("ニックネームを入力してください");

    if (!playerId) {
      playerId = makeId(12);
      localStorage.setItem("playerId", playerId);
    }
    playerName = name;
    localStorage.setItem("playerName", name);

    await FS.setDoc(
      playerRef(playerId),
      {
        name,
        score: 0,
        joinedAt: FS.serverTimestamp ? FS.serverTimestamp() : new Date().toISOString(),
      },
      { merge: true }
    );

    document.getElementById("joinArea").style.display = "none";
    const waitingArea = document.getElementById("waitingArea");
    waitingArea.style.display = "block";
    waitingArea.textContent = "司会の合図があるまでお待ちください…";

    idxJoined = true;
    startIndexRoomListener();
  }

  function startIndexRoomListener() {
    if (idxUnsubRoom) idxUnsubRoom();

    idxUnsubRoom = FS.onSnapshot(roomRef(), async (snap) => {
      if (!snap.exists()) return;
      const st = snap.data().state || null;
      idxState = st;

      // phase で表示制御
      await applyIndexState(st);
    });
  }

  function stopIndexTimer() {
    if (idxTimerInterval) {
      clearInterval(idxTimerInterval);
      idxTimerInterval = null;
    }
  }


  function getEffectiveDeadlineMs(stDeadlineMs) {
    const a = typeof stDeadlineMs === "number" ? stDeadlineMs : 0;
    const b = typeof idxLocalDeadlineMs === "number" ? idxLocalDeadlineMs : 0;
    if (a && b) return Math.min(a, b);
    return b || a || 0;
  }

  async function applyIndexState(st) {
    const waitingArea = document.getElementById("waitingArea");
    const choicesDiv = document.getElementById("choices");

    if (!st || st.phase !== "question") {
      // 回答フェーズ以外は「待機」だけ（スマホは回答欄だけで良い）
      stopIndexTimer();
      choicesDiv.innerHTML = "";
      idxCurrentQuestionKey = null;
      idxSelectedOption = null;
      idxLocalDeadlineMs = null;

      waitingArea.style.display = "block";
      waitingArea.textContent =
        st && st.phase === "intro" ? "問題を確認してください…" : "司会の合図があるまでお待ちください…";
      return;
    }

    // --- question phase ---
    const qid = st.currentQuestion;
    const qKey = st.questionKey; // 重要：毎回ユニーク（過去投票と混ざらない）
    const deadlineMs = st.deadlineMs || 0;

    if (!qid || !qKey) {
      waitingArea.style.display = "block";
      waitingArea.textContent = "準備中です…";
      return;
    }

    // 問題切り替え（questionKeyが変わったら描画し直す）
    if (qKey !== idxCurrentQuestionKey) {
      idxCurrentQuestionKey = qKey;
      idxSelectedOption = null;
      idxLocalDeadlineMs = nowMs() + ANSWER_DURATION_MS;
      await renderIndexChoices(qid);
    }

    // タイマー（残り表示＋自動投票不可）
    stopIndexTimer();
    const tick = () => {
      const effectiveDeadlineMs = getEffectiveDeadlineMs(deadlineMs);
      const remain = effectiveDeadlineMs - nowMs();
      const sec = Math.max(0, Math.ceil(remain / 1000));
      waitingArea.style.display = "block";
      waitingArea.textContent = `残り ${sec} 秒`;

      if (remain <= 0) {
        disableIndexChoices("時間切れです");
      }
    };
    tick();
    idxTimerInterval = setInterval(tick, 200);

    // 時間内なら押せる（ただし既に回答済みなら押せない）
    if (nowMs() < getEffectiveDeadlineMs(deadlineMs) && idxSelectedOption == null) {
      enableIndexChoices();
    } else {
      disableIndexChoices();
    }
  }

  async function renderIndexChoices(qid) {
    const choicesDiv = document.getElementById("choices");
    choicesDiv.innerHTML = "";

    const q = await fetchQuestion(qid);

    // 4択/2択どちらでもOK
    (q.options || []).forEach((text, idx) => {
      const opt = idx + 1;

      const btn = document.createElement("button");
      btn.className = "choiceBtn";
      btn.type = "button";
      btn.textContent = text; // ←「選択肢①」ではなく問題の選択肢文字列

      btn.addEventListener("click", () => indexAnswer(opt));
      choicesDiv.appendChild(btn);
    });
  }

  function enableIndexChoices() {
    document.querySelectorAll(".choiceBtn").forEach((b) => {
      b.disabled = false;
      b.classList.remove("dim");
    });
  }

  function disableIndexChoices() {
    document.querySelectorAll(".choiceBtn").forEach((b) => {
      b.disabled = true;
    });
  }

  function highlightIndexChoice(opt) {
    const btns = Array.from(document.querySelectorAll(".choiceBtn"));
    btns.forEach((b, i) => {
      const myOpt = i + 1;
      b.classList.remove("selected");
      b.classList.remove("dim");

      if (myOpt === opt) {
        b.classList.add("selected"); // 青枠
      } else {
        b.classList.add("dim"); // 薄く
      }
    });
  }

  async function indexAnswer(opt) {
    if (!idxJoined || !playerId) {
      alert("参加してから回答してください");
      return;
    }
    if (!idxState || idxState.phase !== "question") return;

    const deadlineMs = idxState.deadlineMs || 0;
    const effectiveDeadlineMs = getEffectiveDeadlineMs(deadlineMs);
    if (nowMs() >= effectiveDeadlineMs) {
      disableIndexChoices();
      return;
    }

    if (idxSelectedOption != null) return; // 二重回答防止
    idxSelectedOption = opt;

    // UI
    highlightIndexChoice(opt);
    disableIndexChoices();

    // Firestoreへ投票
    const qKey = idxState.questionKey;
    try {
      await FS.setDoc(
        answersRef(qKey),
        {
          [playerId]: {
            option: opt,
            answeredAtMs: nowMs(),
          },
        },
        { merge: true }
      );
    } catch (e) {
      console.error(e);
      alert("送信に失敗しました。電波状況を確認してもう一度試してください。");
      // 失敗時は再回答できるよう戻す
      idxSelectedOption = null;
      enableIndexChoices();
    }
  }

  /* ======================================================
     QUESTION（画面共有）
  ====================================================== */
  let qUnsubRoom = null;
  let qTimerInterval = null;
  let qLastToken = null; // 同じ状態で何度もランキング描画しない用

  function initQuestionPage() {
    if (!document.getElementById("screen")) return;
    startQuestionRoomListener();
  }

  function qHideAll() {
    const elProblem = document.getElementById("problemBox");
    const elTimerBox = document.getElementById("timerBox");
    const elChoices = document.getElementById("screenChoices");
    const elRanking = document.getElementById("screenRanking");

    elProblem.style.display = "none";
    elTimerBox.style.display = "none";
    elChoices.style.display = "none";
    elRanking.style.display = "none";
  }

  function qStopTimer() {
    if (qTimerInterval) {
      clearInterval(qTimerInterval);
      qTimerInterval = null;
    }
  }

  function startQuestionRoomListener() {
    if (qUnsubRoom) qUnsubRoom();

    qUnsubRoom = FS.onSnapshot(roomRef(), async (snap) => {
      if (!snap.exists()) return;
      const st = snap.data().state || null;
      await applyQuestionState(st);
    });
  }

  async function applyQuestionState(st) {
    qStopTimer();
    qHideAll();

    if (!st) return; // 待機＝背景のみ

    const phase = st.phase;

    // 待機：背景のみ
    if (phase === "waiting") return;

    if (phase === "intro") {
      // 出題画面（問題だけ）
      await qRenderProblemOnly(st.currentQuestion);
      return;
    }

    if (phase === "question") {
      // 選択肢＋タイマー表示
      await qRenderQuestion(st.currentQuestion, st.deadlineMs);
      return;
    }

    if (phase === "votes") {
      await qRenderVotes(st.currentQuestion, st.votes);
      return;
    }

    if (phase === "result") {
      await qRenderResult(st.currentQuestion, st.correct);
      return;
    }

    if (phase === "ranking") {
      await qRenderRanking(st.ranking, "正解者ランキング（上位10名）", `ranking:${st.questionKey || ""}`);
      return;
    }

    if (phase === "final") {
      await qRenderFinal(st.finalRanking, "最終結果ランキング", `final:${st.finalKey || "v1"}`);
      return;
    }
  }

  async function qRenderProblemOnly(qid) {
    const q = await fetchQuestion(qid);

    const elProblem = document.getElementById("problemBox");
    const elText = document.getElementById("screenQuestionText");
    const elImg = document.getElementById("screenImage");

    elProblem.style.display = "block";

    elText.style.display = "block";
    elText.textContent = q.text || "";

    if (q.imageUrl) {
      elImg.src = q.imageUrl;
      elImg.style.display = "block";
    } else {
      elImg.style.display = "none";
      elImg.removeAttribute("src");
    }
  }

  async function qRenderQuestion(qid, deadlineMs) {
    const q = await fetchQuestion(qid);

    const elProblem = document.getElementById("problemBox");
    const elTimerBox = document.getElementById("timerBox");
    const elTimer = document.getElementById("screenTimer");
    const elText = document.getElementById("screenQuestionText");
    const elImg = document.getElementById("screenImage");
    const elChoices = document.getElementById("screenChoices");

    elProblem.style.display = "block";
    elTimerBox.style.display = "block";
    elChoices.style.display = "block";

    elText.style.display = "block";
    elText.textContent = q.text || "";

    if (q.imageUrl) {
      elImg.src = q.imageUrl;
      elImg.style.display = "block";
    } else {
      elImg.style.display = "none";
      elImg.removeAttribute("src");
    }

    // choices 表示（画面共有は押さないので div）
    elChoices.innerHTML = "";
    (q.options || []).forEach((opt, idx) => {
      const d = document.createElement("div");
      d.className = "screenChoice";
      d.textContent = `${idx + 1}. ${opt}`;
      elChoices.appendChild(d);
    });

    // timer
    const tick = () => {
      const remain = (deadlineMs || 0) - nowMs();
      const sec = Math.max(0, Math.ceil(remain / 1000));
      elTimer.style.display = "block";
      elTimer.textContent = `${sec}s`;
      if (remain <= 0) {
        elTimer.textContent = `0s`;
        qStopTimer();
      }
    };
    tick();
    qTimerInterval = setInterval(tick, 200);
  }

  async function qRenderVotes(qid, votesObj) {
    // votesObj: {1:n,2:n,3:n,4:n}
    const q = await fetchQuestion(qid);

    const elProblem = document.getElementById("problemBox");
    const elTimerBox = document.getElementById("timerBox");
    const elText = document.getElementById("screenQuestionText");
    const elImg = document.getElementById("screenImage");
    const elChoices = document.getElementById("screenChoices");

    elProblem.style.display = "block";
    elTimerBox.style.display = "block"; // ラベルだけ残してもOK、数字は消す
    document.getElementById("screenTimer").style.display = "none";

    elChoices.style.display = "block";

    elText.style.display = "block";
    elText.textContent = q.text || "";

    if (q.imageUrl) {
      elImg.src = q.imageUrl;
      elImg.style.display = "block";
    } else {
      elImg.style.display = "none";
      elImg.removeAttribute("src");
    }

    elChoices.innerHTML = "";
    (q.options || []).forEach((opt, idx) => {
      const num = idx + 1;
      const v = votesObj?.[num] ?? 0;
      const d = document.createElement("div");
      d.className = "screenChoice";
      d.textContent = `${num}. ${opt}（${v}票）`;
      elChoices.appendChild(d);
    });
  }

  async function qRenderResult(qid, correct) {
    const q = await fetchQuestion(qid);

    const elProblem = document.getElementById("problemBox");
    const elTimerBox = document.getElementById("timerBox");
    const elText = document.getElementById("screenQuestionText");
    const elImg = document.getElementById("screenImage");
    const elChoices = document.getElementById("screenChoices");

    elProblem.style.display = "block";
    elTimerBox.style.display = "block";
    document.getElementById("screenTimer").style.display = "none";

    elChoices.style.display = "block";

    elText.style.display = "block";
    elText.textContent = q.text || "";

    if (q.imageUrl) {
      elImg.src = q.imageUrl;
      elImg.style.display = "block";
    } else {
      elImg.style.display = "none";
      elImg.removeAttribute("src");
    }

    elChoices.innerHTML = "";
    (q.options || []).forEach((opt, idx) => {
      const num = idx + 1;
      const d = document.createElement("div");
      d.className = "screenChoice";

      // 「正解のみ濃く」「それ以外を薄く」
      if (num === correct) {
        d.classList.add("correctChoice");
      } else {
        d.classList.add("dimChoice");
      }

      d.textContent = `${num}. ${opt}`;
      elChoices.appendChild(d);
    });
  }

  async function qRenderRanking(rankingArr, title, token) {
    // rankingArr: [{rank, name, timeSec}]
    const key = token + ":" + JSON.stringify(rankingArr || []);
    if (qLastToken === key) return;
    qLastToken = key;

    const elRanking = document.getElementById("screenRanking");
    const elTitle = document.getElementById("rankingTitle");
    const elList = document.getElementById("rankingList");

    elRanking.style.display = "flex";
    elTitle.textContent = title;
    elList.innerHTML = "";

    const list = Array.isArray(rankingArr) ? rankingArr.slice(0, 10) : [];

    // 表示は「下位→上位」で積み上げたい：遅い方→速い方
    const reveal = list.slice().reverse();

    let i = 0;
    const timer = setInterval(() => {
      if (i >= reveal.length) {
        clearInterval(timer);
        return;
      }
      const item = reveal[i++];
      const div = document.createElement("div");
      div.className = "rankItem";
      div.textContent = `${item.rank}位：${item.name}（${Number(item.timeSec).toFixed(2)}秒）`;
      elList.appendChild(div);
    }, 600);
  }

  async function qRenderFinal(finalArr, title, token) {
    const key = token + ":" + JSON.stringify(finalArr || []);
    if (qLastToken === key) return;
    qLastToken = key;

    const elRanking = document.getElementById("screenRanking");
    const elTitle = document.getElementById("rankingTitle");
    const elList = document.getElementById("rankingList");

    elRanking.style.display = "flex";
    elTitle.textContent = title;
    elList.innerHTML = "";

    const list = Array.isArray(finalArr) ? finalArr : [];

    // finalArr は上位(1位)から入ってくるので、表示は「下位→上位」で積み上げ
    const reveal = list.slice().reverse();

    let i = 0;
    const timer = setInterval(() => {
      if (i >= reveal.length) {
        clearInterval(timer);
        return;
      }
      const item = reveal[i++];
      const div = document.createElement("div");
      div.className = "rankItem";
      div.textContent = `${item.rank}位：${item.name}（${item.score}点）`;
      elList.appendChild(div);
    }, 450);
  }

  /* ======================================================
     ADMIN（管理）
  ====================================================== */
  function initAdminPage() {
    if (!document.getElementById("adminPanel")) return;

    window.admin_resetScreen = admin_resetScreen;
    window.admin_showIntro = admin_showIntro;
    window.admin_startQuestion = admin_startQuestion;
    window.admin_showVotes = admin_showVotes;
    window.admin_reveal = admin_reveal;
    window.admin_showRanking = admin_showRanking;
    window.admin_showFinalRanking = admin_showFinalRanking;
  }

  async function admin_resetScreen() {
    await setRoomState({
      phase: "waiting",
      currentQuestion: null,
      questionKey: null,
      questionStartMs: null,
      deadlineMs: null,
      votes: null,
      correct: null,
      ranking: null,
      finalRanking: null,
      finalKey: null,
    });
    alert("待機画面に戻しました");
  }

  async function admin_showIntro(qid) {
    await setRoomState({
      phase: "intro",
      currentQuestion: qid,
      questionKey: null,
      questionStartMs: null,
      deadlineMs: null,
      votes: null,
      correct: null,
      ranking: null,
      finalRanking: null,
      finalKey: null,
    });
    alert(`Q${qid} を出題表示（問題だけ）にしました`);
  }

  async function admin_startQuestion(qid) {
    const start = nowMs();
    const qKey = `${qid}_${start}`; // 毎回ユニーク（過去投票と混ざらない）
    const deadline = start + ANSWER_DURATION_MS;

    await setRoomState({
      phase: "question",
      currentQuestion: qid,
      questionKey: qKey,
      questionStartMs: start,
      deadlineMs: deadline,
      votes: null,
      correct: null,
      ranking: null,
      finalRanking: null,
      finalKey: null,
    });

    // answers doc を作っておく（なくてもOKだが安定）
    await FS.setDoc(answersRef(qKey), {}, { merge: true });

    alert(`Q${qid} 回答開始（10秒）`);
  }

  async function admin_showVotes(qid) {
    const st = await getRoomState();
    if (!st || st.currentQuestion !== qid || !st.questionKey) {
      alert("まず同じQの「選択肢表示＆回答開始」を押してください（questionKeyがありません）");
      return;
    }

    const q = await fetchQuestion(qid);
    const optionCount = (q.options || []).length;

    const data = await loadAnswers(st.questionKey);
    const counts = {};
    for (let i = 1; i <= optionCount; i++) counts[i] = 0;

    for (const pid in data) {
      const a = normalizeAnswerValue(data[pid]);
      if (a.option && counts[a.option] !== undefined) counts[a.option]++;
    }

    await setRoomState({
      ...st,
      phase: "votes",
      votes: counts,
    });

    alert("投票数を表示しました");
  }

  async function admin_reveal(qid, correctIndex) {
    const st = await getRoomState();
    if (!st || st.currentQuestion !== qid || !st.questionKey) {
      alert("まず同じQの「選択肢表示＆回答開始」を押してください");
      return;
    }

    // 回答を読む
    const ans = await loadAnswers(st.questionKey);

    // プレイヤーを読む
    const psnap = await FS.getDocs(playersCol());
    const players = [];
    psnap.forEach((d) => {
      const p = d.data() || {};
      players.push({ pid: d.id, name: p.name || d.id, score: p.score || 0 });
    });

    // 正解者＋タイム
    const correctList = [];
    for (const p of players) {
      const a = normalizeAnswerValue(ans[p.pid]);
      if (a.option === correctIndex && a.answeredAtMs != null) {
        correctList.push({
          pid: p.pid,
          name: p.name,
          answeredAtMs: a.answeredAtMs,
        });
      }
    }
    correctList.sort((a, b) => a.answeredAtMs - b.answeredAtMs);

    // 点数加算
    // - 正解者全員 +10
    // - 早押し上位3名 追加 (1位+5, 2位+3, 3位+1)
    const bonus = [5, 3, 1];
    const addMap = new Map(); // pid -> add

    for (const p of players) addMap.set(p.pid, 0);

    for (const c of correctList) {
      addMap.set(c.pid, (addMap.get(c.pid) || 0) + 10);
    }
    correctList.slice(0, 3).forEach((c, idx) => {
      addMap.set(c.pid, (addMap.get(c.pid) || 0) + bonus[idx]);
    });

    // 更新
    for (const p of players) {
      const add = addMap.get(p.pid) || 0;
      if (add !== 0) {
        await FS.updateDoc(playerRef(p.pid), { score: (p.score || 0) + add });
      }
    }

    await setRoomState({
      ...st,
      phase: "result",
      correct: correctIndex,
    });

    alert("正解発表（スコア加算）しました");
  }

  async function admin_showRanking(qid, correctIndex) {
    const st = await getRoomState();
    if (!st || st.currentQuestion !== qid || !st.questionKey || !st.questionStartMs) {
      alert("まず同じQの「選択肢表示＆回答開始」を押してください");
      return;
    }

    const ans = await loadAnswers(st.questionKey);

    const psnap = await FS.getDocs(playersCol());
    const players = [];
    psnap.forEach((d) => {
      const p = d.data() || {};
      players.push({ pid: d.id, name: p.name || d.id });
    });

    const correctList = [];
    for (const p of players) {
      const a = normalizeAnswerValue(ans[p.pid]);
      if (a.option === correctIndex && a.answeredAtMs != null) {
        const timeSec = (a.answeredAtMs - st.questionStartMs) / 1000;
        correctList.push({ pid: p.pid, name: p.name, timeSec });
      }
    }

    correctList.sort((a, b) => a.timeSec - b.timeSec);
    const ranking = correctList.slice(0, 10).map((x, i) => ({
      rank: i + 1,
      name: x.name,
      timeSec: Number(x.timeSec.toFixed(2)),
    }));

    await setRoomState({
      ...st,
      phase: "ranking",
      correct: correctIndex,
      ranking,
    });

    alert("正解者ランキングを表示しました");
  }

  async function admin_showFinalRanking() {
    const psnap = await FS.getDocs(playersCol());
    const players = [];
    psnap.forEach((d) => {
      const p = d.data() || {};
      players.push({ pid: d.id, name: p.name || d.id, score: p.score || 0 });
    });

    players.sort((a, b) => (b.score || 0) - (a.score || 0));

    const finalRanking = players.map((p, i) => ({
      rank: i + 1,
      name: p.name,
      score: p.score || 0,
    }));

    await setRoomState({
      phase: "final",
      currentQuestion: null,
      questionKey: null,
      questionStartMs: null,
      deadlineMs: null,
      votes: null,
      correct: null,
      ranking: null,
      finalRanking,
      finalKey: String(nowMs()), // token
    });

    alert("最終結果ランキングを表示しました");
  }

  /* ======================================================
     起動
  ====================================================== */
  window.addEventListener("load", async () => {
    const ok = await waitForFirebaseReady();
    if (!ok) return;

    initAdminPage();
    initIndexPage();
    initQuestionPage();
  });
})();



















