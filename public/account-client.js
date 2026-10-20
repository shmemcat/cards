let pendingSession;

export async function getSession() {
  if (!pendingSession) {
    pendingSession = fetch('/api/account/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || typeof data.csrf_token !== 'string') throw new Error(data.error || 'Unable to reach your account. Please try again.');
        return data;
      }).finally(() => { pendingSession = undefined; });
  }
  return pendingSession;
}

export async function accountRequest(path, data) {
  const session = await getSession();
  const response = await fetch('/api/account/' + path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token },
    body: JSON.stringify(data || {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Unable to update your account. Please try again.');
  if ('user' in result) document.dispatchEvent(new CustomEvent('cards:session', { detail: result }));
  return result;
}

export function paintAccount(session) {
  document.querySelectorAll('.nav-account').forEach(link => {
    const label = link.querySelector('span:last-child');
    if (label) label.textContent = session.user?.name || 'Guest';
    link.setAttribute('aria-label', session.user ? 'Your account' : 'Login and user settings');
  });
}
