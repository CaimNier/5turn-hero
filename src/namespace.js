(function (global) {
  "use strict";

  // 「5ターン勇者」の名前空間。既存のワンオペパズラー（global.GameCore）とは完全に別にする。
  // 以降のsrcはすべて、末尾で Object.assign(global.FiveTurnHero, { ... }) して公開する。
  // scriptタグ方式なので読み込み順が依存順。順序の正は tests/test-runner.html の並び。
  global.FiveTurnHero = global.FiveTurnHero || {};
})(globalThis);
