(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { BattleEffects, EQUIPMENT, POST_PROCESS_ORDER, POST_FIVE_MISS_ORDER, EquipmentEffectTypes } = ns;
  const { TRIGGERS, DETERMINACY, EFFECT_KINDS, POST_FIVE_MISS_KINDS, RESETS, PRIORITIES } = EquipmentEffectTypes;

  // 装備60種の「実行できる」効果定義。出典はゲームロジック仕様書 08 の表と、
  // ゲーム企画書 05 の効果文。equipment-catalog.js の spec（文字列）をここで実行形へ落とす。
  //
  // 1装備 = 1エントリ。巨大なswitchにしないのは、装備を1つ直すときに読む場所を
  // その1エントリだけにしたいから。共通の道具（add / missAdd / force ...）だけを共有する。
  //
  // contributions(context) は「この戦闘でこの装備が出す補正」を返す純粋関数。
  // 戦闘に無関係な条件（敵抵抗・敗北回数・前戦結果）はここで解決して空配列を返し、
  // ターンごとに変わる条件（到達MISS）だけを when / value の関数へ残す。
  // **セーブも画面も状態も触らない。**

  const ALL = BattleEffects.ALL_TURNS;

  // --- contribution の下書き。engine が source と priority を入れて本物にする -------

  const add = (turns, value, when) => ({ kind: EFFECT_KINDS.ADD, turns, value, when });
  const missAdd = (turns, value, when) => ({ kind: EFFECT_KINDS.MISS_ADD, turns, value, when });
  const force = (turns, value, priority) => ({ kind: EFFECT_KINDS.FORCE, turns, value, priority });
  const mult = (turns, value) => ({ kind: EFFECT_KINDS.MULT, turns, value });
  const resistMult = (value) => ({ kind: EFFECT_KINDS.RESIST_MULT, value });
  const crossTurn = (order, apply) => ({ kind: EFFECT_KINDS.CROSS_TURN, order, apply });

  // --- よく使う条件 ---------------------------------------------------------

  // 指定ターンがすべてMISS済みか。「1〜4TすべてMISSなら5T +40」のような条件。
  const missedAll = (turns) => (context) => turns.every((turn) => context.priorMissedTurns.includes(turn));
  // 直前のターンがMISSだったか。T1には直前が無いので必ず false。
  const missedPrevious = (context) => context.priorMissedTurns.includes(context.turn - 1);

  const everyTurn = BattleEffects.everyTurn();
  const otherTurns = (turns) => everyTurn.filter((turn) => !turns.includes(turn));

  // P9 と 5MISS後 の適用順は catalog の並びが正（D1 / ロジック仕様書 05）。
  // ここで番号へ直すだけで、順序そのものはこのファイルで決めない。
  function orderIn(list, equipmentId, label) {
    const index = list.indexOf(equipmentId);
    if (index < 0) throw new Error(`${equipmentId} が ${label} に載っていない`);
    return index + 1;
  }
  const crossTurnOrder = (equipmentId) => orderIn(POST_PROCESS_ORDER, equipmentId, "POST_PROCESS_ORDER");
  const postFiveMissOrder = (equipmentId) => orderIn(POST_FIVE_MISS_ORDER, equipmentId, "POST_FIVE_MISS_ORDER");

  // --- 定義本体 -------------------------------------------------------------

  const definitions = new Map();

  function def(equipmentId, definition) {
    if (definitions.has(equipmentId)) throw new Error(`定義が重複している: ${equipmentId}`);
    definitions.set(equipmentId, Object.freeze({
      equipmentId,
      trigger: definition.trigger,
      determinacy: definition.determinacy,
      // 仕様書 08 の condition 列をそのまま。人が読むためのもので、分岐には使わない。
      condition: definition.condition || null,
      // 累積の上限。仕様書に上限が書かれている装備だけ数値が入る。
      cap: definition.cap === undefined ? null : definition.cap,
      reset: definition.reset,
      priority: definition.priority === undefined ? PRIORITIES.DEFAULT : definition.priority,
      contributions: definition.contributions || null,
      postFiveMiss: definition.postFiveMiss ? Object.freeze(definition.postFiveMiss) : null,
      reward: definition.reward ? Object.freeze(definition.reward) : null,
      // true なら戦闘開始時に対象ターンを1つ抽選する必要がある。
      requiresRandomTurn: Boolean(definition.requiresRandomTurn),
    }));
  }

  // ===== N =================================================================

  def("n_luck_shard", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add(ALL, 1)],
  });

  [1, 2, 3, 4, 5].forEach((turn) => {
    def(`n_charm_turn${turn}`, {
      trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
      contributions: () => [add([turn], 4)],
    });
  });

  def("n_persistent_cloth", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([4, 5], 2)],
  });

  def("n_vanguard_cloth", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([1, 2], 2)],
  });

  def("n_small_clover", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "targetEnemy == lastLostEnemy", reset: RESETS.TARGET_ENEMY_DEFEATED,
    contributions: (context) => (isRevenge(context) ? [add(ALL, 2)] : []),
  });

  def("n_courage_stone", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "rawResistance >= 90", reset: RESETS.NONE,
    contributions: (context) => (context.rawResistance >= 90 ? [add(ALL, 2)] : []),
  });

  // ===== R =================================================================

  def("r_ring_turn2", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([2], 10)],
  });

  def("r_ring_turn3", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([3], 10)],
  });

  def("r_ring_turn5", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([5], 12)],
  });

  def("r_rising_talisman", {
    // 1T+0 / 2T+1 / 3T+2 / 4T+3 / 5T+4。ターン番号から作れるので表を持たない。
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add(ALL, (context) => context.turn - 1)],
  });

  def("r_sore_loser_bracelet", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "targetEnemy == lastLostEnemy", reset: RESETS.TARGET_ENEMY_DEFEATED,
    contributions: (context) => (isRevenge(context) ? [add(ALL, 5)] : []),
  });

  def("r_first_battle_sword", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([1], 15), add([2, 3, 4, 5], -2)],
  });

  def("r_even_talisman", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([2, 4], 8)],
  });

  def("r_odd_talisman", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([1, 3, 5], 6)],
  });

  def("r_misfortune_ward", {
    // 「前のターンがMISSなら次ターン +5%」。累積しない。
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "previousTurn == MISS", reset: RESETS.EACH_BATTLE,
    contributions: () => [missAdd(ALL, 5, missedPrevious)],
  });

  def("r_strong_foe_fang", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "rawResistance >= 100", reset: RESETS.NONE,
    contributions: (context) => (context.rawResistance >= 100 ? [add(ALL, 10)] : []),
  });

  // ===== SR ================================================================

  def("sr_third_time_lucky", {
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "T1,T2 == MISS", reset: RESETS.EACH_BATTLE,
    contributions: () => [missAdd([3], 25, missedAll([1, 2]))],
  });

  def("sr_sacrifice_for_tomorrow", {
    // 3Tの「最終CRITICALを50%減」は倍率（P7）、4T +30 は加算（P2）。
    trigger: TRIGGERS.MIXED, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    contributions: () => [mult([3], 0.5), add([4], 30)],
  });

  def("sr_backwater_crest", {
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "T1-T4 == MISS", reset: RESETS.EACH_BATTLE,
    contributions: () => [missAdd([5], 40, missedAll([1, 2, 3, 4]))],
  });

  def("sr_critical_savings", {
    // 「MISSするたび次ターン +8%」。直前の1回ぶんだけで、累積しない（AC-058）。
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "previousTurn == MISS", reset: RESETS.EACH_BATTLE,
    contributions: () => [missAdd(ALL, 8, missedPrevious)],
  });

  def("sr_unyielding_ring", {
    trigger: TRIGGERS.ATTEMPT_STATE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "sameEnemyLossCount", cap: 25, reset: RESETS.TARGET_ENEMY_DEFEATED,
    contributions: (context) => stackedAdd(context.sameEnemyLossCount, 5, 25),
  });

  def("sr_slow_starter", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => {
      const table = [-10, 0, 5, 15, 25];
      return [add(ALL, (context) => table[context.turn - 1])];
    },
  });

  def("sr_gale_sword", {
    // 1T +30。1Tを外した場合だけ 2〜5T -5（＝到達している時点で条件成立）。
    trigger: TRIGGERS.MIXED, determinacy: DETERMINACY.IN_BATTLE,
    condition: "T1 MISSで後半-5", reset: RESETS.EACH_BATTLE,
    contributions: () => [add([1], 30), missAdd([2, 3, 4, 5], -5, missedAll([1]))],
  });

  def("sr_fourth_awakening", {
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "T1-T3 == MISS", reset: RESETS.EACH_BATTLE,
    contributions: () => [missAdd([4], 35, missedAll([1, 2, 3]))],
  });

  def("sr_strong_slayer", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "rawResistance >= 120", reset: RESETS.NONE,
    contributions: (context) => (context.rawResistance >= 120 ? [add(ALL, 25)] : []),
  });

  def("sr_single_focus", {
    trigger: TRIGGERS.LOADOUT_PARAM, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "selectedTurn=1..5", reset: RESETS.LOADOUT_SAVED,
    contributions: (context) => {
      const selected = context.params.selectedTurn;
      return [add([selected], 35), add(otherTurns([selected]), -5)];
    },
  });

  // ===== SSR ===============================================================

  def("ssr_last_hero", {
    trigger: TRIGGERS.NEXT_BATTLE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "previousWinTurn == 5", reset: RESETS.NEXT_BATTLE_CONSUMED,
    contributions: (context) => (previousWinTurn(context) === 5 ? [add(ALL, 10)] : []),
  });

  def("ssr_tenacity", {
    trigger: TRIGGERS.ATTEMPT_STATE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "sameEnemyLossCount", cap: 40, reset: RESETS.TARGET_ENEMY_DEFEATED,
    contributions: (context) => stackedAdd(context.sameEnemyLossCount, 8, 40),
  });

  def("ssr_miracle_echo", {
    // 前の敵を倒したターンと同じターンへ +25。
    trigger: TRIGGERS.NEXT_BATTLE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "previousBattle == WIN", reset: RESETS.NEXT_BATTLE_CONSUMED,
    contributions: (context) => {
      const turn = previousWinTurn(context);
      return turn === null ? [] : [add([turn], 25)];
    },
  });

  def("ssr_victors_afterglow", {
    trigger: TRIGGERS.NEXT_BATTLE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "previousWinTurn in [1,2]", reset: RESETS.NEXT_BATTLE_CONSUMED,
    contributions: (context) => ([1, 2].includes(previousWinTurn(context)) ? [add([1, 2], 20)] : []),
  });

  def("ssr_memory_of_defeat", {
    // 前回その敵に挑んだときMISSした各ターンへ +10。マスクが空なら何も出さない。
    trigger: TRIGGERS.ATTEMPT_STATE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "previousAttemptSameEnemy", reset: RESETS.NEXT_ATTEMPT,
    contributions: (context) => {
      const mask = context.previousMissMask;
      return mask.length === 0 ? [] : [add(mask.slice(), 10)];
    },
  });

  def("ssr_discard_third", {
    trigger: TRIGGERS.HARD_OVERRIDE, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    priority: PRIORITIES.FORCE_DISCARD_TURN,
    contributions: () => [force([3], 0, PRIORITIES.FORCE_DISCARD_TURN), add([4, 5], 30)],
  });

  def("ssr_fate_acceleration", {
    // 「MISSするたび残りターンすべて +8%（累積）」＝到達までのMISS数 × 8。
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "missCountThisBattle", reset: RESETS.BATTLE_END,
    contributions: () => [missAdd(ALL, (context) => 8 * context.priorMissCount)],
  });

  def("ssr_dying_luck", {
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "T1-T4 == MISS", reset: RESETS.EACH_BATTLE,
    contributions: () => [missAdd([5], 50, missedAll([1, 2, 3, 4]))],
  });

  def("ssr_weak_rebellion", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "rawResistance >= 150", reset: RESETS.NONE,
    contributions: (context) => (context.rawResistance >= 150 ? [add(ALL, 30)] : []),
  });

  def("ssr_five_stars", {
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "T1-T4 == MISS", reset: RESETS.EACH_BATTLE,
    contributions: () => [missAdd([5], 70, missedAll([1, 2, 3, 4]))],
  });

  // ===== UR ================================================================

  def("ur_scales_of_fate", {
    trigger: TRIGGERS.MIXED, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    contributions: () => [mult([1, 2, 3, 4], 0.75), add([5], 80)],
  });

  def("ur_odd_god_blessing", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([1, 3, 5], 45), add([2, 4], -15)],
  });

  def("ur_even_god_blessing", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([2, 4], 55), add([1, 3, 5], -10)],
  });

  def("ur_future_advance", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([1, 2], -20), add([4, 5], 55)],
  });

  def("ur_past_debt", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.NONE,
    contributions: () => [add([1, 2], 55), add([4, 5], -20)],
  });

  def("ur_phoenix_mark", {
    trigger: TRIGGERS.ATTEMPT_STATE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "sameEnemyAttemptCount >= 3", reset: RESETS.TARGET_ENEMY_DEFEATED,
    contributions: (context) => (context.sameEnemyAttemptCount >= 3 ? [add(ALL, 45)] : []),
  });

  def("ur_gambler", {
    trigger: TRIGGERS.MIXED, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    contributions: () => [mult([1, 2, 3, 4], 0.5), add([5], 80)],
  });

  def("ur_fate_accumulation", {
    trigger: TRIGGERS.TURN_DYNAMIC, determinacy: DETERMINACY.IN_BATTLE,
    condition: "missCountThisBattle", reset: RESETS.BATTLE_END,
    contributions: () => [missAdd(ALL, (context) => 12 * context.priorMissCount)],
  });

  def("ur_strong_foe_specialist", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "rawResistance >= 200", reset: RESETS.NONE,
    contributions: (context) => (context.rawResistance >= 200 ? [add(ALL, 50)] : []),
  });

  def("ur_miracle_chain", {
    trigger: TRIGGERS.CHAIN_STATE, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "fiveTurnWinChain", cap: 60, reset: RESETS.CHAIN_BROKEN,
    contributions: (context) => stackedAdd(context.chainCount, 20, 60),
  });

  // ===== LEGEND ============================================================

  def("legend_sixth_miracle", {
    // 通常5ターンには何も足さない。5MISS後にBattleSessionが1回だけ使う（Phase 04）。
    trigger: TRIGGERS.POST_FIVE_MISS, determinacy: DETERMINACY.POST_FIVE_MISS,
    condition: "five misses", reset: RESETS.ONCE_PER_BATTLE,
    postFiveMiss: {
      kind: POST_FIVE_MISS_KINDS.EXTRA_ROLL,
      order: postFiveMissOrder("legend_sixth_miracle"),
      // 確率は「5ターン目の最終CRITICAL +50」をClampしたもの（仕様書 05 / AC-031・032）。
      fromTurn: 5,
      bonus: 50,
    },
  });

  def("legend_fifth_miracle", {
    trigger: TRIGGERS.HARD_OVERRIDE, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    priority: PRIORITIES.FORCE_FIFTH_MIRACLE,
    contributions: () => [force([1, 2, 3, 4], 0, PRIORITIES.FORCE_FIFTH_MIRACLE), add([5], 120)],
  });

  def("legend_world_tree_clover", {
    trigger: TRIGGERS.BATTLE_REWARD, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    contributions: () => [add(ALL, 60)],
    // 報酬側はRewardService（Phase 06）が読む。ここでは倍率を宣言するだけ。
    reward: { killDiamondMultiplier: 0.5 },
  });

  def("legend_reaper_contract", {
    trigger: TRIGGERS.BATTLE_REWARD, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.ON_LOSS,
    contributions: () => [add(ALL, 80)],
    reward: { forfeitRunDiamondsOnLoss: true },
  });

  def("legend_hero_curse", {
    trigger: TRIGGERS.BATTLE_STATIC, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "rawResistance threshold", reset: RESETS.NONE,
    contributions: (context) => [add(ALL, context.rawResistance >= 100 ? 60 : -20)],
  });

  def("legend_reversal_of_fate", {
    // 最高値を「最も低い1ターン」へ複製する。最低値が複数なら最も早いターン1つだけ
    //（仕様書 09 / AC-099）。全値同一なら最高＝最低なので結果は変わらない（AC-100）。
    trigger: TRIGGERS.POST_PROCESS, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    priority: crossTurnOrder("legend_reversal_of_fate"),
    contributions: () => [crossTurn(crossTurnOrder("legend_reversal_of_fate"), (values) => {
      const highest = Math.max(...values);
      const lowestIndex = values.indexOf(Math.min(...values));
      const next = values.slice();
      next[lowestIndex] = highest;
      return next;
    })],
  });

  def("legend_all_or_nothing", {
    // 対象ターンは戦闘開始時に1回だけ抽選する（仕様書 18）。
    // 未抽選（バトル前プレビュー）では何も出さない。画面は「RANDOM」を出す（仕様書 03）。
    trigger: TRIGGERS.BATTLE_RANDOM, determinacy: DETERMINACY.BATTLE_START_RANDOM,
    condition: "draw at battle start", reset: RESETS.EACH_BATTLE,
    priority: PRIORITIES.FORCE_ALL_OR_NOTHING,
    requiresRandomTurn: true,
    contributions: (context) => {
      const selected = context.randomTurn;
      if (selected === null) return [];
      return [add([selected], 100), force(otherTurns([selected]), 0, PRIORITIES.FORCE_ALL_OR_NOTHING)];
    },
  });

  def("legend_godslayer", {
    // 「抵抗を20%無視」＝ effectiveResistance に0.8を掛ける。閾値判定は rawResistance。
    trigger: TRIGGERS.RESIST_MOD, determinacy: DETERMINACY.PRE_BATTLE,
    condition: "rawResistance >= 200", reset: RESETS.EACH_BATTLE,
    contributions: (context) => (context.rawResistance >= 200 ? [resistMult(0.8)] : []),
  });

  def("legend_time_hourglass", {
    trigger: TRIGGERS.POST_FIVE_MISS, determinacy: DETERMINACY.POST_FIVE_MISS,
    condition: "five misses", reset: RESETS.ONCE_PER_BATTLE,
    postFiveMiss: {
      kind: POST_FIVE_MISS_KINDS.RETRY_TURN,
      order: postFiveMissOrder("legend_time_hourglass"),
      turn: 5,
      // 発動判定の確率。成功したらT5の最終値でもう一度だけ抽選する。
      triggerChance: 30,
    },
  });

  def("legend_proof_of_hero", {
    // 5値がすべて異なるなら全ターン +50。判定は**自分の+50を乗せる前の値**で行う
    //（仕様書 09 / AC-101）。P9の先頭で走るので、入ってくる値がそのまま判定対象になる。
    trigger: TRIGGERS.POST_PROCESS, determinacy: DETERMINACY.PRE_BATTLE, reset: RESETS.EACH_BATTLE,
    priority: crossTurnOrder("legend_proof_of_hero"),
    contributions: () => [crossTurn(crossTurnOrder("legend_proof_of_hero"), (values) => {
      const allDistinct = new Set(values).size === values.length;
      return allDistinct ? values.map((value) => value + 50) : values;
    })],
  });

  // --- 共通ヘルパー（定義から呼ぶ） -----------------------------------------

  // 「前回敗北した敵との再戦か」。lastLostEnemyId が未設定なら成立しない。
  function isRevenge(context) {
    return context.lastLostEnemyId !== null && context.lastLostEnemyId === context.enemyId;
  }

  // 前戦で撃破したターン。勝っていなければ null。
  function previousWinTurn(context) {
    const previous = context.previousBattle;
    if (!previous || previous.result !== "WIN") return null;
    return typeof previous.winTurn === "number" ? previous.winTurn : null;
  }

  // 「1回ごとに +step、合計 cap まで」。回数0なら効果なし。
  function stackedAdd(count, step, cap) {
    if (!count || count <= 0) return [];
    return [add(ALL, Math.min(step * count, cap))];
  }

  // --- 公開 -----------------------------------------------------------------

  function getDefinition(equipmentId) {
    return definitions.get(equipmentId) || null;
  }

  // 定義が無い装備ID。0件であることをテストで固定する。
  function getUndefinedEquipmentIds() {
    return EQUIPMENT
      .map((equipment) => equipment.id)
      .filter((id) => !definitions.has(id));
  }

  // カタログに無いのに定義だけある＝IDの打ち間違い。
  function getOrphanDefinitionIds() {
    const catalogIds = new Set(EQUIPMENT.map((equipment) => equipment.id));
    return [...definitions.keys()].filter((id) => !catalogIds.has(id));
  }

  Object.assign(ns, {
    EquipmentEffectDefinitions: Object.freeze({
      getDefinition,
      getUndefinedEquipmentIds,
      getOrphanDefinitionIds,
      get size() {
        return definitions.size;
      },
      ids() {
        return [...definitions.keys()];
      },
    }),
  });
})(globalThis);
