(function (global) {
  'use strict';
  // Keep this grammar independent of CSS parsing: no URLs, variables, escapes,
  // comments, priorities, or additional declarations can become a color value.
  function color(value, document) {
    value = String(value || '').trim();
    if (!/^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/degturnrad]+\))$/i.test(value)) return '';
    if (/^(?:inherit|initial|unset|revert|revert-layer|currentcolor)$/i.test(value)) return '';
    const style = document.createElement('span').style;
    style.color = value;
    return style.color;
  }
  function foreground(node, document) {
    let result = '';
    for (const declaration of (node.getAttribute('style') || '').split(';')) {
      const match = /^\s*color\s*:\s*(.*?)\s*$/i.exec(declaration);
      if (match) result = color(match[1], document) || result;
    }
    return result || (node.nodeName === 'FONT' ? color(node.getAttribute('color'), document) : '');
  }
  function sanitize(html, purifier, document) {
    const colors = new WeakMap();
    const capture = node => {
      if (node.nodeName !== 'SPAN' && node.nodeName !== 'FONT') return;
      const value = foreground(node, document);
      if (value) colors.set(node, value);
    };
    purifier.addHook('uponSanitizeElement', capture);
    let fragment;
    try {
      fragment = purifier.sanitize(html, {
        FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button'],
        FORBID_ATTR: ['style', 'color'],
        RETURN_DOM_FRAGMENT: true
      });
    } finally { purifier.removeHook('uponSanitizeElement', capture); }
    // Restore only the single validated property on nodes that survived DOMPurify.
    // KaTeX and Prism render afterward, so their generated styles stay untouched.
    for (const node of fragment.querySelectorAll('span,font')) {
      const value = colors.get(node);
      if (value) { node.style.color = value; node.classList.add('notebook-foreground'); }
    }
    return fragment;
  }
  const api = Object.freeze({ sanitize });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.NotebookMarkdownColor = api;
})(typeof window !== 'undefined' ? window : globalThis);
