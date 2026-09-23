(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { EQUIPMENT, ENEMIES, getEnemy, ROUTES } = ns;

  // RECORD。仕様書 14「図鑑・RECORD 更新ロジック」の各カウンタと、
  // 通常クリア／TRUE CLEAR のスナップショット。
  //
  // 数えるだけ。画面もセーブも触らない（保存は Phase 08）。
  // 数える元は Phase 04 の BattleResult.recordDelta で、ここで数え直さない。

  const SNAPSHOT_KINDS = Object.freeze({ NORMAL_CLEAR: "NORMAL_CLEAR", TRUE_CLEAR: "TRUE_CLEAR" });

  // 同数のときの並び順。カタログの並び（レア度順・ルートとStage順）で決める。
  // 表示のたびに違うものが出ないよう、乱数もオブジェクトのキー順も使わない。
  const EQUIPMENT_ORDER = new Map(EQUIPMENT.map((equipment, index) => [equipment.id, index]));
  const ENEMY_ORDER = new Map(ENEMIES.map((enemy, index) => [enemy.id, index]));

  // 最大値を1つ選ぶ。同数ならカタログ順で先のほう。全部0なら null。
  function topEntry(counts, order) {
    let best = null;
    Object.keys(counts).forEach((id) => {
      const count = counts[id];
      if (count <= 0) return;
      if (best === null
        || count > best.count
        || (count === best.count && (order.get(id) ?? Infinity) < (order.get(best.id) ?? Infinity))) {
        best = { id, count };
      }
    });
    return best === null ? null : Object.freeze(best);
  }

  function bump(counts, key, amount) {
    if (!amount) return;
    counts[key] = (counts[key] || 0) + amount;
  }

  class RecordState {
    constructor(initial = {}) {
      this.totals = Object.assign({
        totalTaps: 0,
        totalCriticals: 0,
        totalMisses: 0,
        totalDefeats: 0,
        totalKills: 0,
        gachaPullCount: 0,
        extraJudgementCount: 0,
      }, initial.totals);
      this.equipmentUseCounts = Object.assign({}, initial.equipmentUseCounts);
      this.enemyKillCounts = Object.assign({}, initial.enemyKillCounts);
      // 敗北数は全敵ぶん持つ。図鑑が表示するのは裏敵だけなので、そちらは導出で出す。
      this.enemyLossCounts = Object.assign({}, initial.enemyLossCounts);
      this.snapshots = Object.assign({ NORMAL_CLEAR: null, TRUE_CLEAR: null }, initial.snapshots);
    }

    // Phase 04 の BattleResult を1戦ぶん取り込む。
    // 追加判定は総タップへ入らず、CRITICAL/MISS と extraJudgementCount へ入る（D4）。
    applyBattleResult(battleResult) {
      const delta = battleResult.recordDelta;
      if (!delta) throw new TypeError("BattleResult に recordDelta が無い");

      this.totals.totalTaps += delta.totalTap;
      this.totals.totalCriticals += delta.totalCritical;
      this.totals.totalMisses += delta.totalMiss;
      this.totals.totalDefeats += delta.totalDefeat;
      this.totals.totalKills += delta.totalKill;
      this.totals.extraJudgementCount += delta.extraJudgement;

      // 装備使用回数はBattleStart時に装備中だった各IDへ+1。敗北しても取り消さない。
      // 未解放枠・重複・未知IDは BattleSession が落としたあとのものだけが入っている。
      Object.keys(delta.equipmentUsage).forEach((equipmentId) => {
        bump(this.equipmentUseCounts, equipmentId, delta.equipmentUsage[equipmentId]);
      });

      const enemyId = battleResult.enemyId;
      if (enemyId) {
        bump(this.enemyKillCounts, enemyId, delta.enemyKillCount);
        bump(this.enemyLossCounts, enemyId, delta.totalDefeat);
      }
      return this.getState();
    }

    addGachaPulls(count) {
      if (!Number.isInteger(count) || count < 0) throw new RangeError(`ガチャ回数は0以上の整数: ${count}`);
      this.totals.gachaPullCount += count;
      return this.totals.gachaPullCount;
    }

    // 図鑑が表示するのは裏敵の敗北数（企画書 08）。全敵ぶんから絞って返す。
    getBackEnemyLossCounts() {
      const counts = {};
      Object.keys(this.enemyLossCounts).forEach((enemyId) => {
        if (getEnemy(enemyId).route === ROUTES.BACK) counts[enemyId] = this.enemyLossCounts[enemyId];
      });
      return counts;
    }

    getMostUsedEquipment() {
      return topEntry(this.equipmentUseCounts, EQUIPMENT_ORDER);
    }

    getMostDefeatedEnemy() {
      return topEntry(this.enemyLossCounts, ENEMY_ORDER);
    }

    // --- スナップショット -----------------------------------------------------

    // 通常10初回クリアと神初撃破の時点の記録を写す（仕様書 14）。
    // 初回の1回だけ。再クリアで上書きしない。
    takeSnapshot(kind, { equippedIds = [], takenAt = null } = {}) {
      if (!SNAPSHOT_KINDS[kind]) throw new Error(`unknown snapshot kind: ${kind}`);
      if (this.snapshots[kind]) return null;
      const mostUsed = this.getMostUsedEquipment();
      const mostDefeated = this.getMostDefeatedEnemy();
      const snapshot = Object.freeze({
        kind,
        takenAt,
        totalTaps: this.totals.totalTaps,
        totalCriticals: this.totals.totalCriticals,
        totalMisses: this.totals.totalMisses,
        totalDefeats: this.totals.totalDefeats,
        totalKills: this.totals.totalKills,
        gachaPullCount: this.totals.gachaPullCount,
        extraJudgementCount: this.totals.extraJudgementCount,
        mostUsedEquipment: mostUsed,
        mostDefeatedEnemy: mostDefeated,
        // クリア時の装備5枠。BattleSession が正規化した並びをそのまま写す。
        equippedIds: Object.freeze(equippedIds.slice()),
      });
      this.snapshots[kind] = snapshot;
      return snapshot;
    }

    getSnapshot(kind) {
      if (!SNAPSHOT_KINDS[kind]) throw new Error(`unknown snapshot kind: ${kind}`);
      return this.snapshots[kind];
    }

    getState() {
      return Object.freeze({
        totals: Object.freeze(Object.assign({}, this.totals)),
        equipmentUseCounts: Object.freeze(Object.assign({}, this.equipmentUseCounts)),
        enemyKillCounts: Object.freeze(Object.assign({}, this.enemyKillCounts)),
        enemyLossCounts: Object.freeze(Object.assign({}, this.enemyLossCounts)),
        backEnemyLossCounts: Object.freeze(this.getBackEnemyLossCounts()),
        mostUsedEquipment: this.getMostUsedEquipment(),
        mostDefeatedEnemy: this.getMostDefeatedEnemy(),
        snapshots: Object.freeze({
          NORMAL_CLEAR: this.snapshots.NORMAL_CLEAR,
          TRUE_CLEAR: this.snapshots.TRUE_CLEAR,
        }),
      });
    }
  }

  Object.assign(ns, { RecordState: Object.assign(RecordState, { SNAPSHOT_KINDS }) });
})(globalThis);
