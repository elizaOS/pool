#!/usr/bin/env bash
# regression.sh — full pool-meter regression pack.
#
# Covers the public edge (nginx + cloudflare), the local listener, auth gates,
# quota semantics, the v2 metering endpoints and the chunked-request case that
# previously produced alternating 400s.
#
# Usage:
#   POOL_ADMIN_KEY=... POOL_USER_KEY=... ./test/regression.sh [local_port]
#
# Keys are read from the environment ONLY. Never hardcode a key in this file.
# Exit code is the number of failed checks.

set -uo pipefail

PORT="${1:-18811}"
BASE_LOCAL="http://127.0.0.1:${PORT}"
BASE_PUBLIC="${POOL_PUBLIC_URL:-https://pool.example.com}"
ADMIN="${POOL_ADMIN_KEY:-}"
USER_KEY="${POOL_USER_KEY:-}"

if [[ -z "$ADMIN" || -z "$USER_KEY" ]]; then
  echo "FATAL: set POOL_ADMIN_KEY and POOL_USER_KEY in the environment" >&2
  exit 99
fi

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s (%s)\n' "$1" "$2"; fail=$((fail+1)); }
check(){ # check <desc> <expected> <actual>
  if [[ "$3" == "$2" ]]; then ok "$1"; else bad "$1" "expected $2, got $3"; fi
}

section(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- public edge
section "public edge ($BASE_PUBLIC)"

code=$(curl -sS -o /tmp/rp-nonstream.json -w '%{http_code}' -m 120 -X POST "$BASE_PUBLIC/v1/messages" \
  -H "x-api-key: $USER_KEY" -H 'content-type: application/json' \
  -d '{"model":"claude-fable-5","max_tokens":16,"messages":[{"role":"user","content":"regression: reply ok"}]}')
check "public non-streaming /v1/messages" 200 "$code"

code=$(curl -sS -N -o /tmp/rp-stream.txt -w '%{http_code}' -m 120 -X POST "$BASE_PUBLIC/v1/messages" \
  -H "x-api-key: $USER_KEY" -H 'content-type: application/json' \
  -d '{"model":"claude-fable-5","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"regression: count to three"}]}')
check "public streaming /v1/messages" 200 "$code"
if grep -q 'event: message_stop' /tmp/rp-stream.txt; then ok "stream terminates with message_stop"; else bad "stream terminates with message_stop" "no message_stop"; fi

check "public /status"      200 "$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "$BASE_PUBLIC/status")"
check "public /status.json" 200 "$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "$BASE_PUBLIC/status.json")"

# ------------------------------------------------------------------ auth gates
section "auth gates"
check "/meter/stats without key is 401"   401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$BASE_LOCAL/meter/stats")"
check "/meter/stats with user key is 401" 401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/stats")"
check "/meter/stats with admin key is 200" 200 "$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -H "x-api-key: $ADMIN" "$BASE_LOCAL/meter/stats")"
check "bad key is 401"                    401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -H 'x-api-key: sk-pool-definitely-not-valid' "$BASE_LOCAL/v1/messages")"
check "/meter/reputation user key is 401" 401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/reputation")"
check "/meter/reputation admin is 200"    200 "$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -H "x-api-key: $ADMIN" "$BASE_LOCAL/meter/reputation")"
# The ledger joins per-member consumption to per-seat earnings — exactly the
# cross-member view a normal key must never reach.
check "/meter/ledger without key is 401"  401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$BASE_LOCAL/meter/ledger")"
check "/meter/ledger with user key is 401" 401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/ledger")"
check "/meter/ledger?identify=1 user key is 401" 401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/ledger?identify=1")"
check "/meter/ledger with bad key is 401" 401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -H 'x-api-key: sk-pool-definitely-not-valid' "$BASE_LOCAL/meter/ledger")"
check "/meter/ledger with admin key is 200" 200 "$(curl -sS -o /dev/null -w '%{http_code}' -m 30 -H "x-api-key: $ADMIN" "$BASE_LOCAL/meter/ledger")"

# -------------------------------------------------------------- v2 self-serve
section "v2 self-serve metering"
check "/meter/me with user key is 200" 200 "$(curl -sS -o /tmp/rp-me.json -w '%{http_code}' -m 30 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/me")"
check "/meter/me without key is 401"   401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$BASE_LOCAL/meter/me")"

