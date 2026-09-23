(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { BOXES, ROUTES } = ns;

  // 画像と音の置き場所を決める唯一の場所。
  //
  // View は「この敵の絵」「この装備のアイコン」とだけ言い、パスは知らない。
  // ここが `assets/enemies/normal_01.webp` のような**相対パス**を組み立てる。
  // 絶対パスや外部URLは使わない（iOS WebView / Capacitor でも同じ場所を指すため）。
  //
  // 敵21体・宝箱5種・装備60種・BGM8曲・SE12本は入っている。まだ無いもの（UI）は
  // fallback として返し、置いたときに**ファイルを置くだけ**で映るよう、
  // IDから機械的にパスを作る。

  const IMAGE_EXTENSION = ".webp"; // 既存ゲーム（ワンオペパズラー）と同じ形式に合わせる
  const AUDIO_EXTENSION = ".mp3"; // iOS WebView / Android / PCブラウザのどれでも再生できる形式

  const DIRECTORIES = Object.freeze({
    ENEMY: "assets/enemies/",
    EQUIPMENT: "assets/equipment/",
    CHEST: "assets/chests/",
    UI: "assets/ui/",
    AUDIO: "assets/audio/",
  });

  const KINDS = Object.freeze({
    ENEMY: "ENEMY",
    ENEMY_SILHOUETTE: "ENEMY_SILHOUETTE",
    EQUIPMENT: "EQUIPMENT",
    CHEST: "CHEST",
    UI: "UI",
    AUDIO: "AUDIO",
  });

  // バトルのドロップ宝箱。ガチャの演出箱（木・赤・金・虹）とは**別の用途**で、
  // ガチャの presentationChest 抽選をこちらへ流用しない。
  const BATTLE_CHEST = "battle";
  const CHEST_KEYS = Object.freeze(BOXES.map((box) => box.id).concat(BATTLE_CHEST));

  // BGMは8曲。どの場面でどれを鳴らすかも**ここだけ**が決める。
  // 画面側は「この route のこの stage」としか言わない。
  const BGM = Object.freeze({
    THINKING: "bgm_thinking", // 非戦闘（HOME・装備・図鑑・ガチャ・OPTIONS・戦闘前…）
    NORMAL_1_9: "bgm_normal_1_9",
    NORMAL_10: "bgm_normal_10",
    BACK_1_9: "bgm_back_1_9",
    BACK_10: "bgm_back_10",
    GOD: "bgm_god",
    VICTORY: "bgm_victory",
    DEFEAT: "bgm_defeat",
  });

  // 勝利と敗北だけ1回きり。ほかはループ。
  const BGM_ONE_SHOT = Object.freeze([BGM.VICTORY, BGM.DEFEAT]);

  // ガチャ開封のレア度別演出。1枚のスプライトシートを順に見せるだけで、
  // **抽選にも装備にも一切触らない**（結果はタップより前に決まっている）。
  //
  // シートは 5列 × 12行 = 60コマ、1コマ 192×192。60fps で約1秒の1回再生。
  const GACHA_FX = Object.freeze({
    SHIMMER: "gacha_fx_shimmer",
    UNLEASH: "gacha_fx_unleash",
    SMOKE: "gacha_fx_smoke", // 宝箱の昇格を隠す煙。レア度の演出ではない
  });

  const GACHA_FX_SHEET = Object.freeze({
    columns: 5,
    rows: 12,
    frameCount: 60,
    frameWidth: 192,
    frameHeight: 192,
    fps: 60,
  });

  // 煙のシート。**コマの並びは他の演出と同じ**（5列×12行・192px・60fps）だが、
  // 46コマ目から先は完全に空なので、そこまでで畳む（全60コマ回すと0.23秒ぶん
  // 何も映らないまま固まって見える）。swapFrame は煙がいちばん濃いところで、
  // 箱の入れ替えはこのコマで済ませる（入れ替わる瞬間をプレイヤーに見せない）。
  const GACHA_SMOKE_SHEET = Object.freeze({
    columns: 5,
    rows: 12,
    frameCount: 46,
    frameWidth: 192,
    frameHeight: 192,
    fps: 60,
    swapFrame: 24,
  });

  // --- 戦闘の演出 -----------------------------------------------------------
  //
  // ガチャの演出（GACHA_FX）とは**別系統**。互いに流用しない。

  // HOMEの主役の絵。**タイトル文字も絵の中に入っている**ので、
  // 画面側でタイトルを重ねない。置かれていなければ available が false になり、
  // 画面側は同じ場所に枠だけを描く（絵を置けばそのまま替わる）。
  //
  // HOMEのボタンの土台も同じ扱い。**文字は絵に焼き込まれていない**ので、
  // STAGE番号も日本語/英語も画面側の文字が受け持つ（絵は枠と色だけ）。
  // HOMEの色は**役割ごと**に分ける（深紅=バトル／蒼銀=通常メニュー3つ／
  // 黒銀=オプション）。機能ごとではない。
  const UI_IMAGES = Object.freeze({
    HOME_VISUAL: "home_main_visual",
    // いちばん押してほしいバトルだけ深紅。アーカイブ / ガチャ / 装備の3つは
    // **蒼銀の1枚を共用**して、赤から視線を奪う色をHOMEに増やさない。
    // オプションだけは絵を増やさず、黒銀の共通台座（COMMON_BACK_BUTTON）を借りる。
    HOME_BUTTON_BATTLE: "home_button_battle", // バトル：深紅
    HOME_BUTTON_ARCHIVE: "home_button_archive", // 通常メニュー3つ共用：蒼銀
    HOME_BUTTON_GACHA: "home_button_gacha", // 旧・ガチャ専用の黄金（今は使っていない）
    HOME_BUTTON_EQUIPMENT: "home_button_equipment", // 旧・装備専用の深青（今は使っていない）
    // バトルモードの NORMAL / HARD の台座。HOMEのバトルとは**別の1枚**にして、
    // HOME側の絵を替えてもモーダルの見た目が動かないようにしてある。
    BATTLE_MODE_BUTTON: "battle_mode_button",
    HOME_BUTTON_MENU: "home_button_menu", // 旧・小ボタン共通の青枠（今は使っていない）
    HOME_BUTTON_SPECIAL: "home_button_special", // 隠居した神だけの黄枠。**他へは流用しない**
    HOME_OPTION_ICON: "home_option_icon", // OPTIONの歯車（今は使っていない）
    HOME_DIAMOND_FRAME: "home_diamond_frame", // 所持ダイヤの宝石枠
    // ガチャの背景（宝物庫）。待機から開封まで同じ1枚を敷く。
    GACHA_BACKGROUND: "gacha_background",
    // 「1回引く」「10回引く」の共通の台座。**文字は焼き込まれていない。**
    GACHA_DRAW_BUTTON: "gacha_draw_button",
    // 「排出装備一覧」「提供割合」の共通の台座。引くボタン（赤金）とは役割で分ける。
    GACHA_SUB_BUTTON: "gacha_sub_button",
    // 「戻る」「HOMEへ戻る」「閉じる」の共通の台座（黒銀）。
    // 進める操作（赤金）とも脇の操作（青金）とも**役割で分ける**。
    COMMON_BACK_BUTTON: "common_back_button",
    // バトル前の背景。**同じ構図の色違い4枚**で、どれを出すかは route と stage が決める
    //（getBattleBackground が唯一の出どころ。画面側は敵IDを並べない）。
    BATTLE_BG_NORMAL: "battle_bg_normal", // 通常1〜5：青
    BATTLE_BG_STRONG: "battle_bg_strong", // 通常6〜10：赤紫
    BATTLE_BG_BACK: "battle_bg_back", // 裏1〜10：紫黒
    BATTLE_BG_GOD: "battle_bg_god", // 隠居した神：白金
  });

  // 通常のここから先は「強敵」の背景にする。区切りはこの1か所だけが持つ。
  const BATTLE_BG_STRONG_FROM = 6;

  const BATTLE_FX = Object.freeze({ KILL: "battle_kill_fx", KILL_SLASH: "battle_kill_fx_slash" });

  // 撃破演出。プレイヤーがオプションで選ぶ。**どちらも同じ扱い**で、
  // 出す場所も大きさも Hit SE との合わせ方も変わらない（違うのは絵と尺だけ）。
  //
  // frameCount は「実際に絵があるコマ数」。どちらのシートも後ろに空コマが付いていて、
  // そこまで回すと何も映らないまま止まって見えるので、実コマぶんで畳む。
  const BATTLE_KILL_EFFECTS = Object.freeze([
    Object.freeze({
      id: "impulse",
      label: "IMPULSE",
      key: BATTLE_FX.KILL,
      // 45コマ中0〜40の41枚。少し速めに送って約0.64秒。
      sheet: Object.freeze({ columns: 5, rows: 9, frameCount: 41, frameWidth: 192, frameHeight: 192, fps: 64 }),
    }),
    Object.freeze({
      id: "slash",
      label: "SLASH",
      key: BATTLE_FX.KILL_SLASH,
      // 30コマ中0〜18の19枚。斬撃なので等速のまま速く、約0.32秒。
      sheet: Object.freeze({ columns: 5, rows: 6, frameCount: 19, frameWidth: 192, frameHeight: 192, fps: 60 }),
    }),
  ]);

  const BATTLE_KILL_DEFAULT_ID = "impulse";

  // 既存の呼び方をそのまま残す（IMPULSE のシート）。
  const BATTLE_KILL_SHEET = BATTLE_KILL_EFFECTS[0].sheet;

  // 煙が消えたあと、昇格した箱だけを見せておく時間（ms）。
  // このあいだも入力は受けない。連打していても、変わった箱が必ず目に入るようにする。
  const CHEST_PROMOTION_HOLD_MS = 300;

  // 「見せかけの箱」を途中で昇格させる演出。**中身は最初から決まっていて変わらない。**
  // いま入っているのは「LEGEND を木箱で引いたとき、煙のあと虹箱へ」の1つだけ。
  // 赤箱・金箱・虹箱の LEGEND、および他のレア度には昇格を付けない。
  const CHEST_PROMOTIONS = Object.freeze({
    LEGEND: Object.freeze({ wood: "rainbow" }),
  });

  // レア度 → 演出。N と R は演出なし（追加しない）。
  // UR / LEGEND で Shimmer を重ねない。1レア度につき1つだけ。
  const GACHA_FX_BY_RARITY = Object.freeze({
    N: null,
    R: null,
    SR: GACHA_FX.SHIMMER,
    SSR: GACHA_FX.SHIMMER,
    UR: GACHA_FX.UNLEASH,
    LEGEND: GACHA_FX.UNLEASH,
  });

  // ガチャのSE。Battle の Charge / Critical とは**別系統**で、互いに流用しない。
  const GACHA_SE = Object.freeze({
    CHEST_BASIC: "se_gacha_chest_basic", // 木・赤・バトルの宝箱
    CHEST_HIGH: "se_gacha_chest_high", // 金・虹
    SHIMMER: "se_gacha_shimmer", // SR / SSR の演出と同時
    UNLEASH: "se_gacha_unleash", // UR / LEGEND の演出と同時
    ITEM_SR: "se_gacha_item_sr", // SR と SSR は同じ音
    ITEM_UR: "se_gacha_item_ur",
    ITEM_LEGEND: "se_gacha_item_legend",
    CHEST_PROMOTION: "se_gacha_chest_promotion", // 箱が昇格した瞬間（開封SEとは別）
  });

  // 箱 → 開封SE。バトルのドロップ宝箱も basic を使う（演出箱の音を流用はしない）。
  const CHEST_OPEN_SE = Object.freeze({
    wood: GACHA_SE.CHEST_BASIC,
    red: GACHA_SE.CHEST_BASIC,
    gold: GACHA_SE.CHEST_HIGH,
    rainbow: GACHA_SE.CHEST_HIGH,
    battle: GACHA_SE.CHEST_BASIC,
  });

  // レア度 → 演出と同時に鳴らすSE。演出が無い N / R は音も無い。
  const GACHA_FX_SE_BY_RARITY = Object.freeze({
    N: null,
    R: null,
    SR: GACHA_SE.SHIMMER,
    SSR: GACHA_SE.SHIMMER,
    UR: GACHA_SE.UNLEASH,
    LEGEND: GACHA_SE.UNLEASH,
  });

  // レア度 → 装備が出た瞬間のSE。N / R は無し。SR と SSR は同じ音。
  const GACHA_ITEM_SE_BY_RARITY = Object.freeze({
    N: null,
    R: null,
    SR: GACHA_SE.ITEM_SR,
    SSR: GACHA_SE.ITEM_SR,
    UR: GACHA_SE.ITEM_UR,
    LEGEND: GACHA_SE.ITEM_LEGEND,
  });

  // レア度 → 装備が出たあと「結果送り」を出現SEの終わりまで止めるか。
  // UR / LEGEND だけ。連打で当たりの演出が一瞬で飛ぶのを防ぐための錠で、
  // 排出率にも演出そのものにも触らない。SR / SSR は今までどおりすぐ送れる。
  const GACHA_ADVANCE_LOCK_BY_RARITY = Object.freeze({
    N: false,
    R: false,
    SR: false,
    SSR: false,
    UR: true,
    LEGEND: true,
  });

  // 出現SEの「鳴り終わり」が来なかったときだけの保険（ms）。
  // 実尺は UR 約4.4秒 / LEGEND 約5.2秒。長いほうへ十分な余裕を取ってある。
  // **正常時はここを使わない**（`ended` が本来の合図）。秒数はここ1か所だけが持つ。
  const GACHA_ITEM_SE_SAFETY_MS = 8000;

  // 音のキー。ファイル名もこのキーと同じ（assets/audio/<key>.mp3）。
  const SOUNDS = Object.freeze({
    CHARGE: "se_charge_01", // タップのチャージ音（UI仕様書 04）。既定は Charge1
    CRITICAL_DEFAULT: "se_critical_06", // 撃破SEの既定（Hit6）
    MISS: "se_miss", // 外した瞬間の音。Optionsでは選ばせない（1本だけ）
    // 非戦闘の基本BGM。Phase 13 からの名前をそのまま残してある。
    BGM_MAIN: BGM.THINKING,
  });

  // チャージ音3種。**Optionsでは選ばせない。**タップごとに、そのタップの
  // 結果（CRITICAL / MISS）に応じた重みで自動的に選ぶ（下の CHARGE_WEIGHTS）。
  //
  // zoomScale / zoomMs は**溜め演出の唯一の出どころ**。音が鳴っているあいだ
  // 敵の絵がここまでゆっくり拡大する。秒数をCSSやViewへ書き写さないこと。
  // zoomMs は音源の実尺に合わせた目安で、実際に再生時間が取れたらそちらを優先する。
  // 長い音ほど大きく寄る： Charge3 < Charge1 < Charge2。
  const CHARGE_SOUNDS = Object.freeze([
    Object.freeze({ id: "charge01", label: "01", soundKey: "se_charge_01", zoomScale: 1.5, zoomMs: 4000 }),
    Object.freeze({ id: "charge02", label: "02", soundKey: "se_charge_02", zoomScale: 1.8, zoomMs: 5000 }),
    Object.freeze({ id: "charge03", label: "03", soundKey: "se_charge_03", zoomScale: 1.2, zoomMs: 2500 }),
  ]);

  // 結果ごとのチャージ音の重み（%）。各行の合計は100。
  // **これは音の選び方だけ。**CRITICAL / MISS そのものは BattleSession が先に確定していて、
  // ここでは結果を読むだけ。音からゲームの判定へ戻ることはない。
  const CHARGE_WEIGHTS = Object.freeze({
    CRITICAL: Object.freeze({ charge01: 50, charge02: 15, charge03: 35 }),
    MISS: Object.freeze({ charge01: 25, charge02: 5, charge03: 70 }),
  });

  // 撃破SEの選択肢。**実音源があるぶんだけ**並べる。Hit1〜9 の9種。
  // ここへ足すと Options の選択肢も自動で増える（UiContent が写しを作る）。
  const CRITICAL_SOUNDS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => Object.freeze({
    id: `critical0${number}`,
    label: `0${number}`,
    soundKey: `se_critical_0${number}`,
  })));

  // 既存セーブの値が使えないとき（未設定・旧placeholder・範囲外）に落とす先。
  const CRITICAL_DEFAULT_ID = CRITICAL_SOUNDS
    .filter((choice) => choice.soundKey === SOUNDS.CRITICAL_DEFAULT)[0].id;

  // 404 になったパスを覚えておく入れ物。
  // 一度失敗したものを毎回取りに行かないだけで、意味は「まだ置かれていない」。
  const missingSources = new Set();

  function ref(kind, key, src) {
    return Object.freeze({
      kind,
      key,
      // まだ置かれていないと分かっているものは src を渡さない（placeholder で描く）。
      src: src && !missingSources.has(src) ? src : null,
      path: src || null,
      available: Boolean(src) && !missingSources.has(src),
    });
  }

  // 見つからない／知らないIDでも投げない。画面を止めないことを優先する。
  function fallbackRef(kind) {
    return ref(kind, "placeholder", null);
  }

  function isSafeKey(value) {
    // パスの組み立てに使うので、ディレクトリを跨げる文字は通さない。
    return typeof value === "string" && /^[a-z0-9_]+$/i.test(value);
  }

  function getEnemyImage(enemyId) {
    if (!isSafeKey(enemyId)) return fallbackRef(KINDS.ENEMY);
    return ref(KINDS.ENEMY, enemyId, `${DIRECTORIES.ENEMY}${enemyId}${IMAGE_EXTENSION}`);
  }

  // 未撃破の敵。**正式画像があっても元の絵は返さない。**
  // 専用のシルエット枠（src なし）だけを返し、元画像がDOMに載ること自体を防ぐ。
  function getEnemySilhouette(enemyId) {
    return ref(KINDS.ENEMY_SILHOUETTE, isSafeKey(enemyId) ? enemyId : "placeholder", null);
  }

  function getEquipmentIcon(equipmentId) {
    if (!isSafeKey(equipmentId)) return fallbackRef(KINDS.EQUIPMENT);
    return ref(KINDS.EQUIPMENT, equipmentId, `${DIRECTORIES.EQUIPMENT}${equipmentId}${IMAGE_EXTENSION}`);
  }

  function getChestImage(chestType) {
    if (!CHEST_KEYS.includes(chestType)) return fallbackRef(KINDS.CHEST);
    return ref(KINDS.CHEST, chestType, `${DIRECTORIES.CHEST}${chestType}${IMAGE_EXTENSION}`);
  }

  function getUiImage(key) {
    if (!isSafeKey(key)) return fallbackRef(KINDS.UI);
    return ref(KINDS.UI, key, `${DIRECTORIES.UI}${key}${IMAGE_EXTENSION}`);
  }

  function getSound(soundKey) {
    if (!isSafeKey(soundKey)) return fallbackRef(KINDS.AUDIO);
    return ref(KINDS.AUDIO, soundKey, `${DIRECTORIES.AUDIO}${soundKey}${AUDIO_EXTENSION}`);
  }

  // そのレア度の開封演出。無い（N / R）なら null。
  // 画像が置かれていなければ available:false のまま返るので、View は演出を諦めて
  // 結果だけ見せればよい（演出はあくまで presentation）。
  function getGachaEffect(rarity) {
    const key = GACHA_FX_BY_RARITY[rarity] || null;
    if (!key) return null;
    // 絵と音を**同じ1か所**から返す。片方だけ差し替わることが起きない。
    return Object.freeze({
      key,
      rarity,
      sheet: GACHA_FX_SHEET,
      image: getUiImage(key),
      soundKey: GACHA_FX_SE_BY_RARITY[rarity] || null,
    });
  }

  // 外した瞬間の音。チャージ音とも撃破SEとも別系統で、互いに流用しない。
  function getMissSound() {
    return SOUNDS.MISS;
  }

  // 宝箱を開けた瞬間のSE。知らない箱でも落ちず、basic へ落とす。
  function getChestOpenSound(chestType) {
    return CHEST_OPEN_SE[chestType] || GACHA_SE.CHEST_BASIC;
  }

  // 装備が出た瞬間のSE。N / R は null（鳴らさない）。
  function getGachaItemSound(rarity) {
    return GACHA_ITEM_SE_BY_RARITY[rarity] || null;
  }

  // そのレア度で、出現SEが鳴り終わるまで結果送りを止めるか。
  function isGachaAdvanceLocked(rarity) {
    return GACHA_ADVANCE_LOCK_BY_RARITY[rarity] === true;
  }

  // 敵を倒した瞬間の演出。絵が置かれていなければ available が false になるだけで、
  // 呼び出しは成立する（画面は止まらない）。
  //
  // 知らないIDや未設定（旧セーブ）のときは既定の IMPULSE を返す。**落とさない。**
  function getBattleKillEffect(effectId) {
    const found = BATTLE_KILL_EFFECTS.filter((choice) => choice.id === effectId)[0];
    const choice = found || BATTLE_KILL_EFFECTS.filter((c) => c.id === BATTLE_KILL_DEFAULT_ID)[0];
    const sheet = choice.sheet;
    return Object.freeze({
      id: choice.id,
      label: choice.label,
      key: choice.key,
      sheet,
      image: getUiImage(choice.key),
      durationMs: Math.round((sheet.frameCount / sheet.fps) * 1000),
    });
  }

  // その組み合わせに箱の昇格があるか。無ければ null（＝これまでどおり1タップで開く）。
  // 時間はすべてシートのコマ数から出す。秒数を別に持たない。
  function getChestPromotion(rarity, chestType) {
    const byChest = CHEST_PROMOTIONS[rarity];
    if (!byChest) return null;
    const to = byChest[chestType];
    if (!to) return null;
    const sheet = GACHA_SMOKE_SHEET;
    const frameMs = 1000 / sheet.fps;
    return Object.freeze({
      key: GACHA_FX.SMOKE,
      from: chestType,
      to,
      sheet,
      image: getUiImage(GACHA_FX.SMOKE),
      // 差し替えの瞬間に鳴らす音。**開封SEとは別物**で、二重には鳴らさない。
      soundKey: GACHA_SE.CHEST_PROMOTION,
      durationMs: Math.round(sheet.frameCount * frameMs),
      swapAtMs: Math.round(sheet.swapFrame * frameMs),
      holdMs: CHEST_PROMOTION_HOLD_MS,
    });
  }

  // 戦闘BGM。route と stage から決める（ロジック側の値をそのまま渡す）。
  // 通常1〜9 / 通常10 / 裏1〜9 / 裏10 / 神 の5通り。知らない route は通常扱いにして、
  // 曲が無いより鳴っているほうを選ぶ（画面は止めない）。
  function getBattleBgm(route, stage) {
    if (route === ROUTES.SPECIAL) return BGM.GOD;
    const number = Number(stage);
    const isFinal = Number.isFinite(number) && number >= 10;
    if (route === ROUTES.BACK) return isFinal ? BGM.BACK_10 : BGM.BACK_1_9;
    return isFinal ? BGM.NORMAL_10 : BGM.NORMAL_1_9;
  }

  // バトル前の背景。BGMと同じく route と stage だけで決める。
  // **敵IDは見ない**（敵が増えても並べ直さなくていい）。神 → 裏 → 通常後半 → 通常前半 の順。
  // 知らない route は通常扱いにして、背景が出ないより出るほうを選ぶ（画面は止めない）。
  function getBattleBackground(route, stage) {
    if (route === ROUTES.SPECIAL) return getUiImage(UI_IMAGES.BATTLE_BG_GOD);
    if (route === ROUTES.BACK) return getUiImage(UI_IMAGES.BATTLE_BG_BACK);
    const number = Number(stage);
    const isLate = Number.isFinite(number) && number >= BATTLE_BG_STRONG_FROM;
    return getUiImage(isLate ? UI_IMAGES.BATTLE_BG_STRONG : UI_IMAGES.BATTLE_BG_NORMAL);
  }

  // ループするか。勝利・敗北だけ1回きりで、あとは鳴らし続ける。
  function isBgmLooping(soundKey) {
    return BGM_ONE_SHOT.indexOf(soundKey) === -1;
  }

  // 撃破SEのIDから鳴らす音を引く。知らないIDなら既定（Hit6）へ落とす。
  // **既存プレイヤーの有効な選択は書き換えない。**落とすのは使えない値のときだけ。
  function getCriticalSound(soundId) {
    const found = CRITICAL_SOUNDS.filter((choice) => choice.id === soundId)[0];
    return found || CRITICAL_SOUNDS.filter((choice) => choice.id === CRITICAL_DEFAULT_ID)[0];
  }

  // チャージ音のIDから鳴らす音を引く。知らないIDなら Charge1 へ落とす。
  function getChargeSound(soundId) {
    const found = CHARGE_SOUNDS.filter((choice) => choice.id === soundId)[0];
    return found || CHARGE_SOUNDS[0];
  }

  // その結果のときのチャージ音の重み。[id, %] の並びで、合計は100。
  // 重み付き抽選へそのまま渡せる形にしてある（抽選そのものはここではしない）。
  function getChargeWeights(outcome) {
    const table = CHARGE_WEIGHTS[outcome] || CHARGE_WEIGHTS.MISS;
    return CHARGE_SOUNDS.map((choice) => Object.freeze([choice.id, table[choice.id]]));
  }

  // 読み込みに失敗したパスを記録する。次からは placeholder で描く。
  function markMissing(source) {
    if (typeof source === "string" && source.length > 0) missingSources.add(source);
    return source;
  }

  function isMissing(source) {
    return missingSources.has(source);
  }

  // テスト用。実行中の「無かった記録」を消す。
  function resetMissing() {
    missingSources.clear();
  }

  Object.assign(ns, {
    AssetCatalog: Object.freeze({
      KINDS,
      DIRECTORIES,
      IMAGE_EXTENSION,
      AUDIO_EXTENSION,
      SOUNDS,
      CHARGE_SOUNDS,
      CHARGE_WEIGHTS,
      CRITICAL_DEFAULT_ID,
      GACHA_FX,
      GACHA_FX_SHEET,
      GACHA_SMOKE_SHEET,
      UI_IMAGES,
      BATTLE_FX,
      BATTLE_KILL_SHEET,
      BATTLE_KILL_EFFECTS,
      BATTLE_KILL_DEFAULT_ID,
      CHEST_PROMOTIONS,
      CHEST_PROMOTION_HOLD_MS,
      GACHA_FX_BY_RARITY,
      GACHA_SE,
      CHEST_OPEN_SE,
      GACHA_FX_SE_BY_RARITY,
      GACHA_ITEM_SE_BY_RARITY,
      GACHA_ADVANCE_LOCK_BY_RARITY,
      GACHA_ITEM_SE_SAFETY_MS,
      BGM,
      BGM_ONE_SHOT,
      CRITICAL_SOUNDS,
      CHEST_KEYS,
      BATTLE_CHEST,
      getEnemyImage,
      getEnemySilhouette,
      getEquipmentIcon,
      getChestImage,
      getUiImage,
      getGachaEffect,
      getChestOpenSound,
      getMissSound,
      getGachaItemSound,
      isGachaAdvanceLocked,
      getChestPromotion,
      getBattleKillEffect,
      getSound,
      getBattleBackground,
      BATTLE_BG_STRONG_FROM,
      getBattleBgm,
      isBgmLooping,
      getCriticalSound,
      getChargeSound,
      getChargeWeights,
      markMissing,
      isMissing,
      resetMissing,
    }),
  });
})(globalThis);
