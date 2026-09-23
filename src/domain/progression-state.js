(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const {
    ROUTES, getEnemy, ENCYCLOPEDIA_ENEMIES, getStage, SPECIAL_STAGE,
    STAGES_PER_ROUTE, SLOT_UNLOCKS, INITIAL_SLOT_COUNT, ROUTE_UNLOCKS,
  } = ns;

  // 進行。Phase 04 の BattleResult を受けて、通常/裏/神のStage、ルート解放、
  // 装備枠、エンディングフラグ、敵ごとのカウンタを動かす（ロジック仕様書 10）。
  // 仕様書 20 の ProgressionService にあたる層。
  //
  // 画面もセーブも触らない。ダイヤも宝箱も図鑑報酬も扱わない（Phase 06）。
  // 「何が起きたか」は events として返すだけで、見せ方は Phase 09以降。
  //
  // HOMEへ戻る・アプリを中断する、では何も起きない。Stageが1へ戻るのは
  // **敗北** と **Stage10クリア後の新しい周回** の2つだけ。

  // 起きたことの種類。UI・記録・報酬がこれを見て動く。
  const EVENTS = Object.freeze({
    ENEMY_FIRST_KILL: "ENEMY_FIRST_KILL", // その敵を初めて倒した
    STAGE_ADVANCED: "STAGE_ADVANCED", // 次のStageへ
    ROUTE_RESET: "ROUTE_RESET", // そのルートがStage1へ戻った（敗北 or クリア）
    ROUTE_CLEARED: "ROUTE_CLEARED", // Stage10を初めて撃破した
    ROUTE_UNLOCKED: "ROUTE_UNLOCKED", // 裏 / 神が解放された
    SLOT_UNLOCKED: "SLOT_UNLOCKED", // 装備枠が増えた
    ENDING_UNLOCKED: "ENDING_UNLOCKED", // ED到達（初回のみ）
    TRUE_CLEAR: "TRUE_CLEAR", // 神初撃破
    RECORD_SNAPSHOT_REQUESTED: "RECORD_SNAPSHOT_REQUESTED", // 記録のスナップショット（仕様書 14）
    RUN_STARTED: "RUN_STARTED", // 周回の開始（死神との契約の境界）
    RUN_ENDED: "RUN_ENDED", // 周回の終了
    GOD_RETRY_AVAILABLE: "GOD_RETRY_AVAILABLE", // 神に負けた。裏へ戻さず直接再挑戦できる
  });

  const ENDINGS = Object.freeze({ NORMAL: "NORMAL", TRUE: "TRUE" });
  const RUN_END_REASONS = Object.freeze({ DEFEAT: "DEFEAT", CLEARED: "CLEARED" });

  // 周回を持つのは通常と裏だけ。神戦は裏周回に含めない（D2）。
  const RUN_ROUTES = Object.freeze([ROUTES.NORMAL, ROUTES.BACK]);

  const ENCYCLOPEDIA_TOTAL = ENCYCLOPEDIA_ENEMIES.length;

  function emptyRun() {
    return { id: 0, active: false, earnedBattleDiamonds: 0 };
  }

  // 保存する中身。ここに無いもの（クリア済み・解放済み・装備枠の下限）は
  // 初撃破の集合から**毎回導く**。フラグを別に持つと、二重付与や取り違えが起きるため。
  function createState(overrides = {}) {
    const base = {
      currentNormalStage: 1,
      currentBackStage: 1,
      // 初めて倒した敵のID。ルート解放・装備枠・図鑑20体の判定はすべてここから出す。
      firstKillEnemyIds: [],
      // 解放済みの枠は敗北でも戻らないので、単調増加の下限として持っておく。
      unlockedSlotCount: INITIAL_SLOT_COUNT,
      // 敵ごとの状態（仕様書 07）。撃破でリセットするのは対象の敵のぶんだけ。
      sameEnemyLossCounts: {},
      sameEnemyAttemptCounts: {},
      previousMissMasks: {},
      // 戦闘をまたぐ状態（仕様書 07）。
      lastLostEnemyId: null,
      previousBattle: null,
      fiveTurnWinChain: 0,
      // ED はまだ見せていないか。見せたら consumeEnding() で降ろす（表示は Phase 09）。
      normalEndingPending: false,
      trueEndingPending: false,
      // 周回の境界。ダイヤを積むのは Phase 06 で、ここは境界だけを持つ（D2）。
      runs: { [ROUTES.NORMAL]: emptyRun(), [ROUTES.BACK]: emptyRun() },
    };
    const state = Object.assign(base, overrides);
    return normalizeState(state);
  }

  // 配列・辞書はコピーして持つ。外から渡されたものを共有しない。
  function normalizeState(state) {
    return {
      currentNormalStage: state.currentNormalStage,
      currentBackStage: state.currentBackStage,
      firstKillEnemyIds: state.firstKillEnemyIds.slice(),
      unlockedSlotCount: state.unlockedSlotCount,
      sameEnemyLossCounts: Object.assign({}, state.sameEnemyLossCounts),
      sameEnemyAttemptCounts: Object.assign({}, state.sameEnemyAttemptCounts),
      previousMissMasks: Object.assign({}, state.previousMissMasks),
      lastLostEnemyId: state.lastLostEnemyId,
      previousBattle: state.previousBattle,
      fiveTurnWinChain: state.fiveTurnWinChain,
      normalEndingPending: state.normalEndingPending,
      trueEndingPending: state.trueEndingPending,
      runs: {
        [ROUTES.NORMAL]: Object.assign(emptyRun(), state.runs[ROUTES.NORMAL]),
        [ROUTES.BACK]: Object.assign(emptyRun(), state.runs[ROUTES.BACK]),
      },
    };
  }

  function lastStageEnemyId(route) {
    return getStage(route, STAGES_PER_ROUTE).enemyId;
  }

  class ProgressionState {
    constructor(initialState = {}) {
      this.state = createState(initialState);
      // 解放済みの枠は減らない。保存値が初撃破から導ける枠数より小さければ引き上げる
      //（壊れたセーブや古いセーブで枠が減らないようにする）。
      this.state.unlockedSlotCount = Math.max(
        this.state.unlockedSlotCount, this.slotCountFromFirstKills(),
      );
      this.pendingEvents = [];
    }

    // --- 導出（初撃破の集合から毎回作る） ------------------------------------

    hasFirstKill(enemyId) {
      return this.state.firstKillEnemyIds.includes(enemyId);
    }

    // 図鑑に載る20体のうち何体倒したか。神は図鑑に入らないので数えない。
    getEncyclopediaFirstKillCount() {
      return ENCYCLOPEDIA_ENEMIES.filter((enemy) => this.hasFirstKill(enemy.id)).length;
    }

    // 通常10を初めて倒したか＝通常クリア済み＝裏解放。
    isRouteCleared(route) {
      if (route === ROUTES.SPECIAL) return this.hasFirstKill(SPECIAL_STAGE.enemyId);
      return this.hasFirstKill(lastStageEnemyId(route));
    }

    isRouteUnlocked(route) {
      const rule = ROUTE_UNLOCKS[route];
      if (!rule) throw new Error(`unknown route: ${route}`);
      if (rule.requirement === "none") return true;
      if (rule.requirement === "firstKill") return this.hasFirstKill(getStage(rule.route, rule.stage).enemyId);
      // 神は図鑑20体完成で解放（仕様書 10）。通常進行では裏10初撃破がその20体目になる。
      if (rule.requirement === "encyclopediaComplete") {
        return this.getEncyclopediaFirstKillCount() >= rule.count;
      }
      throw new Error(`unknown route requirement: ${rule.requirement}`);
    }

    canStartRoute(route) {
      return this.isRouteUnlocked(route);
    }

    // 初撃破の集合から出る装備枠数。解放済みは減らないので、保存値との大きいほうを採る。
    slotCountFromFirstKills() {
      return SLOT_UNLOCKS.reduce((count, unlock) => {
        const enemyId = getStage(unlock.route, unlock.stage).enemyId;
        return this.hasFirstKill(enemyId) ? Math.max(count, unlock.slotCount) : count;
      }, INITIAL_SLOT_COUNT);
    }

    getUnlockedSlotCount() {
      return this.state.unlockedSlotCount;
    }

    // --- 参照 -----------------------------------------------------------------

    // そのルートで次に戦う相手。HOMEから戻っても現在のStageのまま（AC-122 / AC-123）。
    getCurrentEncounter(route) {
      if (!this.canStartRoute(route)) throw new Error(`route is locked: ${route}`);
      const stage = route === ROUTES.SPECIAL
        ? SPECIAL_STAGE
        : getStage(route, route === ROUTES.NORMAL ? this.state.currentNormalStage : this.state.currentBackStage);
      const enemy = getEnemy(stage.enemyId);
      return Object.freeze({
        route,
        stage: stage.number,
        enemyId: stage.enemyId,
        resistance: stage.resistance,
        enemy,
      });
    }

    // 装備効果へ渡す戦闘外の状態（EquipmentEffectEngine.createContext の入力）。
    getBattleContext(enemyId) {
      const state = this.state;
      return Object.freeze({
        enemyId,
        sameEnemyLossCount: state.sameEnemyLossCounts[enemyId] || 0,
        // これから始める1戦を含めた挑戦回数。不死鳥の印は「3回目以降」を見る。
        sameEnemyAttemptCount: (state.sameEnemyAttemptCounts[enemyId] || 0) + 1,
        previousMissMask: Object.freeze((state.previousMissMasks[enemyId] || []).slice()),
        lastLostEnemyId: state.lastLostEnemyId,
        previousBattle: state.previousBattle,
        chainCount: state.fiveTurnWinChain,
      });
    }

    // 保存・表示用の写し。導出値も入れておく（Phase 08 はこれを書き出せばよい）。
    getState() {
      const state = this.state;
      return Object.freeze({
        currentNormalStage: state.currentNormalStage,
        currentBackStage: state.currentBackStage,
        firstKillEnemyIds: Object.freeze(state.firstKillEnemyIds.slice()),
        unlockedSlotCount: state.unlockedSlotCount,
        sameEnemyLossCounts: Object.freeze(Object.assign({}, state.sameEnemyLossCounts)),
        sameEnemyAttemptCounts: Object.freeze(Object.assign({}, state.sameEnemyAttemptCounts)),
        previousMissMasks: Object.freeze(Object.assign({}, state.previousMissMasks)),
        lastLostEnemyId: state.lastLostEnemyId,
        previousBattle: state.previousBattle,
        fiveTurnWinChain: state.fiveTurnWinChain,
        normalEndingPending: state.normalEndingPending,
        trueEndingPending: state.trueEndingPending,
        runs: Object.freeze({
          [ROUTES.NORMAL]: Object.freeze(Object.assign({}, state.runs[ROUTES.NORMAL])),
          [ROUTES.BACK]: Object.freeze(Object.assign({}, state.runs[ROUTES.BACK])),
        }),
        // ここから下は初撃破の集合から導いたもの。保存しても読み直しても同じ値になる。
        normalUnlocked: true,
        normalCleared: this.isRouteCleared(ROUTES.NORMAL),
        backUnlocked: this.isRouteUnlocked(ROUTES.BACK),
        backCleared: this.isRouteCleared(ROUTES.BACK),
        godUnlocked: this.isRouteUnlocked(ROUTES.SPECIAL),
        godCleared: this.isRouteCleared(ROUTES.SPECIAL),
        trueClear: this.isRouteCleared(ROUTES.SPECIAL),
        encyclopediaFirstKillCount: this.getEncyclopediaFirstKillCount(),
        encyclopediaTotal: ENCYCLOPEDIA_TOTAL,
      });
    }

    getPendingEvents() {
      return Object.freeze(this.pendingEvents.slice());
    }

    // 受け取った側が処理し終えたら降ろす。
    consumePendingEvents() {
      const events = Object.freeze(this.pendingEvents.slice());
      this.pendingEvents = [];
      return events;
    }

    // EDを見せ終えたら降ろす（表示自体は Phase 09）。
    consumeEnding(ending) {
      if (ending === ENDINGS.NORMAL) this.state.normalEndingPending = false;
      else if (ending === ENDINGS.TRUE) this.state.trueEndingPending = false;
      else throw new Error(`unknown ending: ${ending}`);
      return this.getState();
    }

    // --- 戦闘結果の反映 --------------------------------------------------------

    applyBattleResult(battleResult) {
      if (!battleResult || typeof battleResult.enemyId !== "string") {
        throw new TypeError("applyBattleResult には enemyId を持つ BattleResult が要る");
      }
      const enemy = getEnemy(battleResult.enemyId);
      const won = battleResult.result === "WIN";
      const route = enemy.route;
      const stage = enemy.stage;
      const events = [];
      const add = (type, payload) => events.push(Object.freeze(Object.assign({ type }, payload)));

      // 周回の開始。Stage1に入った時点から「その周回」が始まる（D2）。
      if (RUN_ROUTES.includes(route) && stage === 1 && !this.state.runs[route].active) {
        this.startRun(route, add);
      }

      // 初撃破。ルート解放・装備枠・図鑑20体はすべてここから導かれる。
      const firstKill = won && !this.hasFirstKill(enemy.id);
      if (firstKill) {
        this.state.firstKillEnemyIds = this.state.firstKillEnemyIds.concat(enemy.id);
        add(EVENTS.ENEMY_FIRST_KILL, { enemyId: enemy.id, route, stage });
      }

      this.applyStageTransition({ route, stage, won, add });
      this.applyUnlocks({ route, stage, won, firstKill, add });
      this.applyNextContext(battleResult, enemy);

      // 周回の終了。敗北、またはStage10クリアで閉じる（D2）。
      if (RUN_ROUTES.includes(route)) {
        if (!won) this.endRun(route, RUN_END_REASONS.DEFEAT, add);
        else if (stage === STAGES_PER_ROUTE) this.endRun(route, RUN_END_REASONS.CLEARED, add);
      }

      this.pendingEvents = this.pendingEvents.concat(events);
      return Object.freeze({ state: this.getState(), events: Object.freeze(events) });
    }

    // Stageの移動だけ。解放や報酬はここに混ぜない。
    applyStageTransition({ route, stage, won, add }) {
      if (route === ROUTES.SPECIAL) {
        // 神に負けても通常/裏へは戻さない。そのまま再挑戦できる（AC-120）。
        if (!won) add(EVENTS.GOD_RETRY_AVAILABLE, { enemyId: SPECIAL_STAGE.enemyId });
        return;
      }
      const key = route === ROUTES.NORMAL ? "currentNormalStage" : "currentBackStage";
      if (!won) {
        this.state[key] = 1;
        add(EVENTS.ROUTE_RESET, { route, reason: RUN_END_REASONS.DEFEAT, stage: 1 });
        return;
      }
      if (stage < STAGES_PER_ROUTE) {
        this.state[key] = stage + 1;
        add(EVENTS.STAGE_ADVANCED, { route, stage: this.state[key] });
        return;
      }
      // Stage10クリア。以後の周回は1から（仕様書 10）。
      this.state[key] = 1;
      add(EVENTS.ROUTE_RESET, { route, reason: RUN_END_REASONS.CLEARED, stage: 1 });
    }

    // 解放まわり。初撃破のときだけ新しく起きる。再撃破では何も起きない（AC-113 / AC-114）。
    applyUnlocks({ route, stage, won, firstKill, add }) {
      if (!won) return;

      const slotCount = Math.max(this.state.unlockedSlotCount, this.slotCountFromFirstKills());
      if (slotCount > this.state.unlockedSlotCount) {
        this.state.unlockedSlotCount = slotCount;
        add(EVENTS.SLOT_UNLOCKED, { slotCount, route, stage });
      }

      if (!firstKill) return;

      if (route === ROUTES.NORMAL && stage === STAGES_PER_ROUTE) {
        add(EVENTS.ROUTE_CLEARED, { route });
        add(EVENTS.ROUTE_UNLOCKED, { route: ROUTES.BACK });
        // 通常ED「ゲームクリア...？」。初回だけ立てる。
        this.state.normalEndingPending = true;
        add(EVENTS.ENDING_UNLOCKED, { ending: ENDINGS.NORMAL });
        add(EVENTS.RECORD_SNAPSHOT_REQUESTED, { kind: "NORMAL_CLEAR" });
        return;
      }

      if (route === ROUTES.BACK && stage === STAGES_PER_ROUTE) {
        // 裏10クリアではTRUE ENDを出さない。神が解放されるだけ。
        add(EVENTS.ROUTE_CLEARED, { route });
        if (this.isRouteUnlocked(ROUTES.SPECIAL)) {
          add(EVENTS.ROUTE_UNLOCKED, {
            route: ROUTES.SPECIAL,
            encyclopediaFirstKillCount: this.getEncyclopediaFirstKillCount(),
          });
        }
        return;
      }

      if (route === ROUTES.SPECIAL) {
        add(EVENTS.TRUE_CLEAR, { enemyId: SPECIAL_STAGE.enemyId });
        this.state.trueEndingPending = true;
        add(EVENTS.ENDING_UNLOCKED, { ending: ENDINGS.TRUE });
        add(EVENTS.RECORD_SNAPSHOT_REQUESTED, { kind: "TRUE_CLEAR" });
      }
    }

    // BattleResult.next を runtime state へ移す。保存はしない（Phase 08）。
    applyNextContext(battleResult, enemy) {
      const next = battleResult.next;
      if (!next) return;
      const state = this.state;
      const enemyId = enemy.id;
      const won = battleResult.result === "WIN";

      // 直前の戦闘は勝敗にかかわらず上書きする（奇跡の残響・勝者の余韻が見る）。
      state.previousBattle = next.previousBattle;
      state.fiveTurnWinChain = next.chainCount;

      state.sameEnemyLossCounts[enemyId] =
        (state.sameEnemyLossCounts[enemyId] || 0) + (next.sameEnemyLossCountDelta || 0);
      state.sameEnemyAttemptCounts[enemyId] =
        (state.sameEnemyAttemptCounts[enemyId] || 0) + (next.sameEnemyAttemptCountDelta || 0);
      if (next.clearSameEnemyCounters) {
        // 撃破したのはこの敵だけ。他の敵のカウンタには触らない（仕様書 07）。
        state.sameEnemyLossCounts[enemyId] = 0;
        state.sameEnemyAttemptCounts[enemyId] = 0;
      }

      state.previousMissMasks[enemyId] = (next.missMask || []).slice();

      // 前回敗北した敵。他の敵を倒しても消えない。対象の敵を倒したときだけ解除する。
      if (!won) state.lastLostEnemyId = enemyId;
      else if (state.lastLostEnemyId === enemyId) state.lastLostEnemyId = null;
    }

    // --- 周回（死神との契約の境界。ダイヤの出入りは Phase 06） ------------------

    startRun(route, add) {
      const run = this.state.runs[route];
      run.id += 1;
      run.active = true;
      run.earnedBattleDiamonds = 0;
      if (add) add(EVENTS.RUN_STARTED, { route, runId: run.id });
    }

    endRun(route, reason, add) {
      const run = this.state.runs[route];
      if (!run.active) return;
      run.active = false;
      // 貯まっていた額は RUN_ENDED に載せて渡す。没収するかどうかは Phase 06。
      // 値を0へ戻すのは次の周回が始まるとき（startRun）。閉じた直後に0にすると、
      // その最後の1戦の撃破ダイヤを積む先が消えてしまう。
      if (add) add(EVENTS.RUN_ENDED, { route, runId: run.id, reason, earnedBattleDiamonds: run.earnedBattleDiamonds });
    }

    // その周回で敵撃破によって得たダイヤを積む。呼ぶのは RewardService（Phase 06）で、
    // 進行側からは増やさない。図鑑報酬・重複売却はここへ入れない（D2）。
    addRunEarnedBattleDiamonds(route, amount) {
      const run = this.state.runs[route];
      if (!run) return 0;
      if (!Number.isFinite(amount) || amount < 0) {
        throw new TypeError(`積めるのは0以上の有限な数値: ${amount}`);
      }
      run.earnedBattleDiamonds += amount;
      return run.earnedBattleDiamonds;
    }

    getRun(route) {
      const run = this.state.runs[route];
      if (!run) throw new Error(`route has no run: ${route}`);
      return Object.freeze(Object.assign({}, run));
    }
  }

  Object.assign(ns, {
    ProgressionState: Object.assign(ProgressionState, { EVENTS, ENDINGS, RUN_END_REASONS }),
  });
})(globalThis);