python3 - <<'PY'
import json,sys
try: d=json.load(open('/tmp/rp-me.json'))
except Exception as e: print('  \033[31mFAIL\033[0m /meter/me parse (%s)'%e); sys.exit(0)
checks=[
 ('has own label', bool(d.get('label'))),
 ('reports weighted quota', d.get('quota',{}).get('note','').startswith('quota is denominated')),
 ('has per-model breakdown', isinstance(d.get('byModel'),list)),
 ('has day series', isinstance(d.get('series'),list) and len(d['series'])>0),
 ('exposes cache token fields', 'cacheReadTokens' in d.get('allTime',{}) and 'cacheCreationTokens' in d.get('allTime',{})),
 ('effective != raw when cache used', d['allTime']['effectiveTokens'] != d['allTime']['rawTokens'] or d['allTime']['rawTokens']==0),
 ('reports costUsd alongside tokens', 'costUsd' in d.get('allTime',{})),
 ('has budget block', 'budget' in d and 'enforced' in d['budget']),
 ('per-model rows carry cost', all('costUsd' in m for m in d.get('byModel',[]))),
]
for name,okk in checks:
    print(('  \033[32mPASS\033[0m ' if okk else '  \033[31mFAIL\033[0m ')+name)
PY

# --------------------------------------------------- BYO universal proxy + traces
section "BYO universal proxy + trace consent"
check "/byo/credentials without key is 401" 401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 "$BASE_LOCAL/byo/credentials")"
check "/byo/credentials GET with user key is 200" 200 "$(curl -sS -o /tmp/rp-byo.json -w '%{http_code}' -m 20 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/byo/credentials")"
check "/byo/credentials unknown provider is 400" 400 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H "x-api-key: $USER_KEY" -H 'content-type: application/json' -d '{\"provider\":\"bogus\",\"token\":\"x\"}' "$BASE_LOCAL/byo/credentials")"
check "/byo/credentials empty token is 400" 400 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H "x-api-key: $USER_KEY" -H 'content-type: application/json' -d '{\"provider\":\"openrouter\",\"token\":\"\"}' "$BASE_LOCAL/byo/credentials")"
check "/openrouter without BYO cred is 400 (BYO-only leg)" 400 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST -H "x-api-key: $USER_KEY" -H 'content-type: application/json' -d '{}' "$BASE_LOCAL/openrouter/api/v1/chat/completions")"
check "/meter/traces/stats user key is 401" 401 "$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/traces/stats")"
check "/meter/traces/stats admin is 200" 200 "$(curl -sS -o /tmp/rp-traces.json -w '%{http_code}' -m 20 -H "x-api-key: $ADMIN" "$BASE_LOCAL/meter/traces/stats")"

python3 - <<'PY'
import json,sys
try: d=json.load(open('/tmp/rp-byo.json'))
except Exception as e: print('  \033[31mFAIL\033[0m /byo/credentials parse (%s)'%e); sys.exit(0)
checks=[
 ('lists supported providers', set(['anthropic','openai','openrouter']).issubset(set(d.get('providers',[])))),
 ('credentials field is a list', isinstance(d.get('credentials'),list)),
]
for n,o in checks: print(('  \033[32mPASS\033[0m ' if o else '  \033[31mFAIL\033[0m ')+n)
try: t=json.load(open('/tmp/rp-traces.json'))
except Exception as e: print('  \033[31mFAIL\033[0m /meter/traces/stats parse (%s)'%e); sys.exit(0)
tchecks=[
 ('traces stats has fileCount', 'fileCount' in t),
 ('traces stats has capBytes', 'capBytes' in t),
 ('traces stats note is honest about raw capture', 'redact-on-export' in (t.get('note') or '').lower()),
]
for n,o in tchecks: print(('  \033[32mPASS\033[0m ' if o else '  \033[31mFAIL\033[0m ')+n)
PY

python3 - <<'PY'
import json,sys
try: d=json.load(open('/tmp/rp-me.json'))
except Exception as e: print('  \033[31mFAIL\033[0m /meter/me byo block parse (%s)'%e); sys.exit(0)
checks=[
 ('/meter/me exposes byo bucket', 'byo' in d and 'usage' in d['byo']),
 ('/meter/me exposes traces consent block', 'traces' in d and 'pooled' in d['traces']),
]
for n,o in checks: print(('  \033[32mPASS\033[0m ' if o else '  \033[31mFAIL\033[0m ')+n)
PY

# ------------------------------------------------------- dual-unit accounting
section "dual-unit accounting (tokens + USD)"
check "/meter/pricing is 200" 200 "$(curl -sS -o /tmp/rp-pricing.json -w '%{http_code}' -m 20 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/pricing")"

python3 - <<'PY'
import json,subprocess,os
d=json.load(open('/tmp/rp-pricing.json'))
cards={c['model']:c for c in d['cards']}
# Spot-check against the published table (docs.claude.com, verified 2026-07-26).
expect={
 'fable-5':   (10,50,1.0,12.50),
 'opus-5':    (5,25,0.50,6.25),
 'opus-4.1':  (15,75,1.50,18.75),
 'sonnet-4.6':(3,15,0.30,3.75),
 'haiku-4.5': (1,5,0.10,1.25),
 'haiku-3.5': (0.80,4,0.08,1.00),
}
for k,(i,o,r,w) in expect.items():
    c=cards.get(k)
    okk = c and c['input']==i and c['output']==o and c['cacheRead']==r and c['cacheWrite5m']==w
    print(('  \033[32mPASS\033[0m ' if okk else '  \033[31mFAIL\033[0m ')+f'rate card {k} matches published pricing')
