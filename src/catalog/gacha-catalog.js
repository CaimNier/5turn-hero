(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;

  // ガチャの静的データ。
  // 出典：ゲームロジック仕様書 12「ガチャ抽選ロジック」/ 13「所持装備・重複処理」、
  // ゲーム企画書 04「報酬・収集・ガチャ」、UI仕様書 07。
  //
  // ガチャは1種類だけ。割引・10連保証・天井は**現仕様に無い**。足さないこと。

  // 引き方。10連は「10回の独立抽選」であって、まとめ抽選ではない。
  const GACHA_PULLS = Object.freeze([
    Object.freeze({ id: "single", price: 100, pullCount: 1, label: "1回引く" }),
    Object.freeze({ id: "ten", price: 1000, pullCount: 10, label: "10回引く" }),
  ]);

  // レアリティ排出率（%）。合計100。各pullで独立に引く。
  const RARITY_RATES = Object.freeze({
    N: 40,
    R: 30,
    SR: 20,
    SSR: 8,
    UR: 1.5,
    LEGEND: 0.5,
  });

  // 箱の種類。レア抽選の**結果を変えない**演出（ロジック仕様書 12 / UI仕様書 07）。
  // guarantees は「その箱が出たらプレイヤーに分かる保証の下限」。
  const BOXES = Object.freeze([
    Object.freeze({ id: "wood", label: "木箱", guarantees: "全ランク" }),
    Object.freeze({ id: "red", label: "赤箱", guarantees: "SR以上" }),
    Object.freeze({ id: "gold", label: "金箱", guarantees: "SSR以上" }),
    Object.freeze({ id: "rainbow", label: "虹箱", guarantees: "LEGEND確定" }),
  ]);

  // 当選レアごとの箱演出の抽選率（%）。各行の合計が100。
  const BOX_RATES = Object.freeze({
    N: Object.freeze({ wood: 100, red: 0, gold: 0, rainbow: 0 }),
    R: Object.freeze({ wood: 100, red: 0, gold: 0, rainbow: 0 }),
    SR: Object.freeze({ wood: 50, red: 50, gold: 0, rainbow: 0 }),
    SSR: Object.freeze({ wood: 35, red: 45, gold: 20, rainbow: 0 }),
    UR: Object.freeze({ wood: 30, red: 40, gold: 30, rainbow: 0 }),
    LEGEND: Object.freeze({ wood: 10, red: 20, gold: 30, rainbow: 40 }),
  });

  // 重複入手時の自動売却ダイヤ（レア別）。
  // 所持は0/1のフラグで、同名装備を複数持たない（ロジック仕様書 13）。
  const DUPLICATE_SALE_DIAMONDS = Object.freeze({
    N: 10,
    R: 20,
    SR: 30,
    SSR: 50,
    UR: 100,
    LEGEND: 300,
  });

  function getPull(id) {
    const found = GACHA_PULLS.find((item) => item.id === id);
    if (!found) throw new Error(`unknown gacha pull: ${id}`);
    return found;
  }

  Object.assign(ns, {
    GACHA_PULLS,
    RARITY_RATES,
    BOXES,
    BOX_RATES,
    DUPLICATE_SALE_DIAMONDS,
    getPull,
  });
})(globalThis);
