(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;

  // ゲーム全体の定数。出典はゲームロジック仕様書 01「定数・用語・データ型」。
  // 数値をロジックへ直書きしない。ここと各Catalogだけが数値の出どころ。

  // レアリティ。この並び順が「レア度順」の正（装備ボックスの並びもこの順）。
  const RARITIES = Object.freeze(["N", "R", "SR", "SSR", "UR", "LEGEND"]);

  // ルート。通常 / 裏 / SPECIAL「隠居した神」。
  const ROUTES = Object.freeze({ NORMAL: "normal", BACK: "back", SPECIAL: "special" });

  const CONSTANTS = Object.freeze({
    // 勇者の基礎CRITICAL率。ここから敵抵抗を引くのが計算の出発点。
    baseCriticalPercent: 100,
    // 1戦の通常ターン数。砂時計・第六の奇跡の追加判定はこの5に含めない。
    turnsPerBattle: 5,
    // 確率のClamp範囲（勇者の血の適用前）。
    minChancePercent: 0,
    maxChancePercent: 100,
    // 勇者の血：5ターンすべてが0.0のときだけ、5ターンすべてをこの値へ置換する。
    // 1つでも0より大きければ置換しない（ロジック仕様書 09 / BT-007）。
    heroBloodPercent: 0.1,
    // 撃破ダイヤ = 敵のrawResistance × この倍率。
    killDiamondMultiplier: 2,
    // 装備枠の上限。裏STAGE5の初撃破で到達する。
    maxEquipmentSlots: 5,
  });

  Object.assign(ns, { CONSTANTS, RARITIES, ROUTES });
})(globalThis);