print(('  \033[32mPASS\033[0m ' if d.get('lastVerified') else '  \033[31mFAIL\033[0m ')+'pricing table carries lastVerified date')
print(('  \033[32mPASS\033[0m ' if 'sonnet-5' in cards and cards['sonnet-5'].get('effectiveDated') else '  \033[31mFAIL\033[0m ')+'sonnet-5 introductory pricing is effective-dated')
PY

# Cost math must reproduce Anthropic's own published worked examples.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node -e '
const p = require(process.argv[1] + "/src/lib/pricing.js");
const g = (n) => "  \x1b[32mPASS\x1b[0m " + n;
const b = (n) => "  \x1b[31mFAIL\x1b[0m " + n;
const a1 = p.costOf({ input: 50000, output: 15000 }, "claude-opus-5", "2026-07-26").usd;
const a2 = p.costOf({ input: 10000, cacheRead: 40000, output: 15000 }, "claude-opus-5", "2026-07-26").usd;
console.log(Math.abs(a1 - 0.625) < 1e-9 ? g("worked example 1: opus-5 50k in + 15k out = $0.625") : b("worked example 1 (got " + a1 + ")"));
console.log(Math.abs(a2 - 0.445) < 1e-9 ? g("worked example 2: with cache reads = $0.445") : b("worked example 2 (got " + a2 + ")"));
const intro = p.resolveRates("claude-sonnet-5", "2026-07-26").rates.input;
const post  = p.resolveRates("claude-sonnet-5", "2026-09-01").rates.input;
console.log(intro === 2 && post === 3 ? g("sonnet-5 rate switches $2 -> $3 on 2026-09-01") : b("sonnet-5 effective dating (" + intro + "/" + post + ")"));
const fam = p.resolveRates("claude-opus-9-20991231");
console.log(fam.rates && fam.exact === false ? g("unknown version falls back to family card, flagged inexact") : b("family fallback"));
const un = p.costOf({ input: 100 }, "totally-not-a-model");
console.log(un.priced === false && un.usd === 0 ? g("unpriceable model yields usd 0 and priced:false") : b("unpriced handling"));
// Anthropic cards use the documented 0.1x read / 1.25x 5m-write
// multipliers. OpenAI cards have provider-specific semantics and must not be
// forced through the Anthropic write-cache ratio.
const ratios = Object.entries(p.CARDS).filter(([k]) => !k.startsWith("gpt-5")).every(([, r]) =>
  Math.abs(r.cacheRead - r.input * 0.1) < 1e-9 && Math.abs(r.cacheWrite5m - r.input * 1.25) < 1e-9);
console.log(ratios ? g("every Anthropic card: cacheRead = 0.1x input, cacheWrite5m = 1.25x input") : b("Anthropic cache multiplier ratios"));
const tiny = [1e-9, 1e-6, 4.2e-5, 9e-4].every((v) => !/^\$0\.0*$/.test(p.fmtUsd(v)));
console.log(tiny ? g("sub-cent amounts keep significant digits (never render as $0.00)") : b("fmtUsd sub-cent"));
const cc = p.costOf({ cacheCreation: 1e6 }, "claude-opus-5", "2026-07-26").usd;
const cc1h = p.costOf({ cacheCreation1h: 1e6 }, "claude-opus-5", "2026-07-26").usd;
console.log(cc === 6.25 && cc1h === 10 ? g("cache writes priced 5m by default, 1h when reported") : b("cache write pricing"));
' "$REPO_ROOT"

# ------------------------------------------------------------ v2 admin stats
section "v2 admin stats"
curl -sS -m 30 -H "x-api-key: $ADMIN" "$BASE_LOCAL/meter/stats" -o /tmp/rp-stats.json
python3 - <<'PY'
import json
d=json.load(open('/tmp/rp-stats.json'))
checks=[
 ('version is 2', d.get('version')==2),
 ('per-user list present', isinstance(d.get('users'),list) and len(d['users'])>0),
 ('per-user has byModel', all('byModel' in u for u in d['users'])),
 ('pool-wide model table present', isinstance(d.get('models'),list)),
 ('weights exposed', d.get('weights',{}).get('cache_read')==0.1),
 ('rebuild provenance present', d.get('rebuild',{}).get('records',0)>0),
 ('uptime block present', 'uptime' in d and 'meter' in d['uptime']),
 ('donor attribution block present', 'accounts' in d and 'attribution' in d),
 ('legacy v1 fields retained', 'legacy' in d and 'effective' in d['legacy']),
 ('pool carries costUsd', 'costUsd' in d['pool']),
 ('every user carries costUsd', all('costUsd' in u for u in d['users'])),
 ('every model carries costUsd + rateKey', all('costUsd' in m and 'rateKey' in m for m in d['models'])),
 ('per-user-per-model carries both units', all(all('costUsd' in bm and 'inputTokens' in bm for bm in u['byModel']) for u in d['users'])),
 ('day series carries both units', all(all('costUsd' in s and 'rawTokens' in s for s in u['series']) for u in d['users'])),
 ('donor rows carry costUsd', all('costUsd' in a['served'] for a in d['accounts'])),
 ('pricing provenance exposed', d.get('pricing',{}).get('lastVerified') is not None),
]
for name,okk in checks:
    print(('  \033[32mPASS\033[0m ' if okk else '  \033[31mFAIL\033[0m ')+name)
