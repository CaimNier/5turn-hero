(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { RARITIES, RARITY_RATES, BOXES, BOX_RATES, EQUIPMENT_BY_RARITY, getPull } = ns;

  // ガチャ。1種類だけ。1回100ダイヤ / 10回1000ダイヤで、割引も10連保証も天井も無い
  //（ロジック仕様書 12）。足さないこと。
  //
  // 10連は「1回を10回続けたもの」。まとめ抽選ではない。
  //
  // 乱数の消費順は1回につき レア → 装備 → 箱演出 の3つで固定（仕様書 18）。
  // 箱は**演出**で、レアリティを決めるものではない。順序を入れ替えると意味が変わる。

  const FAILURES = Object.freeze({ INSUFFICIENT_DIAMONDS: "INSUFFICIENT_DIAMONDS" });

  // 1回につき引く回数。テストと報告でここを正とする。
  const DRAWS_PER_PULL = 3;

  // レア度順に固定した重み。N40 / R30 / SR20 / SSR8 / UR1.5 / LEGEND0.5 で
  // 区間は [0,40) [40,70) [70,90) [90,98) [98,99.5) [99.5,100)。
  const RARITY_ENTRIES = Object.freeze(RARITIES.map((rarity) => Object.freeze([rarity, RARITY_RATES[rarity]])));

  // 箱の並びも固定。木 → 赤 → 金 → 虹。
  const BOX_ENTRIES = Object.freeze(RARITIES.reduce((map, rarity) => Object.assign(map, {
    [rarity]: Object.freeze(BOXES.map((box) => Object.freeze([box.id, BOX_RATES[rarity][box.id]]))),
  }), {}));

  function drawRarity(random) {
    return random.pickWeighted(RARITY_ENTRIES);
  }

  const EMPTY_POOL = Object.freeze([]);

  // そのレア度で**実際に出る装備**。抽選が読むのと同じ配列をそのまま返す。
  // 排出装備一覧もここから引くので、「出るもの」と「一覧に出すもの」がずれない。
  // 装備を足せば一覧も自動で増える（一覧のための別データを持たない）。
  function getPool(rarity) {
    return EQUIPMENT_BY_RARITY[rarity] || EMPTY_POOL;
  }

  // レア内は均等抽選。個別ウェイトは現仕様に無い。
  function drawEquipmentId(random, rarity) {
    const pool = getPool(rarity);
    return pool[random.pickIndex(pool.length)].id;
  }

  // 見せる箱。結果は既に決まっていて、これは演出の抽選（仕様書 12 / UI仕様書 07）。
  function drawPresentationChest(random, rarity) {
    return random.pickWeighted(BOX_ENTRIES[rarity]);
  }

  // 1回ぶん。レア → 装備 → 箱の順に3つ引き、所持と重複売却まで済ませる。
  function pullOnce({ economy, random }) {
    const rarity = drawRarity(random);
    const equipmentId = drawEquipmentId(random, rarity);
    const presentationChest = drawPresentationChest(random, rarity);
    const acquired = economy.acquireEquipment(equipmentId);
    return Object.freeze({
      rarity,
      equipmentId,
      presentationChest,
      isNew: acquired.isNew,
      duplicateSaleDiamonds: acquired.duplicateSaleDiamonds,
    });
  }

  // ガチャを引く。足りなければ**1つも引かずに**失敗を返す（乱数も残高も動かさない）。
  function draw({ pullId = "single", economy, record = null, random } = {}) {
    if (!economy || !random) throw new TypeError("draw には economy と RandomService が要る");
    const pull = getPull(pullId);

    if (!economy.canAfford(pull.price)) {
      return Object.freeze({
        ok: false,
        reason: FAILURES.INSUFFICIENT_DIAMONDS,
        pullId: pull.id,
        price: pull.price,
        diamonds: economy.getDiamonds(),
        pulls: Object.freeze([]),
        randomDraws: 0,
      });
    }

    economy.spendDiamonds(pull.price);
    const pulls = [];
    for (let index = 0; index < pull.pullCount; index += 1) {
      pulls.push(pullOnce({ economy, random }));
    }
    // 10連は1回を10回。ガチャ回数も引いた数ぶん増える（仕様書 14）。
    if (record) record.addGachaPulls(pull.pullCount);

    const duplicateSaleTotal = pulls.reduce((sum, item) => sum + item.duplicateSaleDiamonds, 0);
    return Object.freeze({
      ok: true,
      pullId: pull.id,
      price: pull.price,
      pullCount: pull.pullCount,
      pulls: Object.freeze(pulls),
      diamondsSpent: pull.price,
      duplicateSaleTotal,
      newCount: pulls.filter((item) => item.isNew).length,
      diamondsAfter: economy.getDiamonds(),
      randomDraws: pull.pullCount * DRAWS_PER_PULL,
    });
  }

  Object.assign(ns, {
    GachaService: Object.freeze({
      FAILURES,
      DRAWS_PER_PULL,
      RARITY_ENTRIES,
      BOX_ENTRIES,
      getPool,
      drawRarity,
      drawEquipmentId,
      drawPresentationChest,
      draw,
    }),
  });
})(globalThis);
