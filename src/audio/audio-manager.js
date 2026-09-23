(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { AssetCatalog, SeededRandom } = ns;

  // 音を鳴らす唯一の場所。画面のあちこちで `new Audio()` しない。
  //
  // 音源が無くても「どの場面でどのIDをどの音量で鳴らそうとしたか」は Adapter に届くので、
  // 配線の正しさはテストで確かめられる（音源を置けばそのまま鳴る）。
  //
  // チャージ音の抽選にはここが持つ**演出専用の乱数**を使う。
  // ゲーム判定用の RandomService（BattleSession へ渡すもの）とは別インスタンスで、
  // 音のために1回でも消費すると CRITICAL/MISS や装備RANDOMの系列がずれるため、
  // 絶対に共有しない。
  //
  // 音量はここでは常に 0〜1（Save の表現）。0〜100 は画面の都合なので、
  // 変換は percentToVolume / volumeToPercent の2つだけに集める。

  const CHANNELS = Object.freeze({ BGM: "BGM", SE: "SE" });

  function clampVolume(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  // 音の出口。既定は「何もしない」。テストでは記録するものへ差し替える。
  class AudioAdapter {
    // request: { channel, key, src, volume, loop }
    play() { return false; }
    pause() {}
    resume() {}
    stop() {}
    setVolume() {}
  }

  // 実ブラウザ / iOS WebView 用。**例外と Promise rejection を外へ出さない**のが仕事。
  // autoplay制限で play() が拒否されても、アプリは何事もなく動き続ける。
  class HtmlAudioAdapter extends AudioAdapter {
    constructor(AudioConstructor) {
      super();
      this.AudioConstructor = AudioConstructor || null;
      // キーごとに1つ使い回す。SEは鳴り直し、BGMはループ。
      this.nodes = new Map();
      this.current = new Map();
      // いま鳴っているもの（チャネルごと）。SEは重なるので複数持つ。
      this.active = new Map();
      // ended の受け口。付けっぱなしにしないよう node ごとに1つだけ持つ。
      this.endedHandlers = new Map();
    }

    node(key, src) {
      if (this.nodes.has(key)) return this.nodes.get(key);
      if (!this.AudioConstructor || !src) return null;
      let created = null;
      try {
        created = new this.AudioConstructor(src);
        created.preload = "auto";
      } catch (error) {
        created = null; // 音が作れなくても止まらない
      }
      this.nodes.set(key, created);
      return created;
    }

    play({ channel, key, src, volume, loop, onEnded = null }) {
      const node = this.node(key, src);
      if (!node) return false;
      // 前に付けた受け口は必ず外す（試聴を連打しても溜まらない）。
      this.detachEnded(node);
      // 「鳴り終わった」の合図。**404・読込失敗・autoplay拒否も同じ合図にする。**
      // 待っている側（戦闘の演出）は、音が終わったのか鳴らなかったのかを気にせず前へ進める。
      let notify = null;
      if (onEnded) {
        let done = false;
        notify = () => {
          if (done) return;
          done = true;
          this.detachEnded(node);
          onEnded();
        };
        const handlers = { ended: notify, error: notify };
        this.endedHandlers.set(node, handlers);
        try {
          node.addEventListener("ended", handlers.ended);
          node.addEventListener("error", handlers.error);
        } catch (error) { /* 無視 */ }
      }
      // BGMは1本だけ。別の曲が鳴っていたら**先に止めてから**差し替える
      // （これをしないと前の曲が鳴りっぱなしになり、BGMが重なる）。
      // SEは重なってよい（箱を開ける音・演出の音・装備が出る音は同時に鳴る）。
      if (channel === CHANNELS.BGM) {
        const previous = this.current.get(channel);
        if (previous && previous !== node) {
          try {
            previous.pause();
            previous.currentTime = 0;
          } catch (error) { /* 読み込み前など。無視する */ }
        }
      }
      if (!this.active.has(channel)) this.active.set(channel, new Set());
      this.active.get(channel).add(node);
      try {
        node.loop = Boolean(loop);
        node.volume = clampVolume(volume);
        node.currentTime = 0;
      } catch (error) {
        // currentTime を触れない状態（読み込み前など）でも続行する。
      }
      this.current.set(channel, node);
      try {
        const played = node.play();
        // iOS/Safari/Chrome の autoplay制限。拒否されても握りつぶし、
        // 待っている側へは「終わった」と伝える（無音のまま先へ進む）。
        if (played && typeof played.catch === "function") {
          played.catch(() => { if (notify) notify(); });
        }
      } catch (error) {
        if (notify) notify();
        return false;
      }
      return true;
    }

    // ended / error の受け口を外す。
    detachEnded(node) {
      const handlers = this.endedHandlers.get(node);
      if (!handlers) return;
      this.endedHandlers.delete(node);
      try {
        node.removeEventListener("ended", handlers.ended);
        node.removeEventListener("error", handlers.error);
      } catch (error) { /* 無視 */ }
    }

    pause(channel) {
      const node = this.current.get(channel);
      if (!node) return;
      try { node.pause(); } catch (error) { /* background復帰時など。無視する */ }
    }

    resume(channel) {
      const node = this.current.get(channel);
      if (!node) return;
      try {
        const played = node.play();
        if (played && typeof played.catch === "function") played.catch(() => {});
      } catch (error) { /* 無視 */ }
    }

    // そのチャネルで鳴っているものを**全部**止める。
    // SEは重なりうるので、最後の1本だけ止めても取りこぼす。
    stop(channel) {
      const playing = this.active.get(channel);
      if (playing) {
        playing.forEach((node) => {
          this.detachEnded(node);
          try {
            node.pause();
            node.currentTime = 0;
          } catch (error) { /* 無視 */ }
        });
        playing.clear();
      }
      this.current.delete(channel);
    }

    setVolume(channel, volume) {
      const playing = this.active.get(channel);
      const nodes = playing && playing.size > 0 ? playing : new Set([this.current.get(channel)]);
      nodes.forEach((node) => {
        if (!node) return;
        try { node.volume = clampVolume(volume); } catch (error) { /* 無視 */ }
      });
    }

    // その音の実尺（ms）。まだ読み込めていなければ null。
    durationMs(key) {
      const node = this.nodes.get(key);
      if (!node) return null;
      const seconds = node.duration;
      return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
    }
  }

  // テスト用。実際には鳴らさず、呼ばれ方だけを記録する。
  // 音源が無くても「何回・どのID・どの音量で鳴らそうとしたか」を検証できる。
  class FakeAudioAdapter extends AudioAdapter {
    constructor() {
      super();
      this.plays = [];
      this.pauses = [];
      this.resumes = [];
      this.stops = [];
      this.volumes = [];
    }

    play(request) {
      this.plays.push(Object.freeze(Object.assign({}, request)));
      return true;
    }

    pause(channel) { this.pauses.push(channel); }
    resume(channel) { this.resumes.push(channel); }
    stop(channel) { this.stops.push(channel); }
    setVolume(channel, volume) { this.volumes.push(Object.freeze({ channel, volume })); }

    playsOn(channel) { return this.plays.filter((play) => play.channel === channel); }
    playsOf(key) { return this.plays.filter((play) => play.key === key); }

    // テスト用。最後に鳴らした音が「鳴り終わった」ことにする。
    endLast() {
      const last = this.plays[this.plays.length - 1];
      if (!last || typeof last.onEnded !== "function") return false;
      last.onEnded();
      return true;
    }
  }

  class AudioManager {
    constructor({ adapter = null, catalog = null, presentationRandom = null } = {}) {
      this.catalog = catalog || AssetCatalog;
      this.adapter = adapter || AudioManager.createDefaultAdapter();
      // 演出専用の乱数。**ゲーム判定用とは別インスタンス。**
      // テストからは固定seedのものを渡せる。
      this.presentationRandom = presentationRandom || new SeededRandom();
      this.bgmVolume = 1;
      this.seVolume = 1;
      this.criticalSoundId = null;
      // 最初のユーザー操作が来るまでBGMを鳴らしにいかない（autoplay制限）。
      this.unlocked = false;
      this.pendingBgmKey = null;
      this.currentBgmKey = null;
      this.suspended = false;
    }

    // 実行環境に Audio があれば使う。Node（テスト）には無いので無音のまま動く。
    static createDefaultAdapter() {
      return typeof global.Audio === "function"
        ? new HtmlAudioAdapter(global.Audio)
        : new AudioAdapter();
    }

    // 0〜1（Save）と 0〜100（画面）の変換はこの2つだけ。
    static percentToVolume(percent) { return clampVolume(Number(percent) / 100); }
    static volumeToPercent(volume) { return Math.round(clampVolume(volume) * 100); }

    // --- 設定 -----------------------------------------------------------------

    // 復元直後とOptions変更時に呼ぶ。SaveData の options をそのまま渡す。
    applyOptions(options = {}) {
      if (options.bgmVolume !== undefined) this.setBgmVolume(options.bgmVolume);
      if (options.seVolume !== undefined) this.setSeVolume(options.seVolume);
      if (options.criticalSoundId !== undefined) this.setCriticalSound(options.criticalSoundId);
      return this.getState();
    }

    setBgmVolume(volume) {
      this.bgmVolume = clampVolume(volume);
      this.adapter.setVolume(CHANNELS.BGM, this.bgmVolume);
      return this.bgmVolume;
    }

    setSeVolume(volume) {
      this.seVolume = clampVolume(volume);
      this.adapter.setVolume(CHANNELS.SE, this.seVolume);
      return this.seVolume;
    }

    setCriticalSound(soundId) {
      this.criticalSoundId = soundId === undefined ? null : soundId;
      return this.criticalSoundId;
    }

    getState() {
      return Object.freeze({
        bgmVolume: this.bgmVolume,
        seVolume: this.seVolume,
        criticalSoundId: this.criticalSoundId,
        unlocked: this.unlocked,
        suspended: this.suspended,
        currentBgmKey: this.currentBgmKey,
      });
    }

    // --- autoplay -------------------------------------------------------------

    // 最初のユーザー操作で1回だけ。待たせていたBGMがあればここで鳴らす。
    unlock() {
      if (this.unlocked) return false;
      this.unlocked = true;
      if (this.pendingBgmKey) {
        const key = this.pendingBgmKey;
        this.pendingBgmKey = null;
        this.startBgm(key);
      }
      return true;
    }

    // --- 再生 -----------------------------------------------------------------

    // 鳴らそうとした事実は必ず Adapter へ渡す（音源が無ければ Adapter 側が黙る）。
    playSound({ channel, soundKey, volume, loop = false, onEnded = null }) {
      const asset = this.catalog.getSound(soundKey);
      return this.adapter.play({
        channel,
        key: soundKey,
        src: asset.src,
        volume: clampVolume(volume),
        loop,
        onEnded,
      });
    }

    playSe(soundKey, onEnded = null) {
      return this.playSound({ channel: CHANNELS.SE, soundKey, volume: this.seVolume, onEnded });
    }

    // そのタップのチャージ音を1つ選ぶ。**結果は選ばない。**
    // outcome（CRITICAL / MISS）は BattleSession がもう確定させたものを受け取るだけで、
    // ここから戦闘の判定へ戻ることはない。乱数は演出専用のものを1つ消費する。
    pickChargeSound(outcome) {
      const id = this.presentationRandom.pickWeighted(this.catalog.getChargeWeights(outcome));
      return this.catalog.getChargeSound(id);
    }

    // タップのチャージ音（UI仕様書 04）。MISSでは別の音を足さない。
    // 結果を渡すと重み付きで選ぶ。渡さなければ既定の1本（Phase 13 の呼び方も通る）。
    //
    // 返り値には**溜め演出に必要なものを全部載せる**。View はこれだけを見て
    // 敵の絵を寄せるので、秒数も倍率も画面側には書かない。
    // zoomMs は実尺が取れたらそれを使い、取れなければカタログの目安。
    playChargeSe(outcome = null, onEnded = null) {
      const choice = outcome ? this.pickChargeSound(outcome) : this.catalog.getChargeSound(null);
      const played = this.playSe(choice.soundKey, onEnded);
      const actual = played && typeof this.adapter.durationMs === "function"
        ? this.adapter.durationMs(choice.soundKey)
        : null;
      this.lastChargeSound = Object.freeze({
        id: choice.id,
        soundKey: choice.soundKey,
        played,
        zoomScale: choice.zoomScale,
        zoomMs: actual || choice.zoomMs,
      });
      return this.lastChargeSound;
    }

    // 外した瞬間の音。**MISSのときだけ**で、CRITICALでも撃破でも鳴らさない。
    // チャージ音とは別の音源で、鳴り終わりは待たない（演出だけの音）。
    playMissSe() {
      return this.playSe(this.catalog.getMissSound());
    }

    // 撃破SE。選択中のIDに対応する音源を鳴らす（AC-191）。
    playCriticalSe() {
      return this.playSe(this.catalog.getCriticalSound(this.criticalSoundId).soundKey);
    }

    // --- ガチャの音 -----------------------------------------------------------
    //
    // 戦闘の Charge / Critical とは**別系統**。互いに流用しない。
    // どれも「その場面で1回」で、鳴らす音の決め方は Asset Catalog が持つ。
    // 3つは時間的に重なってよい（箱 → 演出 → 装備が出る、の順に重なる）。

    // 宝箱を開けた瞬間。木・赤・バトルは basic、金・虹は high。
    playGachaChestSe(chestType) {
      return this.playSe(this.catalog.getChestOpenSound(chestType));
    }

    // 演出スプライトと同時。N / R は演出が無いので鳴らさない。
    playGachaEffectSe(rarity) {
      const effect = this.catalog.getGachaEffect(rarity);
      if (!effect || !effect.soundKey) return false;
      return this.playSe(effect.soundKey);
    }

    // 箱が昇格した瞬間（木箱LEGEND → 虹箱）。**開封SEとは別の音**で、
    // 昇格のある組み合わせでしか鳴らない。鳴り終わりは待たない（演出だけの音）。
    playGachaPromotionSe(rarity, chestType) {
      const promotion = this.catalog.getChestPromotion(rarity, chestType);
      if (!promotion || !promotion.soundKey) return false;
      return this.playSe(promotion.soundKey);
    }

    // 装備が出た瞬間。N / R は鳴らさない。SR と SSR は同じ音。
    //
    // onEnded を渡すと鳴り終わりを知らせる。**404・読込失敗・autoplay拒否も同じ合図**
    // なので（HtmlAudioAdapter の notify）、待っている側が永久に待たされることはない。
    playGachaItemSe(rarity, onEnded = null) {
      const soundKey = this.catalog.getGachaItemSound(rarity);
      if (!soundKey) return false;
      return this.playSe(soundKey, onEnded);
    }

    // Optionsの試聴。**ゲームの判定でも記録でもない**ので、戦闘側には一切触れない。
    // 連打しても重ならないよう、鳴っているSEを止めてから鳴らし直す。
    previewCriticalSe(soundId) {
      this.stopSe();
      return this.playSe(this.catalog.getCriticalSound(soundId).soundKey);
    }

    // 鳴っているSEを止める。次の戦闘や画面へ古い音を持ち越さないための出口。
    stopSe() {
      this.adapter.stop(CHANNELS.SE);
    }

    // --- BGM ------------------------------------------------------------------

    // 音源が無ければ何も鳴らないが、呼び出しは成立する。
    //
    // すでに同じ曲が鳴っているなら**何もしない**。画面を移るたびに
    // 同じBGMが頭から鳴り直すのを防ぐ（HOME→装備→ガチャ→HOME で切れない）。
    playBgm(soundKey) {
      if (this.isPlayingBgm(soundKey)) return false;
      if (!this.unlocked) {
        this.pendingBgmKey = soundKey; // 最初の操作まで待つ
        return false;
      }
      return this.startBgm(soundKey);
    }

    // 「もうその曲になっている」か。解禁前は待たせている曲で見る。
    isPlayingBgm(soundKey) {
      if (!soundKey) return false;
      if (!this.unlocked) return this.pendingBgmKey === soundKey;
      return this.currentBgmKey === soundKey && !this.suspended;
    }

    startBgm(soundKey) {
      this.currentBgmKey = soundKey;
      this.suspended = false;
      return this.playSound({
        channel: CHANNELS.BGM,
        soundKey,
        volume: this.bgmVolume,
        // 勝利・敗北は1回きり。どれをループさせるかは Asset Catalog が決める。
        loop: this.catalog.isBgmLooping(soundKey),
      });
    }

    stopBgm() {
      this.currentBgmKey = null;
      this.pendingBgmKey = null;
      this.suspended = false;
      this.adapter.stop(CHANNELS.BGM);
    }

    // アプリが背面へ回った。BGMは止める。SEは途中でも復帰させない。
    suspend() {
      if (this.suspended) return false;
      this.suspended = true;
      this.adapter.pause(CHANNELS.BGM);
      return true;
    }

    // 前面へ戻った。鳴っていたBGMがあれば続きから。
    resume() {
      if (!this.suspended) return false;
      this.suspended = false;
      if (this.currentBgmKey && this.unlocked) this.adapter.resume(CHANNELS.BGM);
      return true;
    }
  }

  Object.assign(ns, {
    AudioAdapter,
    HtmlAudioAdapter,
    FakeAudioAdapter,
    AudioManager: Object.assign(AudioManager, { CHANNELS }),
  });
})(globalThis);
