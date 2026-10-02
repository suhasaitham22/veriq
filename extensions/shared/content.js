// content.js — runs on every page. Exposes the page's main text for the popup.
// (v0.2: readability-style extraction, selected-text verification.)
(() => {
  const article = document.querySelector("article");
  const root = article || document.body;
  window.__veriqText = root.innerText.slice(0, 20000);
})();
