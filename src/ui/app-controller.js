(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const {
    ROUTES, CONSTANTS, RARITIES, EQUIPMENT, getEquipment, SeededRandom,
    ENCYCLOPEDIA_ENEMIES, SPECIAL_ENEMY, getEnemy, ENCYCLOPEDIA_REWARDS,
    GACHA_PULLS, RARITY_RATES, GachaService,
    BattleCalculator, BattleSession, EquipmentEffectEngine, SaveData, SaveRepository,
    ProgressionState, RewardService, UiContent, AssetCatalog, AudioManager,
  } = ns;

  // 画面の状態遷移。**DOMを触らない。**描画は app-view.js の仕事で、
  // こちらは「いまどの画面か」「そこに何を出すか」を Domain から作るだけ。
  //
  // 状態の正は常に Domain（Progression / Economy / Record / loadout）。
  // 画面用にダイヤやStageの写しを持たない。保存も1か所（save()）へ集める。

  const SCREENS = Object.freeze({
    FIRST_LAUNCH: "FIRST_LAUNCH", // 初回：チュートリアルを見る / 見ない
    TUTORIAL: "TUTORIAL",
    HOME: "HOME",
    BATTLE_PREP: "BATTLE_PREP",
    EQUIPMENT: "EQUIPMENT",
    OPTIONS: "OPTIONS",
    GACHA: "GACHA", // Phase 11b。ここでは入口だけ
    GACHA_POOL: "GACHA_POOL", // 排出装備一覧。見るだけで、引くことも装備することもしない
    ENCYCLOPEDIA: "ENCYCLOPEDIA",
    RECORD: "RECORD",
    ARCHIVE: "ARCHIVE", // 図鑑とRECORDをタブでまとめた入口。中身は既存の2つをそのまま出す
    ENDING: "ENDING", // Phase 12。ここでは pending を見せるだけ
    BATTLE: "BATTLE",
    WIN: "WIN",
    LOSE: "LOSE",
  });

  // アーカイブのタブ。**中身は既存の図鑑とRECORDそのもの**で、入口をまとめただけ。
  const ARCHIVE_TABS = Object.freeze({ CATALOG: "CATALOG", RECORD: "RECORD" });

  // 戦闘まわりの画面。ここから出るときに鳴っているSEを断つ。
  const BATTLE_SCREENS = Object.freeze([SCREENS.BATTLE, SCREENS.WIN, SCREENS.LOSE]);

  // 戦闘画面の段階。READY のときだけタップを受ける。
  //   READY    … 次のタップ待ち
  //   CHARGING … タップを受けて抽選済み。演出の最中
  //   EXTRA    … 5MISS後の追加判定を見せている
  //   RESULT   … 勝敗が出て、結果画面へ移る直前の見せ場
  //   FINISHED … WIN / LOSE 画面へ移った
  // 未撃破の敵に見せる名前。正式名やプロフィールは画面へ出さない。
  const UNKNOWN_ENEMY_NAME = "?????";
  // 中身が無いときの埋め草（神のプロフィールなど）。勝手に文章を作らない。
  const EMPTY_TEXT = "---";

  // ガチャ画面の段階。IDLE のときだけ引ける。
  //   IDLE      … 1回 / 10回を選べる
  //   CHEST     … 箱が出ている（結果はもう決まっている）
  //   PROMOTION … 箱が煙で昇格している最中。**入力は一切受けない**
  //   RESULT    … 開封して中身を見せている
  //   SUMMARY   … 10連の一覧
  const GACHA_PHASES = Object.freeze({
    IDLE: "IDLE",
    CHEST: "CHEST",
    PROMOTION: "PROMOTION",
    RESULT: "RESULT",
    SUMMARY: "SUMMARY",
  });

  const BATTLE_PHASES = Object.freeze({
    READY: "READY",
    CHARGING: "CHARGING",
    EXTRA: "EXTRA",
    RESULT: "RESULT",
    FINISHED: "FINISHED",
  });

  // 抵抗値テストの入力範囲。神の350より上も試せるようにしておく（ビルド確認用）。
  // Catalog の値ではないので、ここが敵データへ影響することはない。
  const TEST_RESISTANCE_MAX = 999;

  // 装備ボックスの並び。高レア順（LEGEND → N）。同レア内はカタログの番号順。
  // `EQUIPMENT` の並び（N → LEGEND）は記録の同数解決などが使うので動かさない。
  // ここは**表示の並び替えだけ**を持つ。
  const BOX_RARITY_ORDER = Object.freeze(RARITIES.slice().reverse());

  class AppController {
    constructor({ repository = null, randomFactory = null, audio = null } = {}) {
      this.repository = repository || new SaveRepository();
      // 音は1か所から。差し替えられるようにしておく（テストは鳴らさない出口を刺す）。
      this.audio = audio || new AudioManager();
      // 戦闘用の乱数。テストからは差し替えられるようにしておく。
      this.randomFactory = randomFactory || (() => new SeededRandom());
      this.gameState = null;
      this.repaired = [];
      this.screen = SCREENS.FIRST_LAUNCH;
      this.tutorialStep = 1;
      this.activeRoute = null;
      // 装備画面の一時状態。画面を閉じたら捨てる。
      this.selectedSlot = 0;
      this.rarityFilter = "ALL";
      this.selectedEquipmentId = null;
      // 5枠すべて埋まっているときの「どれと入れ替えるか」待ち。**画面の状態だけ**で、
      // 確定するまで loadout には何も書かない（画面を離れたら黙って捨てる）。
      this.replaceTargetPending = false;
      // 排出装備一覧の一時状態。装備画面とは別に持つ（絞り込みを取り合わない）。
      this.poolFilter = "ALL";
      this.selectedPoolEquipmentId = null;
      // 提供割合を重ねて出しているか。画面を離れたら閉じる（保存しない）。
      this.ratesOpen = false;
      // HOMEでバトルモードを重ねて出しているか。こちらも保存しない。
      this.battleModesOpen = false;
      // アーカイブで見ているタブ。**図鑑から開く。**保存しない。
      this.archiveTab = ARCHIVE_TABS.CATALOG;
      // ロック枠を押したときの案内。次の操作で消す。
      this.lockNotice = null;
      // 取得直後の「NEW」。**セーブには入れない**（未確認NEWの永続仕様がまだ無いため）。
      // ガチャ・宝箱の結果（isNew）をこの1セッションのあいだだけ覚えておく入口。
      this.newEquipmentIds = new Set();
      // 抵抗値テスト。null なら実際の敵の抵抗値を使う。
      this.testResistance = null;
      this.lastSaveTrigger = null;
      this.pendingSession = null;
      // 進行中の戦闘。beginBattle() で作り、結果画面を抜けるときに捨てる。
      this.battle = null;
      // ガチャの演出。引くたびに差し替える。
      this.gacha = this.createGachaState();
      // ガチャ用の乱数。引き続けても同じ列が続くよう1本だけ持つ。
      this.gachaRandom = null;
      // 図鑑で開いている敵。画面を離れたら捨てる。
      this.selectedEnemyId = null;
      // RECORDを開いた場所。HOMEの補助ボタン以外から開いても戻せるように覚えておく。
      this.recordReturnTo = SCREENS.HOME;
      // 装備画面から戻る先。入ってきた画面を覚えておく。
      this.equipmentReturnTo = SCREENS.BATTLE_PREP;
    }

    // --- 起動 -----------------------------------------------------------------

    // セーブがあれば復元、無ければ既定。壊れていても起動を止めない。
    start() {
      const loaded = this.repository.load();
      this.gameState = loaded.gameState;
      this.repaired = loaded.repaired;
      // ロード時の取りこぼし救済（SaveData.restoreGameState 側で済んでいる）。
      // **何か直したときだけ**1回保存する。直すものが無ければ保存しない。
      // 何を直したかは legacyRepair に残す（console へは書かない：RC-015）。
      this.legacyRepair = loaded.legacy || null;
      if (this.legacyRepair && this.legacyRepair.changed) {
        this.save(SaveData.SAVE_TRIGGERS.LEGACY_REPAIRED);
      }
      // 復元した音量・撃破SEをここで音へ渡す（起動時に1回）。
      this.audio.applyOptions(this.gameState.options);
      if (!this.gameState.tutorial.choiceMade) {
        this.setScreen(SCREENS.FIRST_LAUNCH);
      } else {
        this.setScreen(this.getPendingEnding() ? SCREENS.ENDING : SCREENS.HOME);
      }
      return this.getScreen();
    }

    // 保存はここ1か所から。呼ぶ場所を散らさない（ロジック仕様書 16 の発火点）。
    save(trigger) {
      this.lastSaveTrigger = trigger;
      return this.repository.save(this.gameState, { trigger });
    }

    getScreen() {
      return Object.freeze({ name: this.screen, title: UiContent.SCREEN_TITLES[this.screen] });
    }

    // --- 初回導線 -------------------------------------------------------------

    // 「見る」→ 6STEPへ。「見ない」→ そのままHOME。どちらでも選んだことを保存する。
    chooseTutorial(see) {
      const tutorial = this.gameState.tutorial;
      tutorial.hasLaunched = true;
      tutorial.choiceMade = true;
      tutorial.skipped = see !== true;
      this.save(SaveData.SAVE_TRIGGERS.TUTORIAL_CHANGED);
      if (see === true) {
        this.tutorialStep = 1;
        this.setScreen(SCREENS.TUTORIAL);
      } else {
        this.setScreen(SCREENS.HOME);
      }
      return this.getScreen();
    }

    getTutorialStep() {
      const total = UiContent.TUTORIAL_STEPS.length;
      const step = UiContent.TUTORIAL_STEPS[this.tutorialStep - 1];
      return Object.freeze({
        index: this.tutorialStep,
        total,
        title: step.title,
        body: step.body,
        hasPrev: this.tutorialStep > 1,
        isLast: this.tutorialStep === total,
      });
    }

    tutorialNext() {
      if (this.tutorialStep < UiContent.TUTORIAL_STEPS.length) {
        this.tutorialStep += 1;
        return this.getScreen();
      }
      this.gameState.tutorial.completed = true;
      this.save(SaveData.SAVE_TRIGGERS.TUTORIAL_CHANGED);
      this.setScreen(SCREENS.HOME);
      return this.getScreen();
    }

    tutorialPrev() {
      if (this.tutorialStep > 1) this.tutorialStep -= 1;
      return this.getScreen();
    }

    // --- HOME -----------------------------------------------------------------

    // 裏・神のボタンは解放されるまで出さない（UI仕様書 01）。判定は Progression が正。
    getHome() {
      const progression = this.gameState.progression;
      return Object.freeze({
        title: UiContent.SCREEN_TITLES.HOME,
        diamonds: this.gameState.economy.getDiamonds(),
        // 3つのルートを**並びごと**返す。解放されていないものは locked を立てるだけで、
        // 解放条件そのものは今までどおり Progression の canStartRoute が決める。
        routes: Object.freeze([ROUTES.NORMAL, ROUTES.BACK, ROUTES.SPECIAL]
          .map((route) => {
            const unlocked = progression.canStartRoute(route);
            return Object.freeze({
              route,
              label: UiContent.ROUTE_LABELS[route],
              stage: unlocked && route !== ROUTES.SPECIAL
                ? progression.getCurrentEncounter(route).stage
                : null,
              locked: !unlocked,
            });
          })),
        modesOpen: this.battleModesOpen,
        pendingEnding: this.getPendingEnding(),
      });
    }

    // HOMEのバトルモードを重ねて出す／閉じる。**見せ方だけ**で、解放条件にも進行にも触らない。
    setBattleModesOpen(open) {
      this.battleModesOpen = Boolean(open);
      return this.battleModesOpen;
    }

    // アーカイブ。図鑑とRECORDの入口をまとめただけで、中身のデータは何も変えない。
    openArchive() {
      this.archiveTab = ARCHIVE_TABS.CATALOG; // 開いた直後は図鑑
      this.setScreen(SCREENS.ARCHIVE);
      return this.getArchive();
    }

    setArchiveTab(tab) {
      if (!ARCHIVE_TABS[tab]) throw new Error(`unknown archive tab: ${tab}`);
      this.archiveTab = ARCHIVE_TABS[tab];
      return this.getArchive();
    }

    getArchive() {
      return Object.freeze({
        tab: this.archiveTab,
        tabs: Object.freeze(Object.keys(ARCHIVE_TABS)),
      });
    }

    // 見せていないエンディング。**ここでは consume しない**（Phase 12 の仕事）。
    getPendingEnding() {
      const state = this.gameState.progression.getState();
      if (state.trueEndingPending) return ProgressionState.ENDINGS.TRUE;
      if (state.normalEndingPending) return ProgressionState.ENDINGS.NORMAL;
      return null;
    }

    goHome() {
      this.setScreen(SCREENS.HOME);
      this.activeRoute = null;
      this.selectedEnemyId = null;
      // ガチャの演出は持ち越さない。結果は保存済みなので捨てて困らない。
      this.gacha = this.createGachaState();
      return this.getScreen();
    }

    // 画面を切り替える**唯一の場所**。ここを通すことで、BGMの合わせ忘れが起きない。
    // （画面ごとに playBgm を書いて回ると、必ずどこかで漏れる。）
    setScreen(name) {
      const leavingBattle = BATTLE_SCREENS.indexOf(this.screen) !== -1
        && BATTLE_SCREENS.indexOf(name) === -1;
      // 重ねて出していたものは、画面が変わったら閉じる。
      if (name !== this.screen) {
        this.ratesOpen = false;
        this.battleModesOpen = false;
      }
      this.screen = name;
      // WIN/LOSE へ撃破SEが少し重なるのは構わないが、NEXT / HOME まで残さない。
      if (leavingBattle) this.audio.stopSe();
      this.syncBgm();
      return this.screen;
    }

    openScreen(name) {
      if (!SCREENS[name]) throw new Error(`unknown screen: ${name}`);
      this.setScreen(SCREENS[name]);
      return this.getScreen();
    }

    // 画面内の「戻る」。ブラウザの履歴には触らない。
    back() {
      if (this.screen === SCREENS.EQUIPMENT) {
        // 入ってきた画面へ戻す。バトル前から入ったときは今までどおり。
        // 入れ替え先を選びかけていても、まだ何も書いていないのでそのまま捨てる。
        this.replaceTargetPending = false;
        if (this.equipmentReturnTo === SCREENS.HOME) {
          this.selectedEquipmentId = null;
          return this.goHome();
        }
        this.setScreen(SCREENS.BATTLE_PREP);
        this.selectedEquipmentId = null;
        return this.getScreen();
      }
      if (this.screen === SCREENS.RECORD) {
        this.setScreen(this.recordReturnTo);
        return this.getScreen();
      }
      // アーカイブはHOMEの中の画面。中身（図鑑・RECORD）には触らずHOMEへ返す。
      if (this.screen === SCREENS.ARCHIVE) return this.goHome();
      // 排出装備一覧はガチャの中の画面。抜けてもガチャの状態には触らない。
      if (this.screen === SCREENS.GACHA_POOL) {
        this.selectedPoolEquipmentId = null;
        this.setScreen(SCREENS.GACHA);
        return this.getScreen();
      }
      return this.goHome();
    }

    // --- バトル前 -------------------------------------------------------------

    // Stage番号も抵抗値もUIへ書かない。Progression から引く。
    startRoute(route) {
      if (!this.gameState.progression.canStartRoute(route)) {
        throw new Error(`route is locked: ${route}`);
      }
      this.activeRoute = route;
      // 抵抗値テストは画面を開くたびに実際の敵の値へ戻す（UI仕様書 06）。
      this.testResistance = null;
      this.selectedEquipmentId = null;
      this.setScreen(SCREENS.BATTLE_PREP);
      return this.getScreen();
    }

    getEncounter() {
      if (!this.activeRoute) throw new Error("ルートが選ばれていない");
      return this.gameState.progression.getCurrentEncounter(this.activeRoute);
    }

    // バトル前とバトル中と装備画面で同じ経路を使う。UI側で確率を作り直さない。
    //
    // MISSの数え方は条件付き（D5）。TURN2以降は、それ以前がMISSして到達した前提。
    // 「一か八か」のように開始時に抽選する装備があるあいだは、5値を確定させず
    // RANDOM として返す（ここで乱数は1つも引かない・仕様書 03）。
    getPreview() {
      const encounter = this.getEncounter();
      const loadout = this.gameState.loadout;
      const resistance = this.testResistance === null ? encounter.resistance : this.testResistance;
      // 装備時に選ぶ値（一点集中の selectedTurn）も渡す。戦闘（BattleSession）と同じ入力にしないと、
      // 値を読む装備でプレビューだけが落ちる。
      const context = EquipmentEffectEngine.createContext(Object.assign(
        {}, this.gameState.progression.getBattleContext(encounter.enemyId),
        { rawResistance: resistance, loadoutParams: loadout.params },
      ));
      const path = BattleCalculator.calculateChancePath({
        rawResistance: resistance,
        effects: EquipmentEffectEngine.buildContributions({ slots: loadout.slots, context }),
      });
      const pendingRandom = EquipmentEffectEngine.getPendingRandomEquipmentIds({ slots: loadout.slots });
      const undetermined = pendingRandom.length > 0;
      return Object.freeze({
        route: encounter.route,
        stage: encounter.stage,
        enemyId: encounter.enemyId,
        enemyName: encounter.enemy.name,
        enemyQuote: encounter.enemy.quote,
        resistance: encounter.resistance,
        previewResistance: resistance,
        isTestResistance: this.testResistance !== null,
        chances: path.chances,
        // 表示は Calculator の丸めをそのまま使う。UI側で別の丸めを作らない。
        // 未確定のターンは数字を偽らず「?」。狭い縦画面のセルに「RANDOM」は収まらないので、
        // 語のほうは表の下に1行の注記として出す（仕様書 03 の「RANDOM」表示）。
        display: Object.freeze(path.chances.map((chance) => (
          undetermined ? "?" : `${BattleCalculator.formatChanceForDisplay(chance)}%`
        ))),
        undeterminedNote: undetermined ? "RANDOM：対象ターンはバトル開始時に決まります" : null,
        // 撃破に要るCRITICAL数。1より大きい敵（神）だけ、画面が特殊ルールを出す。
        requiredCriticalHits: encounter.enemy.requiredCriticalHits,
        // 「一撃必殺」を出してよいか。**演出を飛ばせるかどうかだけ**の判定で、
        // 勝敗も確率もここでは作らない（下の canInstantKill を見る）。
        canInstantKill: this.canInstantKill({ encounter, path, undetermined }),
        heroBloodApplied: path.heroBloodApplied,
        pendingRandomEquipmentIds: Object.freeze(pendingRandom),
        undetermined,
      });
    }

    // --- 装備変更 -------------------------------------------------------------

    // 装備画面。バトル前からでもHOMEからでも入れる。
    // 戻り先は**入ってきた画面**で、バトル前から入ったときの道筋は変えない。
    openEquipment() {
      if (!this.activeRoute && this.screen !== SCREENS.HOME) {
        throw new Error("バトル前かHOMEからのみ開ける");
      }
      // HOMEから入ったときだけ戻り先がHOME。それ以外は今までどおりバトル前へ。
      this.equipmentReturnTo = this.screen === SCREENS.HOME ? SCREENS.HOME : SCREENS.BATTLE_PREP;
      // 装備画面は「いま挑もうとしている相手」を見せる。HOMEから入ったときは
      // まだ相手が決まっていないので、既定の通常バトルの相手を見せる。
      // **戦闘は始まらない**し、HOMEへ戻れば goHome() がここを空に戻す。
      if (!this.activeRoute) this.activeRoute = ROUTES.NORMAL;
      this.setScreen(SCREENS.EQUIPMENT);
      this.selectedSlot = 0;
      this.selectedEquipmentId = null;
      this.replaceTargetPending = false;
      return this.getScreen();
    }

    selectSlot(index) {
      // 入れ替え先を選んでいる最中は、枠の押下は chooseReplaceSlot が受け持つ。
      if (this.replaceTargetPending) return this.chooseReplaceSlot(index);
      const unlocked = this.gameState.progression.getUnlockedSlotCount();
      if (!Number.isInteger(index) || index < 0 || index >= CONSTANTS.maxEquipmentSlots) {
        throw new RangeError(`スロットは0〜${CONSTANTS.maxEquipmentSlots - 1}: ${index}`);
      }
      if (index >= unlocked) {
        // ロック中の枠は選べない。黙って無視せず、理由だけ出す。
        this.lockNotice = "この装備枠はまだ解放されていません";
        return this.getEquipmentScreen();
      }
      this.lockNotice = null;
      this.selectedSlot = index;
      this.selectedEquipmentId = null;
      return this.getEquipmentScreen();
    }

    // ガチャ・宝箱で初取得した装備を「NEW」にする。呼ぶのは結果を受け取った側。
    // 1セッションだけの印で、保存はしない（D7で確定）。
    markNewEquipment(equipmentIds) {
      (equipmentIds || []).forEach((equipmentId) => {
        if (this.gameState.economy.owns(equipmentId)) this.newEquipmentIds.add(equipmentId);
      });
      return this.getNewEquipmentIds();
    }

    getNewEquipmentIds() {
      return Object.freeze([...this.newEquipmentIds]);
    }

    // 詳細を開いたら見たものとして印を落とす。
    acknowledgeNewEquipment(equipmentId) {
      this.newEquipmentIds.delete(equipmentId);
      return this.getNewEquipmentIds();
    }

    // 絞り込みは表示だけ。所持装備にもCatalogにも触らない。
    setRarityFilter(filter) {
      if (!UiContent.RARITY_FILTERS.includes(filter)) throw new Error(`unknown filter: ${filter}`);
      // 入れ替え先を選んでいる最中は動かさない（選んでいた装備を見失わせない）。
      if (this.replaceTargetPending) return this.getEquipmentScreen();
      this.lockNotice = null;
      this.rarityFilter = filter;
      return this.getEquipmentScreen();
    }

    selectEquipment(equipmentId) {
      if (!this.gameState.economy.owns(equipmentId)) throw new Error(`not owned: ${equipmentId}`);
      // 入れ替え先を選んでいる最中は別の装備へ移らない（先にキャンセルさせる）。
      if (this.replaceTargetPending) return this.getEquipmentScreen();
      this.lockNotice = null;
      this.selectedEquipmentId = equipmentId;
      // 詳細を開いた＝見た、とみなしてNEWを落とす。
      this.acknowledgeNewEquipment(equipmentId);
      return this.getEquipmentScreen();
    }

    // 「装備する」。**入れ先はここで決める。**
    //
    // 空きがあれば**いちばん小さい番号の空き枠**へそのまま入れる（枠を選ばせない）。
    // 空きが無いときだけ「どれと入れ替えるか」待ちに入り、loadout には何も書かない。
    // 所持・枠・同名重複は、これまでどおり最後に normalizeLoadout が見る。
    equipSelected() {
      if (this.selectedEquipmentId === null) return this.getEquipmentScreen();
      // すでにどこかの枠に入っているものは入れ直さない（同じ装備を2枠へは入れない）。
      if (this.gameState.loadout.slots.includes(this.selectedEquipmentId)) {
        return this.getEquipmentScreen();
      }
      const empty = this.findFirstEmptySlot();
      if (empty === null) {
        this.lockNotice = null;
        this.replaceTargetPending = true;
        return this.getEquipmentScreen();
      }
      return this.setSlotEquipment(empty, this.selectedEquipmentId);
    }

    // 解放済みの枠のうち、いちばん小さい番号の空き。無ければ null。
    findFirstEmptySlot() {
      const unlocked = this.gameState.progression.getUnlockedSlotCount();
      for (let index = 0; index < unlocked; index += 1) {
        if (!this.gameState.loadout.slots[index]) return index;
      }
      return null;
    }

    // 入れ替え先が選ばれた。**その枠だけ**を選択中の装備で上書きする。
    // 外れた装備は loadout から消えるだけで、所持（economy）はそのまま＝装備BOXへ戻る。
    chooseReplaceSlot(index) {
      if (!this.replaceTargetPending || this.selectedEquipmentId === null) {
        return this.getEquipmentScreen();
      }
      const unlocked = this.gameState.progression.getUnlockedSlotCount();
      if (!Number.isInteger(index) || index < 0 || index >= unlocked) {
        return this.getEquipmentScreen();
      }
      const equipmentId = this.selectedEquipmentId;
      this.replaceTargetPending = false;
      return this.setSlotEquipment(index, equipmentId);
    }

    // 入れ替えをやめる。**装備は何も動かさない**で、選んでいた装備の詳細へ戻すだけ。
    cancelReplaceTarget() {
      this.replaceTargetPending = false;
      this.lockNotice = null;
      return this.getEquipmentScreen();
    }

    unequipSlot(index) {
      // 入れ替え先を選んでいる最中の「外す」は受けない（誤操作で枠が空くのを防ぐ）。
      if (this.replaceTargetPending) return this.getEquipmentScreen();
      return this.setSlotEquipment(index, null);
    }

    setSlotEquipment(index, equipmentId) {
      const unlocked = this.gameState.progression.getUnlockedSlotCount();
      if (index >= unlocked) return this.getEquipmentScreen();
      if (equipmentId !== null && !this.gameState.economy.owns(equipmentId)) {
        return this.getEquipmentScreen();
      }
      const slots = this.gameState.loadout.slots.slice();
      slots[index] = equipmentId;
      const normalized = EquipmentEffectEngine.normalizeLoadout({
        slots,
        params: this.gameState.loadout.params,
        unlockedSlotCount: unlocked,
      });
      this.gameState.loadout = { slots: normalized.slots, params: normalized.params };
      this.selectedEquipmentId = null;
      this.replaceTargetPending = false;
      this.lockNotice = null;
      this.save(SaveData.SAVE_TRIGGERS.LOADOUT_CHANGED);
      return this.getEquipmentScreen();
    }

    // 装備画面に出すもの一式。スロット・装備ボックス・詳細・5ターン率。
    // Catalog 引きも装備可否も**ここで済ませる**。View は並べるだけ。
    getEquipmentScreen() {
      const { economy, loadout, progression } = this.gameState;
      const unlocked = progression.getUnlockedSlotCount();
      const equippedIds = loadout.slots.filter((id) => id !== null);
      const preview = this.getPreview();

      const slots = [];
      for (let index = 0; index < CONSTANTS.maxEquipmentSlots; index += 1) {
        const equipmentId = loadout.slots[index] || null;
        const equipment = equipmentId ? getEquipment(equipmentId) : null;
        slots.push(Object.freeze({
          index,
          locked: index >= unlocked,
          equipmentId,
          name: equipment ? equipment.name : null,
          rarity: equipment ? equipment.rarity : null,
          // スロットに出す短い効果。文章はカタログのものをそのまま使う。
          summary: equipment ? equipment.description : null,
          selected: index === this.selectedSlot,
          // 入れ替え先を選んでいる最中だけ、解放済みの枠が「選べる枠」になる。
          replaceTarget: this.replaceTargetPending && index < unlocked,
        }));
      }

      // 所持装備だけを高レア順（LEGEND → N）で。同レア内はカタログの番号順。
      const items = EQUIPMENT
        .filter((equipment) => economy.owns(equipment.id))
        .filter((equipment) => this.rarityFilter === "ALL" || equipment.rarity === this.rarityFilter)
        .slice()
        .sort((a, b) => BOX_RARITY_ORDER.indexOf(a.rarity) - BOX_RARITY_ORDER.indexOf(b.rarity))
        .map((equipment) => {
          const slotIndex = loadout.slots.indexOf(equipment.id);
          return Object.freeze({
            equipmentId: equipment.id,
            name: equipment.name,
            rarity: equipment.rarity,
            description: equipment.description,
            equipped: slotIndex >= 0,
            equippedSlot: slotIndex >= 0 ? slotIndex : null,
            selected: equipment.id === this.selectedEquipmentId,
            isNew: this.newEquipmentIds.has(equipment.id),
          });
        });

      let detail = null;
      if (this.selectedEquipmentId) {
        const equipment = getEquipment(this.selectedEquipmentId);
        // どこかの枠に入っているものは入れ直せない。**同じ装備を2枠へは入れない。**
        // 入れ先はもう枠の選択では決まらないので、「選択中の枠と同じかどうか」は見ない。
        const alreadyElsewhere = equippedIds.includes(equipment.id);
        detail = Object.freeze({
          equipmentId: equipment.id,
          name: equipment.name,
          rarity: equipment.rarity,
          // 効果の文章はカタログのもの。UIへ書き写さない。
          description: equipment.description,
          spec: equipment.spec,
          equipped: equippedIds.includes(equipment.id),
          equippedSlot: loadout.slots.indexOf(equipment.id) >= 0 ? loadout.slots.indexOf(equipment.id) : null,
          canEquip: !alreadyElsewhere,
          reason: alreadyElsewhere ? "DUPLICATE" : null,
        });
      }

      return Object.freeze({
        slots: Object.freeze(slots),
        selectedSlot: this.selectedSlot,
        // 5枠すべて埋まっていて、どれと入れ替えるか待っている最中か。
        // **まだ loadout には何も書いていない**ので、キャンセルも画面離脱も自由。
        replaceTargetPending: this.replaceTargetPending,
        // 「装備する」を押したら入る枠。空きが無ければ null（＝入れ替え先を選ばせる）。
        nextEmptySlot: this.findFirstEmptySlot(),
        unlockedSlotCount: unlocked,
        maxSlotCount: CONSTANTS.maxEquipmentSlots,
        lockNotice: this.lockNotice,
        filter: this.rarityFilter,
        filters: UiContent.RARITY_FILTERS,
        items: Object.freeze(items),
        detail,
        // いま挑もうとしている相手。小さく出すだけ。
        enemy: Object.freeze({ name: preview.enemyName, resistance: preview.resistance, stage: preview.stage }),
        preview,
      });
    }

    // --- 抵抗値テスト ---------------------------------------------------------

    // ビルド確認用。5ターン率の表示だけが変わる。敵データも進行も**変えない**し、
    // 戦闘にも持ち込まない（beginBattle は必ず実際の抵抗値を使う）。
    setTestResistance(value) {
      if (value === null) {
        this.testResistance = null;
        return this.getPreview();
      }
      if (!Number.isFinite(value)) throw new TypeError(`抵抗値は数値: ${value}`);
      this.testResistance = Math.min(TEST_RESISTANCE_MAX, Math.max(0, Math.round(value)));
      return this.getPreview();
    }

    adjustTestResistance(delta) {
      const current = this.testResistance === null ? this.getEncounter().resistance : this.testResistance;
      return this.setTestResistance(current + delta);
    }

    resetTestResistance() {
      return this.setTestResistance(null);
    }

    // --- バトルへ -------------------------------------------------------------

    // 戦闘を始める。使うのは**実際の敵の抵抗値**で、抵抗値テストの値は持ち込まない。
    // 「一か八か」の対象ターンはこの瞬間に1回だけ決まる。
    beginBattle() {
      const encounter = this.getEncounter();
      const session = new BattleSession({
        enemy: encounter.enemy,
        loadout: {
          slots: this.gameState.loadout.slots,
          params: this.gameState.loadout.params,
          unlockedSlotCount: this.gameState.progression.getUnlockedSlotCount(),
        },
        context: this.gameState.progression.getBattleContext(encounter.enemyId),
        random: this.randomFactory(),
      });
      this.pendingSession = session;
      this.battle = {
        session,
        route: encounter.route,
        // この戦闘のSTAGE・敵・抵抗値。**戦闘が終わるまでこれを使う。**
        // 敗北するとProgressionはすぐStage1へ戻るので、そのまま読み直すと
        // 演出やLOSE画面の途中で「STAGE 1」に化ける（Phase 13のQAで見つけた）。
        encounter: Object.freeze({
          route: encounter.route,
          stage: encounter.stage,
          enemyId: encounter.enemyId,
          enemyName: encounter.enemy.name,
          enemyQuote: encounter.enemy.quote,
          resistance: encounter.resistance,
        }),
        phase: BATTLE_PHASES.READY,
        lastResolution: null,
        extraLog: Object.freeze([]),
        finalized: false,
        criticalSeCount: 0,
        killEffectShown: false,
        chestSePlayed: false,
        // 宝箱の開封の段階。ガチャと同じ CHEST / RESULT を使う（WINへ入ったときに立てる）。
        chestPhase: null,
        chargeSound: null,
        result: null,
        reward: null,
        events: Object.freeze([]),
      };
      // 前の戦闘の撃破SEが残っていたら、ここで切る（次戦へ持ち越さない）。
      this.audio.stopSe();
      this.setScreen(SCREENS.BATTLE);
      return session;
    }

    // --- 戦闘中 ---------------------------------------------------------------

    // 画面に出すもの。数字はすべて BattleSession から取り、UI側で作り直さない。
    getBattle() {
      if (!this.battle) throw new Error("戦闘が始まっていない");
      const { session } = this.battle;
      // 戦闘開始時に写し取ったもの。進行がStageを戻しても表示は動かない。
      const encounter = this.battle.encounter;
      const chance = session.currentChance;
      return Object.freeze({
        route: encounter.route,
        stage: encounter.stage,
        // 敵の絵を引くのに使う。パスの組み立ては AssetCatalog の仕事。
        enemyId: encounter.enemyId,
        enemyName: encounter.enemyName,
        enemyQuote: encounter.enemyQuote,
        resistance: encounter.resistance,
        state: session.state,
        phase: this.battle.phase,
        currentTurn: session.isFinished() ? null : session.currentTurn,
        remainingTurns: session.remainingTurns,
        maxTurns: CONSTANTS.turnsPerBattle,
        // 撃破に要るCRITICAL数と、いま当てた数。神だけ2で、通常敵は必ず1。
        // 画面はこの2つを見て「神格耐久」を出すかどうかを決める。
        criticalHits: session.criticalHits,
        requiredCriticalHits: session.requiredCriticalHits,
        currentChance: chance,
        // 0.1% も 0 へ丸めない。Calculator の表示規則をそのまま使う。
        currentChanceText: chance === null ? null : BattleCalculator.formatChanceForDisplay(chance) + "%",
        lastResolution: this.battle.lastResolution,
        extraLog: this.battle.extraLog,
        // 倒したあとか。画面は敵を消したままにするのに使う（再描画でも戻らない）。
        killed: this.battle.killEffectShown,
        canTap: this.battle.phase === BATTLE_PHASES.READY,
      });
    }

    // 1タップ＝1判定。抽選まで進めて演出を待つ。
    // READY 以外では受け付けない（連打でターンが飛ばない）。
    //
    // 順番が大事：**先に BattleSession が CRITICAL/MISS を確定させ**、
    // そのあとで、確定した結果を読むだけでチャージ音を選ぶ。
    // 音の抽選は演出専用の乱数で、戦闘側の乱数は1回も余計に消費しない。
    // onChargeEnd は音が鳴り終わったときの合図（View が結果公開に使う）。
    tapBattle({ onChargeEnd = null } = {}) {
      if (!this.battle || this.battle.phase !== BATTLE_PHASES.READY) {
        return Object.freeze({ accepted: false, reason: this.battle ? this.battle.phase : "NO_BATTLE" });
      }
      const tapped = this.battle.session.tap();
      if (!tapped.accepted) return tapped;
      this.battle.phase = BATTLE_PHASES.CHARGING;
      this.battle.lastResolution = tapped.resolution;
      // 内部の確率がちょうど0のターンは、溜めても結果が変わらない。
      // **判定そのものは普通に済ませてある**（session.tap() が乱数を1つ使う）ので、
      // 消費順も結果も変わらない。変えるのは「溜めを見せるかどうか」だけ。
      //
      // 勇者の血で0.1%になっているターンは 0 ではないので、ここへは入らない。
      // 画面の表示が 0% に丸められていても、見るのは session が持つ実際の値。
      const certainMiss = tapped.resolution.chance === 0;
      // タップしたらチャージ音（UI仕様書 04）。連打はここへ来ないので二重に鳴らない。
      const charge = certainMiss
        ? null
        : this.audio.playChargeSe(tapped.resolution.outcome, onChargeEnd);
      this.battle.chargeSound = charge;
      return Object.freeze(Object.assign({}, tapped, { chargeSound: charge, certainMiss }));
    }

    // 演出が終わった合図。ターンを進め、決着していれば Domain と保存まで済ませる。
    completeBattleTap() {
      if (!this.battle || this.battle.phase !== BATTLE_PHASES.CHARGING) {
        return Object.freeze({ accepted: false, reason: "NOT_CHARGING" });
      }
      const completed = this.battle.session.completeResolution();
      this.battle.extraLog = completed.extraJudgements || Object.freeze([]);
      // CRITICALで倒した瞬間に撃破SE。MISSでは鳴らさない（UI仕様書 04・AC-191）。
      this.playCriticalSeOnce();
      // 外したときはMISSの音。**ここは1タップにつき1回しか通らない**ので重ならない。
      // 一撃必殺はこの道を通らないため、途中のMISSでは鳴らない。
      if (completed.resolution.outcome === BattleSession.OUTCOMES.MISS) this.audio.playMissSe();
      // 撃破の演出も同じ合図から。**SEと同じ行で立てる**のでズレようがない。
      const killed = this.markKillOnce();

      if (!this.battle.session.isFinished()) {
        this.battle.phase = BATTLE_PHASES.READY;
        return Object.freeze({
          accepted: true,
          outcome: completed.resolution.outcome,
          finished: false,
          killed,
          extraJudgements: this.battle.extraLog,
          phase: this.battle.phase,
        });
      }

      // 結果を先に確定して保存し、そのあとで見せる。
      this.finalizeBattle();
      this.battle.phase = this.battle.extraLog.length > 0 ? BATTLE_PHASES.EXTRA : BATTLE_PHASES.RESULT;
      return Object.freeze({
        accepted: true,
        outcome: completed.resolution.outcome,
        finished: true,
        killed,
        extraJudgements: this.battle.extraLog,
        phase: this.battle.phase,
      });
    }

    // 撃破SEはCRITICALが出るたびに1回。演出の再描画では鳴り直さない。
    // 神は1戦で2回当てるので2回鳴る（通常敵は1発で決着するので今までどおり1回）。
    playCriticalSeOnce() {
      if (!this.battle) return false;
      const total = this.battle.session.counters.critical;
      if (total <= this.battle.criticalSeCount) return false;
      this.battle.criticalSeCount = total;
      return this.audio.playCriticalSe();
    }

    // いま選ばれている表記の言語。知らない値・未設定は既定（日本語）へ落とす。
    getLanguage() {
      const saved = this.gameState.options.language;
      const known = UiContent.LANGUAGES.some((choice) => choice.id === saved);
      return known ? saved : UiContent.DEFAULT_LANGUAGE;
    }

    // HOMEの文言。**View はここだけを見る**ので、画面側に日本語も英語も書かない。
    getHomeLabels() {
      return UiContent.HOME_LABELS[this.getLanguage()];
    }

    // いま選ばれている撃破演出。**View はここだけを見る**ので、
    // 設定キーも演出IDも画面側には書かない。選び直せば次の撃破から変わる。
    getKillEffect() {
      return AssetCatalog.getBattleKillEffect(this.gameState.options.killEffectId);
    }

    // 敵を倒した瞬間の合図。View はこれを見て撃破の演出を1回だけ出す。
    //
    // **倒していないCRITICALでは立たない。** 神の1発目のように戦闘が続くときは
    // session がまだ finished でないので false のまま。MISS でも立たない。
    // 敗北（LOSE）でも立たない。1戦につき1回だけ。
    markKillOnce() {
      if (!this.battle || this.battle.killEffectShown) return false;
      const session = this.battle.session;
      if (!session.isFinished() || session.state !== "WIN") return false;
      this.battle.killEffectShown = true;
      return true;
    }

    // 追加判定を見せ終えた。
    acknowledgeExtras() {
      if (!this.battle || this.battle.phase !== BATTLE_PHASES.EXTRA) return this.getScreen();
      this.battle.phase = BATTLE_PHASES.RESULT;
      return this.getScreen();
    }

    // 撃破／敗北の見せ場が終わった。ここで結果画面へ移る。
    acknowledgeResult() {
      if (!this.battle || this.battle.phase !== BATTLE_PHASES.RESULT) return this.getScreen();
      this.battle.phase = BATTLE_PHASES.FINISHED;
      this.setScreen(this.battle.result.result === "WIN" ? SCREENS.WIN : SCREENS.LOSE);
      this.beginWinChest();
      return this.getScreen();
    }

    // 宝箱を手に入れた戦闘は、まず**閉じた箱**を出してタップを待つ。
    // 段階の呼び方はガチャと同じ（CHEST → RESULT）で、戦闘側に別の状態機械を作らない。
    // 中身は finalizeBattle で確定・保存済み。ここでも開封でも一切引き直さない。
    beginWinChest() {
      if (!this.battle || this.screen !== SCREENS.WIN) return null;
      const reward = this.battle.reward;
      this.battle.chestPhase = reward && reward.chestDropped ? GACHA_PHASES.CHEST : null;
      return this.battle.chestPhase;
    }

    // 宝箱をタップした。ガチャの openGachaChest と同じで、**ここでは何も抽選しない**。
    // CHEST の段階でしか通らないので、連打しても二度は開かない。
    openWinChest() {
      if (!this.battle || this.battle.chestPhase !== GACHA_PHASES.CHEST) return this.getWinChest();
      this.battle.chestPhase = GACHA_PHASES.RESULT;
      this.playBattleChestSeOnce();
      return this.getWinChest();
    }

    // 開封の演出へ渡す1件。**ガチャの getGachaCurrent と同じ形**にしてあるので、
    // 画面側は同じ描き方・同じ演出・同じ錠をそのまま使える。
    // 値は RewardService が確定させた reward を写すだけで、ここでは何も決めない。
    getWinChest() {
      if (!this.battle) return null;
      const reward = this.battle.reward;
      if (!reward || !reward.chestDropped) return null;
      const equipment = getEquipment(reward.equipmentId);
      return Object.freeze({
        index: 0,
        total: 1,
        // 箱は戦闘報酬の宝箱そのもの。**レア度から演出箱を推し量らない。**
        chest: AssetCatalog.BATTLE_CHEST,
        drawnChest: AssetCatalog.BATTLE_CHEST,
        // 昇格（木箱LEGEND → 虹箱）はガチャの演出箱だけの話。カタログが無いと言えば無い。
        promotion: AssetCatalog.getChestPromotion(reward.chestRarity, AssetCatalog.BATTLE_CHEST),
        promoted: false,
        rarity: reward.chestRarity,
        equipmentId: reward.equipmentId,
        name: equipment.name,
        description: equipment.description,
        isNew: reward.isNew,
        duplicateSaleDiamonds: reward.duplicateSaleDiamonds,
        opened: this.battle.chestPhase === GACHA_PHASES.RESULT,
        phase: this.battle.chestPhase,
      });
    }

    // バトルのドロップ宝箱。開けたときに1回だけ、ガチャの木箱と同じ basic を鳴らす。
    playBattleChestSeOnce() {
      if (!this.battle || this.battle.chestSePlayed) return false;
      if (this.screen !== SCREENS.WIN) return false;
      const reward = this.battle.reward;
      if (!reward || !reward.chestDropped) return false;
      this.battle.chestSePlayed = true;
      return this.audio.playGachaChestSe(AssetCatalog.BATTLE_CHEST);
    }

    // 1戦の後始末。Phase 06 で決めた順（進行 → 記録 → 報酬 → snapshot）で回し、
    // **同じ BattleResult を二度処理しない**。最後に保存してから画面を動かす。
    finalizeBattle() {
      if (this.battle.finalized) return this.battle.result;
      this.battle.finalized = true;

      const session = this.battle.session;
      const battleResult = session.getResult();
      const progression = this.gameState.progression;
      const economy = this.gameState.economy;
      const record = this.gameState.record;

      const progressionOutcome = progression.applyBattleResult(battleResult);
      record.applyBattleResult(battleResult);
      // 宝箱の抽選は戦闘と同じ乱数列の続き（ロジック仕様書 18 の消費順）。
      const reward = RewardService.applyBattleReward({
        battleResult, progression, progressionOutcome, economy, random: session.random,
      });
      RewardService.applySnapshotRequests({ progressionOutcome, record, battleResult });
      if (reward.isNew && reward.equipmentId) this.markNewEquipment([reward.equipmentId]);

      this.battle.result = battleResult;
      this.battle.reward = reward;
      this.battle.events = progressionOutcome.events;

      this.save(battleResult.result === "WIN"
        ? SaveData.SAVE_TRIGGERS.BATTLE_WIN_RESOLVED
        : SaveData.SAVE_TRIGGERS.BATTLE_LOSE_RESOLVED);
      return battleResult;
    }

    // --- WIN / LOSE -----------------------------------------------------------

    getWin() {
      const finished = this.requireFinishedBattle();
      const reward = finished.reward;
      const chest = reward.chestDropped
        ? Object.freeze({
          rarity: reward.chestRarity,
          equipmentId: reward.equipmentId,
          name: getEquipment(reward.equipmentId).name,
          isNew: reward.isNew,
          duplicateSaleDiamonds: reward.duplicateSaleDiamonds,
        })
        : null;
      return Object.freeze({
        // 表示するのは RewardService が実際に付与した額。UI側で抵抗×2を作り直さない。
        battleDiamonds: reward.battleDiamonds,
        diamondsAfter: reward.diamondsAfter,
        chestDropped: reward.chestDropped,
        chest,
        // 開封の段階。宝箱が出ていなければ null（これまでどおりの流れ）。
        chestPhase: this.battle.chestPhase || null,
        killTurn: finished.result.killTurn,
        killedBy: finished.result.killedBy,
        next: this.getNextFromWin(),
      });
    }

    // いまの戦闘の場所（route と stage）。**背景を選ぶのに使う唯一の入口**で、
    // バトル前・バトル中・WIN・LOSE のどこから聞いても同じ答えが返る。
    // 戦闘が始まったあとは、その戦闘の encounter を見る（敗北すると Progression は
    // すぐ Stage1 へ戻るので、結果画面の途中で背景が変わらないようにするため）。
    getBattleScene() {
      const encounter = this.battle ? this.battle.encounter : this.getEncounter();
      return Object.freeze({ route: encounter.route, stage: encounter.stage });
    }

    getLose() {
      const finished = this.requireFinishedBattle();
      const isGod = this.battle.route === ROUTES.SPECIAL;
      return Object.freeze({
        route: this.battle.route,
        isGod,
        // 神だけは直接RETRY。通常/裏は各ルートのStage1から。
        retryLabel: isGod ? "RETRY" : "最初からやり直し",
        // 没収額は必須表示ではないが、持っておく（表示は後Phaseでも足せる）。
        forfeitedDiamonds: finished.reward.forfeitedDiamonds,
        missedTurns: finished.result.missedTurns,
      });
    }

    requireFinishedBattle() {
      if (!this.battle || !this.battle.result) throw new Error("戦闘が終わっていない");
      return this.battle;
    }

    // NEXTの行き先。Stage10をクリアした直後は一旦HOMEへ戻す（仕様書 10）。
    getNextFromWin() {
      const pending = this.getPendingEnding();
      if (pending) return Object.freeze({ kind: "ENDING", ending: pending, label: "NEXT" });
      const clearedRoute = this.battle.events.some((event) => (
        event.type === ProgressionState.EVENTS.ROUTE_RESET && event.reason === "CLEARED"
      ));
      if (clearedRoute || this.battle.route === ROUTES.SPECIAL) {
        return Object.freeze({ kind: "HOME", ending: null, label: "NEXT" });
      }
      return Object.freeze({ kind: "NEXT_STAGE", ending: null, label: "NEXT" });
    }

    nextFromWin() {
      // 同じ押下が2回届いても（1回目で戦闘はもう畳んである）何もしない。
      if (!this.battle) return this.getScreen();
      // 宝箱を開け終わるまでは次へ進まない。**受け取りそこねを作らない。**
      if (this.battle.chestPhase === GACHA_PHASES.CHEST) return this.getScreen();
      const next = this.getNextFromWin();
      const route = this.battle.route;
      this.battle = null;
      this.pendingSession = null;
      // pending は**消さない**。エンディングの本体は Phase 12。
      if (next.kind === "ENDING") return this.openScreen("ENDING");
      if (next.kind === "HOME") return this.goHome();
      return this.startRoute(route);
    }

    // 通常/裏は Progression が既にStage1へ戻している。UIでStageを代入しない。
    retryFromLose() {
      if (!this.battle) return this.getScreen(); // 2回目の押下は何もしない
      const route = this.battle.route;
      this.battle = null;
      this.pendingSession = null;
      return this.startRoute(route);
    }

    homeFromResult() {
      this.battle = null;
      this.pendingSession = null;
      return this.goHome();
    }

    // --- オプション -----------------------------------------------------------

    setOption(key, value) {
      const options = this.gameState.options;
      if (key === "bgmVolume" || key === "seVolume") {
        if (!Number.isFinite(value)) throw new TypeError(`音量は数値: ${value}`);
        options[key] = Math.min(1, Math.max(0, value));
      } else if (key === "criticalSoundId") {
        const known = UiContent.CRITICAL_SOUND_CHOICES.some((choice) => choice.id === value);
        if (!known) throw new Error(`unknown criticalSoundId: ${value}`);
        options.criticalSoundId = value;
      } else if (key === "language") {
        const known = UiContent.LANGUAGES.some((choice) => choice.id === value);
        if (!known) throw new Error(`unknown language: ${value}`);
        options.language = value;
      } else if (key === "killEffectId") {
        const known = UiContent.KILL_EFFECT_CHOICES.some((choice) => choice.id === value);
        if (!known) throw new Error(`unknown killEffectId: ${value}`);
        options.killEffectId = value;
      } else {
        throw new Error(`unknown option: ${key}`);
      }
      // 音量も撃破SEも即時反映（UI仕様書 09）。保存は従来どおり OPTIONS_CHANGED。
      this.audio.applyOptions(options);
      this.save(SaveData.SAVE_TRIGGERS.OPTIONS_CHANGED);
      return Object.freeze(Object.assign({}, options));
    }

    // 5ターンのどこかで必ず倒せると**プレビューの時点で分かる**か。
    //
    //   - 撃破に1回のCRITICALで足りる敵だけ（神は2回要るので対象外。
    //     enemyId では見ない。将来2回以上要る敵を足しても自動で外れる）
    //   - RANDOM が残っていない（未確定の値を100%扱いしない）
    //   - Clamp後の**内部値**が 100 以上のターンがある（表示の丸めでは判断しない）
    //
    // 抵抗値テスト中は画面の数字が実際の戦闘と違うので出さない。
    canInstantKill({ encounter, path, undetermined }) {
      if (encounter.enemy.requiredCriticalHits !== 1) return false;
      if (undetermined) return false;
      if (this.testResistance !== null) return false;
      return path.chances.some((chance) => chance >= 100);
    }

    // 一撃必殺。**結果を作らない。**通常どおり BattleSession を開いて最後まで回し、
    // 飛ばすのは演出（チャージ音・チャージ抽選・敵のズーム・途中のMISS描画）だけ。
    // 乱数の消費も killTurn も記録も報酬も、通常プレイと同じものになる。
    resolveBattleWithoutPresentation() {
      if (this.screen !== SCREENS.BATTLE_PREP) {
        return Object.freeze({ accepted: false, reason: "NOT_PREP" });
      }
      if (!this.getPreview().canInstantKill) {
        return Object.freeze({ accepted: false, reason: "NOT_INSTANT_KILL" });
      }
      const session = this.beginBattle();
      // 決着まで内部で回す。1タップぶんずつ正式に判定する（省略しない）。
      while (!session.isFinished()) {
        const tapped = session.tap();
        if (!tapped.accepted) break;
        const completed = session.completeResolution();
        this.battle.lastResolution = tapped.resolution;
        this.battle.extraLog = completed.extraJudgements || Object.freeze([]);
      }
      // 撃破SEだけは鳴らす（CRITICALの回数ぶん1回）。チャージ音は鳴らさない。
      this.playCriticalSeOnce();
      const killed = this.markKillOnce();
      this.finalizeBattle();
      // 結果はここで確定させるが、画面は動かさない。撃破の演出を見せてから
      // View が acknowledgeResult() を呼ぶ（通常の撃破とまったく同じ出口を通る）。
      this.battle.phase = BATTLE_PHASES.RESULT;
      return Object.freeze({
        accepted: true,
        result: this.battle.result.result,
        killTurn: this.battle.result.killTurn,
        killed,
      });
    }

    getOptions() {
      return Object.freeze(Object.assign({}, this.gameState.options));
    }

    // --- 音 -------------------------------------------------------------------

    // 撃破SEの試聴。**ゲームの判定ではない**ので、戦闘にも記録にも触らない。
    previewCriticalSound(soundId) {
      return this.audio.previewCriticalSe(soundId);
    }

    // いまの画面に合うBGMを決める。**曲名（キー）は Asset Catalog が持つ**。
    //
    //   BATTLE        … route と stage の組み合わせ（通常1-9 / 通常10 / 裏1-9 / 裏10 / 神）
    //   WIN / LOSE    … 勝利 / 敗北（1回きり。戦闘BGMは playBgm の差し替えで止まる）
    //   それ以外      … 思考フェイズ（HOME・装備・図鑑・ガチャ・OPTIONS・戦闘前…）
    //
    // 戻り値は鳴らすべきキー。同じ曲なら AudioManager 側が鳴らし直さない。
    getScreenBgm() {
      if (this.screen === SCREENS.WIN) return AssetCatalog.BGM.VICTORY;
      if (this.screen === SCREENS.LOSE) return AssetCatalog.BGM.DEFEAT;
      if (this.screen === SCREENS.BATTLE && this.battle) {
        return AssetCatalog.getBattleBgm(this.battle.encounter.route, this.battle.encounter.stage);
      }
      return AssetCatalog.BGM.THINKING;
    }

    // 画面が変わったらBGMを合わせる。同じ曲なら何もしない（頭から鳴り直さない）。
    syncBgm() {
      return this.audio.playBgm(this.getScreenBgm());
    }

    // 最初のユーザー操作。ここまでブラウザは音を鳴らさせてくれない。
    unlockAudio() {
      return this.audio.unlock();
    }

    // BGMの入口。音源が無ければ鳴らないが、呼び出しは成立する。
    startBgm() {
      return this.syncBgm();
    }

    // 背面へ回った / 戻った。BGMだけを止めて再開する。
    suspendAudio() {
      return this.audio.suspend();
    }

    resumeAudio() {
      return this.audio.resume();
    }


    // --- ガチャ ---------------------------------------------------------------

    // ガチャは1種類だけ。箱は**結果を見せるための演出**で、別のガチャではない。
    // 抽選も価格も Phase 06 の GachaService / gacha-catalog が正で、ここでは持たない。
    getGacha() {
      const economy = this.gameState.economy;
      return Object.freeze({
        diamonds: economy.getDiamonds(),
        options: Object.freeze(GACHA_PULLS.map((pull) => Object.freeze({
          id: pull.id,
          label: pull.label,
          price: pull.price,
          pullCount: pull.pullCount,
          affordable: economy.canAfford(pull.price),
        }))),
        rates: Object.freeze(RARITIES.map((rarity) => Object.freeze({ rarity, rate: RARITY_RATES[rarity] }))),
        phase: this.gacha.phase,
        message: this.gacha.message,
        progress: this.gacha.pulls.length > 1
          ? Object.freeze({ index: this.gacha.index + 1, total: this.gacha.pulls.length })
          : null,
        // 演出の最中は引けない。
        canPull: this.gacha.phase === GACHA_PHASES.IDLE,
        ratesOpen: this.ratesOpen,
      });
    }

    getGachaLabels() {
      return UiContent.GACHA_LABELS[this.getLanguage()];
    }

    getEquipmentLabels() {
      return UiContent.EQUIPMENT_LABELS[this.getLanguage()];
    }

    getRecordLabels() {
      return UiContent.RECORD_LABELS[this.getLanguage()];
    }

    getOptionLabels() {
      return UiContent.OPTION_LABELS[this.getLanguage()];
    }

    // 提供割合を重ねて出す／閉じる。**見せ方だけ**で、確率にも抽選にも触らない。
    setGachaRatesOpen(open) {
      this.ratesOpen = Boolean(open);
      return this.ratesOpen;
    }

    // 排出装備一覧を開く。**ガチャの状態（演出の途中・引いた結果）には触らない。**
    openGachaPool() {
      this.selectedPoolEquipmentId = null;
      this.setScreen(SCREENS.GACHA_POOL);
      return this.getGachaPool();
    }

    setPoolRarityFilter(filter) {
      if (!UiContent.RARITY_FILTERS.includes(filter)) throw new Error(`unknown filter: ${filter}`);
      this.poolFilter = filter;
      return this.getGachaPool();
    }

    // 一覧の装備を選ぶ。もう一度同じものを押すと閉じる。**装備はしない。**
    selectPoolEquipment(equipmentId) {
      getEquipment(equipmentId); // 知らないIDならここで落とす
      this.selectedPoolEquipmentId = this.selectedPoolEquipmentId === equipmentId ? null : equipmentId;
      return this.getGachaPool();
    }

    // 排出装備一覧。並びは N → LEGEND で、中身は**ガチャが実際に引く配列そのもの**
    // （GachaService.getPool）。装備を足せばここも自動で増える。
    getGachaPool() {
      const economy = this.gameState.economy;
      const items = RARITIES
        .flatMap((rarity) => GachaService.getPool(rarity))
        .filter((equipment) => this.poolFilter === "ALL" || equipment.rarity === this.poolFilter)
        .map((equipment) => Object.freeze({
          equipmentId: equipment.id,
          name: equipment.name,
          rarity: equipment.rarity,
          // 効果の文章はカタログのもの。未所持でも隠さない（図鑑とは役割が違う）。
          description: equipment.description,
          owned: economy.owns(equipment.id),
          selected: equipment.id === this.selectedPoolEquipmentId,
        }));

      let detail = null;
      if (this.selectedPoolEquipmentId) {
        const equipment = getEquipment(this.selectedPoolEquipmentId);
        detail = Object.freeze({
          equipmentId: equipment.id,
          name: equipment.name,
          rarity: equipment.rarity,
          description: equipment.description,
          spec: equipment.spec,
          owned: economy.owns(equipment.id),
        });
      }

      return Object.freeze({
        // 確率はガチャ画面と同じ出どころ（gacha-catalog）。UIへ書き写さない。
        rates: Object.freeze(RARITIES.map((rarity) => Object.freeze({ rarity, rate: RARITY_RATES[rarity] }))),
        filter: this.poolFilter,
        filters: UiContent.RARITY_FILTERS,
        items: Object.freeze(items),
        detail,
        totalCount: items.length,
        ratesOpen: this.ratesOpen,
      });
    }

    // 引く。**抽選 → 所持と記録の更新 → 保存**まで済ませてから箱を出す。
    // 途中でアプリが落ちても「ダイヤだけ減った」「装備だけ増えた」にならない。
    pullGacha(pullId) {
      if (this.gacha.phase !== GACHA_PHASES.IDLE) {
        return Object.freeze({ ok: false, reason: "BUSY" });
      }
      const economy = this.gameState.economy;
      if (!this.gachaRandom) this.gachaRandom = this.randomFactory();
      const drawn = GachaService.draw({
        pullId, economy, record: this.gameState.record, random: this.gachaRandom,
      });
      if (!drawn.ok) {
        this.gacha.message = "ダイヤが足りません";
        return drawn;
      }
      this.save(SaveData.SAVE_TRIGGERS.GACHA_RESOLVED);
      // 初取得は装備画面でもNEWにする（D7：このセッションのあいだだけ）。
      this.markNewEquipment(drawn.pulls.filter((pull) => pull.isNew).map((pull) => pull.equipmentId));
      this.gacha = {
        phase: GACHA_PHASES.CHEST,
        pulls: drawn.pulls,
        index: 0,
        message: null,
        lastDraw: drawn,
        promotedChest: null,
      };
      return drawn;
    }

    // 箱を開ける。**ここでは何も抽選しない。**結果は箱が出た時点で決まっている。
    // CHEST の段階でしか通らないので、連打しても開封SEは1回で済む。
    // 昇格中（PROMOTION）も通らないので、煙のあいだのタップは全部落ちる。
    //
    // 鳴らす開封SEは**いま画面に出ている箱**のもの。木箱が虹箱へ変わったあとは
    // 虹箱の音が鳴る（見えている箱と音がずれないようにする）。
    openGachaChest() {
      if (this.gacha.phase !== GACHA_PHASES.CHEST) return this.getGacha();
      const current = this.getGachaCurrent();
      this.gacha.phase = GACHA_PHASES.RESULT;
      this.audio.playGachaChestSe(current.chest);
      return this.getGacha();
    }

    // 箱の昇格をはじめる。**中身も抽選結果も一切変わらない。**
    // 変わるのは「見せている箱」だけで、pull.presentationChest は元のまま残る。
    // 昇格のあるなしは Asset Catalog が決める（ここにレア度も箱の名前も書かない）。
    beginChestPromotion() {
      if (this.gacha.phase !== GACHA_PHASES.CHEST) return Object.freeze({ accepted: false, reason: "NOT_CHEST" });
      const promotion = this.getChestPromotion();
      if (!promotion) return Object.freeze({ accepted: false, reason: "NO_PROMOTION" });
      this.gacha.phase = GACHA_PHASES.PROMOTION;
      return Object.freeze({ accepted: true, from: promotion.from, to: promotion.to });
    }

    // 煙に隠れているあいだに箱を差し替える。ここから先は虹箱として扱う。
    //
    // 昇格の音はこの1か所からしか鳴らない。**絵が変わる処理と同じ行**なので、
    // 音と映像がずれることがなく、二度目に呼ばれても（もう昇格済みなので）鳴らない。
    promoteChest() {
      if (this.gacha.phase !== GACHA_PHASES.PROMOTION) return false;
      const promotion = this.getChestPromotion();
      if (!promotion) return false;
      const pull = this.gacha.pulls[this.gacha.index];
      this.gacha.promotedChest = promotion.to;
      this.audio.playGachaPromotionSe(pull.rarity, pull.presentationChest);
      return true;
    }

    // 煙が終わった。虹箱を見せたまま、もう一度のタップを待つ。
    completeChestPromotion() {
      if (this.gacha.phase !== GACHA_PHASES.PROMOTION) return this.getGacha();
      this.promoteChest(); // 途中で差し替えそこねていても、ここで必ず虹箱にする
      this.gacha.phase = GACHA_PHASES.CHEST;
      return this.getGacha();
    }

    // いまの1件に昇格があるか。もう昇格済みなら無い（2回目は普通に開く）。
    getChestPromotion() {
      if (this.gacha.promotedChest) return null;
      const pull = this.gacha.pulls[this.gacha.index];
      if (!pull) return null;
      return AssetCatalog.getChestPromotion(pull.rarity, pull.presentationChest);
    }

    // 演出スプライトと同時に鳴らす音。N / R では鳴らない。
    playGachaEffectSe(rarity) {
      return this.audio.playGachaEffectSe(rarity);
    }

    // 装備が出た瞬間の音。**絵を出す処理と同じ合図から呼ぶ**（View 側で1か所）。
    // onEnded を渡すと鳴り終わりが返ってくる（UR / LEGEND の結果送りの解錠に使う）。
    playGachaItemSe(rarity, onEnded = null) {
      return this.audio.playGachaItemSe(rarity, onEnded);
    }

    // 鳴りかけのガチャSEを切る。**通常は使わない**（出現SEは最後まで鳴る設計）。
    // 鳴り終わる前にガチャ画面を離れたときだけ、古い音と受け口を残さないために呼ぶ。
    stopGachaSe() {
      this.audio.stopSe();
    }

    // 次の1件へ。10連なら10件目まで同じ演出を繰り返し、最後に一覧を出す。
    nextGachaResult() {
      if (this.gacha.phase !== GACHA_PHASES.RESULT) return this.getGacha();
      if (this.gacha.index + 1 < this.gacha.pulls.length) {
        this.gacha.index += 1;
        this.gacha.phase = GACHA_PHASES.CHEST;
        this.gacha.promotedChest = null; // 次の1件へ昇格を持ち越さない
        return this.getGacha();
      }
      this.gacha.phase = this.gacha.pulls.length > 1 ? GACHA_PHASES.SUMMARY : GACHA_PHASES.IDLE;
      if (this.gacha.phase === GACHA_PHASES.IDLE) this.gacha.pulls = Object.freeze([]);
      return this.getGacha();
    }

    closeGachaSummary() {
      if (this.gacha.phase !== GACHA_PHASES.SUMMARY) return this.getGacha();
      this.gacha = this.createGachaState();
      return this.getGacha();
    }

    // いま見せている1件。開封前でも「箱の種類」は分かる（結果は確定済み）。
    getGachaCurrent() {
      if (this.gacha.pulls.length === 0) return null;
      const pull = this.gacha.pulls[this.gacha.index];
      const equipment = getEquipment(pull.equipmentId);
      return Object.freeze({
        index: this.gacha.index,
        total: this.gacha.pulls.length,
        // 画面に出す箱。昇格したあとは虹箱（元の pull.presentationChest は変えない）。
        chest: this.gacha.promotedChest || pull.presentationChest,
        drawnChest: pull.presentationChest,
        promotion: this.getChestPromotion(),
        promoted: this.gacha.promotedChest !== null,
        rarity: pull.rarity,
        equipmentId: pull.equipmentId,
        name: equipment.name,
        description: equipment.description,
        isNew: pull.isNew,
        duplicateSaleDiamonds: pull.duplicateSaleDiamonds,
        opened: this.gacha.phase === GACHA_PHASES.RESULT,
      });
    }

    getGachaSummary() {
      return Object.freeze(this.gacha.pulls.map((pull) => Object.freeze({
        rarity: pull.rarity,
        equipmentId: pull.equipmentId,
        name: getEquipment(pull.equipmentId).name,
        chest: pull.presentationChest,
        isNew: pull.isNew,
        duplicateSaleDiamonds: pull.duplicateSaleDiamonds,
      })));
    }

    createGachaState() {
      return { phase: GACHA_PHASES.IDLE, pulls: Object.freeze([]), index: 0, message: null,
        lastDraw: null, promotedChest: null };
    }


    // --- 敵図鑑 ---------------------------------------------------------------

    // 図鑑に載るのは通常10体＋裏10体の20体。神はSPECIAL枠で、**20体には数えない**。
    // 登録数も解放条件も Progression が持っているものをそのまま出す（ここで数え直さない）。
    getEncyclopedia() {
      const progression = this.gameState.progression;
      const economy = this.gameState.economy;
      const registered = progression.getEncyclopediaFirstKillCount();
      const total = ENCYCLOPEDIA_ENEMIES.length;

      return Object.freeze({
        registered,
        total,
        complete: registered >= total,
        // カタログの並び（通常1〜10 → 裏1〜10）。撃破順などで並べ替えない。
        entries: Object.freeze(ENCYCLOPEDIA_ENEMIES.map((enemy) => this.toEncyclopediaCard(enemy))),
        // SPECIALは別枠。20体のカウントにも図鑑報酬にも入らない。
        special: this.toEncyclopediaCard(SPECIAL_ENEMY),
        // しきい値報酬の状況。受け取りは到達時に自動で済んでいる（Phase 06）。
        rewards: Object.freeze(ENCYCLOPEDIA_REWARDS
          .filter((reward) => reward.diamonds > 0)
          .map((reward) => Object.freeze({
            count: reward.count,
            diamonds: reward.diamonds,
            claimed: economy.hasClaimedEncyclopediaReward(reward.count),
            remaining: Math.max(0, reward.count - registered),
          }))),
        detail: this.selectedEnemyId ? this.getEnemyDetail(this.selectedEnemyId) : null,
      });
    }

    toEncyclopediaCard(enemy) {
      const discovered = this.gameState.progression.hasFirstKill(enemy.id);
      return Object.freeze({
        enemyId: enemy.id,
        route: enemy.route,
        stage: enemy.stage,
        discovered,
        // 未撃破は名前も伏せる。
        name: discovered ? enemy.name : UNKNOWN_ENEMY_NAME,
        selected: enemy.id === this.selectedEnemyId,
      });
    }

    // 未撃破の敵は、抵抗値も一言もプロフィールも返さない（画面へ漏らさないため）。
    getEnemyDetail(enemyId) {
      const enemy = getEnemy(enemyId);
      const discovered = this.gameState.progression.hasFirstKill(enemyId);
      if (!discovered) {
        return Object.freeze({
          enemyId,
          discovered: false,
          name: UNKNOWN_ENEMY_NAME,
          label: "未遭遇",
        });
      }
      const record = this.gameState.record.getState();
      return Object.freeze({
        enemyId,
        discovered: true,
        name: enemy.name,
        route: enemy.route,
        stage: enemy.stage,
        resistance: enemy.resistance,
        quote: enemy.quote,
        appearance: enemy.appearance,
        // 神のプロフィールはカタログで未設定。勝手に文章を作らない。
        profile: enemy.profile || EMPTY_TEXT,
        killCount: record.enemyKillCounts[enemyId] || 0,
        // 敗北数を出すのは裏敵だけ（企画書 08）。
        lossCount: enemy.tracksDefeats ? (record.backEnemyLossCounts[enemyId] || 0) : null,
        inEncyclopedia: enemy.inEncyclopedia,
      });
    }

    selectEnemy(enemyId) {
      getEnemy(enemyId); // 知らないIDならここで落ちる
      this.selectedEnemyId = enemyId;
      return this.getEncyclopedia();
    }

    clearEnemySelection() {
      this.selectedEnemyId = null;
      return this.getEncyclopedia();
    }

    // --- RECORD ---------------------------------------------------------------

    // 数字はすべて RecordState から。合計や順位をUIで作り直さない。
    getRecord() {
      const state = this.gameState.record.getState();
      return Object.freeze({
        totals: state.totals,
        mostUsedEquipment: this.toEquipmentEntry(state.mostUsedEquipment),
        mostDefeatedEnemy: this.toEnemyEntry(state.mostDefeatedEnemy),
        snapshots: Object.freeze({
          NORMAL_CLEAR: this.toSnapshotView(state.snapshots.NORMAL_CLEAR),
          TRUE_CLEAR: this.toSnapshotView(state.snapshots.TRUE_CLEAR),
        }),
        // クリア済みかどうか（初撃破から導いた確定事実）。記録が無いのにクリア済みなら
        // 画面は LOCKED ではなく「記録なし」と出す。**記録そのものは作らない**
        // （クリアした瞬間の値は今の値から戻せないので、推測で埋めない）。
        cleared: Object.freeze({
          NORMAL_CLEAR: this.gameState.progression.isRouteCleared(ROUTES.NORMAL),
          TRUE_CLEAR: this.gameState.progression.isRouteCleared(ROUTES.SPECIAL),
        }),
      });
    }

    toEquipmentEntry(entry) {
      if (!entry) return null;
      const equipment = getEquipment(entry.id);
      // rarity はアイコンの枠色のためだけ。集計値は RecordState のまま。
      return Object.freeze({
        equipmentId: entry.id, name: equipment.name, rarity: equipment.rarity, count: entry.count,
      });
    }

    toEnemyEntry(entry) {
      if (!entry) return null;
      return Object.freeze({ enemyId: entry.id, name: getEnemy(entry.id).name, count: entry.count });
    }

    // クリア時の記録。保存された値をそのまま見せる（現在値で上書きしない）。
    toSnapshotView(snapshot) {
      if (!snapshot) return null;
      return Object.freeze({
        kind: snapshot.kind,
        totals: Object.freeze({
          totalTaps: snapshot.totalTaps,
          totalCriticals: snapshot.totalCriticals,
          totalMisses: snapshot.totalMisses,
          totalDefeats: snapshot.totalDefeats,
          totalKills: snapshot.totalKills,
          gachaPullCount: snapshot.gachaPullCount,
          extraJudgementCount: snapshot.extraJudgementCount,
        }),
        mostUsedEquipment: this.toEquipmentEntry(snapshot.mostUsedEquipment),
        mostDefeatedEnemy: this.toEnemyEntry(snapshot.mostDefeatedEnemy),
        equipment: Object.freeze(snapshot.equippedIds.map((equipmentId) => Object.freeze({
          equipmentId,
          name: getEquipment(equipmentId).name,
          rarity: getEquipment(equipmentId).rarity,
        }))),
      });
    }


    // --- エンディング ---------------------------------------------------------

    // 見せるのは、クリアの一言と**保存済みのクリア時記録**だけ。
    // 記録の整形は RECORD 画面と同じ `toSnapshotView()` を使う（同じ処理を二重に持たない）。
    //
    // 壊れたセーブで両方 pending になっていたら TRUE を先に見せる（D8）。
    // 判定は `getPendingEnding()` の1か所だけで、ここでは分岐を増やさない。
    getEnding() {
      const ending = this.getPendingEnding();
      if (!ending) return Object.freeze({ ending: null, title: null, snapshot: null });
      const isTrue = ending === ProgressionState.ENDINGS.TRUE;
      const kind = isTrue ? "TRUE_CLEAR" : "NORMAL_CLEAR";
      return Object.freeze({
        ending,
        title: isTrue ? UiContent.ENDING_TITLES.TRUE : UiContent.ENDING_TITLES.NORMAL,
        // 保存された値をそのまま。現在値で数え直さない。
        snapshot: this.toSnapshotView(this.gameState.record.getState().snapshots[kind]),
      });
    }

    // 「HOMEへ」を押したときだけ pending を降ろす。**表示しただけでは消さない。**
    // 降ろしてから保存し、そのあとHOMEへ移る。
    consumeEndingAndGoHome() {
      const ending = this.getPendingEnding();
      if (ending) {
        this.gameState.progression.consumeEnding(ending);
        this.save(SaveData.SAVE_TRIGGERS.ENDING_CHANGED);
      }
      return this.goHome();
    }

    // RECORDはHOMEの補助ボタンから開く。開いた場所へ戻せるようにしておく。
    openRecord(returnTo) {
      this.recordReturnTo = returnTo && SCREENS[returnTo] ? SCREENS[returnTo] : SCREENS.HOME;
      this.setScreen(SCREENS.RECORD);
      return this.getScreen();
    }

    // アプリが背面へ回る／閉じるときの最後の保存。
    saveOnBackground() {
      return this.save(SaveData.SAVE_TRIGGERS.APP_BACKGROUND);
    }
  }

  Object.assign(ns, {
    AppController: Object.assign(AppController, {
      SCREENS, BATTLE_PHASES, GACHA_PHASES, ARCHIVE_TABS, TEST_RESISTANCE_MAX,
    }),
  });
})(globalThis);
