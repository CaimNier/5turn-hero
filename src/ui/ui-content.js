(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { RARITIES, AssetCatalog } = ns;

  // 画面に出す文字。ロジックはここに置かない。
  // 数値・装備の効果文・敵の情報は Catalog から引くので、ここには**持たない**。

  // チュートリアル6STEP（PHASES.md D3・UI仕様書 11）。
  // 「見る / 見ない」の選択はこの6つに数えない（STEP 1 の手前）。
  const TUTORIAL_STEPS = Object.freeze([
    Object.freeze({
      title: "勇者は呪われている",
      body: "この勇者は呪いをかけられていて、CRITICALでしか敵にダメージを与えられない。",
    }),
    Object.freeze({
      title: "敵は5ターン後に必殺を放つ",
      body: "5ターン以内に倒せなければ、敵の必殺技で敗北する。",
    }),
    Object.freeze({
      title: "1タップ＝1ターン",
      body: "画面をタップするたびにCRITICAL判定が1回行われる。",
    }),
    Object.freeze({
      title: "CRITICAL率と敵の抵抗値",
      body: "勇者のCRITICAL率から敵の抵抗値を引いた値で判定する。装備の補正もここに乗る。",
    }),
    Object.freeze({
      title: "勝てなくなったら装備",
      body: "装備を変えると、5つのターンそれぞれのCRITICAL率を組み替えられる。",
    }),
    Object.freeze({
      title: "勇者の血",
      body: "5ターンすべてが0%になっても、各ターンに0.1%の奇跡が残る。"
        + "どれほど絶望的な相手でも、可能性が0になることはない。",
    }),
  ]);

  // 初回起動の2択（UI仕様書 11 / ロジック仕様書 17 の Step 0）。6STEPには数えない。
  const FIRST_LAUNCH_CHOICES = Object.freeze([
    Object.freeze({ see: true, label: "チュートリアルを見る" }),
    Object.freeze({ see: false, label: "見ない" }),
  ]);

  // 装備ボックスの絞り込み。ALL とレア度6種だけ。増やさない。
  const RARITY_FILTERS = Object.freeze(["ALL"].concat(RARITIES));

  // 撃破SEの選択肢。**実音源のぶんだけ**出す（AssetCatalog が正）。
  // 音源が増えればそのまま増える。ここで架空の選択肢を作らない。
  const CRITICAL_SOUND_CHOICES = Object.freeze(AssetCatalog.CRITICAL_SOUNDS.map((choice) => (
    Object.freeze({ id: choice.id, label: choice.label })
  )));

  // 撃破演出の選択肢。**中身はカタログが正**で、ここは名前を並べ直すだけ。
  const KILL_EFFECT_CHOICES = Object.freeze(AssetCatalog.BATTLE_KILL_EFFECTS.map((choice) => (
    Object.freeze({ id: choice.id, label: choice.label })
  )));

  // 5MISS後の追加判定の見せ方（ロジック仕様書 05）。
  // 通常5ターンの外なので、**TURN6とは呼ばない**。
  const EXTRA_LABELS = Object.freeze({
    RETRY_TURN: "5ターン目の再挑戦",
    EXTRA_ROLL: "EXTRA CHANCE",
    TRIGGER: "発動判定",
    TRIGGERED: "発動",
    NOT_TRIGGERED: "不発",
  });

  const BATTLE_LABELS = Object.freeze({
    tapHint: "タップ",
    critical: "CRITICAL!",
    miss: "MISS",
    remaining: "残りTURN",
    chance: "CRITICAL",
  });

  // クリアの一言。表記はこの2つで確定（企画書 / UI仕様書 04・12）。
  const ENDING_TITLES = Object.freeze({
    NORMAL: "ゲームクリア...？",
    TRUE: "ゲームクリア！！",
  });

  const SCREEN_TITLES = Object.freeze({
    FIRST_LAUNCH: "5ターン勇者",
    TUTORIAL: "あそびかた",
    HOME: "5ターン勇者",
    BATTLE_PREP: "バトル前",
    EQUIPMENT: "装備変更",
    OPTIONS: "オプション",
    GACHA: "ガチャ",
    ENCYCLOPEDIA: "敵図鑑",
    RECORD: "RECORD",
    ENDING: "記録",
    BATTLE: "バトル",
    WIN: "WIN",
    LOSE: "LOSE",
  });

  // 表記の言語。いまHOMEの文言だけが対象で、既定は日本語。
  // 増やすときはここへ1行足し、HOME_LABELS に同じキーを並べる。
  const LANGUAGES = Object.freeze([
    Object.freeze({ id: "ja", label: "日本語" }),
    Object.freeze({ id: "en", label: "English" }),
  ]);

  const DEFAULT_LANGUAGE = "ja";

  // HOMEのボタンと見出し。**同じキーを両方の言語が必ず持つ**（テストで見張る）。
  const HOME_LABELS = Object.freeze({
    ja: Object.freeze({
      battle: "バトル",
      backBattle: "裏バトル",
      special: "隠居した神",
      gacha: "ガチャ",
      equip: "装備",
      catalog: "図鑑",
      record: "RECORD",
      options: "オプション",
      ending: "記録を見る",
      diamonds: "ダイヤ",
      stage: "STAGE",
      // HOMEの入口をまとめたぶんの文言。中身の呼び方（裏バトル・隠居した神）は
      // データ側の名前として残し、**HOMEでの見せ方だけ**ここで変える。
      archive: "アーカイブ",
      modeTitle: "バトルモード",
      normal: "NORMAL",
      hard: "HARD",
      god: "GOD",
      locked: "未解放",
      back: "戻る",
    }),
    en: Object.freeze({
      battle: "BATTLE",
      backBattle: "HIDDEN BATTLE",
      special: "THE IDLE GOD",
      gacha: "GACHA",
      equip: "EQUIP",
      catalog: "CATALOG",
      record: "RECORD",
      options: "OPTION",
      ending: "SEE RECORD",
      diamonds: "GEMS",
      stage: "STAGE",
      archive: "ARCHIVE",
      modeTitle: "BATTLE MODE",
      normal: "NORMAL",
      hard: "HARD",
      god: "GOD",
      locked: "LOCKED",
      back: "BACK",
    }),
  });

  // ガチャの排出装備一覧。HOME_LABELS と同じ作りで、**同じキーを両方の言語が必ず持つ**。
  // 装備名と効果文は装備カタログが正で、ここには持たない（訳も現状は持たない）。
  const GACHA_LABELS = Object.freeze({
    ja: Object.freeze({
      title: "ガチャ",
      lead: "装備を手に入れて、勇者を強化しよう",
      // 引き方の文言。価格は gacha-catalog から来るので、ここには**数字を書かない**。
      single: "1回引く",
      ten: "10回引く",
      pool: "排出装備一覧",
      poolTitle: "排出装備一覧",
      owned: "所持済み",
      all: "すべて",
      rates: "提供割合",
      close: "閉じる",
      home: "HOMEへ戻る",
      back: "ガチャへ戻る",
      // 結果送り。途中は「次へ」、最後の1件と10連の一覧は「OK」。
      next: "次へ",
      ok: "OK",
      // 一覧の見出し。この画面は10連でしか出ないので、そう名乗る。
      summaryTitle: "10回ガチャ結果",
      // 宝箱の文言。ガチャの箱と戦闘で手に入れた宝箱で**同じもの**を使う。
      chestGot: "宝箱を手に入れた！",
      chestTap: "タップで開く",
      empty: "この絞り込みに合う装備はありません。",
      hint: "装備を選ぶと効果が出ます。",
    }),
    en: Object.freeze({
      title: "GACHA",
      lead: "GET EQUIPMENT AND POWER UP",
      single: "DRAW ×1",
      ten: "DRAW ×10",
      pool: "EQUIPMENT LIST",
      poolTitle: "EQUIPMENT LIST",
      owned: "OWNED",
      all: "ALL",
      rates: "DROP RATES",
      close: "CLOSE",
      home: "BACK TO HOME",
      back: "BACK TO GACHA",
      next: "NEXT",
      ok: "OK",
      summaryTitle: "10 DRAW RESULTS",
      chestGot: "TREASURE CHEST!",
      chestTap: "TAP TO OPEN",
      empty: "No equipment matches this filter.",
      hint: "Tap an item to see its effect.",
    }),
  });

  // 装備変更の「入れ先を決める」まわりの文言だけ。**画面の他の文字は今までどおり**で、
  // ここへ移すのは今回の操作（装備する／入れ替える枠を選ぶ／やめる）に関わる3つに絞る。
  const EQUIPMENT_LABELS = Object.freeze({
    ja: Object.freeze({
      equip: "装備する",
      replaceNotice: "入れ替える枠を選択してください",
      cancel: "キャンセル",
    }),
    en: Object.freeze({
      equip: "EQUIP",
      replaceNotice: "SELECT A SLOT TO REPLACE",
      cancel: "CANCEL",
    }),
  });

  // RECORDの文言。**数字は RecordState のもの**で、ここには見出しと単位だけを置く。
  // 回数は `{n}` を差し替えて使う（日本語は「57回」、英語は「×57」）。
  const RECORD_LABELS = Object.freeze({
    ja: Object.freeze({
      now: "現在までの記録",
      totalTaps: "総タップ数",
      totalCriticals: "総CRITICAL数",
      totalMisses: "総MISS数",
      totalDefeats: "総敗北数",
      totalKills: "総撃破数",
      gachaPullCount: "ガチャ回数",
      mostUsed: "最多使用装備",
      mostDefeated: "最も苦戦した敵",
      normalClear: "表クリア時の記録",
      trueClear: "最終クリア時の記録",
      locked: "LOCKED",
      normalLockedHint: "表10クリア後に記録されます",
      trueLockedHint: "最終クリア後に記録されます",
      missing: "記録なし",
      missingHint: "このクリア時の記録は保存されていません",
      clearEquipment: "クリア時の装備",
      noEquipment: "装備なし",
      none: "---",
      count: "{n}回",
    }),
    en: Object.freeze({
      now: "RECORD SO FAR",
      totalTaps: "TOTAL TAPS",
      totalCriticals: "CRITICALS",
      totalMisses: "MISSES",
      totalDefeats: "DEFEATS",
      totalKills: "KILLS",
      gachaPullCount: "GACHA PULLS",
      mostUsed: "MOST USED GEAR",
      mostDefeated: "TOUGHEST FOE",
      normalClear: "NORMAL CLEAR RECORD",
      trueClear: "FINAL CLEAR RECORD",
      locked: "LOCKED",
      normalLockedHint: "Recorded after clearing NORMAL 10",
      trueLockedHint: "Recorded after the final clear",
      missing: "NO RECORD",
      missingHint: "No clear-time record was saved.",
      clearEquipment: "EQUIPMENT AT CLEAR",
      noEquipment: "NO EQUIPMENT",
      none: "---",
      count: "×{n}",
    }),
  });

  // OPTIONの文言。見出しの SOUND / BATTLE EFFECT / SYSTEM は日本語でも英字のまま。
  // 選択肢の表記（08・SLASH・日本語/English）は CRITICAL_SOUND_CHOICES などが正で、ここには持たない。
  const OPTION_LABELS = Object.freeze({
    ja: Object.freeze({
      title: "オプション",
      sound: "SOUND",
      battleEffect: "BATTLE EFFECT",
      system: "SYSTEM",
      bgmVolume: "BGM音量",
      seVolume: "SE音量",
      criticalSound: "撃破時の効果音",
      preview: "試聴",
      killEffect: "撃破エフェクト",
      language: "言語 / Language",
      back: "戻る",
    }),
    en: Object.freeze({
      title: "OPTION",
      sound: "SOUND",
      battleEffect: "BATTLE EFFECT",
      system: "SYSTEM",
      bgmVolume: "BGM VOLUME",
      seVolume: "SE VOLUME",
      criticalSound: "KILL SOUND",
      preview: "PREVIEW",
      killEffect: "KILL EFFECT",
      language: "LANGUAGE",
      back: "BACK",
    }),
  });

  const ROUTE_LABELS = Object.freeze({
    normal: "バトル開始",
    back: "バトル（裏）開始",
    special: "SPECIAL「隠居した神」",
  });

  Object.assign(ns, {
    UiContent: Object.freeze({
      TUTORIAL_STEPS,
      FIRST_LAUNCH_CHOICES,
      RARITY_FILTERS,
      CRITICAL_SOUND_CHOICES,
      KILL_EFFECT_CHOICES,
      EXTRA_LABELS,
      BATTLE_LABELS,
      ENDING_TITLES,
      SCREEN_TITLES,
      ROUTE_LABELS,
      LANGUAGES,
      DEFAULT_LANGUAGE,
      HOME_LABELS,
      GACHA_LABELS,
      EQUIPMENT_LABELS,
      RECORD_LABELS,
      OPTION_LABELS,
    }),
  });
})(globalThis);
