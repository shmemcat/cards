import { accountRequest, getSession, paintAccount } from '/account-client.js';
import { PROFILE_ICONS } from '/profile-icons.js';

const content = document.getElementById('account-content');
const params = new URLSearchParams(location.search);
const initialView = params.get('view');
let view = ['register', 'recover', 'reset', 'verify', 'resend'].includes(initialView) ? initialView : 'login';
let token = params.get('token') || '';
let session;
let busy = false;
let iconPickerOpen = false;
// Keep recovery tokens out of browser history and referrers after reading the email link.
if (params.has('token')) history.replaceState(null, '', '/user/');

const button = label => `<button class="account-button" type="submit"><span class="button-shine" aria-hidden="true"></span>${label}</button>`;
const input = (name, label, type, autocomplete, extra = '', placeholderOnly = false) => `<label>${placeholderOnly ? `<span class="sr-only">${label}</span>` : label}<input name="${name}" type="${type}" autocomplete="${autocomplete}" ${placeholderOnly ? `placeholder="${label}"` : ''} required ${extra}></label>`;
const link = (target, label) => `<a class="account-text-link" href="/user/${target === 'login' ? '' : `?view=${target}`}" data-view="${target}">${label}</a>`;

function notice(message, isError = false) {
  const status = content.querySelector('#account-status');
  status.textContent = message;
  status.setAttribute('role', isError ? 'alert' : 'status');
  status.classList.toggle('account-error', isError);
}

async function updateProfile(data) {
  if (busy) return;
  busy = true;
  const controls = [...content.querySelectorAll('button, input')].map(control => [control, control.disabled]);
  controls.forEach(([control]) => { control.disabled = true; });
  content.setAttribute('aria-busy', 'true');
  notice('');
  try {
    session = await accountRequest('profile', data, session.user.id);
    paintAccount(session);
    render();
    notice(session.message || 'Profile saved.');
  } catch (error) { notice(error.message, true); }
  finally {
    busy = false;
    controls.forEach(([control, disabled]) => { if (control.isConnected) control.disabled = disabled; });
    content.setAttribute('aria-busy', 'false');
  }
}

function showDeleteDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'account-delete-dialog';
  dialog.setAttribute('aria-labelledby', 'delete-title');
  dialog.innerHTML = '<h2 id="delete-title">Delete Account</h2><p>Are you sure? This deletes your shared account and saved user data across Cards, Hearts, and Euchre. This cannot be undone.</p><div class="account-actions"><button type="button" class="account-button account-button-danger" id="delete-yes">Yes</button><button type="button" class="account-button" id="delete-no">No</button></div>';
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.querySelector('#delete-no').addEventListener('click', () => dialog.close());
  dialog.querySelector('#delete-yes').addEventListener('click', () => {
    dialog.innerHTML = '<h2 id="delete-title">Confirm Deletion</h2><p>Enter your password to permanently delete your shared Cards account.</p><form class="account-form"><label>Password<input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label><p id="delete-status" class="account-note account-error" role="alert"></p><div class="account-actions"><button class="account-button account-button-danger" type="submit">Delete</button><button type="button" class="account-button" id="delete-cancel">Nevermind</button></div></form>';
    dialog.querySelector('input').focus();
    dialog.querySelector('#delete-cancel').addEventListener('click', () => dialog.close());
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const password = dialog.querySelector('input').value;
      if (!password) return;
      busy = true;
      const controls = dialog.querySelectorAll('button, input');
      controls.forEach(control => { control.disabled = true; });
      dialog.setAttribute('aria-busy', 'true');
      try {
        session = await accountRequest('delete', { password }, session.user.id);
        dialog.close();
        paintAccount(session);
        view = 'login';
        render();
        notice(session.message || 'Account deleted.');
      } catch (error) { dialog.querySelector('#delete-status').textContent = error.message; }
      finally { busy = false; controls.forEach(control => { control.disabled = false; }); dialog.setAttribute('aria-busy', 'false'); }
    });
  });
  dialog.showModal();
}