PY

# ------------------------------------------------------- chunked request case
section "chunked request framing (regression: alternating 400s)"
code=$(curl -sS -o /dev/null -w '%{http_code}' -m 120 -X POST "$BASE_LOCAL/v1/messages" \
  -H "x-api-key: $USER_KEY" -H 'content-type: application/json' -H 'Transfer-Encoding: chunked' \
  -d '{"model":"claude-fable-5","max_tokens":16,"messages":[{"role":"user","content":"chunked regression"}]}')
check "chunked request to listener returns 200" 200 "$code"

# ------------------------------------------------------------- budget cap gate
# Self-contained: mints a temporary key with a tiny budgetUsd, proves the gate
# fires, then ALWAYS removes it (trap covers early exit). Requires write access
# to the keys file; skipped cleanly when it is not available.
section "budget cap gate"
KEYS_FILE="${POOL_METER_KEYS_FILE:-/opt/pool/secrets/pool-keys.json}"
BUDGET_LABEL="regression-budget-$$"

remove_budget_key() {
  [[ -f "$KEYS_FILE" ]] || return 0
  python3 - "$KEYS_FILE" "$BUDGET_LABEL" <<'PY' 2>/dev/null || true
import json,sys
p,label=sys.argv[1],sys.argv[2]
d=json.load(open(p))
ks=d if isinstance(d,list) else d['keys']
n=len(ks)
ks[:]=[k for k in ks if k.get('label')!=label]
if len(ks)!=n: json.dump(d,open(p,'w'),indent=2)
PY
}

if [[ -w "$KEYS_FILE" ]]; then
  trap remove_budget_key EXIT
  BUDGET_KEY=$(python3 - "$KEYS_FILE" "$BUDGET_LABEL" <<'PY'
import json,sys,secrets
p,label=sys.argv[1],sys.argv[2]
d=json.load(open(p))
ks=d if isinstance(d,list) else d['keys']
k='sk-pool-regression-'+secrets.token_hex(12)
ks.append({'key':k,'label':label,'enabled':True,'admin':False,'quota':10**15,'budgetUsd':0.000001})
json.dump(d,open(p,'w'),indent=2)
print(k)
PY
)
  sleep 1
  # First request is under budget (spend starts at zero) and must pass.
  c1=$(curl -sS -o /dev/null -w '%{http_code}' -m 120 -X POST "$BASE_LOCAL/v1/messages" -H "x-api-key: $BUDGET_KEY" \
    -H 'content-type: application/json' -d '{"model":"claude-fable-5","max_tokens":16,"messages":[{"role":"user","content":"budget probe"}]}')
  check "under-budget key is allowed through" 200 "$c1"
  sleep 2
  # Second must be refused now that spend exceeds the cap.
  code2=$(curl -sS -m 60 -o /tmp/rp-budget.json -w '%{http_code}' -X POST "$BASE_LOCAL/v1/messages" -H "x-api-key: $BUDGET_KEY" \
    -H 'content-type: application/json' -d '{"model":"claude-fable-5","max_tokens":16,"messages":[{"role":"user","content":"budget probe 2"}]}')
  check "over-budget key is refused with 429" 429 "$code2"
  if grep -q 'budget cap reached' /tmp/rp-budget.json; then ok "refusal names the budget cap"; else bad "refusal message" "got: $(head -c 90 /tmp/rp-budget.json)"; fi
  if grep -q '0\.00000 at api' /tmp/rp-budget.json; then bad "refusal shows a real dollar amount" "renders the cap as zero"; else ok "refusal shows a real dollar amount"; fi
  # A capped key must still be able to see WHY it was capped.
  c3=$(curl -sS -o /tmp/rp-budget-me.json -w '%{http_code}' -m 30 -H "x-api-key: $BUDGET_KEY" "$BASE_LOCAL/meter/me")
  check "capped key can still read /meter/me" 200 "$c3"
  python3 -c "
