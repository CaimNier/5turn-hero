(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { CONSTANTS, BattleEffects, BattleCalculator, EQUIPMENT, getEquipment } = ns;
  const { EquipmentEffectDefinitions, EquipmentEffectTypes } = ns;
  const { EFFECT_KINDS, POST_FIVE_MISS_KINDS } = EquipmentEffectTypes;

  // 装備効果エンジン。ロードアウト（装備5枠）と戦況の context から、
  // BattleCalculator が食べられる contribution の配列を作る。
  //
  // ここも純粋。SaveData・localStorage・DOM・グローバル状態を一切書き換えない。
  // 「敗北回数が増えた」「次戦バフを消費した」といった更新は BattleSession /
  // Progression（Phase 04以降）の仕事で、こちらは受け取った値を読むだけ。
  //
  // 装備スロットの並び順は結果に出さない。装備を処理する順はカタログの並び
  //（レア度順・仕様書の表の番号順）に正規化してから回す。

  const TURN_COUNT = CONSTANTS.turnsPerBattle;

  // カタログ順の索引。A,B,C と C,B,A を同じ順序へ揃えるために使う。
  const CATALOG_ORDER = new Map(EQUIPMENT.map((equipment, index) => [equipment.id, index]));

  function definitionOf(equipmentId) {
    const definition = EquipmentEffectDefinitions.getDefinition(equipmentId);
    if (!definition) throw new Error(`効果定義が無い装備: ${equipmentId}`);
    return definition;
  }

  // 装備中のIDを、重複を除いてカタログ順に並べたもの。
  function orderedEquipmentIds(slots) {
    if (!Array.isArray(slots)) throw new TypeError("slots は配列");
    const seen = new Set();
    slots.forEach((equipmentId) => {
      if (equipmentId === null || equipmentId === undefined) return;
      // 同名2つは仕様で禁止（仕様書 13）。normalizeLoadout を通していれば起きないが、
      // 直接呼ばれても二重適用しないよう、ここでも1つに畳む。
      if (seen.has(equipmentId)) return;
      if (!CATALOG_ORDER.has(equipmentId)) throw new Error(`unknown equipmentId: ${equipmentId}`);
      seen.add(equipmentId);
    });
    return [...seen].sort((a, b) => CATALOG_ORDER.get(a) - CATALOG_ORDER.get(b));
  }

  // --- ロードアウトの検証 ---------------------------------------------------

  // 一点集中の selectedTurn のように、装備時に選ぶ値の既定。
  const PARAM_DEFAULTS = Object.freeze({
    sr_single_focus: Object.freeze({ selectedTurn: 1 }),
  });

  function normalizeParams(equipmentId, given, corrections) {
    const defaults = PARAM_DEFAULTS[equipmentId];
    if (!defaults) return {};
    const params = Object.assign({}, defaults, given || {});
    // selectedTurn は1〜5の整数だけ。範囲外は既定へ寄せて、寄せたことを残す（AC-106）。
    if ("selectedTurn" in defaults) {
      const turn = params.selectedTurn;
      if (!Number.isInteger(turn) || turn < 1 || turn > TURN_COUNT) {
        corrections.push({ equipmentId, key: "selectedTurn", given: turn, used: defaults.selectedTurn });
        params.selectedTurn = defaults.selectedTurn;
      }
    }
    return params;
  }

  // 枠数・同名重複・未知IDを弾き、装備時パラメータを既定値で埋める。
  // 弾いたものは rejections に残す（黙って捨てない）。
  function normalizeLoadout({ slots = [], params = {}, unlockedSlotCount = CONSTANTS.maxEquipmentSlots } = {}) {
    if (!Array.isArray(slots)) throw new TypeError("slots は配列");
    if (!Number.isInteger(unlockedSlotCount) || unlockedSlotCount < 1 || unlockedSlotCount > CONSTANTS.maxEquipmentSlots) {
      throw new RangeError(`unlockedSlotCount は1〜${CONSTANTS.maxEquipmentSlots}: ${unlockedSlotCount}`);
    }
    const rejections = [];
    const corrections = [];
    const normalizedSlots = [];
    const used = new Set();

    for (let slot = 0; slot < CONSTANTS.maxEquipmentSlots; slot += 1) {
      const equipmentId = slots[slot] === undefined ? null : slots[slot];
      if (equipmentId === null) {
        normalizedSlots.push(null);
      } else if (slot >= unlockedSlotCount) {
        // 未解放の枠は null 固定（仕様書 13 / AC-108）。
        rejections.push({ slot, equipmentId, reason: "SLOT_LOCKED" });
        normalizedSlots.push(null);
      } else if (!CATALOG_ORDER.has(equipmentId)) {
        rejections.push({ slot, equipmentId, reason: "UNKNOWN_EQUIPMENT" });
        normalizedSlots.push(null);
      } else if (used.has(equipmentId)) {
        // 同じ equipmentId はロードアウトに1つまで（仕様書 13 / AC-107）。先に入れた枠を残す。
        rejections.push({ slot, equipmentId, reason: "DUPLICATE" });
        normalizedSlots.push(null);
      } else {
        used.add(equipmentId);
        normalizedSlots.push(equipmentId);
      }
    }

    const normalizedParams = {};
    used.forEach((equipmentId) => {
      const normalized = normalizeParams(equipmentId, params[equipmentId], corrections);
      if (Object.keys(normalized).length > 0) normalizedParams[equipmentId] = normalized;
    });

    return Object.freeze({
      slots: Object.freeze(normalizedSlots),
      params: Object.freeze(normalizedParams),
      rejections: Object.freeze(rejections),
      corrections: Object.freeze(corrections),
    });
  }

  // --- 戦況 context ---------------------------------------------------------

  // 装備が参照してよい入力の全部。ここに無いものは装備から見えない。
  // 実際の値を用意して渡すのは BattleSession / Progression（Phase 04以降）。
  function createContext(input = {}) {
    const { rawResistance } = input;
    if (!Number.isFinite(rawResistance) || rawResistance < 0) {
      throw new TypeError(`context.rawResistance は0以上の有限な数値: ${rawResistance}`);
    }
    return Object.freeze({
      rawResistance,
      enemyId: input.enemyId === undefined ? null : input.enemyId,
      // 同一敵への連続敗北回数 / 挑戦回数（仕様書 07）。
      sameEnemyLossCount: input.sameEnemyLossCount || 0,
      sameEnemyAttemptCount: input.sameEnemyAttemptCount === undefined ? 1 : input.sameEnemyAttemptCount,
      // 前回その敵に挑戦したときMISSしたターン番号。
      previousMissMask: Object.freeze((input.previousMissMask || []).slice()),
      // 直前に敗北した敵。リベンジ系の条件。
      lastLostEnemyId: input.lastLostEnemyId === undefined ? null : input.lastLostEnemyId,
      // 直前の戦闘結果 { result: "WIN" | "LOSE", winTurn }。
      previousBattle: input.previousBattle === undefined ? null : input.previousBattle,
      // 連続5ターン撃破数（奇跡の連鎖）。
      chainCount: input.chainCount || 0,
      // 装備時に選んだ値 { equipmentId: { ... } }。
      loadoutParams: Object.freeze(Object.assign({}, input.loadoutParams)),
      // 戦闘開始時に抽選した対象ターン { equipmentId: turn }。
      randomTurnSelections: Object.freeze(Object.assign({}, input.randomTurnSelections)),
    });
  }

  // --- 戦闘開始時の抽選 -----------------------------------------------------

  // 「一か八か」のようにランダム対象が要る装備を、戦闘開始時に1回だけ確定させる
  //（仕様書 18「一か八か対象T：BattleStart時に1回」）。
  //
  // **プレビューではこれを呼ばない。**呼ばない限り乱数は1つも進まないので、
  // バトル前画面を開き閉じしても系列がずれない。
  function resolveBattleStart({ slots = [], random } = {}) {
    const pending = orderedEquipmentIds(slots).filter((id) => definitionOf(id).requiresRandomTurn);
    if (pending.length === 0) return Object.freeze({ randomTurnSelections: Object.freeze({}), draws: 0 });
    if (!random || typeof random.pickIndex !== "function") {
      throw new TypeError("resolveBattleStart には RandomService が要る");
    }
    const selections = {};
    // カタログ順に引く。スロットの並びで消費順が変わらないようにするため。
    pending.forEach((equipmentId) => {
      selections[equipmentId] = random.pickIndex(TURN_COUNT) + 1;
    });
    return Object.freeze({ randomTurnSelections: Object.freeze(selections), draws: pending.length });
  }

  // 抽選待ちの装備。プレビューで「RANDOM」を出すかの判断に使う（仕様書 03）。
  function getPendingRandomEquipmentIds({ slots = [], randomTurnSelections = {} } = {}) {
    return orderedEquipmentIds(slots)
      .filter((id) => definitionOf(id).requiresRandomTurn)
      .filter((id) => randomTurnSelections[id] === undefined);
  }

  // --- contribution の組み立て ----------------------------------------------

  function toContribution(equipmentId, definition, descriptor) {
    const priority = descriptor.priority === undefined ? definition.priority : descriptor.priority;
    const common = { source: equipmentId, turns: descriptor.turns, value: descriptor.value, when: descriptor.when, priority };
    switch (descriptor.kind) {
      case EFFECT_KINDS.ADD:
        return BattleEffects.staticAdd(common);
      case EFFECT_KINDS.MISS_ADD:
        return BattleEffects.missDependentAdd(common);
      case EFFECT_KINDS.FORCE:
        return BattleEffects.force(common);
      case EFFECT_KINDS.MULT:
        return BattleEffects.multiplier(common);
      case EFFECT_KINDS.RESIST_MULT:
        return BattleEffects.resistanceMultiplier({ source: equipmentId, multiplier: descriptor.value, priority });
      case EFFECT_KINDS.CROSS_TURN:
        return BattleEffects.crossTurn({ source: equipmentId, order: descriptor.order, apply: descriptor.apply });
      default:
        throw new TypeError(`${equipmentId}: 未知の効果種別: ${descriptor.kind}`);
    }
  }

  // ロードアウト全体の contribution。BattleCalculator の effects へそのまま渡せる。
  function buildContributions({ slots = [], context } = {}) {
    if (!context) throw new TypeError("buildContributions には context が要る");
    const contributions = [];
    orderedEquipmentIds(slots).forEach((equipmentId) => {
      const definition = definitionOf(equipmentId);
      if (!definition.contributions) return;
      // 装備ごとに、自分のパラメータと自分の抽選結果だけを見える形にして渡す。
      const scoped = Object.freeze(Object.assign({}, context, {
        equipmentId,
        params: context.loadoutParams[equipmentId] || {},
        randomTurn: context.randomTurnSelections[equipmentId] === undefined
          ? null
          : context.randomTurnSelections[equipmentId],
      }));
      definition.contributions(scoped).forEach((descriptor) => {
        contributions.push(toContribution(equipmentId, definition, descriptor));
      });
    });
    return contributions;
  }

  // --- 5MISS後の追加判定（進行は Phase 04） ---------------------------------

  // 5ターンすべてMISSしたあとに使える手を、解決順（砂時計 → 第六の奇跡）で返す。
  // ここは「何がどの確率で使えるか」を答えるだけで、抽選も進行もしない。
  function getPostFiveMissPlan({ slots = [], chances = [], usedEquipmentIds = [] } = {}) {
    if (!Array.isArray(chances) || chances.length !== TURN_COUNT) {
      throw new TypeError(`chances は${TURN_COUNT}要素の配列`);
    }
    return orderedEquipmentIds(slots)
      .map((equipmentId) => ({ equipmentId, definition: definitionOf(equipmentId) }))
      .filter(({ definition }) => definition.postFiveMiss)
      .map(({ equipmentId, definition }) => {
        const plan = definition.postFiveMiss;
        const available = !usedEquipmentIds.includes(equipmentId);
        if (plan.kind === POST_FIVE_MISS_KINDS.RETRY_TURN) {
          return Object.freeze({
            equipmentId,
            kind: plan.kind,
            order: plan.order,
            available,
            // 発動するかどうかの判定確率（砂時計は30%）。
            triggerChance: plan.triggerChance,
            turn: plan.turn,
            // 発動した場合にやり直すターンのCRITICAL率。
            chance: chances[plan.turn - 1],
          });
        }
        // EXTRA_ROLL：確率は元ターンの最終値＋ボーナスをClampしたもの（AC-031 / 032）。
        return Object.freeze({
          equipmentId,
          kind: plan.kind,
          order: plan.order,
          available,
          triggerChance: null,
          turn: null,
          chance: BattleCalculator.clampChance(chances[plan.fromTurn - 1] + plan.bonus),
        });
      })
      .sort((a, b) => a.order - b.order);
  }

  // --- 報酬側（適用は RewardService / Phase 06） ----------------------------

  // 撃破ダイヤの倍率と、敗北時のペナルティ。効果は宣言するだけで、ここでは何も起きない。
  function getRewardModifiers({ slots = [] } = {}) {
    let killDiamondMultiplier = 1;
    let forfeitRunDiamondsOnLoss = false;
    const sources = [];
    orderedEquipmentIds(slots).forEach((equipmentId) => {
      const reward = definitionOf(equipmentId).reward;
      if (!reward) return;
      sources.push(equipmentId);
      if (reward.killDiamondMultiplier !== undefined) killDiamondMultiplier *= reward.killDiamondMultiplier;
      if (reward.forfeitRunDiamondsOnLoss) forfeitRunDiamondsOnLoss = true;
    });
    return Object.freeze({ killDiamondMultiplier, forfeitRunDiamondsOnLoss, sources: Object.freeze(sources) });
  }

  // 撃破ダイヤへ倍率を適用する。敵抵抗×2は必ず偶数なので、現行の21体では端数が出ない。
  // それでも念のため切り捨てで止める（仕様書に丸め規則が無いため、増える側へは倒さない）。
  function applyKillDiamondModifiers(baseDiamonds, { slots = [] } = {}) {
    if (!Number.isFinite(baseDiamonds) || baseDiamonds < 0) {
      throw new TypeError(`baseDiamonds は0以上の有限な数値: ${baseDiamonds}`);
    }
    return Math.floor(baseDiamonds * getRewardModifiers({ slots }).killDiamondMultiplier);
  }

  // 敗北時に没収されるダイヤ。没収対象は「その周回の撃破ダイヤ」だけ（PHASES.md D2）。
  function getLossPenalty({ slots = [], runDiamondEarned = 0 } = {}) {
    const forfeits = getRewardModifiers({ slots }).forfeitRunDiamondsOnLoss;
    return Object.freeze({ forfeitDiamonds: forfeits ? runDiamondEarned : 0 });
  }

  // --- 説明（プレビュー・図鑑・デバッグ用） ---------------------------------

  // 装備中の効果の一覧。determinacy で「開始前に確定」と「戦闘中に変わる」を分けられる。
  function getEffectSummary({ slots = [], context } = {}) {
    return orderedEquipmentIds(slots).map((equipmentId) => {
      const definition = definitionOf(equipmentId);
      const equipment = getEquipment(equipmentId);
      const active = definition.contributions && context
        ? buildContributions({ slots: [equipmentId], context }).length > 0
        : null;
      return Object.freeze({
        equipmentId,
        name: equipment.name,
        rarity: equipment.rarity,
        trigger: definition.trigger,
        determinacy: definition.determinacy,
        condition: definition.condition,
        cap: definition.cap,
        reset: definition.reset,
        priority: definition.priority,
        // context を渡した場合だけ「いまこの戦闘で効いているか」を返す。
        active,
      });
    });
  }

  // どの状態がいつリセットされるか。実際に消すのは Phase 04以降。
  function getResetRules({ slots = [] } = {}) {
    return orderedEquipmentIds(slots).map((equipmentId) => {
      const definition = definitionOf(equipmentId);
      return Object.freeze({ equipmentId, reset: definition.reset, cap: definition.cap });
    });
  }

  Object.assign(ns, {
    EquipmentEffectEngine: Object.freeze({
      orderedEquipmentIds,
      normalizeLoadout,
      createContext,
      resolveBattleStart,
      getPendingRandomEquipmentIds,
      buildContributions,
      getPostFiveMissPlan,
      getRewardModifiers,
      applyKillDiamondModifiers,
      getLossPenalty,
      getEffectSummary,
      getResetRules,
      getDefinition: definitionOf,
    }),
  });
})(globalThis);
