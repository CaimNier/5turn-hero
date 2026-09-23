(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { CONSTANTS, BattleEffects } = ns;

  // 5ターンのCRITICAL率を出す純粋関数。状態を持たず、画面もセーブも乱数も触らない。
  // 同じ入力なら必ず同じ5値を返す（ロジック仕様書 20「計算(pure)と状態更新(session)を分離する」）。
  //
  // 処理順はロジック仕様書 02 の P0〜P10 をそのまま並べたもの。ここを崩さない：
  //   P1 抵抗補正 → P2 固定加算 → P3 MISS依存加算 → P4 抵抗減算 → P5 Clamp
  //   → P6 FORCE → P7 倍率 → P8 Clamp → P9 5ターン横断 → P10 勇者の血
  //
  // 「+10%」は相対10%増ではなく10ポイント加算（仕様書 00 の但し書き）。
  // 加算はすべて P2/P3 で合算してから P4 で抵抗を引くので、この文書での「+10」は
  // そのまま additive への +10 になる。5% × 1.10 という計算はどこにも無い。
  //
  // 装備そのものの発動条件はここに書かない。Phase 03 の効果エンジンが解決した結果を
  // BattleEffects の contribution として受け取るだけ（装備IDごとのifを持たない）。

  const TURN_COUNT = CONSTANTS.turnsPerBattle;

  function clampChance(chance) {
    return Math.min(CONSTANTS.maxChancePercent, Math.max(CONSTANTS.minChancePercent, chance));
  }

  // MISSの数え方は2通りある。既定は "conditional"。
  //
  // conditional … そのターンへ到達した＝手前は全てMISS、として数える。
  //   ロジック仕様書 03 のバトル前5ターン確率と、AC-019 / AC-053 / AC-055 などが
  //   要求する条件付き経路。CRITICALが出れば戦闘は終わるので、実戦でも
  //   「到達したターンの手前は全てMISS」以外の経路は無く、実戦の表示とも一致する。
  //
  // actual … 実際に記録されたMISS（missedTurns）だけを数える。
  //   まだ起きていないMISSを仮定せずに「今の状態」を出したいときに使う。
  //   開始前は missedTurns が空なので、MISS依存装備は未発動のまま表示される。
  //
  // 戦闘中は両者が一致する（到達済みターンは全てMISSしている）ので、
  // BattleSession はどちらで呼んでも同じ値になる。
  const MISS_ASSUMPTIONS = Object.freeze({ CONDITIONAL: "conditional", ACTUAL: "actual" });

  function priorMissesFor(turn, missAssumption, missedTurns) {
    const prior = [];
    for (let earlier = 1; earlier < turn; earlier += 1) {
      if (missAssumption === MISS_ASSUMPTIONS.CONDITIONAL || missedTurns.includes(earlier)) {
        prior.push(earlier);
      }
    }
    return prior;
  }

  function turnContext(turn, rawResistance, effectiveResistance, state, priorMissedTurns) {
    return Object.freeze({
      turn,
      rawResistance,
      effectiveResistance,
      priorMissCount: priorMissedTurns.length,
      priorMissedTurns: Object.freeze(priorMissedTurns),
      state,
    });
  }

  function sumAdds(contributions, turn, context) {
    let total = 0;
    contributions.forEach((contribution) => {
      if (!contribution.turns.includes(turn)) return;
      if (!BattleEffects.isActive(contribution, context)) return;
      total += BattleEffects.resolveValue(contribution, context);
    });
    return total;
  }

  // P1：抵抗値補正。神殺しの「抵抗200以上なら20%無視」は multiplier 0.8 として渡ってくる。
  // 条件が rawResistance を見るのは呼び出し側（context.rawResistance を渡してある）。
  // 補正後に抵抗が負になる意味は無いので0で止める。
  function applyResistanceModifiers(rawResistance, modifiers, state) {
    let effective = rawResistance;
    modifiers.forEach((modifier) => {
      const context = Object.freeze({ rawResistance, effectiveResistance: effective, state });
      if (!BattleEffects.isActive(modifier, context)) return;
      effective = Math.max(0, effective * BattleEffects.resolveValue(modifier, context));
    });
    return effective;
  }

  // P9：5値を見る処理。order順に回すので、装備スロットの並びで結果が変わらない
  //（PHASES.md D1。順序は BattleEffects.crossTurn の order で固定する）。
  // 各効果のあとでClampするのは、英雄の証の「+50 → Clamp」を効果ごとに書かせないため。
  function applyCrossTurnPostProcess(chances, rawResistance, effectiveResistance, state, contributions) {
    let current = chances.slice();
    contributions.forEach((contribution) => {
      const context = Object.freeze({
        rawResistance,
        effectiveResistance,
        state,
        chances: Object.freeze(current.slice()),
      });
      if (!BattleEffects.isActive(contribution, context)) return;
      const next = contribution.apply(current.slice(), context);
      if (!Array.isArray(next) || next.length !== TURN_COUNT) {
        throw new TypeError(`${contribution.source}: crossTurn は${TURN_COUNT}要素の配列を返す`);
      }
      current = next.map((value, index) => {
        if (!Number.isFinite(value)) {
          throw new TypeError(`${contribution.source}: crossTurn の T${index + 1} が数値でない`);
        }
        return clampChance(value);
      });
    });
    return current;
  }

  // 5ターン分のCRITICAL率を出す。
  //
  //   rawResistance … 敵のresistance。抵抗値テスト画面の入力値もここへ入れる。
  //   effects       … Phase 03 の効果エンジンが作った contribution の配列。
  //   state         … 敗北回数・前戦結果などの戦闘外状態。Calculator は中身を解釈せず、
  //                   contribution の条件式（when）と値（value）へそのまま渡すだけ。
  function calculateChancePath({
    rawResistance,
    effects = [],
    state = {},
    missAssumption = MISS_ASSUMPTIONS.CONDITIONAL,
    missedTurns = [],
  } = {}) {
    if (!Number.isFinite(rawResistance) || rawResistance < 0) {
      throw new TypeError(`rawResistance は0以上の有限な数値: ${rawResistance}`);
    }
    if (missAssumption !== MISS_ASSUMPTIONS.CONDITIONAL && missAssumption !== MISS_ASSUMPTIONS.ACTUAL) {
      throw new TypeError(`missAssumption は conditional か actual: ${missAssumption}`);
    }
    if (!Array.isArray(missedTurns)) throw new TypeError("missedTurns は配列");
    const buckets = BattleEffects.normalize(effects);

    const effectiveResistance = applyResistanceModifiers(rawResistance, buckets.resistance, state);

    const stages = {
      staticAdd: [],
      missDependentAdd: [],
      additive: [],
      afterResistance: [],
      firstClamp: [],
      afterForce: [],
      afterMultiplier: [],
      secondClamp: [],
      crossTurn: [],
    };

    for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
      const context = turnContext(turn, rawResistance, effectiveResistance, state,
        priorMissesFor(turn, missAssumption, missedTurns));

      const staticAdd = sumAdds(buckets.staticAdds, turn, context); // P2
      const missAdd = sumAdds(buckets.missDependentAdds, turn, context); // P3
      const additive = staticAdd + missAdd;

      // P4：chance = 100 + additiveTotal - effectiveResistance
      const afterResistance = CONSTANTS.baseCriticalPercent + additive - effectiveResistance;
      const firstClamp = clampChance(afterResistance); // P5

      // P6：FORCEは一次Clamp後の値を上書きする。ADDで戻さない（ロジック仕様書 09）。
      // 同一ターンへ複数来たら priority の高いほうが後に効く（BattleEffects.normalize が
      // 昇順に並べ替え済み）。現行60装備のFORCEはすべて0なので結果は順序に依らない。
      let afterForce = firstClamp;
      buckets.forces.forEach((contribution) => {
        if (!contribution.turns.includes(turn)) return;
        if (!BattleEffects.isActive(contribution, context)) return;
        afterForce = BattleEffects.resolveValue(contribution, context);
      });

      // P7：倍率。複数あれば順に乗算（x0.5 と x0.75 → x0.375）。乗算なので順序に依らない。
      let afterMultiplier = afterForce;
      buckets.multipliers.forEach((contribution) => {
        if (!contribution.turns.includes(turn)) return;
        if (!BattleEffects.isActive(contribution, context)) return;
        afterMultiplier *= BattleEffects.resolveValue(contribution, context);
      });

      stages.staticAdd.push(staticAdd);
      stages.missDependentAdd.push(missAdd);
      stages.additive.push(additive);
      stages.afterResistance.push(afterResistance);
      stages.firstClamp.push(firstClamp);
      stages.afterForce.push(afterForce);
      stages.afterMultiplier.push(afterMultiplier);
      stages.secondClamp.push(clampChance(afterMultiplier)); // P8
    }

    // P9
    stages.crossTurn = applyCrossTurnPostProcess(
      stages.secondClamp,
      rawResistance,
      effectiveResistance,
      state,
      buckets.crossTurn,
    );

    // P10：勇者の血。5ターンすべてがちょうど0のときだけ、5ターンすべてを0.1へ置換する。
    // 1ターンでも0より大きければ発動せず、0のターンは0のまま（ロジック仕様書 09 / BT-007）。
    const allZero = stages.crossTurn.every((chance) => chance === 0);
    const chances = allZero
      ? stages.crossTurn.map(() => CONSTANTS.heroBloodPercent)
      : stages.crossTurn.slice();

    Object.keys(stages).forEach((key) => Object.freeze(stages[key]));
    return Object.freeze({
      rawResistance,
      effectiveResistance,
      missAssumption,
      chances: Object.freeze(chances),
      heroBloodApplied: allZero,
      stages: Object.freeze(stages),
    });
  }

  // 表示用の丸め。**抽選はこの値を使わない**（ロジック仕様書 01・AC-016）。
  // 整数で表せるなら整数、そうでなければ小数第1位まで。
  // 0より大きいのに「0」、100未満なのに「100」と出すと表示が抽選を偽るので、そこだけは寄せる。
  // 仕様書 01 が明記しているのは「0.1%最低保証は必ず0.1%と表示する」の側だけ。
  function formatChanceForDisplay(chance) {
    if (!Number.isFinite(chance)) {
      throw new TypeError(`表示できるのは有限な数値だけ: ${chance}`);
    }
    const rounded = Math.round(chance * 10) / 10;
    let shown = rounded;
    if (rounded <= 0 && chance > 0) shown = 0.1;
    if (rounded >= 100 && chance < 100) shown = 99.9;
    return Number.isInteger(shown) ? String(shown) : shown.toFixed(1);
  }

  Object.assign(ns, {
    BattleCalculator: Object.freeze({
      TURN_COUNT,
      MISS_ASSUMPTIONS,
      calculateChancePath,
      clampChance,
      formatChanceForDisplay,
    }),
  });
})(globalThis);
