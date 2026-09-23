(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;

  // 乱数の唯一の入口。ロジック側から Math.random を直接呼ばない。
  // （ゲームロジック仕様書 18 / 自動テスト仕様書 00「乱数の原則」/ 開発指示書 02）
  //
  // 単位は「パーセント」で [0, 100) を返す。0〜1ではない。
  // ロジック仕様書 04 の判定が `random[0,100) < currentChance` で、
  // テスト仕様書 14 の固定値（RNG_1P_MINUS = 0.9999 など）も100スケールで書かれているため。
  //
  // ここには実装を持たせない。値を作る具象は SeededRandom（本番・再現可能）と
  // FixedSequenceRandom（テスト用の固定列）の2つ。
  class RandomService {
    // [0, 100) の値を1つ消費して返す。派生クラスが実装する。
    next() {
      throw new Error("RandomService.next() must be implemented by a subclass");
    }

    // そのターン/そのドロップが成功したか。境界は「未満」で成功。
    // chance=0 は next() >= 0 なので必ず失敗、chance=100 は next() < 100 なので必ず成功。
    rollPercent(chance) {
      if (!Number.isFinite(chance)) {
        throw new TypeError("rollPercent needs a finite percentage");
      }
      return this.next() < chance;
    }

    // count 個から等確率で1つ選び、0始まりの番号を返す。乱数は1つだけ消費する。
    // 「一か八か」の対象ターン、宝箱・ガチャの装備抽選がこれを共有する（ロジック仕様書 18）。
    pickIndex(count) {
      if (!Number.isInteger(count) || count < 1) {
        throw new RangeError(`pickIndex には1以上の整数が要る: ${count}`);
      }
      // next() は [0,100) なので、100で割ってから count 倍する。端の 99.999… でも
      // count-1 を超えないが、浮動小数の丸めに備えて最後に上限で止める。
      return Math.min(count - 1, Math.floor((this.next() / 100) * count));
    }

    // 重み付き抽選。entries は [キー, パーセント] の配列で、合計は100。
    // パーセントのまま持つのは、仕様書の率（N40/R30/…）と境界テストの値
    //（39.9999→N / 40.0000→R）をそのまま突き合わせられるようにするため。
    // 乱数は1つだけ消費する。
    pickWeighted(entries) {
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new TypeError("pickWeighted には [キー, パーセント] の配列が要る");
      }
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      // 合計が100でない＝表の写し間違い。黙って正規化せずに落とす。
      if (Math.abs(total - 100) > 1e-9) {
        throw new RangeError(`pickWeighted の合計が100でない: ${total}`);
      }
      const roll = this.next();
      let cumulative = 0;
      for (let index = 0; index < entries.length; index += 1) {
        cumulative += entries[index][1];
        if (roll < cumulative) return entries[index][0];
      }
      // 合計100・roll<100 なのでここへは来ないが、浮動小数の端で落ちないよう最後を返す。
      return entries[entries.length - 1][0];
    }
  }

  // 32bit整数の演算だけで作る決定的な乱数列（mulberry32）。
  // ブラウザとNodeで同じseedから同じ系列が出ることが要件（自動テスト仕様書 00「乱数の原則」）。
  // Math.imul と >>> はどちらの環境でも32bit演算として同じ結果になるので、
  // 浮動小数の丸めに依存する生成式を使わない。最後の /2^32 だけが小数になる。
  function stepState(state) {
    let next = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(next ^ (next >>> 15), 1 | next);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return { state: next, value: (t ^ (t >>> 14)) >>> 0 };
  }

  // 文字列seed → 32bit（xmur3）。"AC-019" のような読めるseedをテストで使えるようにする。
  function hashSeed(seed) {
    if (typeof seed === "number" && Number.isInteger(seed)) return seed >>> 0;
    const text = String(seed);
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i += 1) {
      h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // 本番の乱数。seedを渡せば同じ系列を何度でも再現できる。
  // 消費順そのものが仕様なので（ロジック仕様書 18）、drawCount を外から見えるようにしてある。
  let seedCounter = 0;

  class SeededRandom extends RandomService {
    constructor(seed = SeededRandom.newSeed()) {
      super();
      if (typeof seed !== "number" && typeof seed !== "string") {
        throw new TypeError("SeededRandom needs a number or string seed");
      }
      // 元のseedは表示・セーブ・再現のために残す。内部状態は32bitへ畳んだもの。
      this.seed = seed;
      this.initialState = hashSeed(seed);
      this.state = this.initialState;
      this.drawCount = 0;
    }

    next() {
      const stepped = stepState(this.state);
      this.state = stepped.state;
      this.drawCount += 1;
      // [0, 2^32) を [0, 100) へ。最大 (2^32-1)/2^32*100 = 99.999... なので100は出ない。
      return (stepped.value / 4294967296) * 100;
    }

    // 同じ地点から枝分かれさせる。プレビューと実戦で同じ列を食い合わないようにしたいときに使う。
    clone() {
      const copy = new SeededRandom(this.seed);
      copy.state = this.state;
      copy.drawCount = this.drawCount;
      return copy;
    }

    reset() {
      this.state = this.initialState;
      this.drawCount = 0;
      return this;
    }

    // 実プレイ用のseed。乱数APIは使わない（使えば「直接の乱数API呼び出しなし」が崩れる）。
    // 起動ごと・生成ごとに違えば足りるので、時刻と通し番号を混ぜて畳む。
    static newSeed() {
      seedCounter = (seedCounter + 1) >>> 0;
      return hashSeed(`${Date.now()}:${seedCounter}`);
    }

    static hashSeed(seed) {
      return hashSeed(seed);
    }
  }

  // テスト用。消費順つきの固定乱数列を流し込む。
  // 例：RandomService の代わりに new FixedSequenceRandom([34.9999, 4.9999]) を注入し、
  // CRITICAL → 宝箱 → レア → 装備 → 演出 の消費順まで固定する（テスト仕様書 14）。
  class FixedSequenceRandom extends RandomService {
    constructor(values) {
      super();
      if (!Array.isArray(values)) {
        throw new TypeError("FixedSequenceRandom needs an array of values");
      }
      values.forEach((value, index) => {
        if (!Number.isFinite(value) || value < 0 || value >= 100) {
          throw new RangeError(`fixed random value #${index} must be within [0, 100): ${value}`);
        }
      });
      this.values = values.slice();
      this.consumed = 0;
    }

    next() {
      // 足りない＝想定より多く乱数を引いている。消費順の回帰なので黙って回さず落とす。
      if (this.consumed >= this.values.length) {
        throw new RangeError(`fixed random sequence exhausted after ${this.consumed} draws`);
      }
      const value = this.values[this.consumed];
      this.consumed += 1;
      return value;
    }

    // 使い切ったか。「余分に引いていない」ことをテスト側から見るために使う。
    get remaining() {
      return this.values.length - this.consumed;
    }
  }

  Object.assign(ns, { RandomService, SeededRandom, FixedSequenceRandom });
})(globalThis);
