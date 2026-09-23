(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { CONSTANTS } = ns;

  // 装備効果エンジン（Phase 03）と BattleCalculator（Phase 02）の境界。
  //
  // エンジン側が「どの装備が、どの条件で、いくつ足すか」を解決し、その結果を
  // ここで定義する contribution の配列にして Calculator へ渡す。
  // Calculator は装備IDを一切知らない（ロジック仕様書 06「装備効果は文章を直接if文へ散らさない」）。
  //
  // phase はロジック仕様書 02 の P1〜P9 に1対1で対応する。P0（初期化）は呼び出し側、
  // P4/P5/P8（抵抗減算とClamp）と P10（勇者の血）は装備の関与しない固定処理なので
  // contribution は無い。

  const EFFECT_PHASES = Object.freeze({
    RESISTANCE: "RESISTANCE", // P1 抵抗値補正（神殺し）
    STATIC_ADD: "STATIC_ADD", // P2 固定加算（ターン固定・抵抗条件・敗北回数・前戦バフ）
    MISS_DEPENDENT_ADD: "MISS_DEPENDENT_ADD", // P3 MISS依存加算（不運払い・運命加速など）
    FORCE: "FORCE", // P6 強制値（捨て三・五度目の奇跡・一か八かの非選択T）
    MULTIPLIER: "MULTIPLIER", // P7 倍率（勝負師・運命の天秤・明日への犠牲）
    CROSS_TURN: "CROSS_TURN", // P9 5ターン横断処理（英雄の証・逆転の運命）
  });

  // 全ターン対象。装備表の「ALL」をそのまま書けるようにしてある。
  const ALL_TURNS = "ALL";

  function everyTurn() {
    const turns = [];
    for (let turn = 1; turn <= CONSTANTS.turnsPerBattle; turn += 1) turns.push(turn);
    return turns;
  }

  // 対象ターンの正規化。省略は許さない（書き忘れが「全ターン」として通ると気付けない）。
  function normalizeTurns(turns, source) {
    if (turns === ALL_TURNS) return everyTurn();
    const list = Array.isArray(turns) ? turns : [turns];
    if (list.length === 0) throw new TypeError(`${source}: turns が空`);
    const normalized = [];
    list.forEach((turn) => {
      if (!Number.isInteger(turn) || turn < 1 || turn > CONSTANTS.turnsPerBattle) {
        throw new RangeError(`${source}: turns は1〜${CONSTANTS.turnsPerBattle}の整数: ${turn}`);
      }
      if (!normalized.includes(turn)) normalized.push(turn);
    });
    return normalized.sort((a, b) => a - b);
  }

  function requireSource(source) {
    if (typeof source !== "string" || source.length === 0) {
      throw new TypeError("contribution には source（診断用の出どころ）が要る");
    }
    return source;
  }

  // 数値そのままでも、文脈から作る関数でもよい。
  // 関数にしているのは、MISS依存加算のように「到達までのMISS数」がターンごとに
  // 変わる値を、Calculator の外で先に解決できないため（ロジック仕様書 03）。
  function requireValue(value, source) {
    if (typeof value !== "function" && !Number.isFinite(value)) {
      throw new TypeError(`${source}: value は有限な数値かその関数`);
    }
    return value;
  }

  // 同一Phase内の適用順。現行60装備で順序が効くのは P6 のFORCEだけで、その値はすべて0
  // なので実際には結果が変わらない。将来「値の違うFORCE」が増えたときに、装備スロットの
  // 並びではなく定義側の宣言で順序が決まるように、入口だけ用意してある（PHASES.md J2）。
  function requirePriority(priority, source) {
    if (priority === undefined || priority === null) return 0;
    if (!Number.isFinite(priority)) throw new TypeError(`${source}: priority は数値`);
    return priority;
  }

  function requireWhen(when, source) {
    if (when !== undefined && when !== null && typeof when !== "function") {
      throw new TypeError(`${source}: when は関数`);
    }
    return typeof when === "function" ? when : null;
  }

  // 条件付き contribution を評価する。条件なしは常に有効。
  function isActive(contribution, context) {
    if (!contribution.when) return true;
    return Boolean(contribution.when(context));
  }

  // 値を確定させる。関数が数値以外を返したらその場で落とす（黙って0にしない）。
  function resolveValue(contribution, context) {
    const value = typeof contribution.value === "function"
      ? contribution.value(context)
      : contribution.value;
    if (!Number.isFinite(value)) {
      throw new TypeError(`${contribution.source}: value が有限な数値にならなかった: ${value}`);
    }
    return value;
  }

  // --- contribution の作り手 ------------------------------------------------
  // Phase 03 のエンジンはこの関数群だけを使って Calculator への入力を組み立てる。

  // P1：effectiveResistance へ掛ける倍率。神殺しの「20%無視」は multiplier 0.8。
  function resistanceMultiplier({ source, multiplier, when, priority } = {}) {
    return Object.freeze({
      phase: EFFECT_PHASES.RESISTANCE,
      source: requireSource(source),
      value: requireValue(multiplier, source),
      when: requireWhen(when, source),
      priority: requirePriority(priority, source),
    });
  }

  function addContribution(phase, { source, turns, value, when, priority } = {}) {
    return Object.freeze({
      phase,
      source: requireSource(source),
      turns: Object.freeze(normalizeTurns(turns, source)),
      value: requireValue(value, source),
      when: requireWhen(when, source),
      priority: requirePriority(priority, source),
    });
  }

  // P2：ターン・敵抵抗・敗北回数・前戦バフなど、到達MISS数に依らない加算。
  function staticAdd(options) {
    return addContribution(EFFECT_PHASES.STATIC_ADD, options);
  }

  // P3：到達までのMISSに依る加算。value を関数にすると context.priorMissCount が読める。
  function missDependentAdd(options) {
    return addContribution(EFFECT_PHASES.MISS_DEPENDENT_ADD, options);
  }

  // P6：一次Clamp後の値を上書きする。ロジック仕様書 09「FORCE0後に通常ADDは戻さない」。
  function force(options) {
    return addContribution(EFFECT_PHASES.FORCE, options);
  }

  // P7：最終CRITICALへの乗算。「50%減」は value 0.5。
  function multiplier(options) {
    return addContribution(EFFECT_PHASES.MULTIPLIER, options);
  }

  // P9：5値をまとめて見る処理。apply(chances, context) は新しい5値の配列を返す。
  //
  // order は適用順で、**装備スロットの並び順に依存させないため**に必須にしてある
  // （PHASES.md D1：英雄の証 → 逆転の運命 で固定）。同じ order が2つ来たら順序が
  // 決まらないので落とす。Phase 03 が実際の順序値をここへ渡す。
  function crossTurn({ source, order, apply } = {}) {
    requireSource(source);
    if (!Number.isFinite(order)) throw new TypeError(`${source}: crossTurn には order が要る`);
    if (typeof apply !== "function") throw new TypeError(`${source}: crossTurn には apply が要る`);
    return Object.freeze({ phase: EFFECT_PHASES.CROSS_TURN, source, order, apply });
  }

  // --- 正規化 ---------------------------------------------------------------

  // contribution の配列を phase ごとの束へ分ける。
  // Calculator はこの束だけを見るので、入力の並び順が結果へ漏れるのは
  // 「同一ターンへの複数FORCE」だけ（後勝ち・下記コメント参照）。
  function normalize(contributions) {
    if (!Array.isArray(contributions)) {
      throw new TypeError("effects は contribution の配列");
    }
    const buckets = {
      resistance: [],
      staticAdds: [],
      missDependentAdds: [],
      forces: [],
      multipliers: [],
      crossTurn: [],
    };
    const bucketOf = {
      [EFFECT_PHASES.RESISTANCE]: buckets.resistance,
      [EFFECT_PHASES.STATIC_ADD]: buckets.staticAdds,
      [EFFECT_PHASES.MISS_DEPENDENT_ADD]: buckets.missDependentAdds,
      [EFFECT_PHASES.FORCE]: buckets.forces,
      [EFFECT_PHASES.MULTIPLIER]: buckets.multipliers,
      [EFFECT_PHASES.CROSS_TURN]: buckets.crossTurn,
    };
    contributions.forEach((contribution, index) => {
      if (!contribution || !bucketOf[contribution.phase]) {
        throw new TypeError(`effects[${index}]: 未知のphase: ${contribution && contribution.phase}`);
      }
      bucketOf[contribution.phase].push(contribution);
    });

    // P6は priority の昇順。同順位は入力順のまま（Array.prototype.sort は安定）。
    // 現行のFORCEはすべて値0なので、この並べ替えで結果は変わらない。
    buckets.forces.sort((a, b) => a.priority - b.priority);

    // P9はorder順。重複orderは「どちらが先か」が決まらないので実装ミスとして落とす。
    const orders = new Set();
    buckets.crossTurn.forEach((contribution) => {
      if (orders.has(contribution.order)) {
        throw new RangeError(`crossTurn の order が重複している: ${contribution.order}`);
      }
      orders.add(contribution.order);
    });
    buckets.crossTurn.sort((a, b) => a.order - b.order);

    return buckets;
  }

  Object.assign(ns, {
    BattleEffects: Object.freeze({
      PHASES: EFFECT_PHASES,
      ALL_TURNS,
      everyTurn,
      resistanceMultiplier,
      staticAdd,
      missDependentAdd,
      force,
      multiplier,
      crossTurn,
      normalize,
      isActive,
      resolveValue,
    }),
  });
})(globalThis);
