(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { Dom, UiContent, AppController, BattleCalculator, CONSTANTS, AssetCatalog, AudioManager, ROUTES } = ns;
  const { el, button, clear, screen } = Dom;
  const { SCREENS, BATTLE_PHASES: PHASES, GACHA_PHASES: GACHA } = AppController;

  // AppController の状態をDOMにするだけの層。**ここで計算しない。**
  // 確率も解放条件もダイヤも、Controller 越しに Domain から出てきた値を並べるだけ。

  const TURN_LABELS = (() => {
    const labels = [];
    for (let turn = 1; turn <= CONSTANTS.turnsPerBattle; turn += 1) labels.push(`TURN${turn}`);
    return Object.freeze(labels);
  })();

  // チャージ音が終わらなかったときの保険。いちばん長い音（Charge2 約5秒）＋余裕。
  // 音源ごとの秒数はここにもCSSにも書かない（`ended` が本来の合図）。
  const CHARGE_SAFETY_MS = 7000;

  // MISSのあとに敵を等倍へ戻す時間。次のタップは必ず等倍から始まる。
  const MISS_ZOOM_BACK_MS = 160;

  // 大きな「MISS」を見せる時間の既定。CSSの --miss-flash が本来の出どころで、
  // ここは変数が読めなかったときの保険（音源は約0.34秒）。
  const MISS_FLASH_MS = 400;

  // ガチャ開封の演出が始まってから装備を見せるまで。
  // スプライトがいちばん見応えのあるあたり（1秒ぶんの中盤〜終盤）で出す。
  // 絵自体は最後まで回してから消える。
  const GACHA_FX_REVEAL_MS = 620;

  // スプライトを畳むまでの猶予。画面が隠れて rAF が止まっても、
  // この時間で必ず片付ける（器も予約も残さない）。
  const GACHA_FX_END_MARGIN_MS = 120;

  // HOMEで使う絵のキー。**パスは持たない**（どのファイルかは AssetCatalog が決める）。
  const { UI_IMAGES } = AssetCatalog;

  // 開封演出の当て先。id の頭だけが違い、演出も錠もSEも同じものを通す。
  // 引く前のガチャ画面に置く飾りの箱。**結果とは関係ない**ただの看板で、
  // 「このガチャにはこういう箱がある」という雰囲気だけを伝える。
  // 虹箱は出さない（並べると当たりが約束されているように見える）。
  // 上の段に木と赤、下の段の真ん中に金。**大きさは3つとも同じ**で、
  // 金は大きさではなく置き場所（下の真ん中）で主役に見せる。
  const GACHA_IDLE_CHESTS = Object.freeze([
    Object.freeze({ chest: "wood", place: "top" }),
    Object.freeze({ chest: "red", place: "top" }),
    Object.freeze({ chest: "gold", place: "bottom" }),
  ]);

  const GACHA_FX_TARGETS = Object.freeze({ prefix: "gacha", result: "gacha-result", next: "gacha-next" });
  const WIN_FX_TARGETS = Object.freeze({ prefix: "win-item", result: "win-item-result", next: "win-next" });

  // 正式アイコンが無いあいだのレア度の目印。色と枠は styles.css の rarity-* が付ける。
  const RARITY_MARKS = Object.freeze({ N: "N", R: "R", SR: "SR", SSR: "SSR", UR: "UR", LEGEND: "LE" });

  // 画像は AssetCatalog 越しにだけ触る。**パスも敵IDも装備IDもここには書かない。**
  //
  // まだ置かれていないファイルは placeholder で描き、読み込みに失敗したら
  // その場で placeholder へ落として AssetCatalog へ「無かった」と伝える
  // （同じ404を毎回取りに行かないため）。画像が無くても画面は止まらない。

  function onAssetError(node, asset, whenMissing) {
    node.addEventListener("error", () => {
      AssetCatalog.markMissing(asset.path);
      whenMissing(node);
    });
  }

  // 枠ごと画像にする場所（敵の絵・図鑑のサムネ）。無ければ同じ大きさの枠を返す。
  function assetImage(asset, { className, alt = "", id = null } = {}) {
    const attrs = { "data-asset": asset.key, "aria-hidden": alt ? "false" : "true" };
    if (!asset.available) {
      attrs["data-fallback"] = "true";
      return el("div", { className, id, attrs });
    }
    const node = el("img", {
      className,
      id,
      // lazy にしない。置かれていない絵はすぐ失敗させて placeholder へ落としたい。
      attrs: Object.assign(attrs, { src: asset.src, alt, decoding: "async" }),
    });
    onAssetError(node, asset, () => {
      node.removeAttribute("src");
      node.setAttribute("data-fallback", "true");
    });
    return node;
  }

  // すでにCSSで描いてある物（宝箱・レア度の目印）へ重ねる場所。無ければ何も足さない。
  function assetOverlay(asset, { className, alt = "", onMissing = null } = {}) {
    if (!asset.available) return null;
    const node = el("img", {
      className,
      attrs: {
        src: asset.src, alt, "data-asset": asset.key, "aria-hidden": alt ? "false" : "true",
        decoding: "async",
      },
    });
    onAssetError(node, asset, () => {
      const parent = node.parentNode;
      if (parent) parent.removeChild(node);
      if (onMissing) onMissing(parent);
    });
    return node;
  }

  // ガチャの演出箱。箱の種類は**抽選の結果**で、抽選そのものはここでは触らない。
  //
  // 正式アートが読めたときは data-art を立てて、下に敷いてあるCSSの仮箱を隠す
  // （styles.css 側）。404 になったら data-art が外れ、そのままCSSの箱へ戻る。
  function chestBox(chestType, { className, id }) {
    const box = el("div", { className, id, attrs: { "data-chest": chestType } });
    const art = assetOverlay(AssetCatalog.getChestImage(chestType), {
      className: "chest-art",
      onMissing: () => box.removeAttribute("data-art"),
    });
    if (art) {
      box.setAttribute("data-art", "true");
      box.appendChild(art);
    }
    return box;
  }

  // 装備のアイコン。正式アイコンがあれば重ね、無ければレア度の目印がそのまま残る。
  //
  // 一覧と10連の結果ではレア度の目印**だけ**がレアを伝えているので、絵が載っても消さない。
  // 絵があるときは data-art を立てて、目印を隅の小さな札へ寄せる（styles.css 側）。
  // 404 になれば属性が外れ、今までどおり枠いっぱいの目印に戻る。
  function equipmentIcon(equipmentId, rarity) {
    const icon = el("span", {
      className: `icon rarity-${rarity}`,
      attrs: { "data-rarity": rarity, "aria-label": rarity, "data-equipment-icon": "true" },
      children: [el("span", { className: "icon-mark", text: RARITY_MARKS[rarity] || rarity })],
    });
    const art = assetOverlay(AssetCatalog.getEquipmentIcon(equipmentId), {
      className: "icon-art",
      onMissing: () => icon.removeAttribute("data-art"),
    });
    if (art) {
      icon.setAttribute("data-art", "true");
      icon.appendChild(art);
    }
    return icon;
  }

  // HOMEのボタン。正式な枠の絵を土台にして、その上へ文字を重ねる。
  //
  // **文字は絵に焼き込まれていない。**STAGE番号も日本語/英語もこの <span> が受け持つので、
  // 絵は1枚のまま（赤枠はバトルと裏バトルで、青枠は小ボタン4つで使い回す）。
  // 絵が無い／404 のときは data-art が外れ、これまでどおりCSSのボタンが残る。
  //
  // lines を渡すと「名前 / STAGE n」の2行で重ねる。横並びで幅が狭くなったぶん、
  // 1行に伸ばさず2行にして、狭い端末でも文字を切らずに収める。
  function homeImageButton(label, onClick, {
    className, id = null, attrs = null, imageKey, artClassName = "home-button-art", lines = null,
  }) {
    const node = button(label, onClick, { className, id, attrs });
    const art = assetOverlay(AssetCatalog.getUiImage(imageKey), {
      className: artClassName,
      onMissing: () => node.removeAttribute("data-art"),
    });
    if (!art) return node;
    // 文字は絵の上へ重ねたいので、素の文字は外して <span> へ入れ直す。
    clear(node);
    node.setAttribute("data-art", "true");
    node.appendChild(art);
    const children = lines
      ? [el("span", { className: "home-button-name", text: lines[0] }),
        el("span", { className: "home-button-stage", text: lines[1] })]
      : null;
    node.appendChild(el("span", {
      className: "home-button-label",
      text: children ? null : label,
      children: children || [],
    }));
    return node;
  }

  // 装備の詳細の中身（アイコン＋名前＋効果文）。装備画面と排出装備一覧で**同じものを使う**。
  // 効果の文章はカタログから来た detail.description をそのまま置くだけで、ここでは作らない。
  // 「装備する」ボタンや「所持済み」の札など、画面ごとの物は呼び出し側が badge/後ろへ足す。
  function equipmentDetailParts(detail, badge = null) {
    return [
      el("p", {
        className: "detail-head",
        children: [
          equipmentIcon(detail.equipmentId, detail.rarity),
          el("span", { className: "detail-name", text: detail.name }),
          badge,
        ],
      }),
      el("p", { className: "detail-description", text: detail.description }),
    ];
  }

  // ガチャ1回の結果で主役になる大きな装備アイコン。
  //
  // 一覧の 2.4em の目印（equipmentIcon）とは別枠で、正式イラストをそのまま大きく見せる。
  // 枠は正方形で固定なので、どの装備でも下の名前・効果の位置が動かない。
  // 絵が無い／404 のときは data-art が外れ、同じ枠の中にレア度の略号だけが残る。
  function equipmentShowcase(equipmentId, rarity) {
    const frame = el("div", {
      className: "result-art",
      id: "gacha-art",
      attrs: { "data-rarity": rarity, "data-equipment-icon": "true", "aria-label": rarity },
      children: [el("span", { className: "icon-mark", text: RARITY_MARKS[rarity] || rarity })],
    });
    const art = assetOverlay(AssetCatalog.getEquipmentIcon(equipmentId), {
      className: "icon-art result-art-image",
      onMissing: () => frame.removeAttribute("data-art"),
    });
    if (art) {
      frame.setAttribute("data-art", "true");
      frame.appendChild(art);
    }
    return frame;
  }

  // ガチャ開封のレア度別演出。1枚のスプライトシートを background-position で
  // 送るだけ。**DOMは1つ、画像の読み込みも1回。**60コマぶんの要素は作らない。
  //
  // 演出は presentation でしかないので、絵が無くても404でも結果表示は止めない。

  // 読み込み済みのシート。同じ絵を毎回取りに行かない。
  const loadedSheets = new Map();

  function preloadSheet(asset) {
    if (!asset.available) return null;
    if (loadedSheets.has(asset.src)) return loadedSheets.get(asset.src);
    let image = null;
    try {
      image = new global.Image();
      image.decoding = "async";
      image.addEventListener("error", () => {
        AssetCatalog.markMissing(asset.path);
        loadedSheets.delete(asset.src);
      }, { once: true });
      image.src = asset.src;
    } catch (error) {
      image = null; // Image が無い環境（テスト）でも止まらない
    }
    loadedSheets.set(asset.src, image);
    return image;
  }

  // 1コマぶんの background-position。左上が 0% 0%、右下が 100% 100%。
  function framePosition(index, sheet) {
    const column = index % sheet.columns;
    const row = Math.floor(index / sheet.columns);
    const x = sheet.columns > 1 ? (column / (sheet.columns - 1)) * 100 : 0;
    const y = sheet.rows > 1 ? (row / (sheet.rows - 1)) * 100 : 0;
    return `${x}% ${y}%`;
  }

  // スプライトの器。中身は背景画像1枚で、コマ送りは position を動かすだけ。
  function gachaEffectLayer(effect, frameIndex) {
    const layer = el("div", {
      className: "gacha-fx",
      id: "gacha-fx",
      attrs: { "data-fx": effect.key, "aria-hidden": "true" },
    });
    layer.style.backgroundImage = `url("${effect.image.src}")`;
    layer.style.backgroundSize = `${effect.sheet.columns * 100}% ${effect.sheet.rows * 100}%`;
    // 再生中に描き直されても、コマ0へ巻き戻さずいまのコマから続ける。
    layer.style.backgroundPosition = framePosition(frameIndex, effect.sheet);
    return layer;
  }

  // 煙の器。箱の真上に重ねる。作りはガチャ演出のスプライトと同じ。
  function chestSmokeLayer(promotion, frameIndex) {
    const layer = el("div", {
      className: "chest-smoke",
      id: "chest-smoke",
      attrs: { "data-fx": promotion.key, "aria-hidden": "true" },
    });
    layer.style.backgroundImage = `url("${promotion.image.src}")`;
    layer.style.backgroundSize = `${promotion.sheet.columns * 100}% ${promotion.sheet.rows * 100}%`;
    layer.style.backgroundPosition = framePosition(frameIndex, promotion.sheet);
    return layer;
  }

  // 撃破演出の器。敵の絵の真上に重ねる。大きさは styles.css が決める。
  function killEffectLayer(effect, frameIndex) {
    const layer = el("div", {
      className: "battle-kill-fx",
      id: "battle-kill-fx",
      attrs: { "data-fx": effect.key, "aria-hidden": "true" },
    });
    layer.style.backgroundImage = `url("${effect.image.src}")`;
    layer.style.backgroundSize = `${effect.sheet.columns * 100}% ${effect.sheet.rows * 100}%`;
    layer.style.backgroundPosition = framePosition(frameIndex, effect.sheet);
    return layer;
  }

  // 敵の絵。未撃破は**元の絵を一切参照せず**、専用のシルエット枠だけを描く。
  function enemyImage(enemyId, { discovered, className }) {
    const asset = discovered
      ? AssetCatalog.getEnemyImage(enemyId)
      : AssetCatalog.getEnemySilhouette(enemyId);
    const node = assetImage(asset, { className });
    if (!discovered) node.setAttribute("data-silhouette", "true");
    return node;
  }

  class AppView {
    constructor({ controller, root }) {
      if (!controller || !root) throw new TypeError("AppView には controller と root が要る");
      this.controller = controller;
      this.root = root;
      // 絵や文字を引っ張れないようにする（CSSの -webkit-user-drag が効かない環境の保険）。
      // 入力の部品（スライダーなど）は止めない。描き直しても root は同じなので1回だけ。
      if (typeof root.addEventListener === "function") {
        root.addEventListener("dragstart", (event) => {
          const target = event.target;
          if (target && typeof target.closest === "function"
            && target.closest("input, textarea, select, [contenteditable='true']")) return;
          event.preventDefault();
        });
      }
      // 敵の溜めズーム。render() でDOMを作り直すので、transition を効かせるには
      // 「描いた直後の値（from）」と「そこから向かう値（to）」の2つが要る。
      // 倍率も時間も AudioManager が返すチャージ音の情報が唯一の出どころ。
      this.enemyZoom = { from: 1, to: 1, ms: 0, ease: "ease-in" };
      // ガチャ開封の演出。1件につき1回だけ。再生中の rAF もここで持つ。
      this.gachaFx = null;
      this.gachaFxTimer = null;
      this.gachaFxEndTimer = null;
      this.gachaFxFrame = null;
      // 装備が出た瞬間のSEを鳴らしたか。1件（1箱）につき1回だけ。
      this.gachaItemSePlayed = false;
      // UR / LEGEND のあいだだけ立つ「結果送りの錠」。出現SEが鳴り終わるまで倒れない。
      // 錠が立っているあいだ、次へ / OK は押せず、押された入力は**捨てる**（溜めない）。
      this.gachaAdvanceLocked = false;
      // 出現SEの鳴り終わりが来なかったときだけの保険。正常時は使わない。
      this.gachaAdvanceTimer = null;
      // いま開封演出を映している場所。ガチャと戦闘の宝箱で**同じ処理**を使い回すので、
      // 結果カードと送りボタンのidだけをここで切り替える（処理はコピーしない）。
      this.fxTargets = GACHA_FX_TARGETS;
      // 敵を倒した瞬間の演出。1戦につき1回だけ。
      this.killFx = null;
      this.killFxEndTimer = null;
      this.killFxFrame = null;
      // 溜めを飛ばしたMISSのあと、次のタップを少しだけ待たせる時刻。
      // **「MISS」を読む間**をつくるだけで、判定にも記録にも乱数にも触らない。
      this.missHoldUntil = 0;
      // 箱の昇格（木箱LEGEND → 煙 → 虹箱）。動いているあいだは入力を一切受けない。
      this.chestSmoke = null;
      this.chestSmokeTimer = null;
      this.chestSmokeEndTimer = null;
      this.chestSmokeFrame = null;
      // 煙が消えたあと、昇格した箱だけを見せておくあいだの予約。
      this.chestHoldTimer = null;
    }

    // 敵のズームを1つに決める。以後 renderBattle がこれを読むだけになる。
    setEnemyZoom(from, to, ms, ease) {
      this.enemyZoom = { from, to, ms, ease };
    }

    // 画面を作り直す。状態は Controller 側にしか無いので、何度描いても同じ絵になる。
    render() {
      const current = this.controller.getScreen();
      this.syncGachaAdvanceLock(current);
      clear(this.root);
      this.root.setAttribute("data-screen", current.name);
      this.root.appendChild(this.renderScreen(current.name));
      this.startEnemyZoom();
      return this.root;
    }

    // 描いたあと、目標倍率へ動かす。
    //
    // 差し込んだ直後の値（from）をブラウザに一度確定させてから目標値（to）を入れる。
    // これをしないと2つの値が1回の計算にまとめられ、transition が走らずに
    // 一瞬で最終倍率になる（Phase 19 のQAで踏んだ）。offsetWidth の読み出しが
    // そのための「確定」。
    startEnemyZoom() {
      const zoom = this.enemyZoom;
      if (zoom.from === zoom.to) return;
      const art = this.root.querySelector(".battle-enemy");
      if (!art) return;
      void art.offsetWidth;
      art.style.setProperty("--enemy-zoom", String(zoom.to));
    }

    // 押したら状態を変えて描き直す、を1つにまとめる。
    // 最初の操作で音を解禁する（ブラウザはユーザー操作より前に音を鳴らさせない）。
    act(run) {
      return () => {
        this.controller.unlockAudio();
        run();
        this.render();
      };
    }

    renderScreen(name) {
      switch (name) {
        case SCREENS.FIRST_LAUNCH: return this.renderFirstLaunch();
        case SCREENS.TUTORIAL: return this.renderTutorial();
        case SCREENS.HOME: return this.renderHome();
        case SCREENS.BATTLE_PREP: return this.renderBattlePrep();
        case SCREENS.EQUIPMENT: return this.renderEquipment();
        case SCREENS.OPTIONS: return this.renderOptions();
        case SCREENS.ENDING: return this.renderEnding();
        case SCREENS.BATTLE: return this.renderBattle();
        case SCREENS.WIN: return this.renderWin();
        case SCREENS.LOSE: return this.renderLose();
        case SCREENS.GACHA: return this.renderGacha();
        case SCREENS.GACHA_POOL: return this.renderGachaPool();
        case SCREENS.ENCYCLOPEDIA: return this.renderEncyclopedia();
        case SCREENS.RECORD: return this.renderRecord();
        case SCREENS.ARCHIVE: return this.renderArchive();
        default: return this.renderShell(name);
      }
    }

    // --- 初回導線 -------------------------------------------------------------

    renderFirstLaunch() {
      return screen(SCREENS.FIRST_LAUNCH, [
        el("h1", { className: "title", text: UiContent.SCREEN_TITLES.FIRST_LAUNCH }),
        el("p", { className: "lead", text: "はじめる前に、あそびかたを見ますか？" }),
        el("div", {
          className: "choices",
          children: UiContent.FIRST_LAUNCH_CHOICES.map((choice) => button(
            choice.label,
            this.act(() => this.controller.chooseTutorial(choice.see)),
            {
              className: choice.see ? "primary" : "secondary",
              id: choice.see ? "tutorial-see" : "tutorial-skip",
            },
          )),
        }),
      ]);
    }

    renderTutorial() {
      const step = this.controller.getTutorialStep();
      return screen(SCREENS.TUTORIAL, [
        el("p", { className: "step-count", text: `${step.index} / ${step.total}` }),
        el("h2", { className: "title", text: step.title }),
        el("p", { className: "body", text: step.body }),
        el("div", {
          className: "choices",
          children: [
            step.hasPrev
              ? button("前へ", this.act(() => this.controller.tutorialPrev()), { className: "secondary" })
              : null,
            // 進める操作なので、ここも他と同じ赤金の台座。文言も進み方も今までどおり。
            this.renderMainButton(step.isLast ? "はじめる" : "次へ", "tutorial-next",
              () => this.controller.tutorialNext(), { className: "tutorial-next" }),
          ],
        }),
      ]);
    }

    // --- HOME -----------------------------------------------------------------

    // HOMEは「見出しとダイヤ → 真ん中の絵 → 大ボタン → 小ボタン」の3段。
    //
    // 一番押してほしいのはバトルなので、そこだけ大きく置く。
    // 裏が解放されるとそのすぐ下へ増える（未解放のあいだは枠も出さない）。
    // 文言は Controller が言語ごとに返すものを並べるだけで、ここには書かない。
    renderHome() {
      const home = this.controller.getHome();
      const text = this.controller.getHomeLabels();

      // HOMEの主役はバトル。そのあとにアーカイブ / ガチャ / 装備を縦一列で並べ、
      // OPTIONは右下の歯車へ戻した（主要導線と同じ大きさでは並べない）。
      // バトル系3つは「バトル」の中へ、図鑑とRECORDは「アーカイブ」の中へ入ったまま。
      // **中身の処理も解放条件も今までのものを呼ぶだけ。**
      const menu = (label, id, imageKey, run) => homeImageButton(label, this.act(run), {
        className: "home-small", id, imageKey,
      });

      return screen(SCREENS.HOME, [
        this.renderHomeVisual(text.diamonds, home.diamonds),
        home.pendingEnding
          ? button(text.ending, this.act(() => this.controller.openScreen("ENDING")),
            { className: "primary home-ending", id: "home-ending" })
          : null,
        // いちばん押してほしいのはバトル。ここだけ赤枠で横いっぱい。
        el("div", {
          className: "home-menu",
          children: [homeImageButton(text.battle,
            this.act(() => this.controller.setBattleModesOpen(true)),
            {
              className: "primary home-main",
              id: "home-battle",
              imageKey: UI_IMAGES.HOME_BUTTON_BATTLE,
            })],
        }),
        // 主要導線の残り3つ。縦一列で、**外形も文字の大きさも同じ**に揃える。
        // 台座は**3つとも同じ蒼銀の1枚**（HOME_BUTTON_ARCHIVE）を使い回し、
        // 変えるのは重ねる文字だけにした。1つだけ明るい青が混じると、そこが
        // 赤いバトルの次に目立ってしまい、視線の順序が崩れるため。
        el("div", {
          className: "home-list",
          children: [
            menu(text.archive, "home-archive", UI_IMAGES.HOME_BUTTON_ARCHIVE,
              () => this.controller.openArchive()),
            menu(text.gacha, "home-gacha", UI_IMAGES.HOME_BUTTON_ARCHIVE,
              () => this.controller.openScreen("GACHA")),
            menu(text.equip, "home-equipment", UI_IMAGES.HOME_BUTTON_ARCHIVE,
              () => this.controller.openEquipment()),
          ],
        }),
        // OPTIONは補助。歯車ひとつを右下へ、他のボタンに掛からない大きさで置く。
        el("div", {
          className: "home-corner",
          children: [homeImageButton(text.options,
            this.act(() => this.controller.openScreen("OPTIONS")),
            {
              className: "home-option",
              id: "home-options",
              imageKey: UI_IMAGES.HOME_OPTION_ICON,
              artClassName: "home-option-art",
            })],
        }),
        this.renderBattleModes(home, text),
      ]);
    }

    // バトルモード。HOMEの上へ重ねるだけで、画面は移らない。
    // NORMAL / HARD / GOD は**中の呼び方（通常 / 裏 / 神）そのまま**で、
    // 行き先も解放条件も今までのHOMEのボタンと同じものを使う。
    renderBattleModes(home, text) {
      if (!home.modesOpen) return null;
      const modeLabel = { normal: text.normal, back: text.hard, special: text.god };
      const stageOf = (route) => (route.stage === null
        ? null : `${text.stage} ${route.stage}`);
      return el("div", {
        className: "modal-backdrop",
        id: "home-modes-backdrop",
        onClick: this.act(() => this.controller.setBattleModesOpen(false)),
        children: [
          el("div", {
            className: "modal home-modes",
            id: "home-modes",
            onClick: (event) => event.stopPropagation(),
            children: [
              el("h3", { className: "modal-title", text: text.modeTitle }),
              el("div", {
                className: "mode-list",
                children: home.routes.map((route) => {
                  const node = homeImageButton(modeLabel[route.route],
                    this.act(() => this.controller.startRoute(route.route)),
                    {
                      className: `primary home-main mode-button${route.locked ? " locked" : ""}`
                        + (route.route === ROUTES.SPECIAL ? " home-special" : ""),
                      attrs: { "data-route": route.route },
                      imageKey: route.route === ROUTES.SPECIAL
                        ? UI_IMAGES.HOME_BUTTON_SPECIAL
                        : UI_IMAGES.BATTLE_MODE_BUTTON,
                      lines: route.locked
                        ? [modeLabel[route.route], text.locked]
                        : (stageOf(route) ? [modeLabel[route.route], stageOf(route)] : null),
                    });
                  // 解放条件は Progression が決めたまま。**押せないだけ**で条件は動かさない。
                  if (route.locked) node.disabled = true;
                  return node;
                }),
              }),
              this.renderBackButton(text.back, "home-modes-close",
                () => this.controller.setBattleModesOpen(false), { className: "modal-close" }),
            ],
          }),
        ],
      });
    }

    // HOMEの真ん中の絵。まだ置かれていなければ、同じ大きさの枠だけが残る
    // （置き場は Asset Catalog が持っていて、ファイルを置けばそのまま絵に替わる）。
    // 文字は重ねない。
    renderHomeVisual(diamondsLabel, diamonds) {
      const asset = AssetCatalog.getUiImage(UI_IMAGES.HOME_VISUAL);
      const frame = el("div", { className: "home-visual", id: "home-visual" });
      const art = assetImage(asset, { className: "home-hero", alt: "" });
      frame.appendChild(art);
      // 絵の右上。タイトルの下・顔の横（中央からは外れた位置）へ置く。
      frame.appendChild(this.renderDiamonds(diamondsLabel, diamonds));
      // 絵が無いあいだは枠だけを描く。**枠側に印を付ける**ので、
      // 読み込みに失敗した <img> がブラウザの「壊れた画像」を出すことはない。
      if (!asset.available) frame.setAttribute("data-fallback", "true");
      else art.addEventListener("error", () => frame.setAttribute("data-fallback", "true"), { once: true });
      return frame;
    }

    // 所持ダイヤ。宝石の絵を土台にして、その上へ**セーブが持っている今の値**を重ねる。
    // 数え方も増減もここでは触らない（Controller から来た文字を置くだけ）。
    // 絵が無い／404 のときは data-art が外れ、これまでどおりの枠だけが残る。
    // 主役は数字。「ダイヤ」は小さく添え、数字を大きく濃く出す（文字としては「ダイヤ 660」のまま）。
    renderDiamonds(label, diamonds, { id = "home-diamonds" } = {}) {
      const node = el("p", { className: "diamonds", id });
      const art = assetOverlay(AssetCatalog.getUiImage(UI_IMAGES.HOME_DIAMOND_FRAME), {
        className: "diamond-frame",
        onMissing: () => node.removeAttribute("data-art"),
      });
      if (art) {
        node.setAttribute("data-art", "true");
        node.appendChild(art);
      }
      node.appendChild(el("span", {
        className: "diamond-count",
        children: [
          el("span", { className: "diamond-label", text: label }),
          global.document.createTextNode(" "),
          el("span", { className: "diamond-value", text: String(diamonds) }),
        ],
      }));
      return node;
    }

    // --- バトル前 -------------------------------------------------------------

    renderBattlePrep() {
      const preview = this.controller.getPreview();
      return screen(SCREENS.BATTLE_PREP, [
        this.renderBattleBackdrop("prep-backdrop", "strong"),
        el("header", {
          className: "prep-header",
          children: [
            el("span", { className: "stage", text: preview.stage === null ? "SPECIAL" : `STAGE ${preview.stage}` }),
            el("span", { className: "enemy-name", id: "prep-enemy-name", text: preview.enemyName }),
            el("span", { className: "resistance", id: "prep-resistance", text: `抵抗 ${preview.resistance}` }),
          ],
        }),
        // バトル開始直後（Charge前の等倍）と同じ大きさで見せる。大きさの決め方は styles.css。
        enemyImage(preview.enemyId, { discovered: true, className: "enemy-art prep-enemy" }),
        el("p", { className: "quote", text: preview.enemyQuote }),
        this.renderSpecialRule(preview.requiredCriticalHits),
        this.renderTurnTable(preview),
        el("div", {
          className: "choices",
          children: [
            this.renderStartButton(preview),
            this.renderSubButton("装備変更", "prep-equipment",
              () => this.controller.openEquipment(), { className: "prep-sub" }),
            this.renderBackButton("戻る", "prep-back", () => this.controller.goHome()),
          ],
        }),
      ]);
    }

    // 開始ボタン。**同じボタンの見た目と行き先を切り替えるだけ**で、2つ並べない。
    //
    // 5ターンのどこかで必ず倒せると分かっているときだけ「一撃必殺」。
    // 押すと演出を飛ばして結果まで進む（勝敗はいつもどおり BattleSession が決める）。
    renderStartButton(preview) {
      if (!preview.canInstantKill) {
        return this.renderMainButton("バトル開始", "prep-start",
          () => this.controller.beginBattle(), { className: "prep-main" });
      }
      const start = homeImageButton("一撃必殺", () => {
        if (start.disabled) return; // 連打してもここから先へ行かせない
        start.disabled = true;
        this.controller.unlockAudio();
        const done = this.controller.resolveBattleWithoutPresentation();
        // 溜めもタップも飛ばすが、**倒した瞬間の演出だけは見せる。**
        // そのあとは通常の撃破と同じ出口（acknowledgeResult）を通る。
        if (done.killed) this.startKillEffect();
        this.render();
        if (!done.accepted) return;
        this.afterResult(() => {
          this.controller.acknowledgeResult();
          this.render();
        });
      }, {
        // 台座はバトル開始と**同じ赤金1枚**。変わるのは文字と、CSSの軽い金の光だけ。
        className: "primary plate-main prep-main instant-kill",
        id: "prep-start",
        attrs: { "data-instant-kill": "true" },
        imageKey: UI_IMAGES.GACHA_DRAW_BUTTON,
      });
      return start;
    }

    // TURN1〜5の最終CRITICAL率。横に5つ並べる（狭い縦画面でも1画面に収まる）。
    // 文字列は Controller が Calculator の丸めで作ったものをそのまま出す。
    renderTurnTable(preview) {
      const table = el("ul", {
        className: "turns",
        id: "turn-table",
        children: preview.display.map((text, index) => el("li", {
          className: `turn${preview.undetermined ? " undetermined" : ""}`,
          attrs: { "data-turn": String(index + 1) },
          children: [
            el("span", { className: "turn-label", text: TURN_LABELS[index] }),
            el("span", { className: "turn-chance", text }),
          ],
        })),
      });
      if (!preview.undetermined) return table;
      // 未確定のときは、なぜ数字が出ないのかを1行だけ添える。
      return el("div", {
        className: "turns-block",
        children: [table, el("p", { className: "turns-note", id: "turns-note", text: preview.undeterminedNote })],
      });
    }

    // --- 装備変更 -------------------------------------------------------------

    renderEquipment() {
      const view = this.controller.getEquipmentScreen();
      return screen(SCREENS.EQUIPMENT, [
        el("h2", { className: "title", text: UiContent.SCREEN_TITLES.EQUIPMENT }),
        // いま挑もうとしている相手。情報を増やさず1行だけ。
        el("p", {
          className: "current-enemy",
          id: "current-enemy",
          text: `${view.enemy.stage === null ? "SPECIAL" : `STAGE ${view.enemy.stage}`}　`
            + `${view.enemy.name}　抵抗 ${view.enemy.resistance}`,
        }),
        this.renderReplaceBanner(view),
        this.renderSlots(view),
        view.lockNotice ? el("p", { className: "notice", id: "lock-notice", text: view.lockNotice }) : null,
        this.renderFilters(view),
        this.renderEquipmentBox(view),
        this.renderDetail(view),
        this.renderResistanceTest(view.preview),
        this.renderTurnTable(view.preview),
        el("div", {
          className: "choices",
          children: [button("戻る", this.act(() => this.controller.back()), { className: "ghost", id: "equipment-back" })],
        }),
      ]);
    }

    // 5枠すべて埋まっているときの入れ替え待ち。**枠のすぐ上**へ置いて、
    // 案内・入れようとしている装備・やめる手段を1か所で見せる（狭い端末でも同時に見える）。
    renderReplaceBanner(view) {
      if (!view.replaceTargetPending) return null;
      const text = this.controller.getEquipmentLabels();
      const detail = view.detail;
      return el("div", {
        className: "replace-banner",
        id: "replace-banner",
        children: [
          el("p", { className: "replace-notice", id: "replace-notice", text: text.replaceNotice }),
          detail
            ? el("p", {
              className: "replace-target-item",
              children: [
                equipmentIcon(detail.equipmentId, detail.rarity),
                el("span", { className: "replace-target-name", text: detail.name }),
              ],
            })
            : null,
          this.renderBackButton(text.cancel, "replace-cancel",
            () => this.controller.cancelReplaceTarget(), { className: "replace-cancel" }),
        ],
      });
    }

    renderSlots(view) {
      return el("ul", {
        className: "slots",
        id: "equipment-slots",
        children: view.slots.map((slot) => {
          const label = slot.locked ? "この枠はまだ解放されていません" : (slot.name || "（空き）");
          const children = [
            el("span", { className: "slot-index", text: `${slot.index + 1}` }),
            slot.rarity
              ? equipmentIcon(slot.equipmentId, slot.rarity)
              : el("span", { className: `icon ${slot.locked ? "locked-icon" : "empty-icon"}`, text: slot.locked ? "🔒" : "＋" }),
            el("span", {
              className: "slot-body",
              children: [
                el("span", { className: "slot-name", text: label }),
                slot.summary ? el("span", { className: "slot-summary", text: slot.summary }) : null,
              ],
            }),
          ];
          // 入れ替え先を選んでいる最中は「外す」を出さない。誤って枠を空にさせない
          // ため（モードを抜ければそのまま戻る）。
          if (!slot.locked && slot.equipmentId && !view.replaceTargetPending) {
            children.push(button("外す", this.act(() => this.controller.unequipSlot(slot.index)), { className: "ghost" }));
          }
          return el("li", {
            className: `slot${slot.locked ? " locked" : ""}${slot.selected ? " selected" : ""}`
              + `${slot.replaceTarget ? " replace-target" : ""}`,
            attrs: {
              "data-slot": String(slot.index),
              "data-locked": String(slot.locked),
              "data-replace-target": String(Boolean(slot.replaceTarget)),
            },
            onClick: slot.locked ? null : this.act(() => this.controller.selectSlot(slot.index)),
            children,
          });
        }),
      });
    }

    renderFilters(view) {
      return el("div", {
        className: "filters",
        id: "equipment-filters",
        children: view.filters.map((filter) => {
          const node = button(
            filter,
            this.act(() => this.controller.setRarityFilter(filter)),
            { className: filter === view.filter ? "filter active" : "filter", attrs: { "data-filter": filter } },
          );
          // 入れ替え先を選んでいる最中は触らせない（Controller 側でも弾いている）。
          if (view.replaceTargetPending) node.disabled = true;
          return node;
        }),
      });
    }

    renderEquipmentBox(view) {
      if (view.items.length === 0) {
        return el("p", { className: "empty", id: "equipment-box", text: "この絞り込みに合う所持装備はありません。" });
      }
      // 入れ替え先を選んでいる最中は、別の装備へ移らせない（先にキャンセルさせる）。
      const locked = view.replaceTargetPending;
      return el("ul", {
        className: `equipment-box${locked ? " input-locked" : ""}`,
        id: "equipment-box",
        children: view.items.map((item) => el("li", {
          className: `equipment${item.selected ? " selected" : ""}`,
          attrs: { "data-equipment": item.equipmentId, "data-rarity": item.rarity },
          onClick: locked ? null : this.act(() => this.controller.selectEquipment(item.equipmentId)),
          children: [
            equipmentIcon(item.equipmentId, item.rarity),
            el("span", {
              className: "equipment-body",
              children: [
                el("span", { className: "equipment-name", text: item.name }),
                el("span", { className: "equipment-summary", text: item.description }),
              ],
            }),
            item.isNew ? el("span", { className: "new-badge", text: "NEW" }) : null,
            item.equipped ? el("span", { className: "equipped", text: "装備中" }) : null,
          ],
        })),
      });
    }

    renderDetail(view) {
      if (!view.detail) {
        return el("div", { className: "detail empty", id: "equipment-detail", text: "装備を選ぶと効果が出ます。" });
      }
      const detail = view.detail;
      return el("div", {
        className: "detail",
        id: "equipment-detail",
        attrs: { "data-equipment": detail.equipmentId },
        children: [
          ...equipmentDetailParts(detail, detail.equipped
            ? el("span", { className: "equipped", text: `装備中（枠${detail.equippedSlot + 1}）` })
            : null),
          // 入れ先は押してから決まる（空きがあればいちばん小さい番号の空き枠、
          // 空きが無ければ入れ替える枠を選ばせる）ので、ここに枠番号は書かない。
          // 入れ替え待ちのあいだは、枠のすぐ上のバナーが操作を受け持つ。
          view.replaceTargetPending || !detail.canEquip
            ? null
            : button(this.controller.getEquipmentLabels().equip,
              this.act(() => this.controller.equipSelected()), { className: "primary", id: "equip-button" }),
          !view.replaceTargetPending && !detail.canEquip
            ? el("p", { className: "detail-note", text: "すでに他のスロットで装備中です。" })
            : null,
        ],
      });
    }

    // 抵抗値テスト。ここを変えても敵データにも進行にも触らない（表示だけ）。
    renderResistanceTest(preview) {
      return el("div", {
        className: "resistance-test",
        id: "resistance-test",
        children: [
          el("span", { className: "label", text: "TEST RESIST" }),
          button("-10", this.act(() => this.controller.adjustTestResistance(-10)), { className: "ghost" }),
          button("-1", this.act(() => this.controller.adjustTestResistance(-1)), { className: "ghost" }),
          el("span", { className: "value", id: "resistance-value", text: String(preview.previewResistance) }),
          button("+1", this.act(() => this.controller.adjustTestResistance(1)), { className: "ghost" }),
          button("+10", this.act(() => this.controller.adjustTestResistance(10)), { className: "ghost" }),
          preview.isTestResistance
            ? button("敵の値へ戻す", this.act(() => this.controller.resetTestResistance()), { className: "ghost" })
            : null,
        ],
      });
    }

    // --- オプション -----------------------------------------------------------

    renderOptions() {
      const options = this.controller.getOptions();
      const text = this.controller.getOptionLabels();
      // 画面は0〜100、保存と音は0〜1。変換は AudioManager の2つだけを使う。
      // 上段にラベルと現在%、下段にスライダー。--fill は青い塗りの長さ（見た目だけ）。
      const volume = (key, label) => {
        const percent = AudioManager.volumeToPercent(options[key]);
        const input = el("input", {
          className: "slider",
          attrs: {
            type: "range", min: "0", max: "100", step: "1",
            value: String(percent),
            style: `--fill: ${percent}%`,
          },
          id: `option-${key}`,
        });
        input.addEventListener("input", () => {
          this.controller.unlockAudio();
          this.controller.setOption(key, AudioManager.percentToVolume(input.value));
          input.style.setProperty("--fill", `${input.value}%`);
          const readout = global.document.getElementById(`option-${key}-value`);
          if (readout) readout.textContent = `${input.value}%`;
        });
        return el("label", {
          className: "option",
          attrs: { "data-kind": "volume" },
          children: [
            el("span", { className: "label", text: label }),
            el("span", {
              className: "value",
              id: `option-${key}-value`,
              text: `${percent}%`,
            }),
            input,
          ],
        });
      };

      const select = el("select", { id: "option-criticalSoundId", className: "select" });
      // 保存値が使えないもの（旧セーブの null など）のときは、実際に鳴る音を選んで見せる。
      // 保存値そのものは書き換えない（プレイヤーが選び直すまで触らない）。
      const effectiveCriticalId = AssetCatalog.getCriticalSound(options.criticalSoundId).id;
      UiContent.CRITICAL_SOUND_CHOICES.forEach((choice) => {
        const option = el("option", { text: choice.label, attrs: { value: choice.id === null ? "" : choice.id } });
        if (choice.id === effectiveCriticalId) option.setAttribute("selected", "selected");
        select.appendChild(option);
      });
      select.addEventListener("change", () => {
        this.controller.unlockAudio();
        this.controller.setOption("criticalSoundId", select.value === "" ? null : select.value);
        // 選んだ音をその場で試聴する（UI仕様書 09）。戦闘の判定でも記録でもない。
        this.controller.previewCriticalSound(select.value === "" ? null : select.value);
      });

      // 撃破演出の選び方。撃破SEとまったく同じ作りにする（独自のUIは足さない）。
      const killSelect = el("select", { id: "option-killEffectId", className: "select" });
      // 保存値が使えないもの（旧セーブなど）のときは、実際に出る演出を選んで見せる。
      const effectiveKillId = this.controller.getKillEffect().id;
      UiContent.KILL_EFFECT_CHOICES.forEach((choice) => {
        const option = el("option", { text: choice.label, attrs: { value: choice.id } });
        if (choice.id === effectiveKillId) option.setAttribute("selected", "selected");
        killSelect.appendChild(option);
      });
      killSelect.addEventListener("change", () => {
        this.controller.setOption("killEffectId", killSelect.value);
      });

      // 表記の言語。撃破SE・撃破エフェクトとまったく同じ作りにする。
      const langSelect = el("select", { id: "option-language", className: "select" });
      const effectiveLanguage = this.controller.getLanguage();
      UiContent.LANGUAGES.forEach((choice) => {
        const option = el("option", { text: choice.label, attrs: { value: choice.id } });
        if (choice.id === effectiveLanguage) option.setAttribute("selected", "selected");
        langSelect.appendChild(option);
      });
      langSelect.addEventListener("change", () => {
        this.controller.setOption("language", langSelect.value);
        // この画面の文言も選んだ言語で描き直す（保存は setOption の1回だけ）。
        this.render();
      });

      // SOUND / BATTLE EFFECT / SYSTEM のカード。中の label.option は今までと同じ作り。
      const card = (section, title, rows) => el("section", {
        className: "option-card",
        attrs: { "data-section": section },
        children: [el("h3", { className: "option-card-title", text: title })].concat(rows),
      });

      return screen(SCREENS.OPTIONS, [
        el("h2", { className: "title", text: text.title }),
        card("sound", text.sound, [
          volume("bgmVolume", text.bgmVolume),
          volume("seVolume", text.seVolume),
          el("label", {
            className: "option",
            attrs: { "data-kind": "select-preview" },
            children: [
              el("span", { className: "label", text: text.criticalSound }),
              select,
              button(text.preview, () => {
                this.controller.unlockAudio();
                this.controller.previewCriticalSound(this.controller.getOptions().criticalSoundId);
              }, { className: "secondary option-preview", id: "option-preview" }),
            ],
          }),
        ]),
        card("battle-effect", text.battleEffect, [
          el("label", {
            className: "option",
            attrs: { "data-kind": "select" },
            children: [
              el("span", { className: "label", text: text.killEffect }),
              killSelect,
            ],
          }),
        ]),
        card("system", text.system, [
          el("label", {
            className: "option",
            attrs: { "data-kind": "select" },
            children: [
              el("span", { className: "label", text: text.language }),
              langSelect,
            ],
          }),
        ]),
        el("div", {
          className: "choices",
          children: [this.renderBackButton(text.back, "option-back", () => this.controller.back())],
        }),
      ]);
    }


    // --- ガチャ ---------------------------------------------------------------

    // ガチャは1種類だけ。箱は**結果を見せる演出**で、木箱ガチャ・虹箱ガチャのような
    // 別のガチャは存在しない。どの箱からでも全レアが出る（木箱からLEGENDも出る）。
    renderGacha() {
      const gacha = this.controller.getGacha();
      switch (gacha.phase) {
        case GACHA.CHEST: return this.renderGachaChest(gacha);
        // 昇格中も描くのは箱の画面。煙はその箱の上に乗る。
        case GACHA.PROMOTION: return this.renderGachaChest(gacha);
        case GACHA.RESULT: return this.renderGachaResult(gacha);
        case GACHA.SUMMARY: return this.renderGachaSummary(gacha);
        default: return this.renderGachaIdle(gacha);
      }
    }

    // 引く前のガチャ画面。「見出しとダイヤ → 真ん中の宝箱 → 引く → 下ごしらえ → HOME」。
    // 真ん中の箱は**画面の顔**で、結果の箱ではない（押しても何も起きない）。
    renderGachaIdle(gacha) {
      const text = this.controller.getGachaLabels();
      return screen(SCREENS.GACHA, [
        this.renderGachaBackdrop(),
        el("div", {
          className: "gacha-head",
          children: [
            el("h2", { className: "title", text: text.title }),
            // HOMEと同じ宝石の枠・同じ作り方。数はいまの所持ダイヤそのもの。
            this.renderDiamonds(this.controller.getHomeLabels().diamonds, gacha.diamonds,
              { id: "gacha-diamonds" }),
          ],
        }),
        gacha.message ? el("p", { className: "notice", id: "gacha-message", text: gacha.message }) : null,
        this.renderGachaIdleChest(text),
        el("div", {
          className: "menu gacha-draws",
          id: "gacha-options",
          children: gacha.options.map((option) => {
            // 文言は言語表、価格は gacha-catalog。**どちらもここでは作らない。**
            // 台座は1回も10回も**同じ絵**で、違うのは重ねる文字だけ。
            const pullButton = this.renderMainButton(
              `${text[option.id] || option.label}　${option.price}💎`,
              null,
              () => this.controller.pullGacha(option.id),
              { className: "gacha-draw", attrs: { "data-pull": option.id } },
            );
            if (!option.affordable) pullButton.disabled = true;
            return pullButton;
          }),
        }),
        el("div", {
          className: "gacha-subs",
          children: [
            // 何が出るかを引く前に確かめられるようにする。引く操作とは分けて置く。
            this.renderSubButton(text.pool, "gacha-pool-open",
              () => this.controller.openGachaPool()),
            this.renderRatesButton("gacha-rates-open"),
          ],
        }),
        el("div", {
          className: "choices",
          children: [this.renderBackButton(text.home, "gacha-home",
            () => this.controller.back())],
        }),
        this.renderRatesModal(gacha),
      ]);
    }

    // ガチャの背景（宝物庫）。引く前も、箱を開けるあいだも**同じ1枚**を敷く。
    // 待機 → 箱 → 開封 → 結果 で背景が途切れず、宝物庫で開けているように見える。
    // 箱を主役にしたい段階（dim）では暗幕だけを少し濃くする（絵は同じ）。
    // **ガチャの画面だけ**。戦闘の宝箱へは流用しない。
    // 絵が無い／404 のときは何も敷かず、これまでの暗い背景がそのまま残る。
    renderGachaBackdrop({ dim = false } = {}) {
      return this.renderScreenBackdrop(AssetCatalog.getUiImage(UI_IMAGES.GACHA_BACKGROUND),
        { id: "gacha-backdrop", dim });
    }

    // 画面いっぱいの背景を1枚敷く共通の作り。ガチャもバトル前もここを通る。
    // 絵が無い／404 のときは何も敷かず、これまでの暗い背景がそのまま残る。
    renderScreenBackdrop(asset, { id, dim = null }) {
      if (!asset.available) return null;
      const attrs = { "aria-hidden": "true" };
      if (dim) attrs["data-dim"] = dim === true ? "strong" : dim;
      const layer = el("div", { className: "screen-backdrop", id, attrs });
      const art = assetImage(asset, { className: "screen-backdrop-art", alt: "" });
      // 読み込みに失敗したら層ごと畳む（壊れた画像も暗幕も残さない）。
      art.addEventListener("error", () => {
        if (layer.parentNode) layer.parentNode.removeChild(layer);
      }, { once: true });
      layer.appendChild(art);
      return layer;
    }

    // 戦闘の背景。**同じ構図の色違い4枚**を route と stage で切り替える。
    // バトル前・バトル中・WIN・LOSE で**同じ1枚**が続き、途中で無地へ戻らない。
    // どれを出すかは AssetCatalog が決めるので、ここには敵IDもステージ番号も書かない。
    // 濃さだけが場面で変わる（前＝そのまま / 中＝少し暗く / 結果＝もう少し暗く）。
    renderBattleBackdrop(id, dim) {
      const scene = this.controller.getBattleScene();
      return this.renderScreenBackdrop(
        AssetCatalog.getBattleBackground(scene.route, scene.stage), { id, dim },
      );
    }

    // 待機画面の宝箱。**結果の箱ではない**ので、押しても何も起きないし抽選もしない。
    // 絵はガチャの箱をそのまま使い（パスは AssetCatalog が持つ）、
    // 置かれていなければCSSの箱がそのまま残る。
    renderGachaIdleChest(text) {
      return el("div", {
        className: "gacha-idle-stage",
        id: "gacha-idle-stage",
        attrs: { "aria-hidden": "true" },
        children: [
          el("div", {
            className: "gacha-idle-boxes",
            id: "gacha-idle-chests",
            children: GACHA_IDLE_CHESTS.map((item) => {
              const box = chestBox(item.chest, {
                className: `chest-box ${item.chest} idle idle-${item.place}`,
                id: `gacha-idle-chest-${item.chest}`,
              });
              box.setAttribute("data-idle-chest", item.chest);
              return box;
            }),
          }),
          el("p", { className: "gacha-lead", id: "gacha-lead", text: text.lead }),
        ],
      });
    }

    // 「戻る」「HOMEへ戻る」「閉じる」。台座は**どこでも同じ1枚**の黒銀で、
    // 違うのは重ねる文字だけ。進める操作（赤金）・脇の操作（青金）とは役割で分ける。
    // 組み立ても押下感も他の絵ボタンと同じ仕組みを使う（新しい作りは足さない）。
    renderBackButton(label, id, run, { className = "" } = {}) {
      return homeImageButton(label, this.act(run), {
        className: `ghost back-button ${className}`.trim(),
        id,
        imageKey: UI_IMAGES.COMMON_BACK_BUTTON,
      });
    }

    // ガチャの脇の操作（排出装備一覧 / 提供割合）。台座は**2つで同じ1枚**の青枠で、
    // 違うのは重ねる文字だけ。組み立ては引くボタン（赤金）と同じ仕組みを使う。
    renderSubButton(label, id, run, { className = "" } = {}) {
      return homeImageButton(label, this.act(run), {
        className: `secondary sub plate-sub ${className}`.trim(),
        id,
        imageKey: UI_IMAGES.GACHA_SUB_BUTTON,
      });
    }

    // 進める操作（引く・バトル開始・一撃必殺・NEXT・次へ・OK・はじめる）。
    // 台座は**どこでも同じ赤金1枚**で、違うのは重ねる文字だけ。
    //
    // raw を立てると押したときの中身を**そのまま**使う（act で包まない）。
    // 結果送りのように「錠を見る」「演出を止める」を自分で持っているボタン用。
    // これまでの進行処理へ手を入れずに台座だけ着せ替えるための逃げ道。
    renderMainButton(label, id, run, { className = "", attrs = null, raw = false } = {}) {
      return homeImageButton(label, raw ? run : this.act(run), {
        className: `primary plate-main ${className}`.trim(),
        id,
        attrs,
        imageKey: UI_IMAGES.GACHA_DRAW_BUTTON,
      });
    }

    // 提供割合を開くボタン。押すと同じ画面の上へ重ねて出す（画面は移らない）。
    // 青枠の台座を着せるのはガチャ画面の脇の段だけ。見出しの行（排出装備一覧の画面）は
    // 幅が決まっていないので、これまでどおりの素のボタンのまま。
    renderRatesButton(id, { art = true } = {}) {
      const open = () => this.controller.setGachaRatesOpen(true);
      if (!art) {
        return button(this.controller.getGachaLabels().rates, this.act(open),
          { className: "secondary sub", id });
      }
      return this.renderSubButton(this.controller.getGachaLabels().rates, id, open);
    }

    // 提供割合（UI仕様書 07）。**数値は gacha-catalog から来る**ので、ここには書かない。
    // ガチャ画面でも排出装備一覧でも同じものを重ねる。
    renderRatesModal(view, { id = "gacha-rates" } = {}) {
      if (!view.ratesOpen) return null;
      const text = this.controller.getGachaLabels();
      return el("div", {
        className: "modal-backdrop",
        id: "gacha-rates-backdrop",
        onClick: this.act(() => this.controller.setGachaRatesOpen(false)),
        children: [
          el("div", {
            className: "modal rates",
            id,
            // 中身を押しても閉じない（閉じるのは背景か「閉じる」）。
            onClick: (event) => event.stopPropagation(),
            children: [
              el("h3", { className: "modal-title", text: text.rates }),
              el("ul", {
                className: "rate-list",
                children: view.rates.map((entry) => el("li", {
                  className: "rate",
                  attrs: { "data-rarity": entry.rarity },
                  children: [
                    el("span", { className: "rate-rarity", text: entry.rarity }),
                    el("span", { className: "rate-value", text: `${entry.rate}%` }),
                  ],
                })),
              }),
              this.renderBackButton(text.close, "gacha-rates-close",
                () => this.controller.setGachaRatesOpen(false), { className: "modal-close" }),
            ],
          }),
        ],
      });
    }

    // --- 排出装備一覧 ---------------------------------------------------------

    // 「何がガチャから出るか」を確かめる画面。図鑑とは役割が違うので、
    // 未所持でも名前も効果も伏せない。引くことも装備することもできない。
    renderGachaPool() {
      const pool = this.controller.getGachaPool();
      const text = this.controller.getGachaLabels();
      return screen(SCREENS.GACHA_POOL, [
        el("div", {
          className: "gacha-head",
          children: [
            el("h2", { className: "title", text: text.poolTitle }),
            this.renderRatesButton("gacha-pool-rates", { art: false }),
          ],
        }),
        this.renderPoolFilters(pool, text),
        this.renderPoolList(pool, text),
        this.renderPoolDetail(pool, text),
        el("div", {
          className: "choices",
          children: [this.renderBackButton(text.back, "gacha-pool-back",
            () => this.controller.back())],
        }),
        // 提供割合はガチャ画面と同じものを重ねる（画面は移らない）。
        this.renderRatesModal(pool, { id: "gacha-pool-rates-modal" }),
      ]);
    }

    // 絞り込み。並びも仕組みも装備ボックスと同じ（UiContent.RARITY_FILTERS が正）。
    renderPoolFilters(pool, text) {
      return el("div", {
        className: "filters",
        id: "gacha-pool-filters",
        children: pool.filters.map((filter) => button(
          filter === "ALL" ? text.all : filter,
          this.act(() => this.controller.setPoolRarityFilter(filter)),
          { className: filter === pool.filter ? "filter active" : "filter", attrs: { "data-filter": filter } },
        )),
      });
    }

    renderPoolList(pool, text) {
      if (pool.items.length === 0) {
        return el("p", { className: "empty", id: "gacha-pool-list", text: text.empty });
      }
      return el("ul", {
        className: "equipment-box",
        id: "gacha-pool-list",
        children: pool.items.map((item) => el("li", {
          className: `equipment${item.selected ? " selected" : ""}`,
          attrs: { "data-equipment": item.equipmentId, "data-rarity": item.rarity },
          onClick: this.act(() => this.controller.selectPoolEquipment(item.equipmentId)),
          children: [
            equipmentIcon(item.equipmentId, item.rarity),
            el("span", {
              className: "equipment-body",
              children: [
                el("span", { className: "equipment-name", text: item.name }),
                el("span", { className: "equipment-summary", text: item.description }),
              ],
            }),
            // 同名装備は複数持たないので、印だけで数は出さない。
            item.owned ? el("span", { className: "owned", text: text.owned }) : null,
          ],
        })),
      });
    }

    renderPoolDetail(pool, text) {
      if (!pool.detail) {
        return el("div", { className: "detail empty", id: "gacha-pool-detail", text: text.hint });
      }
      return el("div", {
        className: "detail",
        id: "gacha-pool-detail",
        attrs: { "data-equipment": pool.detail.equipmentId },
        children: equipmentDetailParts(pool.detail, pool.detail.owned
          ? el("span", { className: "owned", text: text.owned })
          : null),
      });
    }

    // 箱が出た時点で中身はもう決まっている。開封で抽選し直すことはない。
    renderGachaChest(gacha) {
      const current = this.controller.getGachaCurrent();
      // 煙が出ているあいだは受け付けない。押しても捨てるだけで、溜めて後から開かない。
      const promoting = gacha.phase === GACHA.PROMOTION;
      return screen(SCREENS.GACHA, [
        this.renderGachaBackdrop({ dim: true }),
        this.renderGachaProgress(gacha),
        this.renderChestStage(current.chest, {
          id: "chest-stage",
          boxId: "chest-box",
          hintId: "chest-hint",
          hintText: this.controller.getGachaLabels().chestTap,
          promoting,
          onTap: () => this.handleChestTap(),
          extraClass: current.promoted ? "promoted" : "arriving",
        }),
      ]);
    }

    renderGachaResult(gacha) {
      const current = this.controller.getGachaCurrent();
      const isLast = current.index + 1 >= current.total;
      return screen(SCREENS.GACHA, [
        this.renderGachaBackdrop({ dim: true }),
        this.renderGachaProgress(gacha),
        chestBox(current.chest, { className: `chest-box ${current.chest} opened`, id: "chest-box" }),
        this.renderRewardCard(current, GACHA_FX_TARGETS),
        el("p", { className: "diamonds", id: "gacha-diamonds", text: `ダイヤ ${gacha.diamonds}` }),
        el("div", {
          className: "choices",
          children: [this.renderGachaNext(isLast)],
        }),
      ]);
    }

    // 開けたあとの結果カード。**ガチャの箱も戦闘の宝箱もこれ1つ**で描く。
    // 違うのは id の頭だけで、中身（NEW／絵／名前／レア度／効果／重複売却）は同じ。
    renderRewardCard(current, targets) {
      return el("div", {
        className: "gacha-result",
        id: targets.result,
        // 演出中は中身を visibility で伏せる。**高さは変わらない**ので
        // ダイヤもOKボタンも動かない。演出そのものは visible のまま上に出る。
        attrs: Object.assign(
          { "data-rarity": current.rarity, "data-new": String(current.isNew) },
          this.gachaFxAttributes(),
        ),
        // NEW！ → 大きな装備の絵 → 名前 → レア度 → 効果、の順に縦へ積む。
        // 手に入れた装備そのものを見せる場所なので、絵の上下に文字を挟まない。
        children: [
          current.isNew ? el("p", { className: "new-large", id: `${targets.prefix}-new`, text: "NEW！" }) : null,
          this.renderGachaShowcase(current),
          el("p", { className: "result-name", id: `${targets.prefix}-name`, text: current.name }),
          el("p", {
            className: `result-rarity rarity-${current.rarity}`,
            id: `${targets.prefix}-rarity`,
            attrs: { "data-rarity": current.rarity },
            text: current.rarity,
          }),
          el("p", { className: "result-description", text: current.description }),
          current.isNew
            ? null
            : el("p", {
              className: "result-duplicate",
              id: `${targets.prefix}-duplicate`,
              text: `重複　+${current.duplicateSaleDiamonds} ダイヤ`,
            }),
        ],
      });
    }

    // 閉じた箱とタップの案内。ガチャの箱も戦闘の宝箱もこれ1つで描く。
    renderChestStage(chestType, { id, boxId, hintId, hintText, promoting, onTap, extraClass = "" }) {
      const attrs = { role: "button", tabindex: promoting ? "-1" : "0" };
      if (promoting) attrs["data-promoting"] = "true";
      const box = chestBox(chestType, {
        className: `chest-box ${chestType} ${extraClass}`.trim(),
        id: boxId,
      });
      if (this.chestSmoke) box.appendChild(chestSmokeLayer(this.chestSmoke.promotion, this.chestSmoke.frameIndex));
      return el("div", {
        className: "chest-stage",
        id,
        attrs,
        onClick: onTap,
        children: [
          box,
          // 昇格のあいだは案内を**伏せる**（文字を消さない）。
          // 空にすると行の高さが無くなり、案内が戻る瞬間に箱が跳ねる。
          el("p", {
            className: "tap-hint",
            id: hintId,
            text: hintText,
            attrs: promoting ? { "data-hidden": "true" } : {},
          }),
        ],
      });
    }

    // 結果送り。UR / LEGEND は出現SEが鳴り終わるまで押せない。
    // 台座は引くボタンと同じ赤金1枚（進める操作なので色を分けない）。
    renderGachaNext(isLast) {
      const text = this.controller.getGachaLabels();
      const next = this.renderMainButton(isLast ? text.ok : text.next, "gacha-next", () => {
        // 錠が立っているあいだの入力は**その場で捨てる**。溜めて後から進めない。
        if (this.gachaAdvanceLocked) return;
        this.controller.unlockAudio();
        this.stopGachaEffect(); // 次の箱へ持ち越さない
        this.controller.nextGachaResult();
        this.render();
      }, { className: "gacha-advance", raw: true });
      this.applyGachaAdvanceLock(next);
      return next;
    }

    // 錠の状態をボタンへ映す。**画面は作り直さない。**
    // 作り直すと結果カードが新しくなり、出現アニメーションがもう一度走る。
    applyGachaAdvanceLock(next) {
      if (!next) return;
      next.disabled = this.gachaAdvanceLocked;
      if (this.gachaAdvanceLocked) next.setAttribute("data-locked", "true");
      else next.removeAttribute("data-locked");
    }

    // UR / LEGEND は箱をタップした時点で施錠する。
    // ボタンがまだ出ていない段階でも、ここで内部の受付を閉じておく。
    beginGachaAdvanceLock(rarity) {
      this.resetGachaAdvance();
      if (!AssetCatalog.isGachaAdvanceLocked(rarity)) return false;
      this.gachaAdvanceLocked = true;
      return true;
    }

    // 出現SEが鳴り終わった（または最初から鳴らなかった）。ここで初めて送れるようになる。
    releaseGachaAdvance() {
      this.clearGachaAdvanceTimer();
      if (!this.gachaAdvanceLocked) return false;
      this.gachaAdvanceLocked = false;
      this.applyGachaAdvanceLock(this.root.querySelector(`#${this.fxTargets.next}`));
      return true;
    }

    // 錠も予約も次の1件へ持ち越さない。
    // 鳴り終わる前に画面を離れたときだけ、鳴りかけの出現SEと受け口も落とす
    //（通常は鳴り終わるまで送れないので、ここは通らない）。
    resetGachaAdvance({ stopSe = false } = {}) {
      this.clearGachaAdvanceTimer();
      const wasLocked = this.gachaAdvanceLocked;
      this.gachaAdvanceLocked = false;
      if (wasLocked && stopSe) this.controller.stopGachaSe();
      return wasLocked;
    }

    clearGachaAdvanceTimer() {
      if (this.gachaAdvanceTimer === null) return;
      global.clearTimeout(this.gachaAdvanceTimer);
      this.gachaAdvanceTimer = null;
    }

    // ガチャの結果画面から離れたら、錠も予約も受け口も残さない。
    // render() は画面を作り直す唯一の入口なので、出口もここ1か所に集める。
    syncGachaAdvanceLock(current) {
      if (current.name !== SCREENS.BATTLE && this.killFx) this.stopKillEffect();
      if (current.name !== SCREENS.GACHA) { this.stopChestSmoke(); this.clearChestHoldTimer(); }
      if (!this.gachaAdvanceLocked && this.gachaAdvanceTimer === null) return;
      // 開けた結果を見ているあいだだけ錠を残す。ガチャの結果でも、戦闘の宝箱でも同じ。
      const onResult = (current.name === SCREENS.GACHA
        && this.controller.getGacha().phase === GACHA.RESULT)
        || (current.name === SCREENS.WIN && this.isWinChestOpened());
      if (onResult) return;
      this.resetGachaAdvance({ stopSe: true });
    }

    // 戦闘で手に入れた宝箱を、いま開けたところか。
    isWinChestOpened() {
      const chest = this.controller.getWinChest();
      return Boolean(chest && chest.opened);
    }

    // 装備の絵。演出が動いているあいだは、その絵の真上でスプライトを回す。
    renderGachaShowcase(current) {
      const frame = equipmentShowcase(current.equipmentId, current.rarity);
      if (this.gachaFx) frame.appendChild(gachaEffectLayer(this.gachaFx.effect, this.gachaFx.frameIndex));
      return frame;
    }

    // 結果カードへ足す印。演出中だけ付く。
    gachaFxAttributes() {
      if (!this.gachaFx) return {};
      const attrs = { "data-fx": this.gachaFx.effect.key };
      if (!this.gachaFx.revealed) attrs["data-fx-pending"] = "true";
      return attrs;
    }

    // 宝箱をタップした。**抽選はもう終わっている**ので、ここでするのは
    // 「結果の段階へ進める」ことと「レア度に応じた演出を1回まわす」ことだけ。
    // 受付は openGachaChest() が CHEST のときしか通さないので、連打しても増えない。
    //
    // 昇格のある1件（木箱LEGEND）だけ、1回目のタップは煙に使う。
    // 煙が終わって虹箱が見えてから、2回目のタップで普通に開く。
    handleChestTap() {
      this.controller.unlockAudio();
      const before = this.controller.getGacha().phase;
      if (before !== GACHA.CHEST) return; // 煙の最中も連打もここで断つ
      const current = this.controller.getGachaCurrent();
      if (current.promotion) { this.startChestPromotion(current.promotion); return; }
      // 開封SEは openGachaChest() の中で1回（CHEST の段階でしか通らない）。
      this.controller.openGachaChest();
      this.startGachaEffect(current.rarity);
      this.render();
    }

    // --- 箱の昇格（木箱LEGEND → 煙 → 虹箱） --------------------------------
    //
    // 中身は最初から決まっていて、ここでは何も引き直さない。
    // 変えるのは「見せている箱」だけ。煙が濃いところで裏に差し替えるので、
    // 入れ替わる瞬間はプレイヤーに見えない。

    startChestPromotion(promotion) {
      this.stopChestSmoke();
      this.clearChestHoldTimer();
      const started = this.controller.beginChestPromotion();
      if (!started.accepted) { this.render(); return; }
      // 絵が置かれていない（404含む）なら煙は飛ばす。虹箱だけ見せて待つ。
      if (!promotion.image.available || !preloadSheet(promotion.image)) {
        this.finishChestPromotion(promotion);
        return;
      }
      this.chestSmoke = { promotion, frameIndex: 0 };
      // 煙がいちばん濃いコマで箱を入れ替える。
      this.chestSmokeTimer = global.setTimeout(() => {
        this.chestSmokeTimer = null;
        this.swapPromotedChest();
      }, promotion.swapAtMs);
      // 画面が隠れて rAF が止まっても、時間で必ず終わらせる（虹箱で止まらない）。
      this.chestSmokeEndTimer = global.setTimeout(() => {
        this.chestSmokeEndTimer = null;
        this.finishChestPromotion();
      }, promotion.durationMs + GACHA_FX_END_MARGIN_MS);
      this.playChestSmoke(promotion);
      this.render();
    }

    // 煙の裏で木箱を虹箱へ。画面は描き直すが、煙が上に乗ったままなので見えない。
    swapPromotedChest() {
      if (!this.controller.promoteChest()) return false;
      this.render();
      return true;
    }

    // コマ送り。rAF 1本で background-position を動かすだけ。
    playChestSmoke(promotion) {
      if (typeof global.requestAnimationFrame !== "function") return;
      const { sheet } = promotion;
      const startedAt = typeof global.performance === "object" && global.performance
        ? global.performance.now() : Date.now();
      const step = (now) => {
        if (!this.chestSmoke || this.chestSmoke.promotion !== promotion) return;
        const layer = this.root.querySelector("#chest-smoke");
        if (!layer) { this.chestSmokeFrame = global.requestAnimationFrame(step); return; }
        const elapsed = now - startedAt;
        if (elapsed >= promotion.durationMs) { this.finishChestPromotion(); return; }
        const index = Math.min(sheet.frameCount - 1,
          Math.floor((elapsed / promotion.durationMs) * sheet.frameCount));
        this.chestSmoke.frameIndex = index;
        layer.style.backgroundPosition = framePosition(index, sheet);
        this.chestSmokeFrame = global.requestAnimationFrame(step);
      };
      this.chestSmokeFrame = global.requestAnimationFrame(step);
    }

    // 煙が終わった。器だけ畳んで、**昇格した箱だけを少しのあいだ見せる。**
    // ここではまだ受け付けない（連打していても、変わった箱が必ず目に入る）。
    finishChestPromotion(promotion = null) {
      const target = promotion || (this.chestSmoke ? this.chestSmoke.promotion : null);
      this.controller.promoteChest(); // 差し替えそこねていてもここで虹箱にする
      this.stopChestSmoke();
      this.render();
      const holdMs = target ? target.holdMs : 0;
      if (!(holdMs > 0)) { this.releaseChestPromotion(); return; }
      this.chestHoldTimer = global.setTimeout(() => {
        this.chestHoldTimer = null;
        this.releaseChestPromotion();
      }, holdMs);
    }

    // 見せる時間が過ぎた。ここで初めてタップを受け付ける（案内もここで戻る）。
    // **溜まっていた入力で勝手に開くことはない**（受け付けなかったものは捨ててある）。
    releaseChestPromotion() {
      this.clearChestHoldTimer();
      this.controller.completeChestPromotion();
      this.render();
    }

    // 煙の器も予約もコマ送りも残さない。鑑賞の予約もここで落とす。
    stopChestSmoke() {
      if (this.chestSmokeTimer !== null) { global.clearTimeout(this.chestSmokeTimer); this.chestSmokeTimer = null; }
      if (this.chestSmokeEndTimer !== null) { global.clearTimeout(this.chestSmokeEndTimer); this.chestSmokeEndTimer = null; }
      if (this.chestSmokeFrame !== null && typeof global.cancelAnimationFrame === "function") {
        global.cancelAnimationFrame(this.chestSmokeFrame);
      }
      this.chestSmokeFrame = null;
      this.chestSmoke = null;
    }

    clearChestHoldTimer() {
      if (this.chestHoldTimer === null) return;
      global.clearTimeout(this.chestHoldTimer);
      this.chestHoldTimer = null;
    }

    // レア度に応じた演出を始める。N / R は演出が無いので何もしない。
    // 絵が置かれていない（404含む）ときも、結果はそのまま出す。
    startGachaEffect(rarity, targets = GACHA_FX_TARGETS) {
      this.stopGachaEffect();
      // どの画面の結果カード／送りボタンへ当てるか。**片付けのあとに決める**
      //（stopGachaEffect が既定へ戻すので、順番を入れ替えると戻されてしまう）。
      this.fxTargets = targets;
      // 演出の有無より先に施錠する（UR / LEGEND は絵が無くても錠は掛かる）。
      this.beginGachaAdvanceLock(rarity);
      const effect = AssetCatalog.getGachaEffect(rarity);
      if (!effect || !effect.image.available) {
        // 演出が無い（N / R）か絵が無い。装備はその場で出す＝出現SEもその場で。
        this.revealGachaItem(rarity);
        return;
      }
      if (!preloadSheet(effect.image)) { this.revealGachaItem(rarity); return; }
      this.gachaFx = { effect, revealed: false, frameIndex: 0 };
      // 演出の音は**スプライトの開始と同時**に1回。
      this.controller.playGachaEffectSe(rarity);
      // 中盤〜終盤で装備を出す。スプライト自体は最後まで回してから消す。
      this.gachaFxTimer = global.setTimeout(() => {
        this.gachaFxTimer = null;
        if (!this.gachaFx) return;
        this.gachaFx.revealed = true;
        this.revealGachaItem(rarity);
        this.render();
      }, GACHA_FX_REVEAL_MS);
      this.playGachaEffect(effect);
      // 画面が隠れているあいだ requestAnimationFrame は止まる。そのままだと
      // コマ送りが進まず器が残りっぱなしになるので、時間でも必ず終わらせる。
      const durationMs = (effect.sheet.frameCount / effect.sheet.fps) * 1000;
      this.gachaFxEndTimer = global.setTimeout(() => {
        this.gachaFxEndTimer = null;
        this.finishGachaEffect();
      }, durationMs + GACHA_FX_END_MARGIN_MS);
    }

    // 装備が見える瞬間。**絵を出す合図と音を出す合図を同じにする**ので、
    // 「絵は出たのに音が遅れる」「音だけ先に鳴る」が起きない。
    // N / R は鳴らす音が無いので、AudioManager 側が黙る。
    revealGachaItem(rarity) {
      if (this.gachaItemSePlayed) return false; // 1件につき1回だけ
      this.gachaItemSePlayed = true;
      if (!this.gachaAdvanceLocked) return this.controller.playGachaItemSe(rarity);
      // UR / LEGEND。**鳴り終わりが解錠の合図**で、固定の待ち時間は置かない。
      // 保険は音を鳴らす前に仕掛ける（鳴らした直後に合図が返ってきても取り消せるように）。
      this.gachaAdvanceTimer = global.setTimeout(
        () => { this.gachaAdvanceTimer = null; this.releaseGachaAdvance(); },
        AssetCatalog.GACHA_ITEM_SE_SAFETY_MS,
      );
      const played = this.controller.playGachaItemSe(rarity, () => this.releaseGachaAdvance());
      if (!played) this.releaseGachaAdvance(); // そもそも鳴らす音が無い
      return played;
    }

    // コマ送り。rAF 1本で background-position を動かすだけ。
    playGachaEffect(effect) {
      if (typeof global.requestAnimationFrame !== "function") return;
      const { sheet } = effect;
      const durationMs = (sheet.frameCount / sheet.fps) * 1000;
      const startedAt = typeof global.performance === "object" && global.performance
        ? global.performance.now() : Date.now();
      const step = (now) => {
        if (!this.gachaFx || this.gachaFx.effect !== effect) return;
        const layer = this.root.querySelector("#gacha-fx");
        if (!layer) { this.gachaFxFrame = global.requestAnimationFrame(step); return; }
        const elapsed = now - startedAt;
        if (elapsed >= durationMs) { this.finishGachaEffect(); return; }
        const index = Math.min(sheet.frameCount - 1, Math.floor((elapsed / durationMs) * sheet.frameCount));
        this.gachaFx.frameIndex = index;
        layer.style.backgroundPosition = framePosition(index, sheet);
        this.gachaFxFrame = global.requestAnimationFrame(step);
      };
      this.gachaFxFrame = global.requestAnimationFrame(step);
    }

    // 1回ぶんが終わった。器を消して状態を戻す（次の箱へ持ち越さない）。
    finishGachaEffect() {
      const wasHidden = this.gachaFx && !this.gachaFx.revealed;
      const rarity = this.gachaFx ? this.gachaFx.effect.rarity : null;
      this.stopGachaFx();
      if (wasHidden) {
        // まだ装備を伏せていた（演出が先に終わった）。取りこぼさずここで見せる。
        if (rarity) this.revealGachaItem(rarity);
        this.render();
        return;
      }
      // 装備はもう見えている。**ここで描き直さない。**
      // render() すると結果カードが作り直され、出現アニメーション（result-in）が
      // もう一度走って「装備が二度出た」ように見える。器だけ静かに外す。
      this.removeGachaEffectLayer();
    }

    // スプライトの器だけをDOMから外す。画面は作り直さない。
    removeGachaEffectLayer() {
      const layer = this.root.querySelector("#gacha-fx");
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      const card = this.root.querySelector(`#${this.fxTargets.result}`);
      if (card) card.removeAttribute("data-fx");
    }

    // 1件ぶんの後始末。演出も煙も錠も予約も残さない（画面を離れるときもここを通る）。
    stopGachaEffect() {
      this.stopGachaFx();
      this.stopChestSmoke();
      this.clearChestHoldTimer();
      this.resetGachaAdvance({ stopSe: true });
      this.fxTargets = GACHA_FX_TARGETS;
    }

    // 演出だけを畳む。**錠には触らない**（スプライトが先に終わっても、
    // 出現SEはまだ鳴っていて、解錠の合図はそちらから来る）。
    stopGachaFx() {
      this.gachaItemSePlayed = false; // 次の箱では改めて1回鳴らす
      if (this.gachaFxTimer !== null) { global.clearTimeout(this.gachaFxTimer); this.gachaFxTimer = null; }
      if (this.gachaFxEndTimer !== null) { global.clearTimeout(this.gachaFxEndTimer); this.gachaFxEndTimer = null; }
      if (this.gachaFxFrame !== null && typeof global.cancelAnimationFrame === "function") {
        global.cancelAnimationFrame(this.gachaFxFrame);
      }
      this.gachaFxFrame = null;
      this.gachaFx = null;
    }

    renderGachaProgress(gacha) {
      if (!gacha.progress) return null;
      return el("p", {
        className: "gacha-progress",
        id: "gacha-progress",
        text: `${gacha.progress.index} / ${gacha.progress.total}`,
      });
    }

    // 10連の最後に、引いたものを一覧で見せるだけ。凝ったカード演出は作らない。
    // この画面が出るのは10連のときだけ（1回引きは IDLE へ直接戻る）なので、
    // 見出しも「何回ぶんの一覧なのか」が分かる言い方に決め打ちする。
    renderGachaSummary(gacha) {
      const summary = this.controller.getGachaSummary();
      const text = this.controller.getGachaLabels();
      return screen(SCREENS.GACHA, [
        this.renderGachaBackdrop({ dim: true }),
        el("h2", { className: "title", text: text.summaryTitle }),
        el("ul", {
          className: "gacha-summary",
          id: "gacha-summary",
          children: summary.map((entry) => el("li", {
            className: "summary-row",
            attrs: { "data-rarity": entry.rarity, "data-new": String(entry.isNew) },
            children: [
              equipmentIcon(entry.equipmentId, entry.rarity),
              el("span", { className: "summary-name", text: entry.name }),
              entry.isNew
                ? el("span", { className: "new-badge", text: "NEW" })
                : el("span", { className: "summary-duplicate", text: `+${entry.duplicateSaleDiamonds}💎` }),
            ],
          })),
        }),
        el("p", { className: "diamonds", id: "gacha-diamonds", text: `ダイヤ ${gacha.diamonds}` }),
        el("div", {
          className: "choices",
          children: [this.renderMainButton(text.ok, "gacha-summary-ok",
            () => this.controller.closeGachaSummary(), { className: "gacha-advance" })],
        }),
      ]);
    }


    // --- 敵図鑑 ---------------------------------------------------------------

    // 通常10体＋裏10体の20体。神はSPECIAL枠で、20体のカウントには入らない。
    renderEncyclopedia() {
      return screen(SCREENS.ENCYCLOPEDIA, [
        el("h2", { className: "title", text: UiContent.SCREEN_TITLES.ENCYCLOPEDIA }),
        ...this.encyclopediaBody(),
        el("div", {
          className: "choices",
          children: [this.renderBackButton("HOMEへ戻る", "book-home", () => this.controller.back())],
        }),
      ]);
    }

    // 図鑑の中身。**同じものをアーカイブのタブでも出す**（画面を2つ作らない）。
    // 報酬も解放状態も未取得の見せ方も、これまでの getEncyclopedia のまま。
    encyclopediaBody() {
      const book = this.controller.getEncyclopedia();
      return [
        el("p", {
          className: `book-count${book.complete ? " complete" : ""}`,
          id: "book-count",
          text: book.complete ? `COMPLETE　${book.registered} / ${book.total}` : `${book.registered} / ${book.total}`,
        }),
        this.renderEncyclopediaRewards(book),
        el("ul", {
          className: "book-grid",
          id: "book-grid",
          children: book.entries.map((entry) => this.renderEnemyCard(entry)),
        }),
        // SPECIALは別枠。20体にも図鑑報酬にも入らない。
        el("div", {
          className: "book-special",
          id: "book-special",
          children: [
            el("p", { className: "book-special-label", text: "SPECIAL" }),
            el("ul", { className: "book-grid", children: [this.renderEnemyCard(book.special)] }),
          ],
        }),
        this.renderEnemyDetail(book.detail),
      ];
    }

    renderEncyclopediaRewards(book) {
      return el("ul", {
        className: "book-rewards",
        id: "book-rewards",
        children: book.rewards.map((reward) => el("li", {
          className: `book-reward${reward.claimed ? " claimed" : ""}`,
          attrs: { "data-count": String(reward.count), "data-claimed": String(reward.claimed) },
          children: [
            el("span", { className: "reward-count", text: `${reward.count}体` }),
            el("span", {
              className: "reward-state",
              text: reward.claimed ? "受取済" : `あと${reward.remaining}体`,
            }),
          ],
        })),
      });
    }

    renderEnemyCard(entry) {
      return el("li", {
        className: `enemy-card${entry.discovered ? "" : " unknown"}${entry.selected ? " selected" : ""}`,
        attrs: { "data-enemy": entry.enemyId, "data-discovered": String(entry.discovered) },
        onClick: this.act(() => this.controller.selectEnemy(entry.enemyId)),
        children: [
          // 未撃破はシルエット扱い。正式画像があっても元の絵は読み込まない。
          enemyImage(entry.enemyId, { discovered: entry.discovered, className: "enemy-thumb" }),
          el("span", { className: "enemy-card-name", text: entry.name }),
        ],
      });
    }

    // 未撃破のカードでは、抵抗値も一言もプロフィールも出さない。
    renderEnemyDetail(detail) {
      if (!detail) {
        return el("p", { className: "book-detail empty", id: "book-detail", text: "敵を選ぶと詳しく出ます。" });
      }
      if (!detail.discovered) {
        return el("div", {
          className: "book-detail unknown",
          id: "book-detail",
          attrs: { "data-discovered": "false" },
          children: [
            el("p", { className: "detail-name", text: detail.name }),
            el("p", { className: "detail-note", text: detail.label }),
          ],
        });
      }
      const rows = [
        ["抵抗値", String(detail.resistance)],
        ["撃破数", String(detail.killCount)],
      ];
      // 敗北数は裏敵だけ出す。
      if (detail.lossCount !== null) rows.push(["敗北数", String(detail.lossCount)]);

      return el("div", {
        className: "book-detail",
        id: "book-detail",
        attrs: { "data-enemy": detail.enemyId, "data-discovered": "true" },
        children: [
          el("p", { className: "detail-name", id: "detail-name", text: detail.name }),
          enemyImage(detail.enemyId, { discovered: true, className: "enemy-art detail-art" }),
          el("ul", {
            className: "detail-stats",
            id: "detail-stats",
            children: rows.map(([label, value]) => el("li", {
              className: "detail-stat",
              attrs: { "data-stat": label },
              children: [
                el("span", { className: "stat-label", text: label }),
                el("span", { className: "stat-value", text: value }),
              ],
            })),
          }),
          el("p", { className: "detail-quote", id: "detail-quote", text: detail.quote }),
          el("p", { className: "detail-profile", id: "detail-profile", text: detail.profile }),
        ],
      });
    }

    // --- RECORD ---------------------------------------------------------------

    // 上が現在までの総合記録、下がクリア時の記録。値はすべて RecordState のもの。
    renderRecord() {
      return screen(SCREENS.RECORD, [
        el("h2", { className: "title", text: UiContent.SCREEN_TITLES.RECORD }),
        ...this.recordBody(),
        el("div", {
          className: "choices",
          children: [this.renderBackButton("戻る", "record-back", () => this.controller.back())],
        }),
      ]);
    }

    // RECORDの中身。**同じものをアーカイブのタブでも出す**（保存形式には触らない）。
    recordBody() {
      const record = this.controller.getRecord();
      const text = this.controller.getRecordLabels();
      return [
        el("p", { className: "record-section", text: text.now }),
        this.renderRecordTotals(record.totals, record.mostUsedEquipment, record.mostDefeatedEnemy, "record-now"),
        this.renderSnapshot(record.snapshots.NORMAL_CLEAR, "record-normal",
          { title: text.normalClear, lockedHint: text.normalLockedHint, cleared: record.cleared.NORMAL_CLEAR }),
        this.renderSnapshot(record.snapshots.TRUE_CLEAR, "record-true",
          { title: text.trueClear, lockedHint: text.trueLockedHint, cleared: record.cleared.TRUE_CLEAR }),
      ];
    }

    // アーカイブ。図鑑とRECORDを**タブで切り替えるだけ**で、中身は既存のものをそのまま出す。
    renderArchive() {
      const archive = this.controller.getArchive();
      const text = this.controller.getHomeLabels();
      const tabLabel = { CATALOG: text.catalog, RECORD: text.record };
      return screen(SCREENS.ARCHIVE, [
        el("h2", { className: "title", text: text.archive }),
        el("div", {
          className: "filters archive-tabs",
          id: "archive-tabs",
          children: archive.tabs.map((tab) => button(
            tabLabel[tab],
            this.act(() => this.controller.setArchiveTab(tab)),
            {
              className: tab === archive.tab ? "filter active" : "filter",
              attrs: { "data-tab": tab },
              id: `archive-tab-${tab.toLowerCase()}`,
            },
          )),
        }),
        el("div", {
          className: "archive-body",
          id: "archive-body",
          attrs: { "data-tab": archive.tab },
          children: archive.tab === "RECORD" ? this.recordBody() : this.encyclopediaBody(),
        }),
        el("div", {
          className: "choices",
          children: [this.renderBackButton(text.back, "archive-back", () => this.controller.back())],
        }),
      ]);
    }

    // 基本の6記録（2列×3段のカード）と、最多使用装備・最も苦戦した敵の2枚。
    // 数字はすべて渡された値のまま。**ここで数え直さない。**
    // compact はクリア時の記録の中で使う小さい版（並びは同じ）。
    renderRecordTotals(totals, mostUsed, mostDefeated, id, { compact = false } = {}) {
      const text = this.controller.getRecordLabels();
      const keys = ["totalTaps", "totalCriticals", "totalMisses", "totalDefeats", "totalKills", "gachaPullCount"];
      return el("div", {
        className: `record-totals${compact ? " compact" : ""}`,
        id,
        children: [
          el("ul", {
            className: "record-stats",
            children: keys.map((key) => el("li", {
              className: "record-stat",
              attrs: { "data-row": key },
              children: [
                el("span", { className: "record-label", text: text[key] }),
                el("span", { className: "record-value", text: String(totals[key]) }),
              ],
            })),
          }),
          el("div", {
            className: "record-features",
            children: [
              this.renderRecordFeature("equipment", text.mostUsed, mostUsed, text),
              this.renderRecordFeature("enemy", text.mostDefeated, mostDefeated, text),
            ],
          }),
        ],
      });
    }

    // 最多使用装備／最も苦戦した敵のカード。絵は AssetCatalog から引く（パスを書かない）。
    // 敵の絵は図鑑と同じ enemyImage() を通す。名前は折り返し、省略はしない。
    renderRecordFeature(kind, title, entry, text) {
      let art;
      if (!entry) {
        art = el("span", { className: "record-feature-art empty", attrs: { "aria-hidden": "true" } });
      } else if (kind === "equipment") {
        art = equipmentIcon(entry.equipmentId, entry.rarity);
        art.className = `${art.className} record-feature-art`;
      } else {
        art = el("span", {
          className: "record-feature-art enemy",
          children: [enemyImage(entry.enemyId, { discovered: true, className: "record-feature-enemy" })],
        });
      }
      return el("div", {
        className: "record-feature",
        attrs: { "data-feature": kind, "data-empty": entry ? "false" : "true" },
        children: [
          el("p", { className: "record-feature-title", text: title }),
          el("div", {
            className: "record-feature-body",
            children: [
              art,
              el("div", {
                className: "record-feature-text",
                children: [
                  el("span", { className: "record-feature-name", text: entry ? entry.name : text.none }),
                  entry
                    ? el("span", { className: "record-feature-count", text: text.count.replace("{n}", entry.count) })
                    : null,
                ].filter(Boolean),
              }),
            ],
          }),
        ],
      });
    }

    // クリア時の記録。まだ到達していなければ LOCKED と、いつ記録されるかだけを出す。
    // 到達済みなら**保存された値をそのまま**出す（無い項目を作り足さない）。
    // title を渡さない呼び出し（エンディング）は見出しを持たない。
    // 記録が無いのにクリア済み（記録の仕組みより前のセーブなど）は、LOCKED ではなく
    // 「記録なし」と出す。値は作らない。
    renderSnapshot(snapshot, id, { title = null, lockedHint = null, cleared = false } = {}) {
      const text = this.controller.getRecordLabels();
      const heading = title ? el("p", { className: "record-clear-title", text: title }) : null;
      if (!snapshot) {
        return el("div", {
          className: "record-clear locked",
          id,
          attrs: { "data-taken": "false", "data-missing": cleared ? "true" : "false" },
          children: [
            heading,
            el("p", { className: "record-locked", text: cleared ? text.missing : text.locked }),
            cleared
              ? el("p", { className: "record-locked-hint", text: text.missingHint })
              : (lockedHint ? el("p", { className: "record-locked-hint", text: lockedHint }) : null),
          ].filter(Boolean),
        });
      }
      return el("div", {
        className: "record-clear record-snapshot",
        id,
        attrs: { "data-taken": "true" },
        children: [
          heading,
          this.renderRecordTotals(snapshot.totals, snapshot.mostUsedEquipment, snapshot.mostDefeatedEnemy,
            `${id}-totals`, { compact: true }),
          el("p", { className: "record-clear-sub", text: text.clearEquipment }),
          snapshot.equipment.length === 0
            ? el("p", { className: "record-empty-slot", text: text.noEquipment })
            : el("ul", {
              className: "record-equipment",
              children: snapshot.equipment.map((item) => el("li", {
                className: "record-equipment-row",
                attrs: { "data-equipment": item.equipmentId },
                children: [
                  equipmentIcon(item.equipmentId, item.rarity),
                  el("span", { className: "equipment-name", text: item.name }),
                ],
              })),
            }),
        ].filter(Boolean),
      });
    }

    // --- まだ中身のない画面 ---------------------------------------------------

    // ガチャ（Phase 11b）・図鑑（Phase 11c）はここでは入口だけ。
    renderShell(name) {
      return screen(name, [
        el("h2", { className: "title", text: UiContent.SCREEN_TITLES[name] || name }),
        el("p", { className: "lead", text: "この画面は次のPhaseで作ります。" }),
        el("div", {
          className: "choices",
          children: [button("戻る", this.act(() => this.controller.back()), { className: "ghost" })],
        }),
      ]);
    }

    // エンディング。クリアの一言と、保存済みのクリア時記録と、HOMEへ。それだけ。
    // 「裏が解放されました」はここでは言わない。HOMEでボタンが増えていることで気付かせる。
    renderEnding() {
      const ending = this.controller.getEnding();
      const isTrue = ending.ending === "TRUE";
      return screen(SCREENS.ENDING, [
        el("h2", {
          className: `ending-title${isTrue ? " true" : " normal"}`,
          id: "ending-title",
          attrs: { "data-ending": ending.ending || "NONE" },
          text: ending.title || UiContent.SCREEN_TITLES.ENDING,
        }),
        el("p", { className: "record-section", text: "ここまでの記録" }),
        // RECORD画面と同じ整形を使う。Ending専用の整形を作らない。
        this.renderSnapshot(ending.snapshot, "ending-record"),
        el("div", {
          className: "choices",
          children: [button("HOMEへ", this.act(() => this.controller.consumeEndingAndGoHome()),
            { className: "primary", id: "ending-home" })],
        }),
      ]);
    }

    // --- 戦闘 -----------------------------------------------------------------

    // 出すのは STAGE / 敵名 / 抵抗 / 敵 / 現在のCRITICAL率 / 残りTURN だけ。
    // HPバーも攻撃力もスキルボタンも無い。
    // 敵の絵。溜めズームの倍率・時間・easing はここでだけDOMへ載せる。
    // 数字は AudioManager が返したチャージ音の情報から来ていて、ここには書かない。
    renderBattleEnemy(battle) {
      // 戦闘の1手目。前の戦闘の倍率を持ち越さない（必ず等倍から始める）。
      if (battle.lastResolution === null && battle.phase === PHASES.READY) {
        this.enemyZoom = { from: 1, to: 1, ms: 0, ease: "ease-in" };
      }
      const art = enemyImage(battle.enemyId, { discovered: true, className: "enemy-art battle-enemy" });
      const zoom = this.enemyZoom;
      art.style.setProperty("--enemy-zoom", String(zoom.from));
      art.style.setProperty("--enemy-zoom-ms", `${zoom.ms}ms`);
      art.style.setProperty("--enemy-zoom-ease", zoom.ease);
      // 撃破の演出を敵の中央へ重ねるための器。敵の絵と同じ場所・同じ大きさで、
      // 演出が無いあいだは器があるだけ（見た目も高さも変わらない）。
      const stage = el("div", { className: "battle-enemy-stage", id: "battle-enemy-stage", children: [art] });
      // 倒したあとは敵だけを点滅させて消す。**要素は残す**ので枠も並びも動かない。
      // 描き直しても印は Controller 側に残っているので、敵が戻ってこない。
      if (battle.killed) stage.setAttribute("data-killed", "true");
      if (this.killFx) stage.appendChild(killEffectLayer(this.killFx.effect, this.killFx.frameIndex));
      // 外したときの大きな「MISS」。敵の真ん中へ重ねるだけで、枠も並びも動かさない。
      // 溜めの最中は結果を先に見せない（既存の data-outcome と同じ考え方）。
      if (this.showsBigMiss(battle)) {
        stage.appendChild(el("div", {
          className: "battle-miss",
          id: "battle-miss",
          text: UiContent.BATTLE_LABELS.miss,
          attrs: { "aria-hidden": "true" },
        }));
      }
      return stage;
    }

    // 大きな「MISS」を出すか。**外したターンだけ**で、溜めの最中は出さない。
    // CRITICALでも、まだ何も起きていないうちでも出ない。
    showsBigMiss(battle) {
      if (battle.phase === PHASES.CHARGING) return false;
      const resolution = battle.lastResolution;
      return Boolean(resolution) && resolution.outcome === "MISS";
    }

    // --- 撃破の演出 -----------------------------------------------------------
    //
    // 出すのは**敵が実際に死んだ瞬間だけ**。倒していないCRITICAL・MISS・
    // 神の1発目では Controller 側の合図が立たないので、ここへは来ない。

    // 1戦につき1回。撃破SEと同じ合図（completeBattleTap の返り値）から呼ぶ。
    startKillEffect() {
      this.stopKillEffect();
      // どちらの演出を出すかは Controller が設定から決める。
      const effect = this.controller.getKillEffect();
      if (!effect.image.available || !preloadSheet(effect.image)) return false;
      this.killFx = { effect, frameIndex: 0 };
      this.playKillEffect(effect);
      // 画面が隠れて rAF が止まっても、時間で必ず畳む（器を残さない）。
      this.killFxEndTimer = global.setTimeout(() => {
        this.killFxEndTimer = null;
        this.finishKillEffect();
      }, effect.durationMs + GACHA_FX_END_MARGIN_MS);
      return true;
    }

    // コマ送り。rAF 1本で background-position を動かすだけ。ループしない。
    playKillEffect(effect) {
      if (typeof global.requestAnimationFrame !== "function") return;
      const { sheet } = effect;
      const startedAt = typeof global.performance === "object" && global.performance
        ? global.performance.now() : Date.now();
      const step = (now) => {
        if (!this.killFx || this.killFx.effect !== effect) return;
        const layer = this.root.querySelector("#battle-kill-fx");
        if (!layer) { this.killFxFrame = global.requestAnimationFrame(step); return; }
        const elapsed = now - startedAt;
        if (elapsed >= effect.durationMs) { this.finishKillEffect(); return; }
        const index = Math.min(sheet.frameCount - 1,
          Math.floor((elapsed / effect.durationMs) * sheet.frameCount));
        this.killFx.frameIndex = index;
        layer.style.backgroundPosition = framePosition(index, sheet);
        this.killFxFrame = global.requestAnimationFrame(step);
      };
      this.killFxFrame = global.requestAnimationFrame(step);
    }

    // 再生し終えた。器だけ外す。**画面は作り直さない**（結果の見せ方を邪魔しない）。
    finishKillEffect() {
      this.stopKillEffect();
      const layer = this.root.querySelector("#battle-kill-fx");
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    }

    // 器も予約もコマ送りも残さない。次の戦闘へ持ち越さない。
    stopKillEffect() {
      if (this.killFxEndTimer !== null) { global.clearTimeout(this.killFxEndTimer); this.killFxEndTimer = null; }
      if (this.killFxFrame !== null && typeof global.cancelAnimationFrame === "function") {
        global.cancelAnimationFrame(this.killFxFrame);
      }
      this.killFxFrame = null;
      this.killFx = null;
    }

    renderBattle() {
      const battle = this.controller.getBattle();
      const charging = battle.phase === PHASES.CHARGING;
      const outcome = battle.lastResolution ? battle.lastResolution.outcome : null;
      const showingResult = battle.phase === PHASES.RESULT;
      const won = battle.state === "WIN";

      // タップを受けるのは敵と確率のまとまりだけ。ヘッダや下部のボタン域は含めない。
      const tapArea = el("div", {
        className: `battle-tap${charging ? " charging" : ""}`,
        id: "battle-tap",
        attrs: {
          "data-phase": battle.phase,
          // 演出用。チャージ中は結果を先に見せない（CSSからも分からないようにする）。
          "data-outcome": charging ? "NONE" : (outcome || "NONE"),
          role: "button",
          tabindex: "0",
        },
        onClick: () => this.handleBattleTap(),
        children: [
          this.renderBattleEnemy(battle),
          el("p", {
            className: "battle-chance",
            id: "battle-chance",
            children: [
              el("span", { className: "battle-chance-label", text: UiContent.BATTLE_LABELS.chance }),
              el("span", { className: "battle-chance-value", text: battle.currentChanceText || "—" }),
            ],
          }),
          battle.phase === PHASES.READY
            ? el("p", { className: "tap-hint", text: UiContent.BATTLE_LABELS.tapHint })
            : null,
        ],
      });

      return screen(SCREENS.BATTLE, [
        // バトル前と同じ1枚。敵とCRITICAL率と残りTURNを読ませるぶん、暗幕だけ少し濃い。
        this.renderBattleBackdrop("battle-backdrop", "battle"),
        el("header", {
          className: "prep-header",
          children: [
            el("span", { className: "stage", text: battle.stage === null ? "SPECIAL" : `STAGE ${battle.stage}` }),
            el("span", { className: "enemy-name", id: "battle-enemy-name", text: battle.enemyName }),
            el("span", { className: "resistance", id: "battle-resistance", text: `抵抗 ${battle.resistance}` }),
          ],
        }),
        tapArea,
        // MISS / CRITICAL の手応え。文章は増やさない。
        outcome && !charging
          ? el("p", {
            className: `battle-outcome ${outcome.toLowerCase()}`,
            id: "battle-outcome",
            text: outcome === "CRITICAL" ? UiContent.BATTLE_LABELS.critical : UiContent.BATTLE_LABELS.miss,
          })
          : null,
        battle.extraLog.length > 0 ? this.renderExtraLog(battle) : null,
        showingResult
          ? el("p", { className: `battle-verdict ${won ? "win" : "lose"}`, id: "battle-verdict", text: won ? "WIN！" : "LOSE" })
          : null,
        this.renderGodGauge(battle),
        this.renderRemainingTurns(battle),
      ]);
    }

    // 撃破に2回以上CRITICALが要る敵だけに出す告知。通常敵には出さない。
    // 戦闘が始まってから初めて知る、という状態にしないための1行。
    renderSpecialRule(requiredCriticalHits) {
      if (!requiredCriticalHits || requiredCriticalHits <= 1) return null;
      return el("p", {
        className: "special-rule",
        id: "special-rule",
        attrs: { "data-required": String(requiredCriticalHits) },
        children: [
          el("span", { className: "special-rule-label", text: "SPECIAL RULE" }),
          el("span", { className: "special-rule-body", text: `撃破条件：CRITICAL ×${requiredCriticalHits}` }),
        ],
      });
    }

    // 神格耐久。いま何回CRITICALを当てたか。**2回以上要る敵にだけ**出す。
    // ◆が残り、◇が削れたぶん。MISSでは数字が動かない。
    renderGodGauge(battle) {
      if (!battle.requiredCriticalHits || battle.requiredCriticalHits <= 1) return null;
      const marks = [];
      for (let index = 0; index < battle.requiredCriticalHits; index += 1) {
        const broken = index < battle.criticalHits;
        marks.push(el("span", {
          className: `god-mark${broken ? " broken" : ""}`,
          attrs: { "data-mark": String(index + 1) },
          text: broken ? "◇" : "◆",
        }));
      }
      return el("div", {
        className: "god-gauge",
        id: "god-gauge",
        attrs: {
          "data-hits": String(battle.criticalHits),
          "data-required": String(battle.requiredCriticalHits),
        },
        children: [
          el("span", { className: "label", text: "神格耐久" }),
          el("span", { className: "marks", children: marks }),
          el("span", {
            className: "count",
            id: "god-gauge-count",
            text: `${battle.criticalHits} / ${battle.requiredCriticalHits}`,
          }),
        ],
      });
    }

    // 残りTURN。追加判定では増減しないので、ここに「TURN6」は出ない。
    renderRemainingTurns(battle) {
      const marks = [];
      for (let index = 0; index < battle.maxTurns; index += 1) {
        marks.push(el("span", {
          className: `turn-mark${index < battle.remainingTurns ? " left" : " used"}`,
          attrs: { "data-mark": String(index + 1) },
          text: index < battle.remainingTurns ? "●" : "○",
        }));
      }
      return el("div", {
        className: "remaining",
        id: "remaining-turns",
        attrs: { "data-remaining": String(battle.remainingTurns) },
        children: [
          el("span", { className: "label", text: UiContent.BATTLE_LABELS.remaining }),
          el("span", { className: "marks", children: marks }),
          el("span", { className: "count", text: String(battle.remainingTurns) }),
        ],
      });
    }

    // 5MISS後の追加判定。通常ターンとは別枠で見せる（TURN6とは呼ばない）。
    renderExtraLog(battle) {
      return el("ul", {
        className: "extra-log",
        id: "extra-log",
        children: battle.extraLog.map((entry) => {
          const kindLabel = UiContent.EXTRA_LABELS[entry.kind] || entry.kind;
          const isTrigger = entry.phase === "TRIGGER";
          const detail = isTrigger
            ? `${UiContent.EXTRA_LABELS.TRIGGER} ${entry.chance}%　`
              + (entry.triggered ? UiContent.EXTRA_LABELS.TRIGGERED : UiContent.EXTRA_LABELS.NOT_TRIGGERED)
            : `${BattleCalculator.formatChanceForDisplay(entry.chance)}%　${entry.outcome}`;
          return el("li", {
            className: `extra-entry${entry.outcome === "CRITICAL" ? " critical" : ""}`,
            attrs: { "data-kind": entry.kind, "data-phase": entry.phase },
            children: [
              el("span", { className: "extra-kind", text: kindLabel }),
              el("span", { className: "extra-detail", text: detail }),
            ],
          });
        }),
      });
    }

    // タップ → チャージ（敵をズーム）→ 判定 → 結果。
    //
    // 結果を見せるのは**チャージ音が鳴り終わってから**。音の長さは音源ごとに違う
    // （Charge1 約4秒 / Charge2 約5秒 / Charge3 約2.5秒）ので、CSSに秒数を並べず
    // 実際の `ended` を合図にする。音が鳴らなかった／終わらなかったときのために、
    // 短いfallback（--charge-duration）と保険の上限（--charge-safety）を置く。
    // どちらへ転んでも RESOLVING のまま止まることはない。
    handleBattleTap() {
      this.controller.unlockAudio();
      // 溜めを飛ばした直後だけ、ほんの少し受け付けない（文字が一瞬で消えないように）。
      if (this.now() < this.missHoldUntil) return;
      let advanced = false;
      const advance = () => {
        if (advanced) return; // ended と保険の両方が来ても1回だけ
        advanced = true;
        this.revealBattleResult();
      };
      const tapped = this.controller.tapBattle({ onChargeEnd: advance });
      if (!tapped.accepted) return; // 連打はここで止まる。ズームも鳴り直しも起きない
      // 内部の確率がちょうど0のターン。**溜めても結果は変わらない**ので、
      // 音も待ちもズームも挟まずにその場で外れを見せる（判定はもう済んでいる）。
      if (tapped.certainMiss) {
        this.setEnemyZoom(1, 1, 0, "ease-in");
        advance();
        this.missHoldUntil = this.now() + this.readDuration("--miss-flash", MISS_FLASH_MS);
        return;
      }
      const charge = tapped.chargeSound;
      if (charge && charge.played) {
        // 音と同時に、音の長さをかけて敵をゆっくり寄せる。
        // 最初はゆっくり、終わり際に迫ってくる（ease-in）。
        this.setEnemyZoom(1, charge.zoomScale, charge.zoomMs, "ease-in");
        this.render();
        // 音が終わらなかったときの保険。
        this.after("--charge-safety", CHARGE_SAFETY_MS, advance);
        return;
      }
      // 音が無い／鳴らせなかった。短い演出で寄せて、そのまま結果へ進む。
      this.setEnemyZoom(1, charge ? charge.zoomScale : 1, this.chargeFallbackMs(), "ease-in");
      this.render();
      this.after("--charge-duration", 320, advance);
    }

    // 音が鳴らなかったときの短い溜め時間。CSS変数から読む（秒数は1か所だけ）。
    chargeFallbackMs() {
      return this.readDuration("--charge-duration", 320);
    }

    // チャージが終わったあと。判定を公開して、決着していれば結果画面まで運ぶ。
    revealBattleResult() {
      const done = this.controller.completeBattleTap();
      // 倒した瞬間だけ。撃破SEを鳴らしたのと同じ合図なので、音と絵がズレない。
      if (done.killed) this.startKillEffect();
      // CRITICAL は寄ったまま見せる（閃光は filter なので transform とぶつからない）。
      // MISS は軽く元の大きさへ戻して、次のタップを等倍から始める。
      const zoomed = this.enemyZoom.to;
      // 寄ったまま見せるのは**倒しきったCRITICAL**のときだけ。
      // 神の1発目のように戦闘が続くときは、次のタップへ向けて等倍へ戻す。
      if (done.outcome === "CRITICAL" && done.finished) this.setEnemyZoom(zoomed, zoomed, 0, "ease-out");
      else this.setEnemyZoom(zoomed, 1, MISS_ZOOM_BACK_MS, "ease-out");
      this.render();
      if (!done.accepted || !done.finished) return;
      if (done.phase === PHASES.EXTRA) {
        this.after("--extra-duration", 900, () => {
          this.controller.acknowledgeExtras();
          this.render();
          this.afterResult(() => {
            this.controller.acknowledgeResult();
            this.render();
          });
        });
        return;
      }
      this.afterResult(() => {
        this.controller.acknowledgeResult();
        this.render();
      });
    }

    // いまの時刻。テストから差し替えられるよう1か所にまとめる。
    now() {
      return typeof global.performance === "object" && global.performance
        ? global.performance.now() : Date.now();
    }

    // CSS変数から演出時間を読む。無ければ既定値。
    readDuration(variableName, fallbackMs) {
      try {
        const raw = global.getComputedStyle(global.document.documentElement).getPropertyValue(variableName);
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) return raw.includes("ms") ? parsed : parsed * 1000;
      } catch (error) {
        return fallbackMs;
      }
      return fallbackMs;
    }

    after(variableName, fallbackMs, run) {
      global.setTimeout(run, this.readDuration(variableName, fallbackMs));
    }

    // 結果画面へ移るまでの間。**撃破の演出を出したときは、それが終わるまで待つ。**
    // 途中で画面が移ると演出ごと消えてしまう。倒していないとき（LOSE など）は
    // これまでどおり --result-duration のままで、テンポは変わらない。
    afterResult(run) {
      const resultMs = this.readDuration("--result-duration", 700);
      const killMs = this.killFx ? this.killFx.effect.durationMs : 0;
      global.setTimeout(run, Math.max(resultMs, killMs));
    }

    // --- WIN / LOSE -----------------------------------------------------------

    // 上から WIN！ / 獲得ダイヤ / 宝箱 / NEXT。戦績パネルは足さない。
    renderWin() {
      const win = this.controller.getWin();
      // 宝箱を開ける前は次へ進ませない（受け取りそこねを作らない）。
      const waitingChest = win.chestDropped && win.chestPhase === GACHA.CHEST;
      const node = screen(SCREENS.WIN, [
        // その戦闘の背景をそのまま。主役は結果なので、暗幕はいちばん濃い。
        this.renderBattleBackdrop("result-backdrop", "result"),
        el("h2", { className: "result-title win", id: "win-title", text: "WIN！" }),
        el("p", { className: "result-diamonds", id: "win-diamonds", text: `+${win.battleDiamonds} ダイヤ` }),
        this.renderChest(win),
        el("div", {
          className: "choices",
          children: waitingChest ? [] : [this.renderWinNext(win)],
        }),
      ]);
      // 開けたあとは主役が装備のカードへ移る。見出しの大きさはCSSがここで切り替える。
      if (win.chestPhase) node.setAttribute("data-chest", win.chestPhase);
      return node;
    }

    // 次へ。UR / LEGEND の宝箱は、出現SEが鳴り終わるまで押せない（ガチャと同じ錠）。
    // 台座は引くボタン・バトル開始と同じ赤金1枚。背景4種のどれの上でも読めるように、
    // 文字は plate-main の白文字＋濃い影をそのまま使う。
    renderWinNext(win) {
      const next = this.renderMainButton(win.next.label, "win-next", () => {
        if (this.gachaAdvanceLocked) return; // 錠のあいだの入力は捨てる（溜めない）
        this.controller.unlockAudio();
        this.stopGachaEffect();
        this.controller.nextFromWin();
        this.render();
      }, { className: "win-next", raw: true });
      this.applyGachaAdvanceLock(next);
      return next;
    }

    // 戦闘の宝箱。まず閉じた箱を出し、タップされてから中身を見せる。
    // 箱も結果カードも演出も、ガチャの開封と**同じもの**を通す。
    renderChest(win) {
      if (!win.chestDropped) {
        return el("p", { className: "chest none", id: "win-chest", attrs: { "data-drop": "false" }, text: "宝箱なし" });
      }
      const text = this.controller.getGachaLabels();
      const current = this.controller.getWinChest();
      if (!current.opened) {
        const stage = this.renderChestStage(current.chest, {
          id: "win-chest",
          boxId: "win-chest-box",
          hintId: "win-chest-hint",
          hintText: text.chestTap,
          promoting: false,
          onTap: () => this.handleWinChestTap(),
          extraClass: "arriving battle-chest",
        });
        stage.setAttribute("data-drop", "true");
        stage.setAttribute("data-phase", GACHA.CHEST);
        stage.insertBefore(el("p", { className: "chest-head", text: text.chestGot }), stage.firstChild);
        return stage;
      }
      return el("div", {
        className: "chest opened",
        id: "win-chest",
        attrs: { "data-drop": "true", "data-phase": GACHA.RESULT, "data-rarity": current.rarity },
        children: [
          chestBox(current.chest, { className: `chest-box ${current.chest} battle-chest opened`, id: "win-chest-box" }),
          this.renderRewardCard(current, WIN_FX_TARGETS),
        ],
      });
    }

    // 宝箱をタップした。**抽選はもう終わっている**ので、するのは
    // 「開いた段階へ進める」ことと「レア度に応じた演出を1回まわす」ことだけ。
    // 受付は openWinChest() が CHEST のときしか通さないので、連打しても増えない。
    handleWinChestTap() {
      this.controller.unlockAudio();
      const current = this.controller.getWinChest();
      if (!current || current.phase !== GACHA.CHEST) return; // 連打はここで断つ
      this.controller.openWinChest();
      this.startGachaEffect(current.rarity, WIN_FX_TARGETS);
      this.render();
    }

    // LOSE / 最初からやり直し（神はRETRY）/ HOMEに戻る。詳細戦績は出さない。
    renderLose() {
      const lose = this.controller.getLose();
      return screen(SCREENS.LOSE, [
        this.renderBattleBackdrop("result-backdrop", "result"),
        el("h2", { className: "result-title lose", id: "lose-title", text: "LOSE" }),
        el("div", {
          className: "choices",
          children: [
            button(lose.retryLabel, this.act(() => this.controller.retryFromLose()),
              { className: "primary", id: "lose-retry" }),
            button("HOMEに戻る", this.act(() => this.controller.homeFromResult()),
              { className: "secondary", id: "lose-home" }),
          ],
        }),
      ]);
    }
  }

  // 演出の間合いはテストからも確かめられるように公開しておく。
  Object.assign(ns, { AppView: Object.assign(AppView, { GACHA_FX_REVEAL_MS }) });
})(globalThis);
