(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { ROUTES } = ns;

  // 撃破報酬・宝箱・図鑑報酬の静的データ。
  // 出典：ゲームロジック仕様書 11「撃破報酬・宝箱・図鑑報酬」、ゲーム企画書 04 / 08。
  //
  // 撃破ダイヤの倍率（rawResistance × 2）は CONSTANTS.killDiamondMultiplier 側にある。

  // 勝利時の処理順（ロジック仕様書 11）。ここを入れ替えると二重受取や
  // 「解放前の報酬」が起きるので、順序自体をデータとして固定しておく。
  const WIN_SEQUENCE = Object.freeze([
    "killDiamond",      // ① 撃破ダイヤ
    "treasureBox",      // ② 宝箱抽選
    "encyclopedia",     // ③ 図鑑初登録 / 閾値報酬
    "unlock",           // ④ 装備枠 / ルート解放
    "winScreenData",    // ⑤ WIN画面表示用データ確定
  ]);

  function boxRule(route, stageFrom, stageTo, firstKill, dropRate, rarityRates) {
    return Object.freeze({
      route,
      stageFrom,
      stageTo,
      // true = 初回撃破のみ / false = 2回目以降のみ / null = 初回かどうかを問わない
      firstKill,
      dropRate,
      rarityRates: Object.freeze(rarityRates),
    });
  }

  // 宝箱のドロップ率と、箱の中のレア率。表にない区間（通常1〜9、SPECIAL）は宝箱が出ない。
  // 上から順に最初に当てはまったものを使う。
  const TREASURE_BOX_RULES = Object.freeze([
    boxRule(ROUTES.NORMAL, 10, 10, true, 100, { SSR: 70, UR: 29, LEGEND: 1 }),
    boxRule(ROUTES.NORMAL, 10, 10, false, 5, { SSR: 70, UR: 29, LEGEND: 1 }),
    boxRule(ROUTES.BACK, 1, 4, null, 5, { SSR: 70, UR: 29, LEGEND: 1 }),
    boxRule(ROUTES.BACK, 5, 9, null, 5, { SSR: 50, UR: 40, LEGEND: 10 }),
    boxRule(ROUTES.BACK, 10, 10, true, 100, { UR: 50, LEGEND: 50 }),
    boxRule(ROUTES.BACK, 10, 10, false, 5, { UR: 50, LEGEND: 50 }),
  ]);

  // 該当する宝箱ルールを引く。当てはまらなければ null（＝宝箱なし）。
  // ここは表引きだけ。実際に抽選するのは RewardService（Phase 06）。
  function findTreasureBoxRule(route, stage, isFirstKill) {
    const found = TREASURE_BOX_RULES.find((rule) => (
      rule.route === route
      && stage >= rule.stageFrom
      && stage <= rule.stageTo
      && (rule.firstKill === null || rule.firstKill === isFirstKill)
    ));
    return found || null;
  }

  // 図鑑登録数の到達報酬。各しきい値で一度だけ受け取れる（ロジック仕様書 11 / 企画書 08）。
  // 20体目はダイヤではなくSPECIAL「隠居した神」の解放そのものが報酬。
  const ENCYCLOPEDIA_REWARDS = Object.freeze([
    Object.freeze({ count: 5, diamonds: 1000, unlocksSpecial: false }),
    Object.freeze({ count: 10, diamonds: 1000, unlocksSpecial: false }),
    Object.freeze({ count: 13, diamonds: 1000, unlocksSpecial: false }),
    Object.freeze({ count: 15, diamonds: 1000, unlocksSpecial: false }),
    Object.freeze({ count: 18, diamonds: 1000, unlocksSpecial: false }),
    Object.freeze({ count: 19, diamonds: 1000, unlocksSpecial: false }),
    Object.freeze({ count: 20, diamonds: 0, unlocksSpecial: true }),
  ]);

  Object.assign(ns, {
    WIN_SEQUENCE,
    TREASURE_BOX_RULES,
    ENCYCLOPEDIA_REWARDS,
    findTreasureBoxRule,
  });
})(globalThis);
