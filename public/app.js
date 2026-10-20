const toggle = document.getElementById('theme-toggle');
const themeMeta = document.querySelector('meta[name="theme-color"]');

const themeIcon = toggle.querySelector('.theme-icon');
function bounceThemeIcon() {
  themeIcon.classList.remove('is-bouncing');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // Restart the same press bounce even when the theme is switched again quickly.
  void themeIcon.offsetWidth;
  themeIcon.classList.add('is-bouncing');
}
themeIcon.addEventListener('animationend', () => themeIcon.classList.remove('is-bouncing'));

function updateTheme(theme) {
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute('aria-label', `Use ${theme === 'dark' ? 'light' : 'dark'} theme`);
  themeMeta.content = theme === 'dark' ? '#191b22' : '#e6e8ed';
}

updateTheme(document.documentElement.dataset.theme);
toggle.hidden = false;
toggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  updateTheme(theme);
  bounceThemeIcon();
  try { localStorage.setItem('cards.theme.v1', JSON.stringify(theme)); } catch {}
});
window.addEventListener('storage', event => {
  if (event.key !== 'cards.theme.v1') return;
  try {
    const theme = JSON.parse(event.newValue);
    if (theme === 'light' || theme === 'dark') updateTheme(theme);
  } catch {}
});

import('/account-client.js').then(({ getSession, paintAccount }) => {
  const refreshAccount = () => getSession().then(paintAccount).catch(() => {});
  refreshAccount();
  window.addEventListener('focus', refreshAccount);
  window.addEventListener('pageshow', refreshAccount);
  document.addEventListener('cards:session', event => paintAccount(event.detail));
});
