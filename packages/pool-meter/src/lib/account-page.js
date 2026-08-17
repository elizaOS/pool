'use strict';
// account-page.js — the /account dashboard. Same shell + visual language as
// join-page.js. All state is fetched by the page from cookie-authenticated
// endpoints AFTER load; the HTML itself is static and identical for every
// visitor, so nothing user-specific (and certainly no secret) is ever baked
// into markup, caches, or view-source.
//
// The Steward browser SDK is loaded as a pinned ES module. The passkey
// ceremony runs entirely between the browser and Steward; this page only ever
// posts the resulting short-lived credential to /account/session once.

const page = require('./join-page.js');

const SDK_URL = 'https://esm.sh/@stwd/sdk@0.11.0';

function accountPage({ stewardBase, tenant }) {
  const body = `
<div class="card" id="loginCard">
<h2>sign in</h2>
<p class="muted">Your pool account is your <b>Eliza Cloud</b> account — one identity across
cloud and pool. First time on this device? You'll get a 6-digit email code, then a passkey is
created here — no password, ever.</p>
<div style="display:flex;flex-direction:column;gap:10px;max-width:420px">
<input id="email" type="email" placeholder="you@example.com" autocomplete="email"
  style="background:#0d1117;border:1px solid #26262a;color:inherit;border-radius:8px;padding:10px 12px;font:inherit">
<button class="primary" id="passkeyBtn">Continue</button>
<div id="otpRow" style="display:none;gap:8px">
<input id="otpCode" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" maxlength="6"
  style="flex:1;background:#0d1117;border:1px solid #26262a;color:inherit;border-radius:8px;padding:10px 12px;font:inherit">
<button class="primary" id="otpBtn" style="width:auto">verify</button>
</div>
<span id="loginErr" style="color:#f0883e"></span>
<span id="loginMsg" class="muted"></span>
</div>
</div>

<div id="dash" style="display:none">
<div class="card">
<h2>signed in</h2>
<div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
<span id="who" class="muted"></span>
<button class="ghost" id="logoutBtn" style="width:auto">sign out</button>
</div>
</div>

<div class="card">
<h2>usage across your keys</h2>
<div id="usage" class="muted">loading&hellip;</div>
</div>

<div class="card">
<h2>your donated seats</h2>
<div id="seats" class="muted">loading&hellip;</div>
<p style="margin-bottom:0"><a href="/join">donate another account &rarr;</a>
<span class="muted" style="font-size:12px">(sign-in is the only gate; a seat donated while signed
in attaches to this account automatically)</span></p>
</div>

<div class="card">
<h2>your keys</h2>
<div id="keys" class="muted">loading&hellip;</div>
</div>

<div class="card">
<h2>claim an existing key</h2>
<p class="muted" style="font-size:13px">Minted a key before accounts existed? Paste it once to
attach it to this identity. The key itself keeps working either way and is never shown again.</p>
<div style="display:flex;gap:8px;max-width:520px">
<input id="claimKey" type="password" placeholder="sk-pool-..." autocomplete="off"
  style="flex:1;background:#0d1117;border:1px solid #26262a;color:inherit;border-radius:8px;padding:10px 12px;font:inherit">
<button class="ghost" id="claimBtn" style="width:auto">claim</button>
</div>
<span id="claimMsg" class="muted"></span>
</div>
</div>

<script type="module">
const STEWARD_BASE = ${JSON.stringify(stewardBase)};
const TENANT = ${JSON.stringify(tenant)};
const $ = (id) => document.getElementById(id);
let auth = null;

async function postJSON(url, body) {
  const r = await fetch(url, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, data: await r.json().catch(() => null) };
}

function fmt(n) { return (typeof n === 'number' ? n : 0).toLocaleString('en-US'); }
function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }

function render(acct) {
  $('loginCard').style.display = 'none';
  $('dash').style.display = '';
  $('who').textContent = acct.email || acct.userId;

  const u = acct.usage || {};
  $('usage').innerHTML =
    '<table><tbody>' +
    '<tr><td>effective tokens used</td><td class="num">' + fmt(u.used) + '</td></tr>' +
    '<tr><td>total quota</td><td class="num">' + fmt(u.quota) + '</td></tr>' +
    '<tr><td>remaining</td><td class="num">' + fmt(u.remaining) + '</td></tr>' +
    '<tr><td>spend at list pricing</td><td class="num">' + esc(u.spentDisplay || '$0') + '</td></tr>' +
    '</tbody></table>' +
    '<p class="muted" style="font-size:12px;margin-bottom:0">summed across ' + fmt(acct.keys ? acct.keys.length : 0) + ' key(s). quota is cost-weighted effective tokens.</p>';

  $('seats').innerHTML = (acct.seats && acct.seats.length)
    ? '<table><thead><tr><th>seat</th><th>provider</th><th>weekly contribution</th><th>status</th></tr></thead><tbody>' +
      acct.seats.map((s) =>
        '<tr><td>' + esc(s.label) + '</td><td>' + esc(s.provider || '') + '</td><td class="num">' +
        (s.contributedPct == null ? '&mdash;' : esc(String(s.contributedPct)) + '%') + '</td><td>' +
        (s.live ? '<span class="pill">in pool</span>' : '<span class="muted">not seen</span>') + '</td></tr>').join('') +
      '</tbody></table>'
    : '<span class="muted">no donated seats attached to this account yet.</span>';

  $('keys').innerHTML = (acct.keys && acct.keys.length)
    ? '<table><thead><tr><th>label</th><th>tier</th><th>used</th><th>quota</th><th>state</th></tr></thead><tbody>' +
      acct.keys.map((k) =>
        '<tr><td><code>' + esc(k.label) + '</code></td><td>' + esc(k.tier || '') + '</td><td class="num">' + fmt(k.used) +
        '</td><td class="num">' + fmt(k.quota) + '</td><td>' + (k.enabled ? 'active' : '<span class="muted">disabled</span>') + '</td></tr>').join('') +
      '</tbody></table>' +
      '<p class="muted" style="font-size:12px;margin-bottom:0">key secrets are shown exactly once at mint and never again. revocation stays at <a href="/join/revoke">/join/revoke</a> for now.</p>'
    : '<span class="muted">no keys attached yet. claim one below or <a href="/join">donate a seat</a>.</span>';
}

async function boot() {
  const { status, data } = await postJSON('/account/whoami', {});
  if (status === 200 && data && data.ok) render(data.account);
}

async function loadAuth() {
  if (auth) return auth;
  const { StewardAuth } = await import(${JSON.stringify(SDK_URL)});
  auth = new StewardAuth({ baseUrl: STEWARD_BASE, tenantId: TENANT });
  return auth;
}

// Hand the freshly-minted Steward credential to pool-meter exactly once.
// Prefer the signed identity token; fall back to the access token, which the
// server verifies by introspection against Steward. Both fail closed.
async function establishPoolSession() {
  let idToken = null;
  try { const r = await auth.getIdentityToken(); idToken = r && r.token; } catch (_) {}
  const accessToken = auth.getToken && auth.getToken();
  const { status, data } = await postJSON('/account/session', { idToken, accessToken });
  if (status !== 200 || !data || !data.ok) {
    throw new Error((data && data.error) || ('sign-in failed (' + status + ')'));
  }
  render(data.account);
}

// Existing-passkey path. Steward's smart flow only completes without an email
// grant when this device already has a passkey for this RP; anything else
// (new user, or an Eliza Cloud user whose passkey is bound to elizacloud.ai)
// falls through to the email-code path below.
$('passkeyBtn').addEventListener('click', async () => {
  $('loginErr').textContent = ''; $('loginMsg').textContent = '';
  const email = $('email').value.trim();
  if (!email) { $('loginErr').textContent = 'enter your email first'; return; }
  try {
    await loadAuth();
  } catch (e) {
    $('loginErr').textContent = 'could not load the Steward SDK (network?)';
    return;
  }
  try {
    await auth.signInWithPasskey(email);
    await establishPoolSession();
    return;
  } catch (e) {
    // fall through to email verification — the universal path
  }
  try {
    await auth.sendEmailOtp(email);
    $('otpRow').style.display = 'flex';
    $('loginMsg').textContent = 'we emailed you a 6-digit code — enter it above to continue';
  } catch (e) {
    $('loginErr').textContent = String((e && e.message) || e).slice(0, 200);
  }
});

// Email-code path: code -> single-use email grant -> register a passkey for
// THIS origin on the same Eliza Cloud identity -> signed in. The grant is
// cached across attempts: Steward only peeks it at register/options, so a
// cancelled passkey prompt can retry without burning a fresh OTP.
let cachedGrant = null, grantEmail = null;
function humanAuthError(e) {
  const m = String((e && e.message) || e || '');
  if (/RP ID|relying party|registrable domain/i.test(m)) return 'secure sign-in is not configured for this domain yet \u2014 a server-side issue on our end. try again later.';
  if (/cancelled|NotAllowed|timed out|denied/i.test(m)) return 'the passkey prompt was cancelled \u2014 press verify to try again, no new code needed.';
  if (/Invalid or expired code/i.test(m)) return 'that code is wrong or expired \u2014 check the newest email or request a new one.';
  if (/Invalid or expired email grant/i.test(m)) return 'your verification expired \u2014 start over to get a new code.';
  return m.slice(0, 200) || 'sign-in failed. try again.';
}
$('otpBtn').addEventListener('click', async () => {
  $('loginErr').textContent = '';
  const email = $('email').value.trim();
  const code = $('otpCode').value.trim();
  if (!code && !cachedGrant) { $('loginErr').textContent = 'enter the code from your email'; return; }
  try {
    await loadAuth();
    if (!cachedGrant || grantEmail !== email) {
      const { emailGrant } = await auth.verifyEmailOtp(email, code);
      cachedGrant = emailGrant; grantEmail = email;
    }
    await auth.addPasskey(email, { emailGrant: cachedGrant });
    await establishPoolSession();
  } catch (e) {
    if (/Invalid or expired email grant/i.test(String((e && e.message) || e))) cachedGrant = null;
    $('loginMsg').textContent = '';
    $('loginErr').textContent = humanAuthError(e);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { auth && auth.signOut(); } catch (_) {}
  await postJSON('/account/logout', {});
  location.reload();
});

$('claimBtn').addEventListener('click', async () => {
  const key = $('claimKey').value.trim();
  if (!key) { $('claimMsg').textContent = 'paste a key first'; return; }
  const { status, data } = await postJSON('/account/claim', { key });
  $('claimKey').value = '';
  if (status === 200 && data && data.ok) {
    $('claimMsg').textContent = 'claimed: ' + (data.label || 'ok');
    boot();
  } else {
    $('claimMsg').textContent = (data && data.error) || ('claim failed (' + status + ')');
  }
});

boot();
</script>`;

  return page.shell({ title: 'pool · account', nav: 'your account', wide: true, body });
}

module.exports = { accountPage };
