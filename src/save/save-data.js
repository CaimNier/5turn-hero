(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const {
    CONSTANTS, STAGES_PER_ROUTE, EQUIPMENT_BY_ID, ENEMIES_BY_ID, ENCYCLOPEDIA_REWARDS,
    ProgressionState, EconomyState, RecordState, EquipmentEffectEngine,
  } = ns;

  // SaveData の形と、読み込むときの手当て。
  //
  // 方針はリポジトリ直下のワンオペパズラー（src/save-manager.js）に合わせてある：
  // version付きの1オブジェクト、未知versionは読まない、壊れていてもゲームを止めない。
  // ただしあちらは `global.GameCore` と CONFIG に直結しているので読み込めない
  // （5ターン勇者は互いのファイルを読まない約束）。設計だけを写して別に持つ。
  //
  // **導出できるものは保存しない。**クリア済み・解放済み・図鑑の登録数・装備枠の下限は
  // すべて firstKillEnemyIds から Progression が毎回作り直す（Phase 05）。
  // Catalog（敵の抵抗・レア率・宝箱率・装備効果）も保存しない。

  const SAVE_VERSION = 1;

  // オートセーブを打つ場所（ロジック仕様書 16）。実際に呼ぶのは Phase 09以降のUI側。
  // ここに並べておくのは、打ち忘れを見つけられるようにするため。
  const SAVE_TRIGGERS = Object.freeze({
    GACHA_RESOLVED: "GACHA_RESOLVED", // ガチャ結果確定直後
    BATTLE_WIN_RESOLVED: "BATTLE_WIN_RESOLVED", // WIN報酬まで確定した直後
    BATTLE_LOSE_RESOLVED: "BATTLE_LOSE_RESOLVED", // LOSE確定直後
    LOADOUT_CHANGED: "LOADOUT_CHANGED", // 装備変更確定時
    SLOT_UNLOCKED: "SLOT_UNLOCKED", // 装備枠解放時
    ENDING_CHANGED: "ENDING_CHANGED", // ED / TRUE CLEAR 到達・消費時
    TUTORIAL_CHANGED: "TUTORIAL_CHANGED", // 初回導線の選択時
    OPTIONS_CHANGED: "OPTIONS_CHANGED", // 設定変更時
    APP_BACKGROUND: "APP_BACKGROUND", // background / 終了時の最後の保存
    LEGACY_REPAIRED: "LEGACY_REPAIRED", // ロード時の取りこぼし救済で何か直したときだけ（1回）
  });

  const DEFAULT_TUTORIAL = Object.freeze({
    hasLaunched: false, // 初回起動を済ませたか
    choiceMade: false, // 「見る / 見ない」を選んだか（AC-173）
    completed: false,
    skipped: false,
  });

  // 音量は0〜1（仕様書 15）。撃破SEの選択は初版では未選択＝既定音。
  const DEFAULT_OPTIONS = Object.freeze({
    bgmVolume: 1,
    seVolume: 1,
    criticalSoundId: null,
    // 表記の言語。この項目が無い古いセーブは日本語扱い。
    language: "ja",
    // 撃破演出。**この項目が無い古いセーブは既定の IMPULSE 扱い**にする。
    // ここは Asset Catalog より先に読み込まれるので、文字列で持つ。
    // 中身が正しいかは Asset Catalog 側（getBattleKillEffect）が最後に見る。
    killEffectId: "impulse",
  });

  const ENCYCLOPEDIA_THRESHOLDS = Object.freeze(
    ENCYCLOPEDIA_REWARDS.filter((reward) => reward.diamonds > 0).map((reward) => reward.count)
  );

  // --- 手当ての道具 ---------------------------------------------------------

  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const asBoolean = (value, fallback = false) => (typeof value === "boolean" ? value : fallback);

  function asCount(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function asClampedInt(value, min, max, fallback) {
    if (!Number.isInteger(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function asVolume(value, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(1, Math.max(0, value));
  }

  // 既知のIDだけを残す。知らないIDは黙って捨てず、repaired に理由を残す。
  function knownIds(ids, table, repaired, field) {
    const kept = [];
    asArray(ids).forEach((id) => {
      if (typeof id !== "string" || !table[id]) {
        repaired.push({ field, reason: "UNKNOWN_ID", value: id });
        return;
      }
      if (kept.includes(id)) {
        repaired.push({ field, reason: "DUPLICATE", value: id });
        return;
      }
      kept.push(id);
    });
    return kept;
  }

  // enemyId / equipmentId をキーにした数え上げ。知らないキーと変な値を落とす。
  function knownCounts(counts, table, repaired, field) {
    const kept = {};
    if (!isObject(counts)) return kept;
    Object.keys(counts).forEach((key) => {
      if (!table[key]) {
        repaired.push({ field, reason: "UNKNOWN_ID", value: key });
        return;
      }
      const count = counts[key];
      if (!Number.isInteger(count) || count < 0) {
        repaired.push({ field, reason: "BAD_COUNT", value: key });
        return;
      }
      kept[key] = count;
    });
    return kept;
  }

  function sanitizeMissMasks(masks, repaired) {
    const kept = {};
    if (!isObject(masks)) return kept;
    Object.keys(masks).forEach((enemyId) => {
      if (!ENEMIES_BY_ID[enemyId]) {
        repaired.push({ field: "previousMissMasks", reason: "UNKNOWN_ID", value: enemyId });
        return;
      }
      const turns = asArray(masks[enemyId])
        .filter((turn) => Number.isInteger(turn) && turn >= 1 && turn <= CONSTANTS.turnsPerBattle);
      kept[enemyId] = turns;
    });
    return kept;
  }

  function sanitizePreviousBattle(previous, repaired) {
    if (previous === null || previous === undefined) return null;
    if (!isObject(previous) || (previous.result !== "WIN" && previous.result !== "LOSE")) {
      repaired.push({ field: "previousBattle", reason: "BAD_SHAPE" });
      return null;
    }
    const winTurn = Number.isInteger(previous.winTurn)
      && previous.winTurn >= 1 && previous.winTurn <= CONSTANTS.turnsPerBattle
      ? previous.winTurn : null;
    return { result: previous.result, winTurn };
  }

  function sanitizeRun(run) {
    const source = isObject(run) ? run : {};
    return {
      id: asCount(source.id, 0),
      active: asBoolean(source.active, false),
      earnedBattleDiamonds: asCount(source.earnedBattleDiamonds, 0),
    };
  }

  // --- セクションごとの手当て -----------------------------------------------

  function sanitizeEconomy(data, repaired) {
    const source = isObject(data) ? data : {};
    const diamonds = asCount(source.diamonds, 0);
    // 「直した」と言うのは、**値が有ってそれが駄目だった**ときだけ。
    // 初回起動（セーブ無し）や欄ごと無いセーブで手当ての報告を出さない。
    if (source.diamonds !== undefined && diamonds !== source.diamonds) {
      repaired.push({ field: "diamonds", reason: "OUT_OF_RANGE", value: source.diamonds });
    }
    const claimed = asArray(source.claimedEncyclopediaRewards)
      .filter((count) => ENCYCLOPEDIA_THRESHOLDS.includes(count));
    return {
      diamonds,
      ownedEquipmentIds: knownIds(source.ownedEquipmentIds, EQUIPMENT_BY_ID, repaired, "ownedEquipmentIds"),
      claimedEncyclopediaRewards: claimed,
    };
  }

  function sanitizeProgression(data, repaired) {
    const source = isObject(data) ? data : {};
    return {
      currentNormalStage: asClampedInt(source.currentNormalStage, 1, STAGES_PER_ROUTE, 1),
      currentBackStage: asClampedInt(source.currentBackStage, 1, STAGES_PER_ROUTE, 1),
      firstKillEnemyIds: knownIds(source.firstKillEnemyIds, ENEMIES_BY_ID, repaired, "firstKillEnemyIds"),
      // 枠は1〜5へ収めるだけ。進行から導いた値との大きいほうを採るのは ProgressionState 側。
      unlockedSlotCount: asClampedInt(source.unlockedSlotCount, 1, CONSTANTS.maxEquipmentSlots, 1),
      sameEnemyLossCounts: knownCounts(source.sameEnemyLossCounts, ENEMIES_BY_ID, repaired, "sameEnemyLossCounts"),
      sameEnemyAttemptCounts: knownCounts(source.sameEnemyAttemptCounts, ENEMIES_BY_ID, repaired, "sameEnemyAttemptCounts"),
      previousMissMasks: sanitizeMissMasks(source.previousMissMasks, repaired),
      lastLostEnemyId: typeof source.lastLostEnemyId === "string" && ENEMIES_BY_ID[source.lastLostEnemyId]
        ? source.lastLostEnemyId : null,
      previousBattle: sanitizePreviousBattle(source.previousBattle, repaired),
      fiveTurnWinChain: asCount(source.fiveTurnWinChain, 0),
      normalEndingPending: asBoolean(source.normalEndingPending),
      trueEndingPending: asBoolean(source.trueEndingPending),
      runs: {
        normal: sanitizeRun(isObject(source.runs) ? source.runs.normal : null),
        back: sanitizeRun(isObject(source.runs) ? source.runs.back : null),
      },
    };
  }

  function sanitizeSnapshot(snapshot, kind, repaired) {
    if (!isObject(snapshot)) return null;
    if (snapshot.kind !== kind) {
      repaired.push({ field: `snapshots.${kind}`, reason: "BAD_SHAPE" });
      return null;
    }
    const topEntry = (entry, table) => (isObject(entry) && table[entry.id]
      ? Object.freeze({ id: entry.id, count: asCount(entry.count, 0) }) : null);
    return Object.freeze({
      kind,
      takenAt: snapshot.takenAt === undefined ? null : snapshot.takenAt,
      totalTaps: asCount(snapshot.totalTaps),
      totalCriticals: asCount(snapshot.totalCriticals),
      totalMisses: asCount(snapshot.totalMisses),
      totalDefeats: asCount(snapshot.totalDefeats),
      totalKills: asCount(snapshot.totalKills),
      gachaPullCount: asCount(snapshot.gachaPullCount),
      extraJudgementCount: asCount(snapshot.extraJudgementCount),
      mostUsedEquipment: topEntry(snapshot.mostUsedEquipment, EQUIPMENT_BY_ID),
      mostDefeatedEnemy: topEntry(snapshot.mostDefeatedEnemy, ENEMIES_BY_ID),
      equippedIds: Object.freeze(knownIds(snapshot.equippedIds, EQUIPMENT_BY_ID, repaired, `snapshots.${kind}.equippedIds`)),
    });
  }

  function sanitizeRecord(data, repaired) {
    const source = isObject(data) ? data : {};
    const totals = isObject(source.totals) ? source.totals : {};
    const snapshots = isObject(source.snapshots) ? source.snapshots : {};
    return {
      totals: {
        totalTaps: asCount(totals.totalTaps),
        totalCriticals: asCount(totals.totalCriticals),
        totalMisses: asCount(totals.totalMisses),
        totalDefeats: asCount(totals.totalDefeats),
        totalKills: asCount(totals.totalKills),
        gachaPullCount: asCount(totals.gachaPullCount),
        extraJudgementCount: asCount(totals.extraJudgementCount),
      },
      equipmentUseCounts: knownCounts(source.equipmentUseCounts, EQUIPMENT_BY_ID, repaired, "equipmentUseCounts"),
      enemyKillCounts: knownCounts(source.enemyKillCounts, ENEMIES_BY_ID, repaired, "enemyKillCounts"),
      enemyLossCounts: knownCounts(source.enemyLossCounts, ENEMIES_BY_ID, repaired, "enemyLossCounts"),
      snapshots: {
        NORMAL_CLEAR: sanitizeSnapshot(snapshots.NORMAL_CLEAR, "NORMAL_CLEAR", repaired),
        TRUE_CLEAR: sanitizeSnapshot(snapshots.TRUE_CLEAR, "TRUE_CLEAR", repaired),
      },
    };
  }

  function sanitizeTutorial(data) {
    const source = isObject(data) ? data : {};
    return {
      hasLaunched: asBoolean(source.hasLaunched, DEFAULT_TUTORIAL.hasLaunched),
      choiceMade: asBoolean(source.choiceMade, DEFAULT_TUTORIAL.choiceMade),
      completed: asBoolean(source.completed, DEFAULT_TUTORIAL.completed),
      skipped: asBoolean(source.skipped, DEFAULT_TUTORIAL.skipped),
    };
  }

  function sanitizeOptions(data) {
    const source = isObject(data) ? data : {};
    return {
      bgmVolume: asVolume(source.bgmVolume, DEFAULT_OPTIONS.bgmVolume),
      seVolume: asVolume(source.seVolume, DEFAULT_OPTIONS.seVolume),
      criticalSoundId: typeof source.criticalSoundId === "string" ? source.criticalSoundId : null,
      // 未設定（古いセーブ）は既定の日本語へ。知らない値は画面側が既定へ落とす。
      language: typeof source.language === "string" ? source.language : DEFAULT_OPTIONS.language,
      // 未設定（古いセーブ）は既定へ。知らない文字列は Asset Catalog が既定へ落とす。
      killEffectId: typeof source.killEffectId === "string"
        ? source.killEffectId : DEFAULT_OPTIONS.killEffectId,
    };
  }

  // --- 書き出し -------------------------------------------------------------

  // 導出値を落として、保存する芯だけを取り出す。
  function serializeGameState({ progression, economy, record, loadout, tutorial, options } = {}) {
    if (!progression || !economy || !record) {
      throw new TypeError("serializeGameState には progression / economy / record が要る");
    }
    const progress = progression.getState();
    const recorded = record.getState();
    return {
      version: SAVE_VERSION,
      economy: {
        diamonds: economy.getDiamonds(),
        ownedEquipmentIds: economy.getOwnedEquipmentIds().slice(),
        claimedEncyclopediaRewards: economy.getState().claimedEncyclopediaRewards.slice(),
      },
      progression: {
        currentNormalStage: progress.currentNormalStage,
        currentBackStage: progress.currentBackStage,
        firstKillEnemyIds: progress.firstKillEnemyIds.slice(),
        unlockedSlotCount: progress.unlockedSlotCount,
        sameEnemyLossCounts: Object.assign({}, progress.sameEnemyLossCounts),
        sameEnemyAttemptCounts: Object.assign({}, progress.sameEnemyAttemptCounts),
        previousMissMasks: Object.keys(progress.previousMissMasks).reduce((masks, enemyId) => (
          Object.assign(masks, { [enemyId]: progress.previousMissMasks[enemyId].slice() })
        ), {}),
        lastLostEnemyId: progress.lastLostEnemyId,
        previousBattle: progress.previousBattle ? Object.assign({}, progress.previousBattle) : null,
        fiveTurnWinChain: progress.fiveTurnWinChain,
        normalEndingPending: progress.normalEndingPending,
        trueEndingPending: progress.trueEndingPending,
        runs: {
          normal: Object.assign({}, progress.runs.normal),
          back: Object.assign({}, progress.runs.back),
        },
      },
      record: {
        totals: Object.assign({}, recorded.totals),
        equipmentUseCounts: Object.assign({}, recorded.equipmentUseCounts),
        enemyKillCounts: Object.assign({}, recorded.enemyKillCounts),
        enemyLossCounts: Object.assign({}, recorded.enemyLossCounts),
        snapshots: {
          NORMAL_CLEAR: recorded.snapshots.NORMAL_CLEAR,
          TRUE_CLEAR: recorded.snapshots.TRUE_CLEAR,
        },
      },
      loadout: {
        slots: asArray(loadout && loadout.slots).slice(),
        params: Object.assign({}, loadout && loadout.params),
      },
      tutorial: sanitizeTutorial(tutorial),
      options: sanitizeOptions(options),
    };
  }

  // --- 読み込み -------------------------------------------------------------

  // version の入口。今は1しか無いので、読めなければ null を返して既定で始める。
  // 将来 version 2 を足すときは、ここに 1→2 の移し替えを1つ書けばよい。
  function migrate(data) {
    if (!isObject(data)) return null;
    if (data.version === SAVE_VERSION) return data;
    return null;
  }

  function createGameState() {
    return restoreGameState(null).gameState;
  }

  // SaveData から遊べる状態を組み立てる。壊れていても落とさず、直した所を repaired に残す。
  function restoreGameState(data) {
    const repaired = [];
    const migrated = migrate(data);
    if (data !== null && data !== undefined && migrated === null) {
      repaired.push({ field: "version", reason: "UNSUPPORTED", value: isObject(data) ? data.version : typeof data });
    }
    const source = migrated || {};

    const economyData = sanitizeEconomy(source.economy, repaired);
    const progressionData = sanitizeProgression(source.progression, repaired);
    const recordData = sanitizeRecord(source.record, repaired);

    const economy = new EconomyState(economyData);
    const progression = new ProgressionState(progressionData);
    const record = new RecordState(recordData);

    // 枠は ProgressionState が「保存値」と「進行から導いた値」の大きいほうにしてくれる。
    // 引き上げが起きたらそれも直したこととして残す。
    if (progression.getUnlockedSlotCount() > progressionData.unlockedSlotCount) {
      repaired.push({
        field: "unlockedSlotCount", reason: "RAISED_TO_DERIVED", value: progression.getUnlockedSlotCount(),
      });
    }

    const loadout = restoreLoadout(source.loadout, { economy, progression, repaired });
    const legacy = repairLegacyDerivedState({ economy, progression, record, repaired });

    return {
      gameState: {
        progression,
        economy,
        record,
        loadout,
        tutorial: sanitizeTutorial(source.tutorial),
        options: sanitizeOptions(source.options),
      },
      repaired: Object.freeze(repaired),
      legacy,
    };
  }

  // 取りこぼし救済。保存済みの**確定した事実（初撃破の集合）**から、その瞬間に
  // 起きているはずだった派生処理のうち、今の値だけで正しく決まるものを後から通す。
  //
  // - 図鑑報酬：登録数が届いていて未受取のものだけ。戦闘と同じ関数を通すので、
  //   受取済みの台帳で二重取りを弾き、何度ロードしても2回目以降は0件。
  // - 撃破数を書き足す・クリア扱いにする・ED条件に触る、はしない。
  //
  // 新規ゲーム（初撃破0）では何も起きない。直したら changed が立ち、呼び出し側が1回だけ保存する。
  function repairLegacyDerivedState({ economy, progression, record, repaired }) {
    const rewards = ns.RewardService.claimReachedEncyclopediaRewards({ progression, economy });
    rewards.forEach((reward) => {
      repaired.push({ field: "claimedEncyclopediaRewards", reason: "LEGACY_REWARD_CLAIMED", value: reward.count });
    });
    return Object.freeze({
      changed: rewards.length > 0,
      encyclopediaRewards: Object.freeze(rewards.map((reward) => reward.count)),
      encyclopediaRewardDiamonds: rewards.reduce((sum, reward) => sum + reward.diamonds, 0),
    });
  }

  // 装備の復元。未所持・未知・重複・未解放枠は Phase 03 の normalizeLoadout に落とさせる。
  // 所持していない装備が装備されたままにならないよう、先に所持で絞る。
  function restoreLoadout(data, { economy, progression, repaired }) {
    const source = isObject(data) ? data : {};
    const slots = asArray(source.slots).map((equipmentId) => {
      if (equipmentId === null || equipmentId === undefined) return null;
      if (typeof equipmentId !== "string" || !EQUIPMENT_BY_ID[equipmentId]) {
        repaired.push({ field: "loadout.slots", reason: "UNKNOWN_ID", value: equipmentId });
        return null;
      }
      if (!economy.owns(equipmentId)) {
        repaired.push({ field: "loadout.slots", reason: "NOT_OWNED", value: equipmentId });
        return null;
      }
      return equipmentId;
    });

    const normalized = EquipmentEffectEngine.normalizeLoadout({
      slots,
      params: isObject(source.params) ? source.params : {},
      unlockedSlotCount: progression.getUnlockedSlotCount(),
    });
    normalized.rejections.forEach((rejection) => {
      repaired.push({ field: "loadout.slots", reason: rejection.reason, value: rejection.equipmentId });
    });
    normalized.corrections.forEach((correction) => {
      repaired.push({ field: "loadout.params", reason: "OUT_OF_RANGE", value: correction.equipmentId });
    });
    return { slots: normalized.slots, params: normalized.params };
  }

  Object.assign(ns, {
    SaveData: Object.freeze({
      SAVE_VERSION,
      SAVE_TRIGGERS,
      DEFAULT_TUTORIAL,
      DEFAULT_OPTIONS,
      ENCYCLOPEDIA_THRESHOLDS,
      serializeGameState,
      restoreGameState,
      createGameState,
      migrate,
    }),
  });
})(globalThis);