import json
d=json.load(open('/tmp/rp-budget-me.json'))['budget']
print(('  \033[32mPASS\033[0m ' if d['exhausted'] and d['enforced'] else '  \033[31mFAIL\033[0m ')+'capped key reports exhausted+enforced budget')"
  remove_budget_key
  trap - EXIT
  after=$(python3 -c "
import json;d=json.load(open('$KEYS_FILE'));ks=d if isinstance(d,list) else d['keys']
print(sum(1 for k in ks if k.get('label')=='$BUDGET_LABEL'))")
  check "temporary budget key removed afterwards" 0 "$after"
else
  echo "  SKIP (keys file not writable: $KEYS_FILE)"
fi

# Keys WITHOUT budgetUsd must be completely unaffected by the new gate.
nobudget=$(curl -sS -m 30 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/me" | python3 -c "
import json,sys;d=json.load(sys.stdin)['budget']
print('ok' if d['budgetUsd'] is None and d['enforced'] is False and d['exhausted'] is False else 'bad')")
check "key without budgetUsd is reported unenforced" ok "$nobudget"

# ------------------------------------------------------ payout ledger (live)
section "payout ledger prototype (live)"
curl -sS -m 30 -H "x-api-key: $ADMIN" "$BASE_LOCAL/meter/ledger" -o /tmp/rp-ledger.json
python3 - <<'PY'
import json,re,sys
raw=open('/tmp/rp-ledger.json').read()
d=json.loads(raw)
t=d['totals']
members=d['members']; seats=d['seats']
gross=t['grossValueServedUsd']
sum_earned=sum(m['earnedUsd'] for m in members)
sum_cons=sum(m['consumedUsd'] for m in members)

checks=[
 # ---- math sanity: the invariant a ledger must never violate ----
 ('sum of member earned <= total served value', sum_earned <= gross + 1e-6),
 ('service asserts that invariant itself', d['invariants']['sumMemberEarnedLteGrossServed'] is True),
 ('attributed + unattributed == gross (nothing evaporates)',
   d['invariants']['attributedPlusUnattributedEqualsGross'] is True),
 ('member earnings never exceed seat-attributed value',
   d['invariants']['sumMemberEarnedLteAttributed'] is True),
 ('all ledger invariants hold', d['invariants']['allHold'] is True),
 ('net == earned - consumed on every member row',
   all(abs(m['netUsd']-(m['earnedUsd']-m['consumedUsd']))<1e-6 for m in members)),
 ('operator position == gross - sum(member earned)',
   abs(t['operatorPositionUsd']-(gross-sum_earned))<1e-4),
 ('no member earns a negative amount', all(m['earnedUsd']>=0 for m in members)),
 ('no seat earns more than the pool served', all(s['earnedUsd']<=gross+1e-6 for s in seats)),
 ('credited value never exceeds seat earned value',
   all(s['creditedUsd']<=s['earnedUsd']+1e-9 for s in seats)),

 # ---- prototype labeling: no money movement, no promises ----
 ('payload declares prototype:true', d.get('prototype') is True),
 ('disclaimer says no money moves', 'no money moves' in d['disclaimer'].lower()),
 ('disclaimer says nothing is owed', 'nothing is owed' in d['disclaimer'].lower()),
 ('valuation basis is api list pricing', d['valuation']['basis']=='anthropic api list pricing'),
 ('valuation carries a lastVerified date', bool(d['valuation'].get('lastVerified'))),
 ('every member row is labelled prototype/estimate',
   all('prototype' in m['valuation'].lower() for m in members) if members else True),
 ('operator line is not called profit',
   'NOT profit' in t['operatorPositionNote']),
]
# Every promissory word must appear under a negation. Banning the words
# outright would evict the honest "nothing is owed" copy, so check context.
PROM=re.compile(r'\b(owed|owes|payable|balance due|will be paid|paid out|payout|entitled)\b',re.I)
NEG=re.compile(r"\b(no|not|nothing|never|isn't|is not|nobody|neither|without)\b",re.I)
bare=[raw[max(0,m.start()-80):m.start()+40] for m in PROM.finditer(raw) if not NEG.search(raw[max(0,m.start()-80):m.start()+40])]
checks.append(('no unnegated promissory language in the payload', not bare))

# ---- honest unattributed bucket ----
un=t['unattributed']
checks += [
 ('unattributed bucket present', isinstance(un,dict) and 'valueUsd' in un),
 ('unattributed explains the missing org header', 'organization-id' in un['reason'].lower()),
 ('unattributed is credited to nobody', 'nobody' in un['handling'].lower()),
 ('unattributed value is not folded into any member earning',
   sum_earned <= t['attributedToSeatsUsd'] + 1e-6),
]

# ---- contribution classes (EXIT-NODE-DESIGN decision 2) ----
c=d['classes']
checks += [
 ('seat contribution class active', c['seat']['active'] is True),
 ('relay contribution class declared but inactive', c['relay']['active'] is False),
 ('relay rate is null, not fabricated', c['relay']['rate'] is None),
 ('member earnings sum over contributions[] (relay slots in later)',
   all(isinstance(m.get('contributions'),list) for m in members) if members else True),
 ('per-class totals exposed', 'seat' in t['byClass'] and 'relay' in t['byClass']),
]

# ---- STEER: pool vs outside-pool split rides along, bounded ----
with_cap=[s for s in seats if s['capacity'].get('available')]
checks += [
 ('every seat row carries a capacity block', all('capacity' in s for s in seats)),
 ('capacity block states its bound', all(s['capacity'].get('bound') in ('upper','point') for s in with_cap)),
 ('no point estimate published without calibration',
   not [s for s in with_cap if not s['capacity'].get('estimable') and s['capacity'].get('poolSharePct') is not None]),
 ('uncalibrated seats labelled upper-bound',
   not [s for s in with_cap if not s['capacity'].get('estimable') and s['capacity'].get('bound')!='upper']),
 ('capacity carries raw ingredients for later recomputation',
   all(isinstance(s['capacity'].get('ingredients'),dict) for s in with_cap)),
 ('ingredients name the tokens-per-point source',
   all(s['capacity']['ingredients'].get('tokensPerPctSource') for s in with_cap)),
 ('split is explicitly NOT multiplied into earnings',
   all('not multiplied' in s['capacity']['note'] for s in with_cap)),
]

# ---- provenance / rebuildability ----
checks += [
 ('ledger documents rebuildability from logs', d['derivedFrom']['rebuildableFromLogs'] is True),
 ('ledger names its data sources', len(d['derivedFrom']['sources'])>=3),
 ('metrics rebuild provenance carried through', d['derivedFrom']['metricsRebuild'].get('records',0)>0),
 ('coverage block explains seat-linkage state', bool(d['coverage'].get('note'))),
]

# ---- privacy: admin view is anonymized by DEFAULT ----
checks += [
 ('no raw account uuids without identify=1', not re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',raw)),
 ('no emails without identify=1', not re.search(r'[\w.+-]+@[\w-]+\.[\w.]+',raw)),
 ('no pool keys in the ledger', 'sk-pool-' not in raw),
 ('member labels masked without identify=1',
   not any('"%s"'%l in raw for l in ['member-a','member-b','member-c','member-d'])),
 ('seat refs are aliases', all(str(s['seatAlias']).startswith('acct-') for s in seats)),
]
for n,o in checks:
    print(('  \033[32mPASS\033[0m ' if o else '  \033[31mFAIL\033[0m ')+n)
print('  ---- ledger headline: gross $%s | member earned $%s | consumed $%s | operator $%s | unattributed $%s (%s%%)'
      % (gross, round(sum_earned,4), round(sum_cons,4), t['operatorPositionUsd'], un['valueUsd'], un['shareOfGrossPct']))
sys.exit(sum(1 for _,o in checks if not o))
PY
ledrc=$?
LEDN=41
if [[ "$ledrc" == "0" ]]; then pass=$((pass+LEDN)); else fail=$((fail+ledrc)); pass=$((pass+LEDN-ledrc)); fi

# /meter/me must carry a myEarnings block (or an explicit null + reason).
curl -sS -m 30 -H "x-api-key: $USER_KEY" "$BASE_LOCAL/meter/me" -o /tmp/rp-me2.json
python3 - <<'PY'
import json,re,sys
raw=open('/tmp/rp-me2.json').read(); d=json.loads(raw)
me=d.get('myEarnings')
checks=[('/meter/me exposes a myEarnings key', 'myEarnings' in d)]
if me is None:
    # Honest for every pre-/join key: a null plus the reason beats a zero row
    # that reads as "your seat earned nothing".
    checks += [('unlinked key gets explicit null, not a misleading zero row', d.get('myEarnings') is None),
               ('unlinked key is told why it earns nothing', 'not linked to a donated seat' in d.get('myEarningsNote','')),
               ('note still labels earnings a prototype', 'PROTOTYPE' in d.get('myEarningsNote','').upper())]
else:
    checks += [('myEarnings labelled prototype', me.get('prototype') is True),
               ('myEarnings disclaims money movement', 'no money moves' in me['disclaimer'].lower()),
               ('myEarnings has earned/consumed/net', all(k in me for k in ('earnedUsd','consumedUsd','netUsd'))),
               ('myEarnings net is self-consistent', abs(me['netUsd']-(me['earnedUsd']-me['consumedUsd']))<1e-6),
               ('myEarnings references seat by alias only', str(me['seatAlias']).startswith('acct-')),
               ('myEarnings carries the bounded capacity split', me['capacity'].get('bound') in ('upper','point',None)),
               ('myEarnings surfaces the inactive relay class', me['otherClasses']['relay']['active'] is False)]
# A member view must never leak another member.
checks += [('myEarnings leaks no other member label',
            not any(l in raw for l in ['member-a','member-b','member-c','member-d'] if l!=d.get('label'))),
           ('myEarnings leaks no uuid or email',
            not re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',raw)
            and not re.search(r'[\w.+-]+@[\w-]+\.[\w.]+',raw))]
for n,o in checks:
    print(('  \033[32mPASS\033[0m ' if o else '  \033[31mFAIL\033[0m ')+n)
sys.exit(sum(1 for _,o in checks if not o))
PY
merc=$?
MEN=6
if [[ "$merc" == "0" ]]; then pass=$((pass+MEN)); else fail=$((fail+merc)); pass=$((pass+MEN-merc)); fi

# ---------------------------------------------- ledger unit (pure logic)
# Cases production cannot reach on demand: a seat claimed by two keys, an
# unclaimed seat, a member underwater, and the empty-pool degenerate.
if ledout=$(node "$(dirname "${BASH_SOURCE[0]}")/ledger-unit.js" 2>&1); then
  n=$(grep -c '  PASS ' <<<"$ledout")
  ok "ledger unit suite ($n checks)"
else
  bad "ledger unit suite" "$(grep -c '  FAIL ' <<<"$ledout") failing check(s)"
  grep '  FAIL ' <<<"$ledout" | sed 's/^/    /'
fi

# ------------------------------------------------- poolshare unit (pure logic)
# Exercises the pool-vs-outside estimator against synthetic seats, including
# the cases production cannot reach on demand: a calibrated seat, a window
# contaminated by the owner's own usage, and a zero denominator.
section "pool vs outside-pool estimator (unit)"
if psout=$(node "$(dirname "${BASH_SOURCE[0]}")/poolshare-unit.js" 2>&1); then
  n=$(grep -c '  PASS ' <<<"$psout")
  ok "poolshare unit suite ($n checks)"
else
  bad "poolshare unit suite" "$(grep -c '  FAIL ' <<<"$psout") failing check(s)"
  grep '  FAIL ' <<<"$psout" | sed 's/^/    /'
fi

# ---------------------------------------- OpenAI cached-token conversion unit
# Pure unit coverage for both OpenAI response shapes and the unchanged
# Anthropic branch. This suite is deliberately bidirectional: 7 checks fail
# against the pre-fix converter that copies cached_tokens without subtracting.
section "OpenAI usage conversion (unit)"
if oaiout=$(node "$(dirname "${BASH_SOURCE[0]}")/openai-usage-unit.js" 2>&1); then
  n=$(grep -c 'PASS' <<<"$oaiout")
  ok "OpenAI usage conversion unit suite ($n checks)"
else
  bad "OpenAI usage conversion unit suite" "$(grep -c 'FAIL' <<<"$oaiout") failing check(s)"
  grep 'FAIL' <<<"$oaiout" | sed 's/^/    /'
fi

# --------------------------------------------------------- privacy invariants
section "privacy invariants on public status"
curl -sS -m 30 "$BASE_LOCAL/status.json" -o /tmp/rp-status.json
python3 - <<'PY'
import json,re
raw=open('/tmp/rp-status.json').read()
d=json.loads(raw)
checks=[
 ('no raw account UUIDs', not re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-',raw)),
 ('no email addresses', not re.search(r'[\w.+-]+@[\w-]+\.[\w.]+',raw)),
 ('no pool keys', 'sk-pool-' not in raw),
 ('reliability block present', 'reliability' in json.loads(raw)),
 ('aggregate USD present on public status', 'costUsd' in json.loads(raw)['meter']['allTime']),
 ('public model cost table is label-free', not any(l in raw for l in ['member-a','member-b','member-c','member-d'])),
 ('provider split includes anthropic and openai', set(d.get('meter',{}).get('byProvider',{})) == {'anthropic','openai'}),
 ('gpt models identify the openai provider', all(m.get('provider')=='openai' for m in d.get('meter',{}).get('byModel',[]) if str(m.get('model','')).startswith('gpt-'))),
 ('codex seats appear with stable aliases', all(str(s.get('seat','')).startswith('acct-') and s.get('provider')=='openai' for s in d.get('codingPool',{}).get('sessions',[]))),
 ('public per-seat usage present', isinstance(d.get('seatUsage'),list)),
 ('per-seat usage uses aliases and provider labels', all(str(s.get('seat','')).startswith('acct-') and s.get('provider') in ('anthropic','openai','former') for s in d.get('seatUsage',[]))),
]
# ---- pool vs outside-pool usage split (anonymized, bounded) ----
split=d.get('usageSplit')
seats=d.get('reliability',{}).get('seats',[])
with_split=[s for s in seats if s.get('usageSplit')]
checks += [
 ('usageSplit summary block present', isinstance(split,dict) and 'calibratedSeats' in split),
 ('usageSplit documents its method', bool(split and split.get('method'))),
 ('usageSplit carries an explicit caveat', bool(split and split.get('caveat'))),
 ('every seat carries a usageSplit block', len(with_split)==len(seats) and len(seats)>0),
 ('seat split keys are aliases only', all(str(s['seat']).startswith('acct-') for s in seats)),
]
# The core honesty invariant: a point estimate may only be published when the
# seat actually calibrated. Otherwise the value must be null and the payload
# must present itself as an upper bound.
bad_point=[s['seat'] for s in with_split
           if not s['usageSplit'].get('estimable') and s['usageSplit'].get('poolSharePct') is not None]
bad_bound=[s['seat'] for s in with_split
           if not s['usageSplit'].get('estimable') and s['usageSplit'].get('bound')!='upper']
checks += [
 ('no point estimate without calibration', not bad_point),
 ('uncalibrated seats are labelled upper-bound', not bad_bound),
]
# Shares must be coherent: pool + outside == 100 (within rounding).
incoherent=[]
for s in with_split:
    u=s['usageSplit']; p=u.get('poolSharePctUpperBound'); o=u.get('outsideSharePctLowerBound')
    if p is None or o is None: continue
    if not (-0.05 <= (p+o)-100 <= 0.05): incoherent.append((s['seat'],p,o))
    if p<0 or p>100 or o<0 or o>100: incoherent.append((s['seat'],p,o))
checks.append(('pool + outside shares are coherent 0..100', not incoherent))
checks.append(('per-seat sparkline present for the honest-gap view',
               all(isinstance(s['usageSplit'].get('sparkline'),list) for s in with_split)))
# Backwards compatibility: v2/pricing fields must all still be there.
required=[('meter','today'),('meter','allTime'),('meter','byModel'),('meter','pricing'),
          ('reliability','seats'),('pool','accounts'),('fable','leftPct'),('urgency','burnRatePctPerHour')]
missing=[a+'.'+b for a,b in required if not (isinstance(d.get(a),dict) and b in d[a])]
checks.append(('v2 + pricing fields all still present (additive-only)', not missing))
for name,okk in checks:
    print(('  \033[32mPASS\033[0m ' if okk else '  \033[31mFAIL\033[0m ')+name)
import sys
sys.exit(sum(1 for _,o in checks if not o))
PY
splitrc=$?
if [[ "$splitrc" == "0" ]]; then pass=$((pass+23)); else fail=$((fail+splitrc)); pass=$((pass+23-splitrc)); fi

# ------------------------------------------- public status page (html render)
section "public status page"
curl -sS -m 30 "$BASE_LOCAL/status" -o /tmp/rp-status.html
htmlcode=$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "$BASE_LOCAL/status")
check "/status renders 200" 200 "$htmlcode"
python3 - <<'PY'
import re,sys
h=open('/tmp/rp-status.html').read()
checks=[
 ('status page is complete html', h.rstrip().endswith('</html>')),
 ('no NaN leaked into the page', 'NaN' not in h),
 ('no undefined leaked into the page', 'undefined' not in h),
 # Zero third-party assets: the dashboard must render on a locked-down network.
 ('no third-party stylesheets or scripts', not re.search(r'(src|href)="https?://',h)),
 ('model mix donut is inline svg', 'class="donut"' in h),
 ('donut has real segments', bool(re.search(r'stroke-dasharray="[\d.]+ [\d.]+"',h))),
 ('seat reliability cards rendered', 'class="seat"' in h),
 ('headline usd figure present', bool(re.search(r'class="(?:big|mega-usd)"[^>]*>(?:<small>[^<]*</small>)?\$',h))),
 ('mobile viewport declared', 'width=device-width' in h),
 ('390px breakpoint present', 'max-width:430px' in h),
 ('no member labels on the public page', not any(l in h for l in ['member-a','member-b','member-c','member-d'])),
 ('no raw uuids on the public page', not re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-',h)),
 ('no emails on the public page', not re.search(r'[\w.+-]+@[\w-]+\.[\w.]+',h)),
 ('header names both claude and chatgpt capacity', 'shared claude + chatgpt capacity' in h),
 ('anthropic-only gauge is explicitly labelled', 'claude capacity left' in h),
 ('provider cards render both legs', 'anthropic leg' in h and 'openai leg' in h),
 ('gpt-5.6-sol renders in model mix', 'gpt-5.6-sol' in h),
 ('seat usage table renders', 'seat usage' in h and 'value served per donated account' in h),
 ('chatgpt seat is provider-labelled', 'class="prov oai">chatgpt' in h),
]
for n,o in checks:
    print(('  \033[32mPASS\033[0m ' if o else '  \033[31mFAIL\033[0m ')+n)
sys.exit(sum(1 for _,o in checks if not o))
PY
htmlrc=$?
if [[ "$htmlrc" == "0" ]]; then pass=$((pass+19)); else fail=$((fail+htmlrc)); pass=$((pass+19-htmlrc)); fi

printf '\n\033[1mresult: %d passed, %d failed\033[0m\n' "$pass" "$fail"
exit "$fail"
