// Read the shared preference before paint; storage can be unavailable in private browsers.
(() => {
  let theme;
  try {
    const saved = JSON.parse(localStorage.getItem('cards.theme.v1') ?? 'null');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch {}
  document.documentElement.dataset.theme = theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
})();
