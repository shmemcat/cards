import { accountRequest, getSession, paintAccount } from '/account-client.js';

const content = document.getElementById('account-content');
const params = new URLSearchParams(location.search);
const initialView = params.get('view');
let view = ['register', 'recover', 'reset', 'verify', 'resend'].includes(initialView) ? initialView : 'login';
let token = params.get('token') || '';
let session;
let busy = false;
// Keep recovery tokens out of browser history and referrers after reading the email link.
if (params.has('token')) history.replaceState(null, '', '/user/');

const button = label => `<button class="account-button" type="submit"><span class="button-shine" aria-hidden="true"></span>${label}</button>`;
const input = (name, label, type, autocomplete, extra = '') => `<label>${label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" required ${extra}></label>`;
const link = (target, label) => `<button type="button" class="account-text-link" data-view="${target}">${label}</button>`;

function notice(message, isError = false) {
  const status = content.querySelector('#account-status');
  status.textContent = message;
  status.setAttribute('role', isError ? 'alert' : 'status');
  status.classList.toggle('account-error', isError);
}

function render() {
  content.setAttribute('aria-busy', 'false');
  if (session?.user && view !== 'reset' && view !== 'verify') {
    content.innerHTML = `<h2 class="account-subtitle"></h2><p class="account-email"></p><div class="account-actions"><button id="logout" class="account-button" type="button"><span class="button-shine" aria-hidden="true"></span>Log out</button><a class="account-text-link" href="/">Home</a></div><p id="account-status" class="account-note" role="status"></p>`;
    content.querySelector('h2').textContent = `Hello, ${session.user.name}`;
    content.querySelector('.account-email').textContent = session.user.email || '';
    content.querySelector('#logout').addEventListener('click', async event => {
      const control = event.currentTarget;
      control.disabled = true;
      try { session = await accountRequest('logout'); render(); }
      catch (error) { control.disabled = false; notice(error.message, true); }
    });
    return;
  }
  const titles = { login: 'Sign in', register: 'Create account', recover: 'Reset password', reset: 'New password', verify: 'Verify email', resend: 'Resend verification' };
  let fields = '';
  let action = '';
  let links = [];
  if (view === 'login') {
    fields = input('username', 'Username or email', 'text', 'username', 'maxlength="255"') + input('password', 'Password', 'password', 'current-password', 'maxlength="1024"');
    action = 'Sign in';
    links = [link('recover', 'Forgot password?'), link('register', 'Create account'), link('resend', 'Resend verification')];
  } else if (view === 'register') {
    fields = input('username', 'Username', 'text', 'username', 'minlength="3" maxlength="64" pattern="[A-Za-z0-9_]{3,64}"') + input('email', 'Email', 'email', 'email', 'maxlength="255"') + input('password', 'Password', 'password', 'new-password', 'minlength="8" maxlength="1024"') + input('confirm', 'Confirm password', 'password', 'new-password', 'minlength="8" maxlength="1024"');
    action = 'Create account';
  } else if (view === 'recover' || view === 'resend') {
    fields = input('email', 'Email', 'email', 'email', 'maxlength="255"');
    action = 'Send link';
  } else if (view === 'reset') {
    fields = input('password', 'New password', 'password', 'new-password', 'minlength="8" maxlength="1024"') + input('confirm', 'Confirm password', 'password', 'new-password', 'minlength="8" maxlength="1024"');
    action = 'Save password';
  } else { action = 'Verify email'; }
  if (view !== 'login') links = [link('login', 'Back to sign in')];
  content.innerHTML = `<h2 class="account-subtitle">${titles[view]}</h2><form id="account-form" class="account-form">${fields}${button(action)}</form><p id="account-status" class="account-note" role="status"></p><div class="account-links">${links.join('')}</div>`;
  content.querySelectorAll('[data-view]').forEach(control => control.addEventListener('click', () => {
    view = control.dataset.view;
    render();
    content.querySelector('input')?.focus();
  }));
  if ((view === 'reset' || view === 'verify') && !token) {
    content.querySelector('[type="submit"]').disabled = true;
    notice('This link is missing its token. Request a new email link.', true);
  }
  content.querySelector('form').addEventListener('submit', submit);
}

async function submit(event) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  if ('confirm' in data && data.password !== data.confirm) { notice('The passwords do not match.', true); return; }
  delete data.confirm;
  busy = true;
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  content.setAttribute('aria-busy', 'true');
  notice('');
  try {
    const endpoint = { login: 'login', register: 'register', recover: 'forgot-password', reset: 'reset-password', verify: 'verify-email', resend: 'resend-verification' }[view];
    if (view === 'reset' || view === 'verify') data.token = token;
    const result = await accountRequest(endpoint, data);
    if (view === 'login') {
      session = result;
      render();
    } else {
      if (view === 'reset' || view === 'verify') { token = ''; view = 'login'; }
      if (view === 'register') view = 'login';
      render();
      notice(result.message);
    }
  } catch (error) {
    notice(error.message, true);
    form.querySelectorAll('[type="password"]').forEach(field => { field.value = ''; });
  } finally {
    busy = false;
    if (submitButton.isConnected) submitButton.disabled = false;
    content.setAttribute('aria-busy', 'false');
  }
}

async function refresh() {
  if (busy) return;
  try {
    const next = await getSession();
    const identityChanged = session && session.user?.id !== next.user?.id;
    session = next;
    paintAccount(session);
    if (!content.querySelector('form') || identityChanged) render();
  } catch (error) {
    if (!session) {
      content.innerHTML = '<p id="account-status" class="account-note" role="alert"></p><button class="account-text-link" id="retry" type="button">Try again</button>';
      content.setAttribute('aria-busy', 'false');
      notice(error.message, true);
      content.querySelector('#retry').addEventListener('click', refresh);
    }
  }
}
await refresh();
window.addEventListener('focus', refresh);
