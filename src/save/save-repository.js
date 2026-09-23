(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;
  const { SaveData } = ns;

  // 保存先。localStorage が使えればそれ、駄目ならメモリ。
  // 形はリポジトリ直下のワンオペパズラー（src/save-manager.js）に合わせてある。
  // 読めない・書けない環境でもゲームを止めない。
  //
  // キーは5ターン勇者専用。**既存ゲームの `onepaz.save.v1` には触らない。**

  const SAVE_KEY = "fiveTurnHero.save.v1";
  const PROBE_KEY = "fiveTurnHero.probe";

  // localStorage が無い／使えない環境（Node実行・file://の制限）でも動くための入れ物。
  class MemoryStorage {
    constructor() {
      this.values = {};
    }

    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
    }

    setItem(key, value) {
      this.values[key] = String(value);
    }

    removeItem(key) {
      delete this.values[key];
    }
  }

  // 使えるなら localStorage、駄目なら MemoryStorage。例外を投げる環境でも起動を止めない。
  function defaultStorage() {
    try {
      const store = global.localStorage;
      if (!store) return new MemoryStorage();
      store.setItem(PROBE_KEY, "1");
      store.removeItem(PROBE_KEY);
      return store;
    } catch (error) {
      return new MemoryStorage();
    }
  }

  class SaveRepository {
    constructor({ storage = null, key = SAVE_KEY } = {}) {
      this.storage = storage || defaultStorage();
      this.key = key;
      // 二重セーブが起きていないかを見るための数え。
      this.saveCount = 0;
      this.loadCount = 0;
      // 最後にどの区切りで保存したか（ロジック仕様書 16 の発火点）。
      this.lastTrigger = null;
    }

    // 確定した状態だけを書く。戦闘の途中（RESOLVING・乱数の途中）は保存しない。
    save(gameState, { trigger = null } = {}) {
      const data = SaveData.serializeGameState(gameState);
      try {
        this.storage.setItem(this.key, JSON.stringify(data));
      } catch (error) {
        // 保存できなくてもゲームは止めない。次の発火点で書き直される。
        return null;
      }
      this.saveCount += 1;
      this.lastTrigger = trigger;
      return data;
    }

    // 生のまま読む。壊れていれば null。
    read() {
      let raw = null;
      try {
        raw = this.storage.getItem(this.key);
      } catch (error) {
        return null;
      }
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (error) {
        return null;
      }
    }

    hasSave() {
      const data = this.read();
      return SaveData.migrate(data) !== null;
    }

    // 遊べる状態にして返す。セーブが無ければ既定の状態（＝初回起動）。
    // 壊れていても落とさず、直した所を repaired で知らせる。
    load() {
      const data = this.read();
      const restored = SaveData.restoreGameState(data);
      if (data !== null) this.loadCount += 1;
      return Object.freeze({
        gameState: restored.gameState,
        repaired: restored.repaired,
        legacy: restored.legacy,
        hadSave: data !== null,
        data,
      });
    }

    // テストと NEW GAME 用。消せない環境では黙って諦める。
    clear() {
      try {
        this.storage.removeItem(this.key);
      } catch (error) {
        // 消せない環境では何もしない。
      }
      return true;
    }
  }

  Object.assign(ns, {
    SAVE_KEY,
    MemoryStorage,
    defaultStorage,
    SaveRepository,
  });
})(globalThis);
