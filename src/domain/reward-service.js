(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const {
    CONSTANTS, RARITIES, ROUTES, getEnemy, EQUIPMENT_BY_RARITY,
    findTreasureBoxRule, ENCYCLOPEDIA_REWARDS,
    EquipmentEffectEngine, ProgressionState,
  } = ns;

  // 勝敗が決まったあとの報酬。撃破ダイヤ → 宝箱 → 図鑑登録／しきい値報酬 の順で処理する
  //（ロジック仕様書 11 の WIN_SEQUENCE）。④装備枠／ルート解放は Phase 05 の担当で、
  // ここへは入れない。⑤WIN画面用のデータは戻り値として返すだけ。
  //
  // 画面もセーブも触らない。乱数は渡された RandomService からだけ引く。
  //
  // **Progression のあとに呼ぶ。**初撃破かどうかは Progression が出す
  // ENEMY_FIRST_KILL イベントを見る。同じ判定をここでもう一度持たない。

  const { EVENTS } = ProgressionState;

  // 抽選に使う重みの並び。レア度順に固定しておかないと、同じ表でも
  // 境界値（SSR70 / UR29 / LEGEND1）の区間がずれる。
  function rarityEntries(rates) {
    return RARITIES.filter((rarity) => rates[rarity] !== undefined)
      .map((rarity) => [rarity, rates[rarity]]);
  }

  // 敵撃破ダイヤ。rawResistance × 2（仕様書 01）。世界樹の四葉だけがここへ効く。
  function getKillDiamonds(enemy, equippedIds = []) {
    const base = enemy.resistance * CONSTANTS.killDiamondMultiplier;
    return EquipmentEffectEngine.applyKillDiamondModifiers(base, { slots: equippedIds });
  }

  // 箱の中の装備。そのレアリティの10種から均等に1つ（個別ウェイトは現仕様に無い）。
  function drawChestEquipmentId(random, rarity) {
    const pool = EQUIPMENT_BY_RARITY[rarity];
    return pool[random.pickIndex(pool.length)].id;
  }

  function findEvent(events, type) {
    return events.find((event) => event.type === type) || null;
  }

  // 1戦ぶんの報酬をまとめて処理する。
  //
  //   battleResult       … Phase 04 の BattleResult
  //   progression        … Phase 05 の ProgressionState（applyBattleResult 済み）
  //   progressionOutcome … その applyBattleResult の戻り値（events を見る）
  //   economy / record   … 反映先
  //   random             … 宝箱の抽選に使う
  function applyBattleReward({ battleResult, progression, progressionOutcome, economy, random } = {}) {
    if (!battleResult || !progression || !progressionOutcome || !economy) {
      throw new TypeError("applyBattleReward には battleResult / progression / progressionOutcome / economy が要る");
    }
    const events = progressionOutcome.events || [];
    const enemy = getEnemy(battleResult.enemyId);
    const won = battleResult.result === "WIN";
    const equippedIds = battleResult.equippedIds || [];
    const firstKill = Boolean(findEvent(events, EVENTS.ENEMY_FIRST_KILL));

    let battleDiamonds = 0;
    let chestDropped = false;
    let chestRarity = null;
    let equipmentId = null;
    let isNew = false;
    let duplicateSaleDiamonds = 0;
    let encyclopediaRegistered = false;
    const encyclopediaRewards = [];
    let encyclopediaRewardDiamonds = 0;
    let forfeitedDiamonds = 0;

    // ① 撃破ダイヤ。周回の獲得ダイヤにも積む（死神との契約の没収対象・D2）。
    if (won) {
      battleDiamonds = getKillDiamonds(enemy, equippedIds);
      economy.addDiamonds(battleDiamonds);
      if (enemy.route !== ROUTES.SPECIAL) {
        progression.addRunEarnedBattleDiamonds(enemy.route, battleDiamonds);
      }
    }

    // ② 宝箱。表にない区間（通常1〜9・神）はルートが無いので1回も引かない。
    if (won) {
      const rule = findTreasureBoxRule(enemy.route, enemy.stage, firstKill);
      if (rule) {
        if (!random) throw new TypeError("宝箱の抽選には RandomService が要る");
        chestDropped = random.rollPercent(rule.dropRate);
        if (chestDropped) {
          chestRarity = random.pickWeighted(rarityEntries(rule.rarityRates));
          equipmentId = drawChestEquipmentId(random, chestRarity);
          const acquired = economy.acquireEquipment(equipmentId);
          isNew = acquired.isNew;
          duplicateSaleDiamonds = acquired.duplicateSaleDiamonds;
        }
      }
    }

    // ③ 図鑑の初登録としきい値報酬。神は図鑑に入らない。
    if (firstKill && enemy.inEncyclopedia) {
      encyclopediaRegistered = true;
      claimReachedEncyclopediaRewards({ progression, economy }).forEach((reward) => {
        encyclopediaRewards.push(reward);
        encyclopediaRewardDiamonds += reward.diamonds;
      });
    }

    // 敗北時の没収。対象はその周回の**敵撃破ダイヤだけ**（図鑑報酬も売却分も含まない）。
    // 周回は Progression が閉じ、貯まっていた額を RUN_ENDED に載せて渡してくる。
    if (!won) {
      const runEnded = findEvent(events, EVENTS.RUN_ENDED);
      const penalty = EquipmentEffectEngine.getLossPenalty({
        slots: equippedIds,
        runDiamondEarned: runEnded ? runEnded.earnedBattleDiamonds : 0,
      });
      // 使ってしまって残高が足りなくても、マイナスにはしない。
      forfeitedDiamonds = economy.forfeitDiamonds(penalty.forfeitDiamonds);
    }

    const totalDiamondDelta =
      battleDiamonds + duplicateSaleDiamonds + encyclopediaRewardDiamonds - forfeitedDiamonds;

    return Object.freeze({
      enemyId: enemy.id,
      route: enemy.route,
      stage: enemy.stage,
      result: battleResult.result,
      firstKill,
      battleDiamonds,
      chestDropped,
      chestRarity,
      equipmentId,
      isNew,
      duplicateSaleDiamonds,
      encyclopediaRegistered,
      encyclopediaCount: progression.getEncyclopediaFirstKillCount(),
      encyclopediaRewards: Object.freeze(encyclopediaRewards),
      encyclopediaRewardDiamonds,
      forfeitedDiamonds,
      totalDiamondDelta,
      diamondsAfter: economy.getDiamonds(),
    });
  }

  // 図鑑の登録数が届いている報酬のうち、**まだ受け取っていないものだけ**を受け取る。
  // 登録数は初撃破の集合から毎回数え直し（神は数えない）、受取済みは economy の台帳で弾く。
  // 何度呼んでも2回目以降は何も起きない。戦闘の初撃破とロード時の取りこぼし救済の両方がここを通る。
  function claimReachedEncyclopediaRewards({ progression, economy }) {
    const count = progression.getEncyclopediaFirstKillCount();
    const claimed = [];
    ENCYCLOPEDIA_REWARDS.forEach((reward) => {
      if (reward.diamonds <= 0) return; // 20体はダイヤではなく神の解放（Phase 05）
      if (reward.count > count) return;
      if (!economy.claimEncyclopediaReward(reward.count)) return; // 受取済み
      economy.addDiamonds(reward.diamonds);
      claimed.push(Object.freeze({ count: reward.count, diamonds: reward.diamonds }));
    });
    return Object.freeze(claimed);
  }

  // Phase 05 が出す RECORD_SNAPSHOT_REQUESTED を実処理する。
  // 初回の1回だけ写し、再クリアでは上書きしない（RecordState 側で弾く）。
  function applySnapshotRequests({ progressionOutcome, record, battleResult, takenAt = null } = {}) {
    if (!progressionOutcome || !record) {
      throw new TypeError("applySnapshotRequests には progressionOutcome / record が要る");
    }
    const taken = [];
    (progressionOutcome.events || []).forEach((event) => {
      if (event.type !== EVENTS.RECORD_SNAPSHOT_REQUESTED) return;
      const snapshot = record.takeSnapshot(event.kind, {
        equippedIds: (battleResult && battleResult.equippedIds) || [],
        takenAt,
      });
      if (snapshot) taken.push(snapshot);
    });
    return Object.freeze(taken);
  }

  Object.assign(ns, {
    RewardService: Object.freeze({
      getKillDiamonds,
      drawChestEquipmentId,
      applyBattleReward,
      claimReachedEncyclopediaRewards,
      applySnapshotRequests,
      rarityEntries,
    }),
  });
})(globalThis);
