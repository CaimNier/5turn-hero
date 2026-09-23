(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { RARITIES } = ns;

  // 装備60種（各レア10種）。
  // 名称・効果文はゲーム企画書 05「装備リスト案」、
  // spec欄（Phase/対象/処理/条件/Reset）はゲームロジック仕様書 08「装備60種 実装定義一覧」から。
  //
  // ここは**データ定義だけ**。効果を実際に計算へ適用するのは EquipmentEngine（Phase 03）。
  // spec欄は仕様書の表記をそのまま文字列で持つ。今ここで独自のDSLへ変換すると、
  // Phase 03で効果エンジンを設計する前に形を決め打ちしてしまうため。
  //
  // equipmentId は `<rarity>_<英語>` の形。ロジック仕様書 06 が例として挙げている
  // `ur_gambler`（= UR 勝負師）に合わせた。IDは不変。あとから変えるとセーブが壊れる。

  function eq(id, rarity, no, name, description, spec, parameter = null) {
    return Object.freeze({
      id,
      rarity,
      // レア内の通し番号（1〜10）。仕様書の表のNo.と一致させる。
      no,
      name,
      description,
      spec: Object.freeze(spec),
      // 装備時にプレイヤーが選ぶ値。現状は「一点集中」の選択ターンだけ（ロジック仕様書 06）。
      parameter,
    });
  }

  const N_EQUIPMENT = Object.freeze([
    eq("n_luck_shard", "N", 1, "幸運の欠片", "全ターン CRITICAL +1%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +1", condition: null, reset: null }),
    eq("n_charm_turn1", "N", 2, "一撃のお守り", "1ターン目 +4%",
      { phase: "BATTLE_STATIC", target: "T1", operation: "ADD +4", condition: null, reset: null }),
    eq("n_charm_turn2", "N", 3, "二撃のお守り", "2ターン目 +4%",
      { phase: "BATTLE_STATIC", target: "T2", operation: "ADD +4", condition: null, reset: null }),
    eq("n_charm_turn3", "N", 4, "三撃のお守り", "3ターン目 +4%",
      { phase: "BATTLE_STATIC", target: "T3", operation: "ADD +4", condition: null, reset: null }),
    eq("n_charm_turn4", "N", 5, "四撃のお守り", "4ターン目 +4%",
      { phase: "BATTLE_STATIC", target: "T4", operation: "ADD +4", condition: null, reset: null }),
    eq("n_charm_turn5", "N", 6, "五撃のお守り", "5ターン目 +4%",
      { phase: "BATTLE_STATIC", target: "T5", operation: "ADD +4", condition: null, reset: null }),
    eq("n_persistent_cloth", "N", 7, "粘りの布", "4・5ターン目 +2%",
      { phase: "BATTLE_STATIC", target: "T4,T5", operation: "ADD +2", condition: null, reset: null }),
    eq("n_vanguard_cloth", "N", 8, "先陣の布", "1・2ターン目 +2%",
      { phase: "BATTLE_STATIC", target: "T1,T2", operation: "ADD +2", condition: null, reset: null }),
    eq("n_small_clover", "N", 9, "小さな四葉", "前回敗北した敵との再戦時、全ターン +2%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +2",
        condition: "targetEnemy == lastLostEnemy", reset: "対象敵撃破で解除" }),
    eq("n_courage_stone", "N", 10, "勇気の石", "敵抵抗90以上なら全ターン +2%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +2",
        condition: "rawResistance >= 90", reset: null }),
  ]);

  const R_EQUIPMENT = Object.freeze([
    eq("r_ring_turn2", "R", 1, "二撃の指輪", "2ターン目 +10%",
      { phase: "BATTLE_STATIC", target: "T2", operation: "ADD +10", condition: null, reset: null }),
    eq("r_ring_turn3", "R", 2, "三度目の指輪", "3ターン目 +10%",
      { phase: "BATTLE_STATIC", target: "T3", operation: "ADD +10", condition: null, reset: null }),
    eq("r_ring_turn5", "R", 3, "最後の指輪", "5ターン目 +12%",
      { phase: "BATTLE_STATIC", target: "T5", operation: "ADD +12", condition: null, reset: null }),
    eq("r_rising_talisman", "R", 4, "尻上がりの護符",
      "ターン経過ごとに +1%（1T +0 / 2T +1 / 3T +2 / 4T +3 / 5T +4）",
      { phase: "BATTLE_STATIC", target: "各ターン", operation: "ADD + turnIndex-1",
        condition: null, reset: null }),
    eq("r_sore_loser_bracelet", "R", 5, "負けず嫌いの腕輪", "前回敗北した敵との再戦時、全ターン +5%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +5",
        condition: "targetEnemy == lastLostEnemy", reset: "対象敵撃破で解除" }),
    eq("r_first_battle_sword", "R", 6, "初陣の剣", "1ターン目 +15%、2～5ターン目 -2%",
      { phase: "BATTLE_STATIC", target: "T1 / T2-T5", operation: "ADD +15 / -2",
        condition: null, reset: null }),
    eq("r_even_talisman", "R", 7, "偶数の護符", "2・4ターン目 +8%",
      { phase: "BATTLE_STATIC", target: "T2,T4", operation: "ADD +8", condition: null, reset: null }),
    eq("r_odd_talisman", "R", 8, "奇数の護符", "1・3・5ターン目 +6%",
      { phase: "BATTLE_STATIC", target: "T1,T3,T5", operation: "ADD +6", condition: null, reset: null }),
    eq("r_misfortune_ward", "R", 9, "不運払い", "前のターンがMISSなら次ターン +5%",
      { phase: "TURN_DYNAMIC", target: "次ターン", operation: "ADD +5",
        condition: "previousTurn == MISS", reset: "各ターン判定" }),
    eq("r_strong_foe_fang", "R", 10, "強敵の牙", "敵抵抗100以上なら全ターン +10%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +10",
        condition: "rawResistance >= 100", reset: null }),
  ]);

  const SR_EQUIPMENT = Object.freeze([
    eq("sr_third_time_lucky", "SR", 1, "三度目の正直", "1・2ターン目がMISSなら3ターン目 +25%",
      { phase: "TURN_DYNAMIC", target: "T3", operation: "ADD +25",
        condition: "T1,T2 == MISS", reset: "各バトル" }),
    eq("sr_sacrifice_for_tomorrow", "SR", 2, "明日への犠牲",
      "3ターン目の最終CRITICALを50%減らし、4ターン目 +30%",
      { phase: "MIXED", target: "T3 / T4", operation: "MULT x0.5 / ADD +30",
        condition: null, reset: "各バトル" }),
    eq("sr_backwater_crest", "SR", 3, "背水の紋章", "1～4ターンすべてMISSなら5ターン目 +40%",
      { phase: "TURN_DYNAMIC", target: "T5", operation: "ADD +40",
        condition: "T1-T4 == MISS", reset: "各バトル" }),
    eq("sr_critical_savings", "SR", 4, "会心貯金", "MISSするたび次ターン +8%",
      { phase: "TURN_DYNAMIC", target: "次ターン", operation: "ADD +8",
        condition: "previousTurn == MISS", reset: "次ターンのみ" }),
    eq("sr_unyielding_ring", "SR", 5, "不屈の指輪",
      "同じ敵に敗北するたび全ターン +5%。最大+25%。その敵を撃破するとリセット",
      { phase: "ATTEMPT_STATE", target: "ALL", operation: "ADD +5*losses cap25",
        condition: "sameEnemyLossCount", reset: "対象敵撃破で0" }),
    eq("sr_slow_starter", "SR", 6, "スロースターター", "1T -10 / 2T +0 / 3T +5 / 4T +15 / 5T +25%",
      { phase: "BATTLE_STATIC", target: "各ターン", operation: "ADD table",
        condition: null, reset: null }),
    eq("sr_gale_sword", "SR", 7, "疾風の剣", "1ターン目 +30%。外れた場合2～5ターン目 -5%",
      { phase: "MIXED", target: "T1 / T2-T5", operation: "ADD +30 / -5",
        condition: "T1 MISSで後半-5", reset: "各バトル" }),
    eq("sr_fourth_awakening", "SR", 8, "四度目の覚醒", "1～3ターンがMISSなら4ターン目 +35%",
      { phase: "TURN_DYNAMIC", target: "T4", operation: "ADD +35",
        condition: "T1-T3 == MISS", reset: "各バトル" }),
    eq("sr_strong_slayer", "SR", 9, "強者殺し", "敵抵抗120以上なら全ターン +25%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +25",
        condition: "rawResistance >= 120", reset: null }),
    eq("sr_single_focus", "SR", 10, "一点集中", "1ターン目だけ +35%、それ以外 -5%",
      { phase: "LOADOUT_PARAM", target: "指定T / その他", operation: "ADD +35 / -5",
        condition: "selectedTurn=1..5", reset: "装備設定保存" },
      "selectedTurn"),
  ]);

  const SSR_EQUIPMENT = Object.freeze([
    eq("ssr_last_hero", "SSR", 1, "最後の英雄", "5ターン目のCRITICALで敵を倒すと、次の戦闘の全ターン +10%",
      { phase: "NEXT_BATTLE", target: "ALL", operation: "ADD +10",
        condition: "previousWinTurn == 5", reset: "次の1戦で消費" }),
    eq("ssr_tenacity", "SSR", 2, "執念",
      "同じ敵に敗北するたび全ターン +8%。最大+40%。その敵を撃破するとリセット",
      { phase: "ATTEMPT_STATE", target: "ALL", operation: "ADD +8*losses cap40",
        condition: "sameEnemyLossCount", reset: "対象敵撃破で0" }),
    eq("ssr_miracle_echo", "SSR", 3, "奇跡の残響", "前の敵を倒したターンと同じターンに、次戦 +25%",
      { phase: "NEXT_BATTLE", target: "previousWinTurn", operation: "ADD +25",
        condition: "previousBattle == WIN", reset: "次の1戦で消費" }),
    eq("ssr_victors_afterglow", "SSR", 4, "勝者の余韻",
      "前戦を1～2ターン目で撃破した場合、次戦の1～2ターン目 +20%",
      { phase: "NEXT_BATTLE", target: "T1,T2", operation: "ADD +20",
        condition: "previousWinTurn in [1,2]", reset: "次の1戦で消費" }),
    eq("ssr_memory_of_defeat", "SSR", 5, "敗北の記憶",
      "前回その敵に挑戦した時にMISSした各ターンへ、再戦時それぞれ +10%",
      { phase: "ATTEMPT_STATE", target: "missMask", operation: "ADD +10",
        condition: "previousAttemptSameEnemy", reset: "次回挑戦で参照" }),
    eq("ssr_discard_third", "SSR", 6, "捨て三", "3ターン目を0%にする代わりに4・5ターン目 +30%",
      { phase: "HARD_OVERRIDE", target: "T3 / T4,T5", operation: "FORCE 0 / ADD +30",
        condition: null, reset: "各バトル" }),
    eq("ssr_fate_acceleration", "SSR", 7, "運命加速", "MISSするたび、残りターンすべて +8%（累積）",
      { phase: "TURN_DYNAMIC", target: "futureTurns", operation: "ADD +8 per prior MISS",
        condition: "missCountThisBattle", reset: "バトル終了で0" }),
    eq("ssr_dying_luck", "SSR", 8, "瀕死の幸運", "1～4ターンすべてMISSなら5ターン目 +50%",
      { phase: "TURN_DYNAMIC", target: "T5", operation: "ADD +50",
        condition: "T1-T4 == MISS", reset: "各バトル" }),
    eq("ssr_weak_rebellion", "SSR", 9, "弱者の反逆", "敵抵抗150以上なら全ターン +30%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +30",
        condition: "rawResistance >= 150", reset: null }),
    eq("ssr_five_stars", "SSR", 10, "五連星", "1～4ターンすべてMISSなら5ターン目 +70%",
      { phase: "TURN_DYNAMIC", target: "T5", operation: "ADD +70",
        condition: "T1-T4 == MISS", reset: "各バトル" }),
  ]);

  const UR_EQUIPMENT = Object.freeze([
    eq("ur_scales_of_fate", "UR", 1, "運命の天秤",
      "1～4ターン目の最終CRITICALを25%減少し、5ターン目 +80%",
      { phase: "MIXED", target: "T1-T4 / T5", operation: "MULT x0.75 / ADD +80",
        condition: null, reset: "各バトル" }),
    eq("ur_odd_god_blessing", "UR", 2, "奇数神の祝福", "1・3・5ターン目 +45%、2・4ターン目 -15%",
      { phase: "BATTLE_STATIC", target: "odd/even", operation: "ADD +45 / -15",
        condition: null, reset: null }),
    eq("ur_even_god_blessing", "UR", 3, "偶数神の祝福", "2・4ターン目 +55%、1・3・5ターン目 -10%",
      { phase: "BATTLE_STATIC", target: "even/odd", operation: "ADD +55 / -10",
        condition: null, reset: null }),
    eq("ur_future_advance", "UR", 4, "未来への前借り", "1・2ターン目 -20%、4・5ターン目 +55%",
      { phase: "BATTLE_STATIC", target: "T1,T2 / T4,T5", operation: "ADD -20 / +55",
        condition: null, reset: null }),
    eq("ur_past_debt", "UR", 5, "過去からの借金", "1・2ターン目 +55%、4・5ターン目 -20%",
      { phase: "BATTLE_STATIC", target: "T1,T2 / T4,T5", operation: "ADD +55 / -20",
        condition: null, reset: null }),
    eq("ur_phoenix_mark", "UR", 6, "不死鳥の印",
      "同じ敵への3回目以降の挑戦で全ターン +45%。撃破でカウントリセット",
      { phase: "ATTEMPT_STATE", target: "ALL", operation: "ADD +45",
        condition: "sameEnemyAttemptCount >= 3", reset: "対象敵撃破で0" }),
    eq("ur_gambler", "UR", 7, "勝負師", "1～4ターン目の最終CRITICALを50%減少し、5ターン目 +80%",
      { phase: "MIXED", target: "T1-T4 / T5", operation: "MULT x0.5 / ADD +80",
        condition: null, reset: "各バトル" }),
    eq("ur_fate_accumulation", "UR", 8, "運命蓄積",
      "MISSするたび残りターンすべて +12%（累積）。撃破すると蓄積リセット",
      { phase: "TURN_DYNAMIC", target: "futureTurns", operation: "ADD +12 per prior MISS",
        condition: "missCountThisBattle", reset: "バトル終了で0" }),
    eq("ur_strong_foe_specialist", "UR", 9, "強敵専門", "敵抵抗200以上なら全ターン +50%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD +50",
        condition: "rawResistance >= 200", reset: null }),
    eq("ur_miracle_chain", "UR", 10, "奇跡の連鎖",
      "5ターン目撃破で次戦の全ターン +20%。連続達成で+40%、+60%まで上昇",
      { phase: "CHAIN_STATE", target: "ALL", operation: "ADD +20*chain cap60",
        condition: "fiveTurnWinChain", reset: "5T以外/敗北で0" }),
  ]);

  const LEGEND_EQUIPMENT = Object.freeze([
    eq("legend_sixth_miracle", "LEGEND", 1, "第六の奇跡",
      "5ターンすべてMISSした時、6回目の判定を1回だけ行う。6回目は5ターン目の最終CRITICAL +50%",
      { phase: "POST_FIVE_MISS", target: "EXTRA", operation: "chance=T5+50",
        condition: "five misses", reset: "1戦1回" }),
    eq("legend_fifth_miracle", "LEGEND", 2, "五度目の奇跡",
      "1～4ターン目を0%にする代わりに、5ターン目 +120%",
      { phase: "HARD_OVERRIDE", target: "T1-T4 / T5", operation: "FORCE0 / ADD +120",
        condition: null, reset: "各バトル" }),
    eq("legend_world_tree_clover", "LEGEND", 3, "世界樹の四葉",
      "全ターン +60%。ただし敵撃破時のダイヤ獲得量 -50%",
      { phase: "BATTLE_REWARD", target: "ALL", operation: "ADD +60 / reward x0.5",
        condition: null, reset: "各バトル" }),
    eq("legend_reaper_contract", "LEGEND", 4, "死神との契約",
      "全ターン +80%。ただし敗北すると、その周回中に獲得したダイヤをすべて失う",
      { phase: "BATTLE_REWARD", target: "ALL", operation: "ADD +80 / loss penalty",
        condition: null, reset: "敗北時ペナルティ" }),
    eq("legend_hero_curse", "LEGEND", 5, "勇者の呪い",
      "敵抵抗99以下では全ターン -20%。敵抵抗100以上では全ターン +60%",
      { phase: "BATTLE_STATIC", target: "ALL", operation: "ADD -20 or +60",
        condition: "rawResistance threshold", reset: null }),
    eq("legend_reversal_of_fate", "LEGEND", 6, "逆転の運命",
      "5ターンの最終CRITICAL計算後、最も高い確率を最も低い1ターンにも複製する",
      { phase: "POST_PROCESS", target: "lowestTurn", operation: "COPY maxChance",
        condition: "final rates computed", reset: "各再計算" }),
    eq("legend_all_or_nothing", "LEGEND", 7, "一か八か",
      "戦闘開始時にランダムな1ターンを選ぶ。そのターン +100%、残り4ターンは0%",
      { phase: "BATTLE_RANDOM", target: "randomT / others", operation: "ADD +100 / FORCE0",
        condition: "draw at battle start", reset: "1戦固定" }),
    eq("legend_godslayer", "LEGEND", 8, "神殺し",
      "敵抵抗200以上なら、敵抵抗値を20%無視する（例：抵抗300 → 240）",
      { phase: "RESIST_MOD", target: "ALL", operation: "resistance x0.8",
        condition: "rawResistance >= 200", reset: "各バトル" }),
    eq("legend_time_hourglass", "LEGEND", 9, "時渡りの砂時計",
      "5ターンすべてMISSした時、30%で5ターン目をもう一度だけやり直す",
      { phase: "POST_FIVE_MISS", target: "T5 RETRY", operation: "30% trigger",
        condition: "five misses", reset: "1戦1回" }),
    eq("legend_proof_of_hero", "LEGEND", 10, "英雄の証",
      "5ターンすべての最終CRITICAL率が異なる場合、全ターン +50%",
      { phase: "POST_PROCESS", target: "ALL", operation: "ADD +50",
        condition: "pre-self rates all distinct", reset: "各再計算" }),
  ]);

  const EQUIPMENT_BY_RARITY = Object.freeze({
    N: N_EQUIPMENT,
    R: R_EQUIPMENT,
    SR: SR_EQUIPMENT,
    SSR: SSR_EQUIPMENT,
    UR: UR_EQUIPMENT,
    LEGEND: LEGEND_EQUIPMENT,
  });

  // レア度順（N → LEGEND）に並べた全60種。装備ボックスの既定の並びもこれ。
  const EQUIPMENT = Object.freeze(RARITIES.flatMap((rarity) => EQUIPMENT_BY_RARITY[rarity]));

  const EQUIPMENT_BY_ID = Object.freeze(
    EQUIPMENT.reduce((map, item) => Object.assign(map, { [item.id]: item }), {})
  );

  function getEquipment(id) {
    const found = EQUIPMENT_BY_ID[id];
    if (!found) throw new Error(`unknown equipmentId: ${id}`);
    return found;
  }

  // ---- 同時発動の順序 --------------------------------------------------------
  // どちらも「同時装備できてしまう」ため、順序を決めておかないと結果が一意にならない。
  // 装備スロットの並び順には**依存させない**。この配列が唯一の順序。

  // P9（5ターン横断処理）の適用順。docs/PHASES.md の D1 で確定。
  // 英雄の証を先に判定・適用し、そのあと逆転の運命で複製する。
  // 逆にすると複製で2ターンが同値になり、英雄の証の「5つすべて異なる」が成立しなくなる。
  const POST_PROCESS_ORDER = Object.freeze(["legend_proof_of_hero", "legend_reversal_of_fate"]);

  // 5MISS後の追加判定の優先順位（ロジック仕様書 05）。
  // 砂時計が先。未発動または再抽選もMISSだった場合に第六の奇跡へ進む。
  const POST_FIVE_MISS_ORDER = Object.freeze(["legend_time_hourglass", "legend_sixth_miracle"]);

  Object.assign(ns, {
    N_EQUIPMENT,
    R_EQUIPMENT,
    SR_EQUIPMENT,
    SSR_EQUIPMENT,
    UR_EQUIPMENT,
    LEGEND_EQUIPMENT,
    EQUIPMENT_BY_RARITY,
    EQUIPMENT,
    EQUIPMENT_BY_ID,
    POST_PROCESS_ORDER,
    POST_FIVE_MISS_ORDER,
    getEquipment,
  });
})(globalThis);
