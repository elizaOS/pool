'use strict';
// join-page.js — HTML for /join and /ledger.
//
// Deliberately matches the existing /status visual language (eliza mark, dark
// panes, orange accent, same type scale). No new design system, no framework,
// no client-side build. The only JS is an EventSource subscription that
// reflects real broker flow state.

const fs = require('fs');
const path = require('path');
const qr = require('./qr.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
let ELIZA_MARK = '';
try {
  ELIZA_MARK = fs
    .readFileSync(path.join(PUBLIC_DIR, 'eliza-mark.svg'), 'utf8')
    .replace('<svg ', '<svg class="mark" aria-hidden="true" ');
} catch (_) {
  /* mark is decorative */
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

// Shared CSS. Extends the /status palette rather than replacing it.
const CSS = `
:root{color-scheme:dark;--bg:#0a0a0a;--card:#141414;--card2:#181818;--ink:#f5f5f5;--muted:#8a8a8a;--line:#262626;--orange:#ff5800;--green:#4ade80;--red:#f87171;--amber:#fbbf24}
*{box-sizing:border-box}html{background:var(--bg)}
body{margin:0;color:var(--ink);font:14px/1.6 -apple-system,'Segoe UI',Inter,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(720px,calc(100% - 32px));margin:0 auto;padding:20px 0 64px}
main.wide{width:min(1120px,calc(100% - 32px))}
.top{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}
.top svg.mark{width:30px;height:35px;flex:none}
.top h1{margin:0;font-size:17px;font-weight:650;letter-spacing:-.01em}
.top h1 small{display:block;font-size:11px;font-weight:500;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.top a.navlink{margin-left:auto;font-size:12px;color:var(--muted);text-decoration:none}
.top a.navlink:hover{color:var(--ink)}
h2{font-size:15px;font-weight:650;margin:28px 0 10px;letter-spacing:-.01em}
p{margin:0 0 12px}
.lede{font-size:16px;line-height:1.55;margin:22px 0 8px}
.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:16px 0}
.card.tight{padding:14px 16px}
.deal{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}
.deal div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.deal span{display:block;font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}
.deal b{font-size:15px;font-weight:600;letter-spacing:-.01em}
button.primary{appearance:none;width:100%;padding:14px 20px;font:inherit;font-weight:650;font-size:15px;color:#fff;background:var(--orange);border:0;border-radius:12px;cursor:pointer}
button.primary:hover{filter:brightness(1.08)}
button.primary:disabled{opacity:.5;cursor:not-allowed}
button.ghost{appearance:none;padding:9px 16px;font:inherit;font-size:13px;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:10px;cursor:pointer}
button.ghost:hover{color:var(--ink);border-color:#3a3a3a}
ul{margin:0 0 12px;padding-left:20px}li{margin:5px 0}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{background:#1e1e1e;border:1px solid var(--line);border-radius:5px;padding:1px 5px;font-size:12.5px}
pre{background:#0f0f0f;border:1px solid var(--line);border-radius:10px;padding:13px 15px;overflow-x:auto;font-size:12.5px;line-height:1.5;margin:10px 0}
pre code{background:0;border:0;padding:0;font-size:inherit}
.warn{border-left:3px solid var(--amber);background:#191408;border-radius:0 12px 12px 0}
.warn h2{margin-top:0;color:var(--amber)}
.err{border-left:3px solid var(--red);background:#1a0f0f;border-radius:0 12px 12px 0;color:#fca5a5}
.ok{border-left:3px solid var(--green);background:#0d1710;border-radius:0 12px 12px 0}
.steps{list-style:none;padding:0;margin:16px 0}
.steps li{display:flex;gap:12px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line);color:var(--muted)}
.steps li:last-child{border-bottom:0}
.steps .n{flex:none;width:22px;height:22px;border-radius:50%;background:#1e1e1e;border:1px solid var(--line);font-size:11px;font-weight:700;display:grid;place-items:center;color:var(--muted)}
.steps li.on{color:var(--ink)}
.steps li.on .n{background:var(--orange);border-color:var(--orange);color:#fff}
.steps li.done .n{background:#14351f;border-color:var(--green);color:var(--green)}
.steps li.fail .n{background:#2a1414;border-color:var(--red);color:var(--red)}
.codebox{display:flex;align-items:center;gap:12px;flex-wrap:wrap;background:#0f0f0f;border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0}
.codebox .val{font-family:ui-monospace,Menlo,monospace;font-size:19px;font-weight:650;letter-spacing:.12em;word-break:break-all;flex:1;min-width:0}
.qrwrap{display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:14px 0}
.qrwrap svg{width:172px;height:172px;border-radius:10px;flex:none;background:#fff;padding:8px}
.qrwrap .qrtext{flex:1;min-width:200px}
.hidden{display:none}
input.code{width:100%;padding:12px 14px;font:inherit;font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--ink);background:#0f0f0f;border:1px solid var(--line);border-radius:10px;margin:8px 0}
input.code:focus{outline:0;border-color:var(--orange)}
.keyout{font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:600;color:var(--green);word-break:break-all;background:#0d1710;border:1px solid #14351f;border-radius:10px;padding:14px 16px;margin:10px 0}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:10px 12px;font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;text-align:left;border-bottom:1px solid var(--line)}
th.num,td.num{text-align:right}
td{padding:11px 12px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border:1px solid var(--line);color:var(--muted)}
.pill.pos{border-color:var(--green);color:var(--green)}
.pill.neg{border-color:var(--amber);color:var(--amber)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat span{display:block;font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.stat b{display:block;margin-top:4px;font-size:22px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat b.orange{color:var(--orange)}
.stat small{display:block;margin-top:3px;font-size:11px;font-weight:400;color:var(--muted);letter-spacing:0;text-transform:none}
.foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-top:24px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
.foot a{color:var(--muted)}
.rules{margin:14px 0 12px;padding-left:20px}
.rules li{margin:0 0 10px;line-height:1.55;color:var(--muted)}
.rules li:last-child{margin-bottom:0}
.rules li b{color:var(--ink);font-weight:650}
.rules li::marker{color:var(--orange);font-weight:700;font-variant-numeric:tabular-nums}
@media(max-width:560px){
  body{padding-bottom:82px}
  main{width:calc(100% - 24px);padding-bottom:40px}
  #go{position:fixed;left:12px;right:12px;bottom:12px;width:auto;z-index:20;box-shadow:0 10px 30px rgba(0,0,0,.65)}
  .deal{grid-template-columns:1fr}
  .lede{font-size:15px}
  .codebox{padding:12px 13px;gap:10px}
  .codebox .val{font-size:18px;letter-spacing:.06em}
  .qrwrap{gap:14px;justify-content:center}
  .qrwrap svg{width:100%;max-width:260px;height:auto}
  .qrwrap .qrtext{min-width:0;text-align:center}
  pre{font-size:11.5px}
  .stats{grid-template-columns:1fr 1fr}
  table{font-size:12px}th,td{padding:9px 8px}
  .xs-hide{display:none}
  /* 16px is the threshold below which ios safari auto-zooms on focus, which
     mid-oauth would throw the layout off exactly when the donor is pasting. */
  input.code{font-size:16px;padding:13px 14px}
  .keyout{font-size:13px;padding:13px 14px}
  .rules{padding-left:18px}
  .rules li{font-size:13.5px}
  /* full-width tap targets, comfortably above the 44px minimum */
  button.primary,button.ghost{width:100%;min-height:46px}
  .codebox button.ghost{width:auto;min-height:40px}
}
`;

const JOIN_CSS = `
/* Join front door: status-page palette, editorial mono structure, physical motion. */
:root{--join-ease:cubic-bezier(.16,1,.3,1);--join-fast:cubic-bezier(.25,1,.5,1);--blue:#38bdf8;--dim:#666}
[hidden]{display:none!important}
body:has(.join-hero) #go{position:static;inset:auto;width:100%;box-shadow:none}
body:has(.join-hero){background:radial-gradient(900px 520px at 74% 8%,rgba(255,88,0,.08),transparent 60%),var(--bg)}
body:has(.join-hero)::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.028;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.8'/%3E%3C/svg%3E");z-index:1}
body:has(.join-hero) main{width:min(980px,calc(100% - 40px));position:relative;z-index:2;padding-top:24px}
body:has(.join-hero) .top{border:0;padding:10px 0 28px}
body:has(.join-hero) .top h1 small{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
body:has(.join-hero) .navlink{text-transform:uppercase;letter-spacing:.08em;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
.join-hero{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.55fr);align-items:center;gap:54px;min-height:350px;padding:54px 4px 46px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.eyebrow,.kicker{display:block;color:var(--muted);font:600 10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.11em;text-transform:uppercase}
.eyebrow{display:inline-flex;align-items:center;gap:9px;color:#b5b5b5}.eyebrow>i{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px rgba(74,222,128,.7);animation:signal 2.2s var(--join-ease) infinite}.eyebrow.danger{color:var(--red)}
.display{max-width:690px;margin:23px 0 20px;font-size:clamp(46px,7vw,76px);line-height:.96;font-weight:680;letter-spacing:-.062em;text-wrap:balance}.display.small{font-size:clamp(34px,5vw,54px);margin-top:18px}
.hero-lede{max-width:620px;margin:0;color:#aaa;font-size:17px;line-height:1.65;text-wrap:pretty}.hero-meta{display:flex;flex-wrap:wrap;gap:18px;margin-top:28px;color:var(--muted);font:500 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.07em}.hero-meta span{padding-left:12px;border-left:1px solid #343434}.hero-meta b{color:var(--ink);font-weight:650}.hero-meta .elevated b{color:var(--orange)}
.pool-orbit{position:relative;width:260px;height:260px;justify-self:end;display:grid;place-items:center}.orbit{position:absolute;border:1px solid #292929;border-radius:50%;animation:orbitPulse 5s var(--join-ease) infinite}.o1{inset:18px}.o2{inset:48px;animation-delay:-2.4s}.core{width:116px;height:116px;border-radius:50%;display:grid;place-content:center;text-align:center;background:#111;border:1px solid #343434;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 0 70px rgba(255,88,0,.11);font:700 18px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em}.core small{display:block;margin-top:9px;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.12em}.node{position:absolute;width:9px;height:9px;border-radius:50%;background:var(--orange);box-shadow:0 0 14px rgba(255,88,0,.8)}.n1{top:27px;left:84px}.n2{right:17px;bottom:86px;animation:signal 2.8s var(--join-ease) infinite}.n3{left:24px;bottom:66px;background:var(--green);box-shadow:0 0 12px rgba(74,222,128,.7)}
.journey{display:grid;grid-template-columns:auto 1fr auto 1fr auto;align-items:center;padding:25px 0 21px}.journey-step{display:flex;align-items:baseline;gap:8px;color:#555;transition:color .35s var(--join-ease)}.journey-step span{font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.journey-step b{font:650 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}.journey-step.active{color:var(--orange)}.journey-step.done{color:var(--green)}.journey-line{height:1px;margin:0 18px;background:#262626;position:relative;overflow:hidden}.journey-step.done+.journey-line::after{content:'';position:absolute;inset:0;background:var(--green);transform-origin:left;animation:lineGrow .45s var(--join-ease) both}
.join-shell{padding:1px;border:1px solid #2b2b2b;border-radius:21px;background:linear-gradient(145deg,#202020,#101010);box-shadow:0 28px 80px rgba(0,0,0,.28)}.join-core{padding:31px 33px;background:#121212;border-radius:19px;box-shadow:inset 0 1px 0 rgba(255,255,255,.04)}.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.section-head h2{margin:7px 0 0;color:var(--ink);font-size:24px;line-height:1.2;text-transform:none;letter-spacing:-.035em}.quiet-link,.text-link{appearance:none;border:0;background:transparent;color:var(--muted);padding:4px 0;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-decoration:underline;text-underline-offset:4px;cursor:pointer;transition:color .2s var(--join-fast)}.quiet-link:hover,.text-link:hover{color:var(--ink)}
.auth-form{margin-top:24px}.auth-form label,.code-submit label{display:block;margin-bottom:8px;color:var(--muted);font:600 10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}.input-row{display:flex;gap:9px}.input-row input{min-width:0;flex:1;height:50px;padding:0 16px;border:1px solid #303030;border-radius:11px;background:#0c0c0c;color:var(--ink);font:500 15px/1 -apple-system,'Segoe UI',sans-serif;outline:0;transition:border-color .2s var(--join-fast),box-shadow .2s var(--join-fast)}.input-row input:focus{border-color:#6a3319;box-shadow:0 0 0 3px rgba(255,88,0,.09)}.otp-row{margin-top:10px}.form-note{display:block;min-height:20px;margin-top:9px;color:var(--muted);font-size:12px}.form-note.error{color:var(--red)}
button.primary,.button{min-height:50px;border-radius:11px;transition:transform .18s var(--join-fast),filter .18s var(--join-fast),background .18s var(--join-fast)}button.primary{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:6px 7px 6px 20px}button.primary i,.button i{display:grid;place-items:center;width:36px;height:36px;border-radius:8px;background:rgba(255,255,255,.13);font-style:normal;font-size:16px;transition:transform .25s var(--join-ease)}button.primary:hover:not(:disabled),.button:hover{filter:brightness(1.08);transform:translateY(-1px)}button.primary:hover:not(:disabled) i,.button:hover i{transform:translateX(2px)}button.primary:active:not(:disabled),.button:active{transform:scale(.985)}button.primary:focus-visible,.button:focus-visible,.provider:focus-within,.device-code:focus-visible,.key-reveal:focus-visible,.quiet-link:focus-visible{outline:2px solid #ff8b4d;outline-offset:3px}.primary.compact{width:auto;min-width:158px}.spin{animation:spin .8s steps(8) infinite!important}.identity-ok{margin-top:22px;display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #24422e;background:#0e1912;border-radius:12px;animation:stateIn .42s var(--join-ease) both}.identity-ok[hidden]{display:none}.checkmark{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--green);color:#07140b;font-weight:800}.identity-ok small{display:block;color:var(--green);font:600 9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.09em}.identity-ok b{font-size:13px}
.connect-zone{margin-top:32px;padding-top:29px;border-top:1px solid #282828;transition:opacity .35s var(--join-ease)}.connect-zone[aria-disabled=true]{opacity:.4;pointer-events:none}.tier-chip{padding:5px 9px;border:1px solid #3d271d;border-radius:99px;color:var(--orange);font:650 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}.provider-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:21px 0 14px}.provider{min-height:78px;display:grid;grid-template-columns:40px 1fr 18px;align-items:center;gap:12px;padding:13px 14px;border:1px solid #292929;border-radius:12px;background:#0e0e0e;cursor:pointer;transition:transform .2s var(--join-ease),border-color .2s var(--join-ease),background .2s var(--join-ease)}.provider:hover{transform:translateY(-2px);border-color:#3b3b3b}.provider.selected{border-color:#5e321d;background:#17110e}.provider input{position:absolute;opacity:0;pointer-events:none}.provider-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:#2c1810;color:var(--orange);font:700 14px/1 ui-monospace,SFMono-Regular,Menlo,monospace}.provider-mark.blue{color:var(--blue);background:#0c2029}.provider b,.provider small{display:block}.provider b{font-size:13px}.provider small{margin-top:3px;color:var(--muted);font-size:10px}.provider>i{opacity:0;color:var(--orange);font-style:normal;transform:scale(.4);transition:all .22s var(--join-ease)}.provider.selected>i{opacity:1;transform:scale(1)}.launch{width:100%!important}.consent-line{margin:11px 0 0;text-align:center;color:#666;font-size:10.5px}
.flow-region{margin-top:16px}.flow-region:empty{display:none}.stage-in{animation:stateIn .52s var(--join-ease) both}.flow-card{position:relative;padding:33px 34px;border:1px solid #2b2b2b;border-radius:20px;background:#121212;overflow:hidden}.flow-card h2{margin:10px 0 9px;color:var(--ink);font-size:31px;line-height:1.1;text-transform:none;letter-spacing:-.04em}.flow-card>p{max-width:610px;color:var(--muted)}.flow-status{position:absolute;top:25px;right:27px;display:flex;align-items:center;gap:8px;color:var(--green);font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}.pulse{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);animation:signal 1.7s var(--join-ease) infinite}.device-code,.key-reveal{appearance:none;width:100%;margin:18px 0 12px;padding:20px;border:1px solid #303030;border-radius:14px;background:#090909;color:var(--ink);cursor:pointer;text-align:left;transition:transform .2s var(--join-ease),border-color .2s var(--join-ease),background .2s var(--join-ease)}.device-code:hover,.key-reveal:hover{transform:translateY(-2px);border-color:#555;background:#0c0c0c}.device-code small,.key-reveal small{display:block;color:var(--muted);font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em}.device-code b{display:block;margin:12px 0 8px;font:700 clamp(32px,7vw,58px)/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;color:#fff;word-break:break-all}.device-code>span,.key-reveal>span{color:var(--orange);font:650 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.device-code.copied,.key-reveal.copied{border-color:#28613a;background:#0d1710}.button{appearance:none;display:inline-flex;align-items:center;justify-content:space-between;gap:24px;padding:6px 7px 6px 20px;border:0;font:650 14px/1.2 -apple-system,'Segoe UI',sans-serif;text-decoration:none;cursor:pointer}.primary-link{background:var(--orange);color:#fff}.secondary{background:#202020;color:var(--ink)}.launch-link{margin-top:4px}.code-submit{margin:17px 0;padding:18px 0;border-top:1px solid #242424;border-bottom:1px solid #242424}.waiting{position:relative;display:grid;grid-template-columns:10px 1fr;gap:2px 10px;margin-top:20px;padding:16px 18px;border:1px solid #272727;border-radius:11px;overflow:hidden;color:#bbb;font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.07em}.waiting>i{width:8px;height:8px;margin-top:3px;border-radius:50%;border:2px solid #555;border-top-color:var(--orange);animation:spin 1s linear infinite}.waiting small{grid-column:2;color:#666;font-size:8.5px}.scanline{position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,88,0,.06),transparent);transform:translateX(-100%);animation:scan 2.2s var(--join-ease) infinite}.cancel{margin-top:17px}.success-card{text-align:center;padding-top:45px}.success-ring,.error-mark{display:grid;place-items:center;width:58px;height:58px;margin:0 auto 22px;border-radius:50%;background:#11271a;border:1px solid #275c38;color:var(--green);font-size:25px;animation:successPop .55s var(--join-ease) both}.success-card>p,.already-card>p{margin-left:auto;margin-right:auto}.success-card .kicker,.already-card .kicker{text-align:center}.key-reveal{text-align:left;margin-top:25px}.key-reveal b{display:block;margin:13px 0 10px;color:var(--green);font:650 15px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}.receipt{display:flex;justify-content:center;flex-wrap:wrap;gap:8px 22px;margin:18px 0 24px;color:var(--muted);font:500 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}.receipt b{color:var(--ink)}.action-row{display:flex;align-items:center;justify-content:center;gap:20px;flex-wrap:wrap}.success-flourish i{position:absolute;left:50%;top:68px;width:3px;height:28px;border-radius:4px;background:var(--orange);transform-origin:50% 96%;opacity:0;animation:ray .7s var(--join-ease) .12s both}.success-flourish i:nth-child(1){transform:rotate(-55deg) translateY(-54px)}.success-flourish i:nth-child(2){transform:rotate(0) translateY(-64px)}.success-flourish i:nth-child(3){transform:rotate(55deg) translateY(-54px)}.already-card{text-align:center}.error-card{text-align:center}.error-mark{color:var(--red);background:#251111;border-color:#592727}.setup-details{margin-top:28px;text-align:left;border-top:1px solid #292929}.setup-details summary{padding:18px 0;color:var(--muted);cursor:pointer;font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em}.setup-details .card{border:0;padding:6px 0;background:transparent}.edge-state{margin:90px auto 80px;max-width:760px;text-align:center}.edge-state p{max-width:580px;margin:0 auto 28px;color:var(--muted)}
.modal[hidden]{display:none}.modal{position:fixed;inset:0;z-index:40;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.76);opacity:0;transition:opacity .22s var(--join-fast)}.modal.open{opacity:1}.modal-panel{width:min(680px,100%);max-height:min(780px,calc(100dvh - 40px));display:grid;grid-template-rows:auto minmax(0,1fr) auto;border:1px solid #353535;border-radius:20px;background:#111;box-shadow:0 40px 120px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05);transform:translateY(18px) scale(.985);transition:transform .36s var(--join-ease);overflow:hidden}.modal.open .modal-panel{transform:none}.modal-head{display:flex;justify-content:space-between;align-items:flex-start;padding:25px 27px 20px;border-bottom:1px solid #292929}.modal-head h2{margin:7px 0 0;color:var(--ink);font-size:30px;text-transform:none;letter-spacing:-.04em}.modal-close{appearance:none;width:44px;height:44px;border:1px solid #303030;border-radius:10px;background:#181818;color:var(--muted);font-size:25px;cursor:pointer;transition:all .2s var(--join-fast)}.modal-close:hover{color:#fff;background:#222;transform:rotate(4deg)}.modal-scroll{overflow:auto;padding:24px 27px;overscroll-behavior:contain}.modal-intro{margin-bottom:24px;color:#aaa;font-size:15px}.term{display:grid;grid-template-columns:34px 1fr;gap:13px;padding:16px 0;border-top:1px solid #252525}.term>span{color:var(--orange);font:650 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.term h3{margin:0 0 6px;font-size:14px}.term p{margin:0;color:var(--muted);font-size:12.5px;line-height:1.65}.term p b{color:#ddd}.modal-foot{padding:18px 27px 22px;border-top:1px solid #292929;background:#0d0d0d}.ack{display:grid;grid-template-columns:20px 1fr;gap:10px;align-items:start;margin-bottom:15px;color:#bbb;font-size:12px;cursor:pointer}.ack input{position:absolute;opacity:0}.ack .box{display:grid;place-items:center;width:19px;height:19px;border:1px solid #444;border-radius:5px;color:transparent;transition:all .18s var(--join-fast)}.ack input:checked+.box{background:var(--orange);border-color:var(--orange);color:#fff}.ack input:focus-visible+.box{outline:2px solid #ff8b4d;outline-offset:2px}.modal-foot .primary{width:100%}.modal-open{overflow:hidden}.toast{position:fixed;left:50%;bottom:24px;z-index:50;padding:12px 16px;border:1px solid #343434;border-radius:10px;background:#171717;color:#fff;box-shadow:0 14px 50px #000;transform:translate(-50%,15px);opacity:0;transition:all .25s var(--join-ease)}.toast.show{transform:translate(-50%,0);opacity:1}.toast.error{border-color:#5a2727;color:#fca5a5}
.join-enter{opacity:0;animation:joinEnter .72s var(--join-ease) forwards}.delay-1{animation-delay:.08s}.delay-2{animation-delay:.16s}
@keyframes joinEnter{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}@keyframes stateIn{from{opacity:0;transform:translateY(14px) scale(.992)}to{opacity:1;transform:none}}@keyframes signal{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.42;transform:scale(.72)}}@keyframes orbitPulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:1;transform:scale(1.025)}}@keyframes lineGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes scan{to{transform:translateX(100%)}}@keyframes successPop{from{opacity:0;transform:scale(.5) rotate(-12deg)}to{opacity:1;transform:none}}@keyframes ray{from{opacity:0}45%{opacity:.85}to{opacity:0}}
@media(max-width:760px){body:has(.join-hero) main{width:calc(100% - 28px);padding-top:10px}.join-hero{grid-template-columns:1fr;min-height:0;padding:40px 0 35px}.pool-orbit{display:none}.display{font-size:clamp(42px,14vw,64px)}.hero-lede{font-size:15px}.journey{padding:20px 0}.journey-line{margin:0 9px}.join-core,.flow-card{padding:24px 20px}.provider-grid{grid-template-columns:1fr}.section-head{align-items:flex-start}.auth-form .input-row{flex-direction:column}.primary.compact{width:100%}.flow-status{position:static;margin-bottom:20px}.device-code b{font-size:clamp(28px,10vw,48px)}.modal{padding:0;align-items:end}.modal-panel{max-height:94dvh;border-radius:20px 20px 0 0}.modal-head,.modal-scroll,.modal-foot{padding-left:20px;padding-right:20px}.modal-foot{padding-bottom:max(20px,env(safe-area-inset-bottom))}}
@media(max-width:480px){body:has(.join-hero) main{width:calc(100% - 22px)}.top h1 small{max-width:190px}.display{letter-spacing:-.055em}.hero-meta{gap:10px 14px}.journey-step{gap:4px}.journey-step b{font-size:9px}.join-shell{border-radius:17px}.join-core{border-radius:15px}.section-head h2{font-size:21px}.section-head .quiet-link{max-width:110px;text-align:right}.provider{min-height:72px}.flow-card h2{font-size:28px}.button{width:100%}.action-row{gap:12px}.action-row .text-link{padding:10px}.receipt{justify-content:flex-start;text-align:left}.device-code,.key-reveal{padding:17px}.device-code b{letter-spacing:.07em}.modal-head h2{font-size:26px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;

function shell({ title, body, wide, nav }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0a0a">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" type="image/svg+xml" href="/eliza-mark.svg">
<title>${esc(title)}</title><style>${CSS}${JOIN_CSS}</style></head>
<body><main${wide ? ' class="wide"' : ''}>
<div class="top">${ELIZA_MARK}<h1>Eliza Account Pool<small>${esc(nav || 'donate a seat')}</small></h1><a class="navlink" href="/status">pool status</a></div>
${body}
<div class="foot"><span>pool.example.com</span><span><a href="/status">status</a> &middot; <a href="/ledger">ledger</a> &middot; <a href="/docs">docs</a></span></div>
</main></body></html>\n`;
}

// ---- the honesty block. shown on every /join state, never collapsed. ----
function honesty() {
  return `<div class="card warn">
<h2>read this before you click</h2>
<ul>
<li><b>this is against anthropic's terms of service.</b> pooling subscription seats is not an
authorized use of a claude max plan. we are not going to pretend otherwise.</li>
<li><b>your account can be rate-limited or banned.</b> that risk is real and it is yours. do not
donate an account you cannot afford to lose.</li>
<li><b>we store an oauth refresh token on this server.</b> that token can make claude requests as
your account until you revoke it. it lives in a root-owned file on one box in a closet, not in a
vault, not in an hsm.</li>
<li><b>what gets logged:</b> a label, token counts, model name, latency, status code — always.
<b>pooled usage is also traced:</b> the request and response text are stored (raw, access-controlled,
0600) and may be included in future ANONYMIZED datasets used to improve the service. that is the
deal for using donated quota. traces are redacted (emails, phone numbers, keys, seed phrases) before
any dataset ever leaves this box, and nothing is published or sold today — storage only.
if you bring your OWN token (BYO), your traffic is NOT traced unless you opt in.</li>
<li><b>what you get:</b> an api key metered against a quota that scales with what your seat
actually contributes. net-positive donors get more.</li>
<li><b>how to leave:</b> <a href="/join/revoke">/join/revoke</a>, or run <code>/logout</code> in
claude on the donated account, which invalidates the refresh token immediately.</li>
</ul>
<p class="muted" style="margin-bottom:0">the subsidy is the product. pooling is the market
discovering the true price.</p>
</div>`;
}

// ---- the rules. written like a tracker's /rules page: short, numbered,
// unambiguous, no marketing voice. a tracker with clear rules gets respect;
// a tracker with vague ones gets gamed.
function rules() {
  return `<div class="card">
<h2>the rules</h2>
<p class="muted" style="font-size:13px;margin-top:0">this is a tracker. it runs on ratio,
not goodwill. the code enforces verified sign-in, one active key per account, per-account flow
limits, tiers, quotas, and model access. the social rules below are the contract for what gets
disabled or pruned.</p>
<ol class="rules">
<li><b>your identity is your Eliza Cloud account.</b> signup is open, but every key is minted into
a verified identity and every action is auditable against it. one active key per account. abuse
does not just cost you your key, it costs you the account.</li>
<li><b>invites still exist, as elevation.</b> an invite link from shadow grants a higher tier at
join. abuse on an invited key is visible up the tree and an inviter's whole branch can be disabled
at once.</li>
<li><b>ratio = capacity you contribute / tokens you consume.</b> your seat being online and healthy
is the contribution being measured. it is not a one-time donation event.</li>
<li><b>seeding means staying in the pool.</b> minimum seeding period is <b>7 days</b>. donate,
drain the pool, and yank your account inside that window and you are a hit-and-run: key disabled,
invite branch flagged.</li>
<li><b>freeleech is tier policy.</b> demo keys are restricted to fable and sonnet. opus access is
for earned classes. per-model ratio weights are the next accounting pass, not a promise hidden in
fine print.</li>
<li><b>classes are earned, not bought.</b> sustained contribution raises your quota and unlocks the
expensive models. one donation does not.</li>
<li><b>pruning.</b> dead seats and inactive members get demoted, then disabled. if your account
falls out of the pool and stays out, so does your key.</li>
<li><b>leaving is always allowed.</b> <a href="/join/revoke">/join/revoke</a> disables your key and
removes your credential. leaving cleanly is not a hit-and-run, and it never counts against the
person who invited you.</li>
</ol>
<p class="muted" style="font-size:12px;margin-bottom:0">the invite tree is internal only. the public
<a href="/ledger">ledger</a> is anonymized and aggregate. we never publish who invited whom.</p>
</div>`;
}

// Pinned Steward browser SDK, same module the /account page loads. The passkey
// ceremony runs entirely between the browser and Steward; this page only posts
// the resulting short-lived credential to /account/session once.
const SDK_URL = 'https://esm.sh/@stwd/sdk@0.11.0';

function joinLanding({ inviteError, tier, invited, utilization, stewardBase, tenant }) {
  if (inviteError) {
    return shell({
      title: 'join the pool',
      nav: 'invite unavailable',
      body: `<section class="join-stage edge-state join-enter"><span class="eyebrow danger">invite unavailable</span><h2 class="display small">This link cannot elevate your account.</h2><p>${esc(inviteError)}. The open pool is still available at the standard tier.</p><div class="action-row"><a class="button primary-link" href="/join"><span>continue without invite</span><i>→</i></a><a class="text-link" href="/status">view pool status</a></div></section>
${agreementModal()}`,
    });
  }
  const utilText = utilization && utilization.available ? `${esc(utilization.utilizationPct)}% utilized` : 'live capacity';
  const seatText = utilization ? esc(utilization.seats) : '—';
  const tierName = esc(tier || 'invited');
  return shell({
    title: 'join the account pool',
    nav: invited ? 'elevated join' : 'open join',
    body: `
<section class="join-hero join-enter">
  <div class="hero-copy">
    <span class="eyebrow"><i></i> open enrollment · ${utilText}</span>
    <h2 class="display">Turn idle access into shared capacity.</h2>
    <p class="hero-lede">Sign in with Eliza Cloud, connect one Claude Max or ChatGPT seat, and receive a metered key for the whole pool.</p>
    <div class="hero-meta"><span><b>${seatText}</b> seats online</span><span><b>${tierName}</b> starting tier</span>${invited ? '<span class="elevated"><b>donor</b> invite link is valid · elevation active</span>' : ''}</div>
  </div>
  <div class="pool-orbit" aria-hidden="true"><span class="orbit o1"></span><span class="orbit o2"></span><span class="core">POOL<small>shared compute</small></span><i class="node n1"></i><i class="node n2"></i><i class="node n3"></i></div>
</section>

<nav class="journey join-enter delay-1" aria-label="Join progress">
  <div class="journey-step active" id="j1"><span>01</span><b>identity</b></div>
  <div class="journey-line"></div>
  <div class="journey-step" id="j2"><span>02</span><b>connect</b></div>
  <div class="journey-line"></div>
  <div class="journey-step" id="j3"><span>03</span><b>key</b></div>
</nav>

<section class="join-shell join-enter delay-2" id="joinShell">
  <div class="join-core">
    <div class="section-head"><div><span class="kicker">01 / verify identity</span><h2>Sign in first</h2></div><button class="quiet-link" type="button" data-open-agreement>How it works & terms</button></div>
    <div id="authForm" class="auth-form">
      <label for="authEmail">Eliza Cloud email</label>
      <div class="input-row"><input id="authEmail" type="email" placeholder="you@example.com" autocomplete="email"><button class="primary compact" id="authBtn"><span>continue</span><i>→</i></button></div>
      <div id="authOtpRow" class="input-row otp-row" hidden><input id="authOtp" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" maxlength="6" aria-label="Email verification code"><button class="primary compact" id="authOtpBtn"><span>verify</span><i>→</i></button></div>
      <span id="authErr" class="form-note error" role="alert"></span><span id="authMsg" class="form-note"></span>
      <button class="quiet-link" id="authResend" type="button" hidden>send a new code</button>
    </div>
    <div id="authDone" class="identity-ok" hidden><span class="checkmark">✓</span><div><small>verified identity</small><b id="authWho"></b></div></div>

    <div class="connect-zone" id="connectZone" aria-disabled="true">
      <div class="section-head"><div><span class="kicker">02 / contribute capacity</span><h2>Choose a seat</h2></div><span class="tier-chip">${tierName} tier</span></div>
      <div class="provider-grid" id="provpick" role="radiogroup" aria-label="Seat provider">
        <label class="provider selected"><input type="radio" name="prov" value="anthropic" checked><span class="provider-mark">A</span><span><b>Claude Max</b><small>Anthropic subscription</small></span><i>✓</i></label>
        <label class="provider"><input type="radio" name="prov" value="codex"><span class="provider-mark blue">O</span><span><b>ChatGPT / Codex</b><small>OpenAI subscription</small></span><i>✓</i></label>
      </div>
      <button class="primary launch" id="go" disabled><span>sign in above to start device login</span><i>→</i></button>
      <p class="consent-line">By continuing, you will review and acknowledge the pool terms before any provider login begins.</p>
    </div>
  </div>
</section>
<div id="flow" class="flow-region" aria-live="polite"></div>
${agreementModal()}
<script>
(function(){
  var go=document.getElementById('go'),flow=document.getElementById('flow'),es=null,sid=null,agreed=false,pendingStart=false;
  var modal=document.getElementById('agreementModal'),ack=document.getElementById('termsAck'),accept=document.getElementById('acceptTerms'),lastFocus=null;
  function setJourney(n){for(var i=1;i<=3;i++){var e=document.getElementById('j'+i);if(e)e.className='journey-step '+(i<n?'done':i===n?'active':'');}}
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':s;return d.innerHTML;}
  function render(h){flow.innerHTML=h;flow.classList.remove('stage-in');void flow.offsetWidth;flow.classList.add('stage-in');}
  function copyText(text,btn){navigator.clipboard.writeText(text).then(function(){var old=btn.innerHTML;btn.classList.add('copied');btn.innerHTML='<span>copied</span><i>✓</i>';setTimeout(function(){btn.classList.remove('copied');btn.innerHTML=old;},1600);});}
  window.__copyJoin=copyText;
  function openModal(){lastFocus=document.activeElement;modal.hidden=false;document.body.classList.add('modal-open');requestAnimationFrame(function(){modal.classList.add('open');var x=modal.querySelector('[data-close-agreement]');if(x)x.focus();});}
  function closeModal(){modal.classList.remove('open');document.body.classList.remove('modal-open');setTimeout(function(){modal.hidden=true;if(lastFocus)lastFocus.focus();},220);}
  document.querySelectorAll('[data-open-agreement]').forEach(function(b){b.addEventListener('click',function(){pendingStart=false;openModal();});});
  modal.querySelectorAll('[data-close-agreement]').forEach(function(b){b.addEventListener('click',closeModal);});
  modal.addEventListener('click',function(e){if(e.target===modal)closeModal();});
  ack.addEventListener('change',function(){accept.disabled=!ack.checked;});
  accept.addEventListener('click',function(){if(!ack.checked)return;agreed=true;closeModal();if(pendingStart){pendingStart=false;startFlow();}});
  document.addEventListener('keydown',function(e){if(modal.hidden)return;if(e.key==='Escape')closeModal();if(e.key==='Tab'){var f=modal.querySelectorAll('button:not([disabled]),input:not([disabled]),a[href]');if(!f.length)return;var first=f[0],last=f[f.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
  function cancel(){if(!sid)return;navigator.sendBeacon?navigator.sendBeacon('/join/cancel',new Blob([JSON.stringify({sessionId:sid})],{type:'application/json'})):fetch('/join/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:sid}),keepalive:true});}
  window.addEventListener('pagehide',cancel);
  window.__joinAuthReady=function(){go.disabled=false;go.innerHTML='<span>connect this seat</span><i>→</i>';document.getElementById('connectZone').setAttribute('aria-disabled','false');setJourney(2);};
  var provInputs=document.getElementsByName('prov');
  function selectedProvider(){for(var i=0;i<provInputs.length;i++)if(provInputs[i].checked)return provInputs[i].value;return'anthropic';}
  for(var i=0;i<provInputs.length;i++)provInputs[i].addEventListener('change',function(){document.querySelectorAll('.provider').forEach(function(x){x.classList.toggle('selected',x.querySelector('input').checked);});});
  go.addEventListener('click',function(){if(!agreed){pendingStart=true;openModal();return;}startFlow();});
  function startFlow(){
    go.disabled=true;go.innerHTML='<span>creating secure login</span><i class="spin">↻</i>';
    var sep=location.search?'&':'?';
    fetch('/join/start'+location.search+sep+'provider='+encodeURIComponent(selectedProvider()),{method:'POST'}).then(function(r){return r.json().then(function(j){return{ok:r.ok,status:r.status,j:j};});}).then(function(res){
      if(!res.ok){if(res.j&&res.j.needsAuth)throw new Error('Your sign-in expired. Reload and sign in again.');if(res.j&&res.j.alreadyJoined){go.hidden=true;setJourney(3);render(alreadyCard(res.j.label));return;}var msg=res.j&&res.j.error?res.j.error:'Could not start the flow';if(res.status===429)msg='Too many attempts right now. Your account is safe. Try again later.';throw new Error(msg);}
      var d=res.j;sid=d.sessionId;go.hidden=true;setJourney(2);var isCodex=selectedProvider()==='codex';var site=isCodex?'OpenAI':'Anthropic';var code=d.userCode||'';
      render('<section class="flow-card device-card"><div class="flow-status"><span class="pulse"></span> secure device login ready</div><span class="kicker">02 / authorize seat</span><h2>Continue with '+site+'</h2><p>Open the provider page, approve access, then return here. This tab will update automatically.</p>'+(code?'<button class="device-code" id="deviceCode" type="button" aria-label="Copy device code"><small>device code · click to copy</small><b>'+esc(code)+'</b><span>copy</span></button>':'')+'<a class="button primary-link launch-link" href="'+esc(d.authUrl)+'" target="_blank" rel="noopener noreferrer"><span>open '+site+' login</span><i>↗</i></a>'+(d.needsCodeSubmission?'<div class="code-submit" id="codein"><label for="authcode">Paste the complete code#state</label><div class="input-row"><input id="authcode" placeholder="code#state" autocomplete="off" spellcheck="false"><button class="primary compact" id="submitcode"><span>submit</span><i>→</i></button></div></div>':'')+'<div class="waiting"><span class="scanline"></span><i></i><span>waiting for authorization</span><small>live connection · do not close this tab</small></div><button class="quiet-link cancel" id="cancelbtn">cancel and start over</button></section>');
      var dc=document.getElementById('deviceCode');if(dc)dc.addEventListener('click',function(){copyText(code,dc);});
      document.getElementById('cancelbtn').addEventListener('click',function(){cancel();location.reload();});
      var sc=document.getElementById('submitcode');if(sc)sc.addEventListener('click',function(){var v=document.getElementById('authcode').value.trim();if(!v)return;sc.disabled=true;sc.innerHTML='<span>exchanging</span><i class="spin">↻</i>';fetch('/join/submit-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:sid,code:v})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){if(!x.ok){sc.disabled=false;sc.innerHTML='<span>try again</span><i>→</i>';showToast((x.j&&x.j.error)||'Code rejected','error');}}).catch(function(){sc.disabled=false;});});
      es=new EventSource('/join/events?sessionId='+encodeURIComponent(sid));es.onmessage=function(ev){var st;try{st=JSON.parse(ev.data);}catch(e){return;}if(st.status==='pending')return;es.close();sid=null;if(st.status==='already-joined'){setJourney(3);render(alreadyCard(st.label));return;}if(st.status==='success'){setJourney(3);render(successCard(st));return;}render(errorCard(st.status==='cancelled'?'Flow cancelled':st.status==='timeout'?'Login timed out':'Connection failed',st.error||'The provider login ended without completing.'));};
    }).catch(function(e){go.disabled=false;go.hidden=false;go.innerHTML='<span>try again</span><i>→</i>';render(errorCard('Could not begin',e.message||'Could not start the flow'));});
  }
  function alreadyCard(label){return '<section class="flow-card already-card"><span class="success-ring">✓</span><span class="kicker">account recognized</span><h2>You are already in.</h2><p>Your active key <code>'+esc(label||'')+'</code> is safe. Keys are only displayed once, so manage this one from your account.</p><a class="button primary-link" href="/account"><span>open account</span><i>→</i></a></section>';}
  function successCard(st){return '<section class="flow-card success-card"><div class="success-flourish" aria-hidden="true"><i></i><i></i><i></i></div><span class="success-ring">✓</span><span class="kicker">03 / key delivered</span><h2>You are in the pool.</h2><p>Save this key now. It is shown once and cannot be recovered.</p><button class="key-reveal" id="keyReveal"><small>pool api key · click to copy</small><b id="keyValue">'+esc(st.poolKey)+'</b><span>copy key</span></button><div class="receipt"><span>label <b>'+esc(st.label)+'</b></span><span>tier <b>'+esc(st.tier)+'</b></span><span>quota <b>'+esc(st.quotaText)+'</b></span></div><div class="action-row"><a class="button primary-link" href="/account"><span>open account</span><i>→</i></a><a class="text-link" href="/status?fresh=1">watch pool status</a></div><details class="setup-details"><summary>API setup instructions</summary>'+st.setup+'</details></section>';
  }
  function errorCard(title,msg){return '<section class="flow-card error-card"><span class="error-mark">!</span><span class="kicker">join interrupted</span><h2>'+esc(title)+'</h2><p>'+esc(msg)+'</p><button class="button secondary" onclick="location.reload()"><span>start over</span><i>↻</i></button></section>';}
  flow.addEventListener('click',function(e){var k=e.target.closest('#keyReveal');if(k)copyText(document.getElementById('keyValue').textContent,k);});
  function showToast(msg,type){var t=document.createElement('div');t.className='toast '+(type||'');t.textContent=msg;document.body.appendChild(t);setTimeout(function(){t.classList.add('show');},20);setTimeout(function(){t.classList.remove('show');setTimeout(function(){t.remove();},250);},3500);}
})();
</script>
<script type="module">
const STEWARD_BASE=${JSON.stringify(stewardBase || '')};const TENANT=${JSON.stringify(tenant || '')};const $=id=>document.getElementById(id);let auth=null,cachedGrant=null,grantEmail=null;
async function postJSON(url,body){const r=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});return{status:r.status,data:await r.json().catch(()=>null)};}
function authed(who){$('authForm').hidden=true;$('authDone').hidden=false;$('authWho').textContent=who||'signed in';if(window.__joinAuthReady)window.__joinAuthReady();}
async function loadAuth(){if(auth)return auth;const{StewardAuth}=await import(${JSON.stringify(SDK_URL)});auth=new StewardAuth({baseUrl:STEWARD_BASE,tenantId:TENANT});return auth;}
// WebAuthn RP IDs are origin-bound: a ceremony only works when the server's
// rpId equals this hostname or is a registrable suffix of it. If Steward is
// serving a foreign rpId to this origin (server misconfig), every passkey
// ceremony is guaranteed to throw a SecurityError — so we check FIRST and
// fail with honest copy instead of burning the user's OTP on a dead path.
function rpOk(id){const h=location.hostname;return !!id&&(id===h||h.endsWith('.'+id));}
async function stewardRpId(){try{const r=await fetch(STEWARD_BASE+'/auth/passkey/login/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'rp-probe@'+location.hostname,tenantId:TENANT})});const j=await r.json().catch(()=>null);return(j&&j.rpId)||null;}catch(_){return null;}}
function human(e){const m=String((e&&e.message)||e||'');
 if(/RP ID|relying party|registrable domain/i.test(m))return 'Secure sign-in is not configured for this domain yet. This is a server-side issue on our end, not something you can fix. Please try again later.';
 if(/cancelled|NotAllowed|timed out|denied/i.test(m))return 'The passkey prompt was cancelled. Press verify to try again — no new code needed.';
 if(/Invalid or expired code/i.test(m))return 'That code is wrong or expired. Check the newest email, or send a new code below.';
 if(/Invalid or expired email grant/i.test(m))return 'Your verification expired. Send a new code below and try again.';
 return m.slice(0,200)||'Sign-in failed. Please try again.';}
function failAuth(e){$('authMsg').textContent='';$('authErr').textContent=human(e);}
$('authBtn').addEventListener('click',async()=>{$('authErr').textContent='';$('authMsg').textContent='';const email=$('authEmail').value.trim();if(!email){$('authErr').textContent='Enter your email first.';return;}$('authBtn').disabled=true;$('authBtn').querySelector('span').textContent='checking';try{await loadAuth();}catch(e){$('authErr').textContent='Could not load secure sign-in. Check your connection.';$('authBtn').disabled=false;$('authBtn').querySelector('span').textContent='continue';return;}
const rid=await stewardRpId();if(rid&&!rpOk(rid)){failAuth(new Error('RP ID mismatch'));$('authBtn').disabled=false;$('authBtn').querySelector('span').textContent='continue';return;}
try{await auth.signInWithPasskey(email);await establishPoolSession();return;}catch(e){}
try{await auth.sendEmailOtp(email);cachedGrant=null;grantEmail=null;$('authOtpRow').hidden=false;$('authResend').hidden=false;$('authMsg').textContent='A 6-digit code is on its way.';$('authBtn').hidden=true;$('authOtp').focus();}catch(e){failAuth(e);$('authBtn').disabled=false;$('authBtn').querySelector('span').textContent='continue';}});
$('authResend').addEventListener('click',async()=>{$('authErr').textContent='';const email=$('authEmail').value.trim();if(!email)return;$('authResend').disabled=true;try{await loadAuth();await auth.sendEmailOtp(email);cachedGrant=null;grantEmail=null;$('authOtp').value='';$('authMsg').textContent='A new code is on its way.';}catch(e){failAuth(e);}$('authResend').disabled=false;});
$('authOtpBtn').addEventListener('click',async()=>{$('authErr').textContent='';const email=$('authEmail').value.trim(),code=$('authOtp').value.trim();if(!code&&!cachedGrant){$('authErr').textContent='Enter the code from your email.';return;}$('authOtpBtn').disabled=true;try{await loadAuth();if(!cachedGrant||grantEmail!==email){const{emailGrant}=await auth.verifyEmailOtp(email,code);cachedGrant=emailGrant;grantEmail=email;}await auth.addPasskey(email,{emailGrant:cachedGrant});await establishPoolSession();}catch(e){if(/Invalid or expired email grant/i.test(String((e&&e.message)||e)))cachedGrant=null;failAuth(e);$('authOtpBtn').disabled=false;}});
async function establishPoolSession(){let idToken=null;try{const r=await auth.getIdentityToken();idToken=r&&r.token;}catch(_){}const accessToken=auth.getToken&&auth.getToken();const{status,data}=await postJSON('/account/session',{idToken,accessToken});if(status!==200||!data||!data.ok)throw new Error((data&&data.error)||('sign-in failed ('+status+')'));authed((data.account&&(data.account.email||data.account.userId))||null);}
postJSON('/account/whoami',{}).then(({status,data})=>{if(status===200&&data&&data.ok)authed(data.account.email||data.account.userId);}).catch(()=>{});
</script>`,
  });
}

function agreementModal() {
  return `<div class="modal" id="agreementModal" role="dialog" aria-modal="true" aria-labelledby="termsTitle" hidden><div class="modal-panel"><div class="modal-head"><div><span class="kicker">pool agreement · rev 07.31.26</span><h2 id="termsTitle">Know the deal.</h2></div><button class="modal-close" type="button" data-close-agreement aria-label="Close terms">×</button></div><div class="modal-scroll"><p class="modal-intro">This is shared infrastructure, not a conventional subscription. Read the operating contract before connecting an account.</p><div class="term"><span>01</span><div><h3>Account risk is real</h3><p><b>This is against Anthropic's terms of service.</b> Pooling subscription seats is not an authorized use of a Claude Max plan. Your account can be rate-limited or banned. Do not contribute an account you cannot afford to lose.</p></div></div><div class="term"><span>02</span><div><h3>What the server holds</h3><p>We store an OAuth refresh token on one root-owned server. It can make provider requests until you revoke it. It is not stored in a vault or HSM.</p></div></div><div class="term"><span>03</span><div><h3>What gets logged</h3><p>A label, model, token counts, latency and status code are always logged. Pooled request and response text is access-controlled and may enter future anonymized datasets after credential and personal-data redaction. BYO traffic is not traced unless you opt in.</p></div></div><div class="term"><span>04</span><div><h3>Identity and ratio</h3><p>Your verified Eliza Cloud account owns the key. One active open-join key per account. Capacity contributed divided by tokens consumed determines standing. Classes are earned through sustained contribution, not purchased.</p></div></div><div class="term"><span>05</span><div><h3>Seeding and pruning</h3><p>Minimum seeding is <b>7 days</b>. Donating, draining the pool, then removing the seat inside that window is a hit-and-run. Dead seats and inactive members are demoted, then disabled. Freeleech and model access follow tier policy.</p></div></div><div class="term"><span>06</span><div><h3>Leaving is always allowed</h3><p>Use <a href="/join/revoke">/join/revoke</a> or run <code>/logout</code> in Claude. Leaving cleanly removes the credential and does not count against an inviter. The public <a href="/ledger">ledger</a> is anonymized and never publishes the invite tree.</p></div></div></div><div class="modal-foot"><label class="ack"><input id="termsAck" type="checkbox"><span class="box">✓</span><span>I understand the account risk, data policy, and seven-day seeding rule.</span></label><button class="primary" id="acceptTerms" type="button" disabled><span>acknowledge and continue</span><i>→</i></button></div></div></div>`;
}

function setupBlurb(key) {
  const k = esc(key);
  return `<div class="card"><h2 style="margin-top:0">use it</h2>
<p class="muted" style="font-size:13px">base url <code>https://pool.example.com</code> &middot;
header <code>x-api-key</code> (or <code>Authorization: Bearer</code>)</p>
<pre><code>export ANTHROPIC_BASE_URL="https://pool.example.com"
export ANTHROPIC_AUTH_TOKEN="${k}"
claude</code></pre>
<p class="muted" style="font-size:13px">if <code>ANTHROPIC_API_KEY</code> is already set,
<code>unset</code> it first or it wins.</p>
<pre><code>curl -s https://pool.example.com/v1/messages \\
  -H "x-api-key: ${k}" \\
  -H "content-type: application/json" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{"model":"claude-fable-5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}'</code></pre>
<p style="margin-bottom:4px"><b>anthropic models</b></p>
<ul style="margin-bottom:14px">
<li><code>claude-opus-5</code></li>
<li><code>claude-fable-5</code></li>
<li><code>claude-opus-4-8</code></li>
<li><code>claude-sonnet-4-6</code></li>
</ul>
<p class="muted" style="font-size:13px;margin-bottom:4px"><b>openai / codex</b> &mdash; the same key
also draws pooled ChatGPT/Codex seats on the <code>/openai/*</code> leg (Responses API).</p>
<pre><code># point the Codex CLI at the pool (base url includes the /openai prefix)
export OPENAI_BASE_URL="https://pool.example.com/openai/v1"
export OPENAI_API_KEY="${k}"
codex

# or raw:
curl -s https://pool.example.com/openai/v1/responses \\
  -H "x-api-key: ${k}" \\
  -H "content-type: application/json" \\
  -d '{"model":"gpt-5.6-sol","input":[{"role":"user","content":"hi"}],"stream":true,"store":false}'</code></pre>
<p style="margin-bottom:4px"><b>openai models</b></p>
<ul style="margin-bottom:0">
<li><code>gpt-5.6-sol</code></li>
<li><code>gpt-5.6-codex</code></li>
<li><code>gpt-5.6-terra</code></li>
<li><code>gpt-5-mini</code></li>
</ul></div>`;
}

function revokePage({ message, ok }) {
  return shell({
    title: 'revoke',
    nav: 'revoke a donation',
    body: `
${message ? `<div class="card ${ok ? 'ok' : 'err'}"><p style="margin:0">${esc(message)}</p></div>` : ''}
<h2>get your account out of the pool</h2>
<p><b>the fastest and most complete option, which you control entirely:</b> run
<code>/logout</code> inside claude on the donated account, or revoke the session from
<a href="https://claude.ai/settings" target="_blank" rel="noopener noreferrer">claude.ai settings</a>.
that invalidates the refresh token we hold. the pool immediately stops being able to use your
seat, whether or not we cooperate.</p>

<div class="card ok"><h2 style="margin-top:0">what this page now does</h2>
<p>paste your pool key and we will do two things:</p>
<ul>
<li>disable your metered pool key immediately, so it cannot draw capacity.</li>
<li>if that key is tied to a donated broker account, call the broker's real account-delete API for that account id. that removes the stored credential and pool metadata from the broker.</li>
</ul>
<p style="margin-bottom:0">if the broker delete fails, the key still stays disabled and this page tells you to use <code>/logout</code>. that is the independent kill-switch.</p></div>

<h2>disable a pool key and remove the donated account</h2>
<p class="muted" style="font-size:13px">paste the pool key you were given. we will disable it and
flag the donation for operator removal.</p>
<form method="POST" action="/join/revoke">
<input class="code" name="key" placeholder="sk-pool-..." autocomplete="off" spellcheck="false">
<button class="primary" type="submit">disable this key and request removal</button>
</form>`,
  });
}

function ledgerPage({ rows, util, tiers }) {
  const body = rows.length
    ? rows
        .map(
          (r) => `<tr>
<td>${esc(r.donor)}</td>
<td><span class="pill">${esc(r.tier)}</span></td>
<td class="num">${r.contributedPct === null ? '&mdash;' : `${r.contributedPct.toFixed(1)}%`}</td>
<td class="num">${fmtNum(r.consumedTokens)}</td>
<td class="num xs-hide">${fmtNum(r.quota)}</td>
<td class="num"><span class="pill ${r.netPositive ? 'pos' : 'neg'}">${r.netPositive ? 'net +' : 'net -'}</span></td>
</tr>`,
        )
        .join('')
    : '<tr><td colspan="6" class="muted">no donors yet. be the first.</td></tr>';

  return shell({
    title: 'contribution ledger',
    nav: 'contribution ledger',
    wide: true,
    body: `
<div class="stats">
<div class="stat"><span>pool utilization</span><b class="orange">${util.available ? `${util.utilizationPct}%` : '&mdash;'}</b><small>${esc(util.caveat)}</small></div>
<div class="stat"><span>seats</span><b>${util.seats}</b><small>staggered resets</small></div>
<div class="stat"><span>capacity consumed</span><b>${util.available ? `${util.consumedPct.toFixed(1)}%` : '&mdash;'}</b><small>of ${util.seats * 100}% weekly</small></div>
<div class="stat"><span>tokens served</span><b>${fmtNum(util.tokensServed)}</b><small>all time, metered edge</small></div>
</div>

<div class="card tight" style="padding:0;overflow-x:auto">
<table>
<thead><tr><th>donor</th><th>tier</th><th class="num">capacity contributed</th><th class="num">tokens consumed</th><th class="num xs-hide">quota</th><th class="num">standing</th></tr></thead>
<tbody>${body}</tbody>
</table></div>

<h2>how utilization is computed</h2>
<p class="muted" style="font-size:13px">${esc(util.formula)}</p>
<p class="muted" style="font-size:13px">${esc(util.honesty)}</p>

<h2>tiers</h2>
<div class="card tight" style="padding:0;overflow-x:auto"><table>
<thead><tr><th>tier</th><th class="num">base quota</th><th class="num">per 1% contributed</th><th>models</th></tr></thead>
<tbody>${Object.values(tiers)
      .map(
        (t) => `<tr><td><span class="pill">${esc(t.name)}</span></td>
<td class="num">${fmtNum(t.baseQuota)}</td>
<td class="num">${t.capacityMultiplier ? fmtNum(t.capacityMultiplier * 2000000) : '&mdash;'}</td>
<td class="muted">${t.models ? esc(t.models.join(', ')) : 'all'}</td></tr>`,
      )
      .join('')}</tbody></table></div>
<p class="muted" style="font-size:12px">donor names are truncated. no emails, no account ids, no keys.</p>`,
  });
}

function qrSvg(text) {
  return qr.svg(text, { quiet: 2, dark: '#000000', light: '#ffffff' });
}

module.exports = { shell, joinLanding, setupBlurb, revokePage, ledgerPage, qrSvg, esc, honesty, rules };
