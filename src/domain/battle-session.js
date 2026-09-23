(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { CONSTANTS, BattleCalculator, EquipmentEffectEngine, EquipmentEffectTypes } = ns;
  const { POST_FIVE_MISS_KINDS } = EquipmentEffectTypes;

  // 1戦ぶんの進行。BattleCalculator（Phase 02）と EquipmentEffect（Phase 03）を繋ぎ、
  // 1タップ → 判定 → MISSなら次ターン → 最大5ターン → WIN/LOSE までを持つ。
  //
  // ここは Domain層。画面・DOM・localStorage・SaveData を一切触らない。
  // 敗北回数やRECORDの更新も**しない**。戦闘が終わったら BattleResult を返すので、
  // 進行と保存は Phase 05以降がそれを読んで行う。
  //
  // 1戦だけを担当する。Stage進行・報酬・装備枠解放はここに無い。

  const TURN_COUNT = CONSTANTS.turnsPerBattle;

  // 状態。READY だけが入力を受け付ける。
  const STATES = Object.freeze({
    READY: "READY", // 次のタップを待っている
    RESOLVING: "RESOLVING", // タップを受けて演出・解決の最中
    WIN: "WIN",
    LOSE: "LOSE",
  });

  const OUTCOMES = Object.freeze({ CRITICAL: "CRITICAL", MISS: "MISS" });

  // 入力を弾いた理由。UIがメッセージを出し分けられるように文字列で返す。
  const REJECTIONS = Object.freeze({
    RESOLVING: "RESOLVING", // 解決中の連打
    FINISHED: "FINISHED", // 決着後の入力
    NOT_RESOLVING: "NOT_RESOLVING", // 演出完了の二重呼び出し
  });

  class BattleSession {
    // enemy / loadout / 戦闘をまたぐ context / RandomService を受け取って1戦を開く。
    constructor({ enemy, loadout = {}, context = {}, random } = {}) {
      if (!enemy || !Number.isFinite(enemy.resistance)) {
        throw new TypeError("BattleSession には resistance を持つ enemy が要る");
      }
      if (!random || typeof random.rollPercent !== "function") {
        throw new TypeError("BattleSession には RandomService が要る");
      }
      this.enemy = enemy;
      this.random = random;

      // 壊れたロードアウトでも開けるように、ここで正規化する（同名2つ・未解放枠・範囲外param）。
      const normalized = EquipmentEffectEngine.normalizeLoadout({
        slots: loadout.slots || [],
        params: loadout.params || {},
        unlockedSlotCount: loadout.unlockedSlotCount || CONSTANTS.maxEquipmentSlots,
      });
      this.loadout = normalized;
      this.equippedIds = EquipmentEffectEngine.orderedEquipmentIds(normalized.slots);

      // 「一か八か」等の対象ターンは**ここで1回だけ**引く（ロジック仕様書 18）。
      // 以後どれだけ再計算しても引き直さない。プレビューはこの経路を通らない。
      const battleStart = EquipmentEffectEngine.resolveBattleStart({ slots: normalized.slots, random });
      this.randomTurnSelections = battleStart.randomTurnSelections;
      this.battleStartDraws = battleStart.draws;

      this.effectContext = EquipmentEffectEngine.createContext(Object.assign({}, context, {
        rawResistance: enemy.resistance,
        enemyId: enemy.id === undefined ? null : enemy.id,
        loadoutParams: normalized.params,
        randomTurnSelections: this.randomTurnSelections,
      }));

      // 撃破に必要なCRITICAL数。敵Catalogが持つ値をそのまま使い、
      // 指定が無ければ1（＝これまでどおり1発で倒れる）。
      this.requiredCriticalHits = Number.isInteger(enemy.requiredCriticalHits) && enemy.requiredCriticalHits > 0
        ? enemy.requiredCriticalHits
        : 1;
      // この戦闘で当てたCRITICAL数。**戦闘をまたいで持ち越さない。**
      this.criticalHits = 0;

      this.state = STATES.READY;
      this.currentTurn = 1;
      this.missedTurns = [];
      // 当てたのに倒しきれなかったCRITICALのターン。神だけが積む
      //（通常敵は1発で決着するので常に空のまま）。残りTURNの計算に使う。
      this.survivedCriticalTurns = [];
      this.usedEquipmentIds = [];
      this.extraJudgements = [];
      this.pending = null;
      this.killTurn = null;
      this.killedBy = null;
      this.result = null;
      this.counters = { tap: 0, normalJudgement: 0, extraJudgement: 0, critical: 0, miss: 0 };

      this.path = this.calculatePath();
    }

    // 5ターン率。到達＝手前は全てMISS、の条件付き確率で出す（D5・ロジック仕様書 03）。
    //
    // 戦闘中もこの式のまま使える。CRITICALが出れば戦闘は終わるので、到達したターンの
    // 手前は必ず全てMISSしており、実際のMISS履歴と条件付きの仮定が常に一致するため。
    // バトル前プレビューと実戦の表示が同じ値になるのはこの理由（AC-020）。
    calculatePath() {
      return BattleCalculator.calculateChancePath({
        rawResistance: this.enemy.resistance,
        effects: EquipmentEffectEngine.buildContributions({
          slots: this.loadout.slots,
          context: this.effectContext,
        }),
      });
    }

    get chances() {
      return this.path.chances;
    }

    // 現在ターンのCRITICAL率。決着後は null。
    get currentChance() {
      if (this.isFinished()) return null;
      return this.path.chances[this.currentTurn - 1];
    }

    // 残りターン。追加判定では増減しない（AC-027 / AC-033）。
    // 倒しきれなかったCRITICALもターンを1つ使う（神の1発目）。通常敵では
    // survivedCriticalTurns が常に空なので、これまでと同じ値になる。
    get remainingTurns() {
      return TURN_COUNT - this.missedTurns.length - this.survivedCriticalTurns.length;
    }

    isFinished() {
      return this.state === STATES.WIN || this.state === STATES.LOSE;
    }

    // 入力ロック。UI任せにせずここでも持つ（仕様書 04「多重タップ防止ロック」）。
    get inputLocked() {
      return this.state !== STATES.READY;
    }

    canTap() {
      return this.state === STATES.READY;
    }

    getState() {
      return Object.freeze({
        state: this.state,
        currentTurn: this.isFinished() ? null : this.currentTurn,
        remainingTurns: this.remainingTurns,
        currentChance: this.currentChance,
        chances: this.path.chances,
        missedTurns: Object.freeze(this.missedTurns.slice()),
        criticalHits: this.criticalHits,
        requiredCriticalHits: this.requiredCriticalHits,
        randomTurnSelections: this.randomTurnSelections,
        usedEquipmentIds: Object.freeze(this.usedEquipmentIds.slice()),
        counters: Object.freeze(Object.assign({}, this.counters)),
        inputLocked: this.inputLocked,
      });
    }

    // --- 1タップ ------------------------------------------------------------

    // 入力受付と抽選まで。演出はUI側で走らせ、終わったら completeResolution() を呼ぶ。
    // 弾いたタップでは**乱数を1つも消費しない**（AC-021）。
    tap() {
      if (this.isFinished()) return Object.freeze({ accepted: false, reason: REJECTIONS.FINISHED });
      if (this.state === STATES.RESOLVING) return Object.freeze({ accepted: false, reason: REJECTIONS.RESOLVING });

      const turn = this.currentTurn;
      const chance = this.path.chances[turn - 1];
      // 1タップ＝1判定（ロジック仕様書 04「random[0,100) < currentChance」）。
      const critical = this.random.rollPercent(chance);

      this.counters.tap += 1;
      this.counters.normalJudgement += 1;
      if (critical) this.counters.critical += 1;
      else this.counters.miss += 1;

      this.state = STATES.RESOLVING;
      this.pending = Object.freeze({
        turn,
        chance,
        outcome: critical ? OUTCOMES.CRITICAL : OUTCOMES.MISS,
      });
      return Object.freeze({ accepted: true, resolution: this.pending });
    }

    // 演出が終わった合図。ここでターンを進め、次ターンの率を出し直す。
    // 5回目のMISSならそのまま5MISS後の処理へ入る（初版は自動抽選・AC-034）。
    completeResolution() {
      if (this.state !== STATES.RESOLVING) {
        return Object.freeze({ accepted: false, reason: REJECTIONS.NOT_RESOLVING });
      }
      const resolved = this.pending;
      this.pending = null;

      if (resolved.outcome === OUTCOMES.CRITICAL) {
        this.criticalHits += 1;
        if (this.criticalHits >= this.requiredCriticalHits) {
          // 必要なぶん当てた。ここで勝利し、以降のターン判定は行わない（AC-023）。
          // 通常敵は1発なので、これまでどおり最初のCRITICALで即WIN。
          this.finish(STATES.WIN, { killTurn: resolved.turn, killedBy: null });
          return Object.freeze({ accepted: true, state: this.state, resolution: resolved, extraJudgements: Object.freeze([]) });
        }

        // まだ倒れない（神の1発目）。**CRITICALもターンを1つ使う。**
        // MISSではないので missedTurns へは入れない（記録上もMISSにしない）。
        this.survivedCriticalTurns.push(resolved.turn);

        if (resolved.turn < TURN_COUNT) {
          this.currentTurn = resolved.turn + 1;
          this.path = this.calculatePath();
          this.state = STATES.READY;
          return Object.freeze({ accepted: true, state: this.state, resolution: resolved, extraJudgements: Object.freeze([]) });
        }

        // 5ターン目で当てたが足りない。5ターンすべてMISSではないので
        // 追加判定（第六の奇跡・砂時計）の条件を満たさず、そのまま敗北。
        const extrasAfterCritical = this.resolvePostFiveMiss();
        return Object.freeze({ accepted: true, state: this.state, resolution: resolved, extraJudgements: extrasAfterCritical });
      }

      // MISS。履歴を残してから次ターンへ（CRITICALではここを通らない＝AC-026）。
      this.missedTurns.push(resolved.turn);

      if (resolved.turn < TURN_COUNT) {
        this.currentTurn = resolved.turn + 1;
        // 実際のMISS履歴が1つ増えた状態で装備効果を評価し直す（仕様書 04 手順5）。
        this.path = this.calculatePath();
        this.state = STATES.READY;
        return Object.freeze({ accepted: true, state: this.state, resolution: resolved, extraJudgements: Object.freeze([]) });
      }

      const extras = this.resolvePostFiveMiss();
      return Object.freeze({ accepted: true, state: this.state, resolution: resolved, extraJudgements: extras });
    }

    // タップから演出完了までを一息で。ヘッドレスなテストと自動進行用。
    resolveTap() {
      const tapped = this.tap();
      if (!tapped.accepted) return tapped;
      const completed = this.completeResolution();
      return Object.freeze({
        accepted: true,
        resolution: tapped.resolution,
        state: completed.state,
        extraJudgements: completed.extraJudgements,
      });
    }

    // --- 5MISS後 -------------------------------------------------------------

    // 通常5回がすべてMISSしたあとの追加効果。順序は Phase 03 が返す step 順が正で、
    // ここでは装備名を見て並べ替えない（ロジック仕様書 05：砂時計 → 第六の奇跡 → 敗北）。
    resolvePostFiveMiss() {
      // 決着後は何もしない。二度呼ばれても勝敗を書き換えない。
      if (this.isFinished()) return Object.freeze([]);
      // 追加判定は**通常5ターンがすべてMISS**のときだけ（第六の奇跡・砂時計の既存条件）。
      // 神へ1発当てている戦闘は5MISSではないので、ここを通らずそのまま敗北する。
      // 通常敵はCRITICALで即決着するため、ここへ来る時点で必ず5MISSになっている。
      if (this.missedTurns.length < TURN_COUNT) {
        this.finish(STATES.LOSE, { killTurn: null, killedBy: null });
        return Object.freeze([]);
      }
      const steps = EquipmentEffectEngine.getPostFiveMissPlan({
        slots: this.loadout.slots,
        chances: this.path.chances,
        usedEquipmentIds: this.usedEquipmentIds,
      });

      // 追加判定のログはそのまま this.extraJudgements へ積む。BattleResult が読むので、
      // 決着（finish）より前に入れておく必要がある。戻り値は今回ぶんだけを切り出す。
      const logStart = this.extraJudgements.length;
      const logSinceStart = () => Object.freeze(this.extraJudgements.slice(logStart));

      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        // 1戦1回。使い切ったものは二度と回さない。
        if (!step.available) continue;
        this.usedEquipmentIds.push(step.equipmentId);

        if (step.kind === POST_FIVE_MISS_KINDS.RETRY_TURN) {
          // まず発動するかどうか（砂時計は30%）。ここはCRITICAL判定ではないので記録へ加えない。
          const triggered = this.random.rollPercent(step.triggerChance);
          this.extraJudgements.push(Object.freeze({
            equipmentId: step.equipmentId, kind: step.kind, phase: "TRIGGER",
            chance: step.triggerChance, triggered,
          }));
          if (!triggered) continue;
        }

        // ここからがCRITICAL判定。総タップ数には入れず、CRITICAL/MISSと追加判定数へ入れる（D4）。
        const critical = this.random.rollPercent(step.chance);
        this.counters.extraJudgement += 1;
        if (critical) this.counters.critical += 1;
        else this.counters.miss += 1;
        this.extraJudgements.push(Object.freeze({
          equipmentId: step.equipmentId, kind: step.kind, phase: "JUDGE",
          turn: step.turn, chance: step.chance,
          outcome: critical ? OUTCOMES.CRITICAL : OUTCOMES.MISS,
        }));

        if (critical) {
          this.criticalHits += 1;
          if (this.criticalHits >= this.requiredCriticalHits) {
            // 砂時計はT5をやり直すので撃破ターンは5。第六の奇跡は通常ターン外なので null。
            this.finish(STATES.WIN, {
              killTurn: step.kind === POST_FIVE_MISS_KINDS.RETRY_TURN ? step.turn : null,
              killedBy: step.equipmentId,
            });
            return logSinceStart();
          }
          // 神へ1発目。まだ倒れないので、残っている追加判定があれば続ける
          //（同一戦闘中の2発目ならそれで撃破になる）。
        }
      }

      // 追加判定を使い切ってもCRITICALが出なければ敵の必殺技で敗北。
      this.finish(STATES.LOSE, { killTurn: null, killedBy: null });
      return logSinceStart();
    }

    // --- 決着 -----------------------------------------------------------------

    finish(state, { killTurn, killedBy }) {
      this.state = state;
      this.killTurn = killTurn;
      this.killedBy = killedBy;
      this.result = this.buildResult();
    }

    // 戦闘の結果。進行・記録・保存は Phase 05以降がこれを読んで行う。
    // ここでは何も保存しないし、何も書き換えない。
    buildResult() {
      const won = this.state === STATES.WIN;
      const fiveTurnWin = won && this.killTurn === TURN_COUNT;
      const context = this.effectContext;

      return Object.freeze({
        enemyId: context.enemyId,
        rawResistance: this.enemy.resistance,
        result: this.state,
        // 通常ターンで倒したターン番号。第六の奇跡で倒した場合は null。
        killTurn: this.killTurn,
        // 追加判定で倒した場合の装備ID。通常ターンなら null。
        killedBy: this.killedBy,
        missedTurns: Object.freeze(this.missedTurns.slice()),
        // 当てたCRITICAL数と、撃破に要る数。通常敵は必ず requiredCriticalHits = 1。
        criticalHits: this.criticalHits,
        requiredCriticalHits: this.requiredCriticalHits,
        chances: this.path.chances,
        equippedIds: Object.freeze(this.equippedIds.slice()),
        usedEquipmentIds: Object.freeze(this.usedEquipmentIds.slice()),
        randomTurnSelections: this.randomTurnSelections,
        extraJudgements: Object.freeze(this.extraJudgements.slice()),
        counters: Object.freeze(Object.assign({}, this.counters)),

        // 次戦・進行へ渡す材料。**適用は Phase 05以降**（ここでは計算して渡すだけ）。
        next: Object.freeze({
          previousBattle: Object.freeze({ result: this.state, winTurn: this.killTurn }),
          // 5ターン目撃破か。奇跡の連鎖・最後の英雄が見る（仕様書 07）。
          fiveTurnWin,
          // 連鎖数の更新案。5T撃破で+1、それ以外の勝利と敗北で0。
          chainCount: fiveTurnWin ? context.chainCount + 1 : 0,
          // この敵への今回のMISSマスク。撃破したら0にする（仕様書 07）。
          missMask: won ? Object.freeze([]) : Object.freeze(this.missedTurns.slice()),
          // 敗北した敵。撃破していれば解除。
          lastLostEnemyId: won ? null : context.enemyId,
          // 同一敵の連続敗北回数・挑戦回数の更新材料。撃破時は0へ戻す。
          sameEnemyLossCountDelta: won ? 0 : 1,
          sameEnemyAttemptCountDelta: 1,
          clearSameEnemyCounters: won,
        }),

        // RECORD用の増分（仕様書 14）。追加判定は総タップへ入れない（D4）。
        recordDelta: Object.freeze({
          totalTap: this.counters.tap,
          totalCritical: this.counters.critical,
          totalMiss: this.counters.miss,
          totalKill: won ? 1 : 0,
          totalDefeat: won ? 0 : 1,
          extraJudgement: this.counters.extraJudgement,
          enemyKillCount: won ? 1 : 0,
          // 装備使用回数はBattleStart時に装備中の各IDへ+1（仕様書 14）。
          equipmentUsage: Object.freeze(this.equippedIds.reduce(
            (usage, equipmentId) => Object.assign(usage, { [equipmentId]: 1 }), {},
          )),
        }),
      });
    }

    // 決着していなければ null。
    getResult() {
      return this.result;
    }
  }

  function startBattle(options) {
    return new BattleSession(options);
  }

  Object.assign(ns, {
    BattleSession: Object.assign(BattleSession, { STATES, OUTCOMES, REJECTIONS }),
    startBattle,
  });
})(globalThis);