function renderSignedIn() {
  const currentKey = session.user.profile_icon === 'robot' ? 'user-robot' : session.user.profile_icon;
  const currentIcon = PROFILE_ICONS.find(icon => icon.key === currentKey) || PROFILE_ICONS.find(icon => icon.key === 'user');
  content.innerHTML = `<div class="account-profile"><p class="account-welcome"></p><h2>Profile Icon</h2><div class="iconPreview"><button type="button" class="iconPreviewCircle iconPreviewClickable" aria-label="Toggle icon picker" aria-expanded="${iconPickerOpen}" aria-controls="profile-picker">${currentIcon.svg}</button><span class="iconPreviewLabel"></span><span class="iconPreviewHint">${iconPickerOpen ? 'tap to close' : 'tap to change'}</span></div><div id="profile-picker" class="pickerContainer" ${iconPickerOpen ? '' : 'hidden'}><div class="pickerInner"></div></div><section class="emailSection"><h2>Email</h2><form class="emailRow"><label for="profile-email" hidden>Email address</label><input id="profile-email" name="email" type="email" autocomplete="email" aria-label="Email address" required maxlength="255"><button type="submit" class="emailSaveBtn" disabled>Save</button></form><p class="verificationStatus"></p></section><p id="account-status" class="account-note" role="status"></p><div class="account-actions"><button id="logout" class="account-button" type="button"><span class="button-shine" aria-hidden="true"></span>Sign Out</button><a class="account-button" href="/"><span class="button-shine" aria-hidden="true"></span>Home</a><button id="delete-account" class="account-button account-button-danger" type="button"><span class="button-shine" aria-hidden="true"></span>Delete Account</button></div></div>`;
  content.querySelector('.account-welcome').textContent = `Welcome ${session.user.name}!`;
  content.querySelector('.iconPreviewLabel').textContent = currentIcon.label;
  content.querySelector('.iconPreviewCircle').addEventListener('click', () => { iconPickerOpen = !iconPickerOpen; renderSignedIn(); content.querySelector('.iconPreviewCircle').focus(); });
  const picker = content.querySelector('.pickerInner');
  for (const category of [...new Set(PROFILE_ICONS.map(icon => icon.category))]) {
    const heading = document.createElement('h3');
    heading.className = 'categoryLabel';
    heading.textContent = category;
    const grid = document.createElement('div');
    grid.className = 'iconGrid';
    for (const icon of PROFILE_ICONS.filter(icon => icon.category === category)) {
      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'iconCell' + (icon.key === currentIcon.key ? ' iconCellActive' : '');
      control.setAttribute('aria-label', icon.label);
      control.setAttribute('aria-pressed', String(icon.key === currentIcon.key));
      control.innerHTML = icon.svg;
      control.addEventListener('click', () => void updateProfile({ profile_icon: icon.key }));
      grid.append(control);
    }
    picker.append(heading, grid);
  }
  const email = content.querySelector('#profile-email');
  email.value = session.user.email || '';
  email.addEventListener('input', () => { content.querySelector('.emailSaveBtn').disabled = email.value.trim().toLowerCase() === session.user.email.toLowerCase(); });
  content.querySelector('.emailRow').addEventListener('submit', event => { event.preventDefault(); void updateProfile({ email: email.value.trim() }); });
  const verification = content.querySelector('.verificationStatus');
  verification.textContent = session.user.email_verified ? '✓ Verified' : 'Not verified';
  verification.classList.add(session.user.email_verified ? 'verified' : 'notVerified');
  content.querySelector('#delete-account').addEventListener('click', showDeleteDialog);
  content.querySelector('#logout').addEventListener('click', async event => {
    if (busy) return;
    busy = true;
    const control = event.currentTarget;
    control.disabled = true;
    try { session = await accountRequest('logout'); paintAccount(session); render(); }
    catch (error) { control.disabled = false; notice(error.message, true); }
    finally { busy = false; }
  });
}

function render() {
  content.setAttribute('aria-busy', 'false');
  if (session?.user && view !== 'reset' && view !== 'verify') {
    renderSignedIn();
    return;
  }
  const titles = { login: 'Sign in', register: 'Create account', recover: 'Reset password', reset: 'New password', verify: 'Verify email', resend: 'Resend verification' };
  let fields = '';
  let action = '';
  let links = [];
  if (view === 'login') {
    fields = input('username', 'Username or email', 'text', 'username', 'maxlength="255" autocapitalize="none" spellcheck="false"', true) + input('password', 'Password', 'password', 'current-password', 'maxlength="1024"', true);
    action = 'Sign in';
    links = [link('recover', 'Forgot password?'), link('register', 'Create an account'), link('resend', 'Resend verification')];
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
  content.innerHTML = `${view === 'login' ? '' : `<h2 class="account-subtitle">${titles[view]}</h2>`}<form id="account-form" class="account-form" aria-label="${titles[view]}">${fields}${button(action)}</form><p id="account-status" class="account-note" role="status"></p><div class="account-links">${links.join('')}</div>`;
  content.querySelectorAll('[data-view]').forEach(control => control.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    view = control.dataset.view;
    history.replaceState(null, '', control.getAttribute('href'));
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
    const profileChanged = session?.user && next.user && (session.user.profile_icon !== next.user.profile_icon || session.user.email !== next.user.email);
    session = next;
    paintAccount(session);
    if (!content.querySelector('form') || identityChanged || profileChanged) render();
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
