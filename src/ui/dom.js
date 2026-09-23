(function (global) {
  "use strict";

  const ns = global.FiveTurnHero;

  // DOMを組み立てる最小の道具。読み込んだだけでは document を触らない
  //（Nodeのテストでも安全に読み込めるようにするため）。

  function el(tag, options = {}) {
    const node = global.document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.id) node.id = options.id;
    if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
    if (options.attrs) {
      Object.keys(options.attrs).forEach((name) => node.setAttribute(name, options.attrs[name]));
    }
    if (options.onClick) node.addEventListener("click", options.onClick);
    (options.children || []).forEach((child) => {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function button(label, onClick, options = {}) {
    return el("button", Object.assign({ text: label, onClick, attrs: { type: "button" } }, options));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // 画面の外枠。どの画面も同じ形（見出し + 中身）で作る。
  function screen(name, children) {
    return el("section", { className: "screen", attrs: { "data-screen": name }, children });
  }

  Object.assign(ns, { Dom: Object.freeze({ el, button, clear, screen }) });
})(globalThis);
