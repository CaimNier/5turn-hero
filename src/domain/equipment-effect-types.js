(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;

  // 装備効果定義で使う語彙。文字列をあちこちへ直書きしないための置き場所。
  // 値はロジック仕様書 06〜08 の列名をそのまま使う。

  // 仕様書 08「Phase」列。装備がどういう性格の効果かを表す分類で、
  // 計算のフェーズ（P1〜P9）とは別物。計算フェーズは EFFECT_KINDS のほう。
  const TRIGGERS = Object.freeze({
    BATTLE_STATIC: "BATTLE_STATIC", // 戦闘開始時点で値が決まる
    TURN_DYNAMIC: "TURN_DYNAMIC", // 戦闘中のMISSで変わる
    ATTEMPT_STATE: "ATTEMPT_STATE", // 同一敵への敗北/挑戦回数
    NEXT_BATTLE: "NEXT_BATTLE", // 前戦の結果を次の1戦だけ持ち越す
    CHAIN_STATE: "CHAIN_STATE", // 連続5ターン撃破
    LOADOUT_PARAM: "LOADOUT_PARAM", // 装備設定時に選ぶ値
    BATTLE_RANDOM: "BATTLE_RANDOM", // 戦闘開始時に抽選
    HARD_OVERRIDE: "HARD_OVERRIDE", // FORCE
    POST_PROCESS: "POST_PROCESS", // 5値を見てから処理
    POST_FIVE_MISS: "POST_FIVE_MISS", // 5MISS後の追加判定
    BATTLE_REWARD: "BATTLE_REWARD", // 報酬側にも作用
    RESIST_MOD: "RESIST_MOD", // 敵抵抗そのものを変える
    MIXED: "MIXED", // 上記の組み合わせ
  });

  // その効果の値が「いつ確定するか」。バトル前プレビューの表示判断に使う。
  // 仕様書には無い区分だが、開始前に見せてよい効果と、MISSが起きて初めて動く効果を
  // 呼び出し側が区別できないと、プレビューの作りが装備ごとの特例だらけになるため。
  const DETERMINACY = Object.freeze({
    // 敵・装備・保存状態だけで決まる。バトル前から確定している。
    PRE_BATTLE: "PRE_BATTLE",
    // 戦闘中のMISSで変わる。開始前は未発動（missAssumption が "actual" のとき）。
    IN_BATTLE: "IN_BATTLE",
    // 戦闘開始時の抽選で決まる。プレビュー時点では未確定（仕様書 03「RANDOM」表示）。
    BATTLE_START_RANDOM: "BATTLE_START_RANDOM",
    // 通常5ターンの外。5MISS後にだけ意味を持つ。
    POST_FIVE_MISS: "POST_FIVE_MISS",
  });

  // contribution の種類。BattleEffects の各作り手＝計算フェーズに1対1で対応する。
  const EFFECT_KINDS = Object.freeze({
    RESIST_MULT: "RESIST_MULT", // P1
    ADD: "ADD", // P2
    MISS_ADD: "MISS_ADD", // P3
    FORCE: "FORCE", // P6
    MULT: "MULT", // P7
    CROSS_TURN: "CROSS_TURN", // P9
  });

  // 5MISS後の追加判定の種類。進行させるのは BattleSession（Phase 04）。
  const POST_FIVE_MISS_KINDS = Object.freeze({
    RETRY_TURN: "RETRY_TURN", // そのターンをもう一度抽選する（時渡りの砂時計）
    EXTRA_ROLL: "EXTRA_ROLL", // 通常ターン外の追加判定（第六の奇跡）
  });

  // 仕様書 07「装備状態の保存・リセット規則」。
  // 実際にリセットを行うのは BattleSession / Progression（Phase 04以降）。
  // ここは「この装備はどの状態に依存し、いつ消えるか」を機械で引けるようにするためのラベル。
  const RESETS = Object.freeze({
    NONE: "NONE",
    EACH_BATTLE: "EACH_BATTLE", // 毎戦ゼロから
    BATTLE_END: "BATTLE_END", // 戦闘終了で累積を0（MISS累積）
    TARGET_ENEMY_DEFEATED: "TARGET_ENEMY_DEFEATED", // その敵を撃破したら0
    NEXT_BATTLE_CONSUMED: "NEXT_BATTLE_CONSUMED", // 次の1戦で消費
    NEXT_ATTEMPT: "NEXT_ATTEMPT", // 次回挑戦時に更新
    ONCE_PER_BATTLE: "ONCE_PER_BATTLE", // 1戦1回
    CHAIN_BROKEN: "CHAIN_BROKEN", // 5T以外の勝利/敗北で0
    LOADOUT_SAVED: "LOADOUT_SAVED", // 装備設定として保存される
    ON_LOSS: "ON_LOSS", // 敗北時にペナルティ
  });

  // 同一フェーズ内の適用順。小さいほど先。
  //
  // FORCE は現行60装備がすべて値0なので順序で結果が変わらないが、将来の競合に備えて
  // 定義側が明示できるようにしてある（PHASES.md J2）。装備スロットの並びは見ない。
  //
  // P9（英雄の証 → 逆転の運命）と5MISS後（砂時計 → 第六の奇跡）の順序はここに持たない。
  // equipment-catalog.js の POST_PROCESS_ORDER / POST_FIVE_MISS_ORDER が唯一の出どころで、
  // 定義側はその並び順から order を作る（D1・ロジック仕様書 05）。
  const PRIORITIES = Object.freeze({
    DEFAULT: 0,
    FORCE_DISCARD_TURN: 10, // 捨て三
    FORCE_FIFTH_MIRACLE: 20, // 五度目の奇跡
    FORCE_ALL_OR_NOTHING: 30, // 一か八か（非選択ターン）
  });

  Object.assign(ns, {
    EquipmentEffectTypes: Object.freeze({
      TRIGGERS,
      DETERMINACY,
      EFFECT_KINDS,
      POST_FIVE_MISS_KINDS,
      RESETS,
      PRIORITIES,
    }),
  });
})(globalThis);
