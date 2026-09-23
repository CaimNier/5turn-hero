(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { ROUTES, NORMAL_ENEMIES, BACK_ENEMIES, SPECIAL_ENEMY } = ns;

  // STAGE定義と装備枠の解放条件。
  // 出典：ゲーム企画書 06「ステージ構成」/ ゲームロジック仕様書 10「STAGE / ROUTE 状態遷移」。
  //
  // ここに置くのは「どのStageにどの敵がいるか」「何で何が解放されるか」という静的な対応だけ。
  // 勝敗でStageがどう動くか（表敗北→通常1、裏敗北→裏1、神は直接RETRY）は
  // 状態遷移なので ProgressionService（Phase 05）が持つ。

  function stage(route, number, enemy) {
    return Object.freeze({
      route,
      number,
      enemyId: enemy.id,
      // 抵抗値は敵が持つものを引くだけ。Stage側に二重に書いて食い違わせない。
      resistance: enemy.resistance,
    });
  }

  const NORMAL_STAGES = Object.freeze(
    NORMAL_ENEMIES.map((enemy) => stage(ROUTES.NORMAL, enemy.stage, enemy))
  );

  const BACK_STAGES = Object.freeze(
    BACK_ENEMIES.map((enemy) => stage(ROUTES.BACK, enemy.stage, enemy))
  );

  // SPECIALはStage番号を持たない1戦だけの入口。
  const SPECIAL_STAGE = Object.freeze({
    route: ROUTES.SPECIAL,
    number: null,
    enemyId: SPECIAL_ENEMY.id,
    resistance: SPECIAL_ENEMY.resistance,
  });

  const STAGES_PER_ROUTE = 10;

  // 装備枠の解放条件。開始時1枠で、下記4つの初撃破で1枠ずつ増えて最大5枠。
  // 企画書 06 /（ロジック仕様書 10「解放条件」）。
  // 「初回撃破」なので、周回で同じ敵を倒しても増えない。冪等化はPhase 05側の責務。
  const SLOT_UNLOCKS = Object.freeze([
    Object.freeze({ route: ROUTES.NORMAL, stage: 4, slotCount: 2 }),
    Object.freeze({ route: ROUTES.NORMAL, stage: 10, slotCount: 3 }),
    Object.freeze({ route: ROUTES.BACK, stage: 2, slotCount: 4 }),
    Object.freeze({ route: ROUTES.BACK, stage: 5, slotCount: 5 }),
  ]);

  // ゲーム開始時点の装備枠数。
  const INITIAL_SLOT_COUNT = 1;

  // ルート自体の解放条件。
  // 通常は最初から。裏は通常STAGE10の初撃破。神は図鑑20体完成。
  const ROUTE_UNLOCKS = Object.freeze({
    [ROUTES.NORMAL]: Object.freeze({ requirement: "none" }),
    [ROUTES.BACK]: Object.freeze({ requirement: "firstKill", route: ROUTES.NORMAL, stage: 10 }),
    [ROUTES.SPECIAL]: Object.freeze({ requirement: "encyclopediaComplete", count: 20 }),
  });

  function getStages(route) {
    if (route === ROUTES.NORMAL) return NORMAL_STAGES;
    if (route === ROUTES.BACK) return BACK_STAGES;
    if (route === ROUTES.SPECIAL) return Object.freeze([SPECIAL_STAGE]);
    throw new Error(`unknown route: ${route}`);
  }

  function getStage(route, number) {
    if (route === ROUTES.SPECIAL) return SPECIAL_STAGE;
    const found = getStages(route).find((item) => item.number === number);
    if (!found) throw new Error(`unknown stage: ${route} ${number}`);
    return found;
  }

  Object.assign(ns, {
    NORMAL_STAGES,
    BACK_STAGES,
    SPECIAL_STAGE,
    STAGES_PER_ROUTE,
    SLOT_UNLOCKS,
    INITIAL_SLOT_COUNT,
    ROUTE_UNLOCKS,
    getStages,
    getStage,
  });
})(globalThis);
