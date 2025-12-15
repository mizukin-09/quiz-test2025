/* ======================================================
   script.js（安定版）
   - Index(参加者): 回答ボタンのみ表示（投票数は出さない）
   - Question(画面共有): 問題/投票数/正解/ランキング/最終結果を表示
   - Admin(管理): ボタンで state を切り替える
   - ランキング表示は「下位→上位で下から積み上げ」
   - join で score を 0 に戻さない（←最終結果0点の原因を修正）
====================================================== */

(() => {
  const ROOM_ID = "roomA";
  const ANSWER_LIMIT_SEC = 10;     // 回答制限 10 秒
  const RANK_ANIM_INTERVAL = 1000; // ランキング積み上げ 1秒ごと

  let db = null;
  let FS = null;

  // 参加者情報（Indexで使用）
  let playerId = localStorage.getItem("playerId");
  let playerName = localStorage.getItem("playerName");

  // 監視解除
  let unsubRoom = null;

  // タイマー
  let questionTimerInterval = null;
  let rankAnimTimer = null;

  // ============ 共通ユーティリティ ============
  function makeId(len = 12) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function clearIntervalSafe(id) {
    if (id) clearInterval(id);
  }

  function clearTimeoutSafe(id) {
    if (id) clearTimeout(id);
  }

  function stopAllTimers() {
    clearIntervalSafe(questionTimerInterval);
    questionTimerInterval = null;
    clearTimeoutSafe(rankAnimTimer);
    rankAnimTimer = null;
  }

  function fmtSec(ms) {
    const s = ms / 1000;
    return s.toFixed(2); // 2.56 形式
  }

  function isIndexPage() {
    return !!document.getElementById("joinBtn") && !!document.getElementById("choices");
  }
  function isQuestionPage() {
    return !!document.getElementById("screen") && !!document.getElementById("screenChoices");
  }
  function isAdminPage() {
    return !!document.getElementById("adminPanel");
  }

  async function waitFirebaseReady() {
    // HTML 側の module script が window に注入するまで待つ
    for (let i = 0; i < 200; i++) {
      if (window.firebaseDB && window.firebaseFirestoreFuncs) {
        db = window.firebaseDB;
        FS = window.firebaseFirestoreFuncs;
        return;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    alert("Firebase の初期化が完了していません。ページを再読み込みしてください。");
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

  async function getRoomState() {
    const snap = await FS.getDoc(roomRef());
    if (!snap.exists()) return null;
    return snap.data().state || null;
  }

  // ============ Index(参加者) UI ============
  function idxEls() {
    return {
      joinArea: document.getElementById("joinArea"),
      nameInput: document.getElementById("nameInput"),
      joinBtn: document.getElementById("joinBtn"),
      waitingArea: document.getElementById("waitingArea"),
      choices: document.getElementById("choices"),
    };
  }

  function idxSetWaiting(text, showChoices = false) {
    const el = idxEls();
    if (!el.waitingArea) return;
    el.waitingArea.style.display = "block";
    el.waitingArea.textContent = text || "";
    if (!showChoices && el.choices) el.choices.innerHTML = "";
  }

  function idxRenderChoices(options, enabled) {
    const el = idxEls();
    if (!el.choices) return;

    el.choices.innerHTML = "";
    options.forEach((opt, idx) => {
      const b = document.createElement("button");
      b.className = "choiceBtn";
      b.textContent = `${idx + 1}. ${opt}`;
      b.style.display = "block";
      b.style.width = "100%";
      b.style.padding = "14px";
      b.style.margin = "10px 0";
      b.style.fontSize = "18px";
      b.style.borderRadius = "10px";
      b.style.border = "2px solid #333";
      b.style.background = "#fff";

      b.disabled = !enabled;
      b.onclick = () => answer(idx + 1);

      el.choices.appendChild(b);
    });
  }

  function idxHighlightMyChoice(optIdx) {
    document.querySelectorAll(".choiceBtn").forEach((btn, idx) => {
      const n = idx + 1;
      if (n === optIdx) {
        btn.style.border = "4px solid #1e66ff";
        btn.style.background = "#eaf2ff";
        btn.style.opacity = "1";
      } else {
        btn.style.opacity = "0.35";
      }
    });
  }

  // ======= joinGame（scoreを0で上書きしない修正版）=======
  async function joinGame() {
    if (!FS) {
      alert("Firestore の準備中です。数秒待って再度お試しください。");
      return;
    }

    const el = idxEls();
    const name = (el.nameInput?.value || "").trim();
    if (!name) return alert("ニックネームを入力してください");

    if (!playerId) {
      playerId = makeId();
      localStorage.setItem("playerId", playerId);
    }
    playerName = name;
    localStorage.setItem("playerName", name);

    // ★ここが重要：既存プレイヤーなら score を絶対に 0 で上書きしない
    const pRef = playerRef(playerId);
    const pSnap = await FS.getDoc(pRef);

    if (!pSnap.exists()) {
      await FS.setDoc(pRef, {
        name,
        score: 0,
        joinedAt: Date.now(),
      });
    } else {
      await FS.setDoc(pRef, { name }, { merge: true });
    }

    // UI
    if (el.joinArea) el.joinArea.style.display = "none";
    idxSetWaiting("司会の合図があるまでお待ちください…", false);

    // state監視開始
    listenRoom();
  }

  // ======= 回答送信 =======
  async function answer(optIdx) {
    if (!playerId) return alert("まず参加してください");

    // state を確認して締切後なら送らない
    const st = await getRoomState();
    if (!st || st.phase !== "question") return;

    const now = Date.now();
    if (st.deadline && now > st.deadline) {
      idxSetWaiting("時間切れです（投票できません）", false);
      return;
    }

    // 自分の選択を見える化
    idxHighlightMyChoice(optIdx);

    const qid = st.currentQuestion;
    if (!qid) return;

    // answers/{qid} に pid: {opt, t} を保存
    await FS.setDoc(
      answersRef(qid),
      { [playerId]: { opt: optIdx, t: now } },
      { merge: true }
    );

    // 押せないように
    document.querySelectorAll(".choiceBtn").forEach(b => (b.disabled = true));
  }

  // ============ Question(画面共有) UI ============
  function qEls() {
    return {
      screen: document.getElementById("screen"),
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
    if (!el.screen) return;

    stopAllTimers();

    if (el.screenQuestionText) el.screenQuestionText.style.display = "none";
    if (el.screenTimer) el.screenTimer.style.display = "none";
    if (el.screenImage) {
      el.screenImage.style.display = "none";
      el.screenImage.src = "";
    }
    if (el.screenChoices) {
      el.screenChoices.style.display = "none";
      el.screenChoices.innerHTML = "";
    }
    if (el.screenRanking) {
      el.screenRanking.style.display = "none";
    }
    if (el.rankingTitle) el.rankingTitle.textContent = "";
    if (el.rankingList) el.rankingList.innerHTML = "";
  }

  async function qLoadQuestion(qid) {
    const snap = await FS.getDoc(questionRef(qid));
    if (!snap.exists()) return null;
    return snap.data();
  }

  function qRenderIntro(q) {
    const el = qEls();
    qHideAll();

    // 問題文のみ表示
    el.screenQuestionText.style.display = "block";
    el.screenQuestionText.textContent = q?.text || "";

    // 画像がある場合は表示（question画面のみ）
    if (q?.imageUrl) {
      el.screenImage.style.display = "block";
      el.screenImage.src = q.imageUrl;
    }
  }

  function qRenderQuestion(q, st) {
    const el = qEls();
    qHideAll();

    el.screenQuestionText.style.display = "block";
    el.screenQuestionText.textContent = q?.text || "";

    // タイマー表示
    el.screenTimer.style.display = "block";

    // 画像
    if (q?.imageUrl) {
      el.screenImage.style.display = "block";
      el.screenImage.src = q.imageUrl;
    }

    // 選択肢表示
    el.screenChoices.style.display = "block";
    el.screenChoices.innerHTML = "";
    (q.options || []).forEach((opt, idx) => {
      const div = document.createElement("div");
      div.className = "screenChoice";
      div.dataset.idx = String(idx + 1);
      div.textContent = `${idx + 1}. ${opt}`;
      el.screenChoices.appendChild(div);
    });

    // カウントダウン
    stopAllTimers();
    questionTimerInterval = setInterval(() => {
      const now = Date.now();
      const remainMs = Math.max(0, (st.deadline || 0) - now);
      const remainSec = Math.ceil(remainMs / 1000);
      el.screenTimer.textContent = `残り ${remainSec} 秒`;

      if (remainMs <= 0) {
        clearIntervalSafe(questionTimerInterval);
        questionTimerInterval = null;
        el.screenTimer.textContent = `時間切れ`;
      }
    }, 100);
  }

  function qRenderVotes(q, votes) {
    const el = qEls();
    // 問題と選択肢が表示されている前提で上書き
    const items = el.screenChoices?.querySelectorAll(".screenChoice") || [];
    items.forEach((node, idx) => {
      const n = idx + 1;
      const v = (votes && typeof votes[n] === "number") ? votes[n] : 0;
      const base = (q.options && q.options[idx]) ? q.options[idx] : "";
      node.textContent = `${n}. ${base}（${v}票）`;
    });
  }

  function qRenderResult(q, correct) {
    const el = qEls();
    const items = el.screenChoices?.querySelectorAll(".screenChoice") || [];
    items.forEach((node, idx) => {
      const n = idx + 1;
      if (n === correct) {
        node.style.border = "4px solid #ff2b2b";
        node.style.background = "rgba(255, 230, 230, 0.95)";
        node.style.opacity = "1";
      } else {
        // ★正解以外は薄く
        node.style.opacity = "0.18";
      }
    });
  }

  // ===== ランキング（下位→上位で下から積み上げ表示）=====
  function qStartRankingAnimation(title, entries, type) {
    // entries は「順位順（1位→…）」で来る想定
    // 表示は「下位→上位」を1秒ごとに積み上げたいので、逆順で追加
    const el = qEls();
    qHideAll();

    el.screenRanking.style.display = "flex";
    el.rankingTitle.textContent = title || "";

    const list = el.rankingList;
    list.innerHTML = "";

    stopAllTimers();

    const itemsBottomFirst = (entries || []).slice().reverse(); // 下位→上位
    let i = 0;

    const step = () => {
      if (i >= itemsBottomFirst.length) return;

      const e = itemsBottomFirst[i];

      const div = document.createElement("div");
      div.className = "rankItem";

      if (type === "time") {
        div.textContent = `${e.rank}位：${e.name}（${fmtSec(e.timeMs)}秒）`;
      } else {
        div.textContent = `${e.rank}位：${e.name}（${e.score}点）`;
      }

      // ★CSSが column-reverse なので append で「下から積み上げ」になる
      list.appendChild(div);

      i++;
      rankAnimTimer = setTimeout(step, RANK_ANIM_INTERVAL);
    };

    step();
  }

  // ============ Firestore state監視（各ページ共通） ============
  function listenRoom() {
    if (unsubRoom) unsubRoom();
    unsubRoom = FS.onSnapshot(roomRef(), async (snap) => {
      if (!snap.exists()) return;

      const data = snap.data() || {};
      const st = data.state || { phase: "idle" };

      // Index(参加者)
      if (isIndexPage()) {
        await handleIndexState(st);
      }

      // Question(画面共有)
      if (isQuestionPage()) {
        await handleQuestionState(st);
      }
    });
  }

  // ---------- Index state ----------
  async function handleIndexState(st) {
    const el = idxEls();
    if (!el.waitingArea) return;

    // join前は何もしない（joinで listener 開始）
    // join後は phase に合わせてボタン表示/非表示
    if (st.phase === "question") {
      const q = await qLoadQuestion(st.currentQuestion);
      const now = Date.now();
      const enabled = !!st.deadline && now <= st.deadline;

      idxSetWaiting("", true);
      idxRenderChoices(q?.options || [], enabled);

      // 期限が過ぎたら自動で押せなくする
      if (st.deadline) {
        const remain = Math.max(0, st.deadline - now);
        setTimeout(() => {
          document.querySelectorAll(".choiceBtn").forEach(b => (b.disabled = true));
        }, remain + 50);
      }

      return;
    }

    // それ以外のフェーズでは回答ボタンは出さない（投票数も出さない）
    if (st.phase === "intro") {
      idxSetWaiting("司会の合図を待っています…", false);
      return;
    }
    if (st.phase === "votes" || st.phase === "result" || st.phase === "ranking") {
      idxSetWaiting("集計中…", false);
      return;
    }
    if (st.phase === "final") {
      idxSetWaiting("最終結果発表中…", false);
      return;
    }

    // idle など
    idxSetWaiting("司会の合図があるまでお待ちください…", false);
  }

  // ---------- Question state ----------
  async function handleQuestionState(st) {
    // 待機：背景のみ（何も出さない）
    if (!st || st.phase === "idle") {
      qHideAll();
      return;
    }

    const qid = st.currentQuestion;
    const q = qid ? await qLoadQuestion(qid) : null;

    if (st.phase === "intro") {
      qRenderIntro(q);
      return;
    }

    if (st.phase === "question") {
      qRenderQuestion(q, st);
      return;
    }

    if (st.phase === "votes") {
      // まず問題状態を描画してから票数反映
      qRenderQuestion(q, st);
      qRenderVotes(q, st.votes);
      return;
    }

    if (st.phase === "result") {
      qRenderQuestion(q, st);
      qRenderResult(q, st.correct);
      return;
    }

    if (st.phase === "ranking") {
      // 正解者ランキング（上位10名）を「下位→上位で積み上げ」
      // st.ranking: [{rank,name,timeMs}, ...] rank=1が最速
      qStartRankingAnimation("正解者ランキング（上位10名）", st.ranking || [], "time");
      return;
    }

    if (st.phase === "final") {
      // 最終結果ランキング（全員）を「下位→上位で積み上げ」
      qStartRankingAnimation("最終結果ランキング", st.finalRanking || [], "score");
      return;
    }
  }

  // ============ Admin(管理) functions ============
  async function admin_resetScreen() {
    await FS.setDoc(roomRef(), { state: { phase: "idle" } }, { merge: true });
  }

  async function admin_showIntro(qid) {
    await FS.setDoc(roomRef(), {
      state: {
        phase: "intro",
        currentQuestion: qid
      }
    }, { merge: true });
  }

  async function admin_startQuestion(qid) {
    const startAt = Date.now();
    const deadline = startAt + ANSWER_LIMIT_SEC * 1000;

    // ★前回の回答を消す（上書きで空にする）
    await FS.setDoc(answersRef(qid), {});

    await FS.setDoc(roomRef(), {
      state: {
        phase: "question",
        currentQuestion: qid,
        startAt,
        deadline
      }
    }, { merge: true });
  }

  async function admin_showVotes(qid) {
    const q = await qLoadQuestion(qid);
    const numOpt = (q?.options || []).length || 4;

    const aSnap = await FS.getDoc(answersRef(qid));
    const ans = aSnap.exists() ? aSnap.data() : {};

    const votes = {};
    for (let i = 1; i <= numOpt; i++) votes[i] = 0;

    for (const pid in ans) {
      const v = ans[pid];
      const opt = (v && typeof v.opt === "number") ? v.opt : null;
      if (opt && votes[opt] !== undefined) votes[opt]++;
    }

    await FS.setDoc(roomRef(), {
      state: {
        phase: "votes",
        currentQuestion: qid,
        votes
      }
    }, { merge: true });
  }

  async function admin_reveal(qid, correct) {
    await FS.setDoc(roomRef(), {
      state: {
        phase: "result",
        currentQuestion: qid,
        correct
      }
    }, { merge: true });
  }

  // ★採点は「ランキング表示ボタン」を押した時に 1回だけ行う
  async function admin_showRanking(qid, correct) {
    const rRef = roomRef();
    const roomSnap = await FS.getDoc(rRef);
    const roomData = roomSnap.exists() ? roomSnap.data() : {};
    const scoreLog = roomData.scoreLog || {};
    const alreadyScored = !!scoreLog[String(qid)];

    const st = (roomData.state || {});
    const startAt = st.startAt || Date.now();

    const q = await qLoadQuestion(qid);
    const aSnap = await FS.getDoc(answersRef(qid));
    const ans = aSnap.exists() ? aSnap.data() : {};

    // players 取得（名前と現在スコア）
    const pSnap = await FS.getDocs(FS.collection(db, "rooms", ROOM_ID, "players"));
    const players = {}; // pid -> {name, score}
    pSnap.forEach(docSnap => {
      players[docSnap.id] = {
        name: docSnap.data().name || docSnap.id,
        score: typeof docSnap.data().score === "number" ? docSnap.data().score : 0
      };
    });

    // 正解者（pid, timeMs）
    const correctList = [];
    for (const pid in ans) {
      const v = ans[pid];
      const opt = (v && typeof v.opt === "number") ? v.opt : null;
      const t = (v && typeof v.t === "number") ? v.t : null;
      if (!opt || !t) continue;
      if (opt === correct) {
        correctList.push({
          pid,
          name: players[pid]?.name || pid,
          timeMs: Math.max(0, t - startAt)
        });
      }
    }

    // 早い順に並べる（最速=1位）
    correctList.sort((a, b) => a.timeMs - b.timeMs);

    // 上位10名（表示用）
    const top10 = correctList.slice(0, 10).map((e, i) => ({
      rank: i + 1,
      name: e.name,
      timeMs: e.timeMs,
      pid: e.pid
    }));

    // ---- 採点（まだなら実施）----
    if (!alreadyScored) {
      // 全正解者 +10
      correctList.forEach(e => {
        if (players[e.pid]) players[e.pid].score += 10;
      });

      // 早押し上位3名 追加（1位+5, 2位+3, 3位+1）
      const bonus = [5, 3, 1];
      for (let i = 0; i < Math.min(3, correctList.length); i++) {
        const pid = correctList[i].pid;
        if (players[pid]) players[pid].score += bonus[i];
      }

      // 書き戻し
      for (const pid in players) {
        await FS.setDoc(playerRef(pid), { score: players[pid].score }, { merge: true });
      }

      // 「この問題は採点済み」フラグ
      await FS.setDoc(rRef, { scoreLog: { [String(qid)]: true } }, { merge: true });
    }

    // ランキング表示（画面共有）
    await FS.setDoc(rRef, {
      state: {
        phase: "ranking",
        currentQuestion: qid,
        ranking: top10.map(x => ({ rank: x.rank, name: x.name, timeMs: x.timeMs }))
      }
    }, { merge: true });
  }

  async function admin_showFinalRanking() {
    // players 全取得 → score 降順で順位付け
    const pSnap = await FS.getDocs(FS.collection(db, "rooms", ROOM_ID, "players"));
    const arr = [];
    pSnap.forEach(docSnap => {
      arr.push({
        pid: docSnap.id,
        name: docSnap.data().name || docSnap.id,
        score: typeof docSnap.data().score === "number" ? docSnap.data().score : 0
      });
    });

    // 高得点が上位（1位）
    arr.sort((a, b) => b.score - a.score);

    const finalRanking = arr.map((e, i) => ({
      rank: i + 1,
      name: e.name,
      score: e.score
    }));

    await FS.setDoc(roomRef(), {
      state: {
        phase: "final",
        finalRanking
      }
    }, { merge: true });
  }

  // ============ グローバル公開（onclick 用） ============
  window.joinGame = joinGame;

  window.admin_resetScreen = admin_resetScreen;
  window.admin_showIntro = admin_showIntro;
  window.admin_startQuestion = admin_startQuestion;
  window.admin_showVotes = admin_showVotes;
  window.admin_reveal = admin_reveal;
  window.admin_showRanking = admin_showRanking;
  window.admin_showFinalRanking = admin_showFinalRanking;

  // ============ 初期化 ============
  window.addEventListener("load", async () => {
    await waitFirebaseReady();

    // indexの入力に名前を戻す
    if (isIndexPage()) {
      const el = idxEls();
      if (playerName && el.nameInput) el.nameInput.value = playerName;
    }

    // questionは常に state監視
    if (isQuestionPage()) {
      listenRoom();
    }

    // adminも state監視が必要ならここ（基本不要だが、付けてもOK）
    if (isAdminPage()) {
      // 何もしなくてもボタン押下で動く
    }
  });
})();



















