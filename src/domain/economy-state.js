(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { DUPLICATE_SALE_DIAMONDS, getEquipment } = ns;

  // ダイヤ残高と所持装備。仕様書 15 の `currency.diamond` /
  // `inventory.ownedEquipmentIds` / `encyclopedia.claimedRewards` にあたる。
  //
  // メモリ上の状態だけを持つ。localStorage もDOMも触らない（保存は Phase 08）。
  //
  // 図鑑のしきい値報酬の受取済みをここへ置いているのは、それが
  // 「どの一度きりのダイヤを受け取ったか」という台帳だから。払う側と同じ場所にある。

  class EconomyState {
    constructor({ diamonds = 0, ownedEquipmentIds = [], claimedEncyclopediaRewards = [] } = {}) {
      if (!Number.isFinite(diamonds) || diamonds < 0) {
        throw new RangeError(`ダイヤ残高は0以上: ${diamonds}`);
      }
      this.diamonds = diamonds;
      // 同名装備は複数持たない。0/1のフラグ管理（仕様書 13）。
      this.ownedEquipmentIds = new Set(ownedEquipmentIds);
      this.claimedEncyclopediaRewards = new Set(claimedEncyclopediaRewards);
    }

    // --- ダイヤ ---------------------------------------------------------------

    getDiamonds() {
      return this.diamonds;
    }

    canAfford(cost) {
      return this.diamonds >= cost;
    }

    addDiamonds(amount) {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new RangeError(`加算できるのは0以上の有限な数値: ${amount}`);
      }
      this.diamonds += amount;
      return this.diamonds;
    }

    // 足りなければ何もしないで false。呼ぶ側が canAfford で先に見る想定だが、
    // ここでも払えない支払いを通さない。
    spendDiamonds(amount) {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new RangeError(`支払えるのは0以上の有限な数値: ${amount}`);
      }
      if (this.diamonds < amount) return false;
      this.diamonds -= amount;
      return true;
    }

    // 死神との契約の没収。残高より多く没収しようとしても0で止める（負数にしない）。
    // 実際に失った額を返す。
    forfeitDiamonds(amount) {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new RangeError(`没収できるのは0以上の有限な数値: ${amount}`);
      }
      const lost = Math.min(amount, this.diamonds);
      this.diamonds -= lost;
      return lost;
    }

    // --- 所持装備 -------------------------------------------------------------

    owns(equipmentId) {
      return this.ownedEquipmentIds.has(equipmentId);
    }

    getOwnedEquipmentIds() {
      return Object.freeze([...this.ownedEquipmentIds]);
    }

    // 装備を1つ手に入れる。未所持なら所持へ、既所持なら足さずに自動売却（仕様書 13）。
    // 装備中かどうかは見ない。装備中の重複を取っても、装備状態はそのままで売却だけ起きる。
    acquireEquipment(equipmentId) {
      const equipment = getEquipment(equipmentId);
      if (this.ownedEquipmentIds.has(equipmentId)) {
        const sale = DUPLICATE_SALE_DIAMONDS[equipment.rarity];
        this.addDiamonds(sale);
        return Object.freeze({
          equipmentId,
          rarity: equipment.rarity,
          isNew: false,
          duplicateSaleDiamonds: sale,
        });
      }
      this.ownedEquipmentIds.add(equipmentId);
      return Object.freeze({
        equipmentId,
        rarity: equipment.rarity,
        isNew: true,
        duplicateSaleDiamonds: 0,
      });
    }

    // --- 図鑑しきい値報酬の受取台帳 -------------------------------------------

    hasClaimedEncyclopediaReward(count) {
      return this.claimedEncyclopediaRewards.has(count);
    }

    claimEncyclopediaReward(count) {
      if (this.claimedEncyclopediaRewards.has(count)) return false;
      this.claimedEncyclopediaRewards.add(count);
      return true;
    }

    getState() {
      return Object.freeze({
        diamonds: this.diamonds,
        ownedEquipmentIds: Object.freeze([...this.ownedEquipmentIds]),
        claimedEncyclopediaRewards: Object.freeze([...this.claimedEncyclopediaRewards].sort((a, b) => a - b)),
      });
    }
  }

  Object.assign(ns, { EconomyState });
})(globalThis);
