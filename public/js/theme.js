/*
 * Theme is applied to <html> before this file loads (see the inline
 * head script on each page) to avoid a flash of the wrong theme.
 * This module only wires up the toggle button and keeps its icon in sync.
 */
const Theme = (() => {
  const KEY = 'ipmcs_theme';

  function current() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-toggle i').forEach(icon => {
      icon.className = theme === 'light' ? 'ti ti-moon' : 'ti ti-sun';
    });
  }

  function toggle() {
    const next = current() === 'light' ? 'dark' : 'light';
    localStorage.setItem(KEY, next);
    apply(next);
  }

  function init() {
    apply(current());
    document.querySelectorAll('.theme-toggle').forEach(btn => btn.addEventListener('click', toggle));
  }

  return { init, toggle };
})();

document.addEventListener('DOMContentLoaded', Theme.init);
