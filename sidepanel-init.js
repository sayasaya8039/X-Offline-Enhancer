/**
 * Fallback check: if the ES module fails to load, show error message.
 * This must be a separate file (not inline) to comply with MV3 CSP.
 */
window.__xoeModuleLoaded = false;
setTimeout(function () {
  if (!window.__xoeModuleLoaded) {
    var el = document.getElementById('empty-state');
    var hint = el ? el.querySelector('.empty-hint') : null;
    if (hint) hint.textContent = 'スクリプトの読み込みに失敗しました。拡張機能をリロードしてください。';
  }
}, 3000);
