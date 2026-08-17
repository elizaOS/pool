'use strict';
// pricing.js — official Anthropic API list pricing, per model, in USD.
//
// THIS TABLE IS THE SOURCE OF TRUTH FOR COST. The older TOKEN_WEIGHTS vector
// survives only as a derived, model-agnostic view (see metrics.js). Weights
// cannot express that a Fable input token costs 5x a Sonnet 5 input token;
// dollars can.
//
// ---------------------------------------------------------------------------
// SOURCE:        https://platform.claude.com/docs/en/about-claude/pricing
// LAST VERIFIED: 2026-07-26  (fetched from the live docs page on this date)
// UNITS:         USD per million tokens (MTok)
// ---------------------------------------------------------------------------
//
// Re-verify whenever a new model ships or an introductory window lapses. The
// `LAST_VERIFIED` constant is surfaced through the API and README so a stale
// table is visible rather than silently wrong.
//
// Modifiers deliberately NOT modelled, because this deployment cannot observe
// them from a response and guessing would corrupt the number:
//   - Batch API 50% discount (pool traffic is interactive, never batch)
//   - Fast mode premium (`speed: "fast"`, Opus 5 / 4.8 only)
//   - Data residency 1.1x (`inference_geo: "us"`; pool uses the global default)
// If any of those ever apply, reported cost is an UNDERSTATEMENT, never an
// overstatement, which is the safe direction for a budget cap.
//
// Node stdlib only.

const LAST_VERIFIED = '2026-07-26';
const PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';

// Rates are USD per MTok: [input, cacheWrite5m, cacheWrite1h, cacheRead, output]
function rates(input, write5m, write1h, read, output) {
  return { input, cacheWrite5m: write5m, cacheWrite1h: write1h, cacheRead: read, output };
}

// Published rate cards, keyed by a canonical family+version id.
const CARDS = {
  // Frontier tier
  'fable-5':  rates(10, 12.50, 20, 1.00, 50),
  'mythos-5': rates(10, 12.50, 20, 1.00, 50),

  // Opus 4.5 through 5 share a card
  'opus-5':   rates(5, 6.25, 10, 0.50, 25),
  'opus-4.8': rates(5, 6.25, 10, 0.50, 25),
  'opus-4.7': rates(5, 6.25, 10, 0.50, 25),
  'opus-4.6': rates(5, 6.25, 10, 0.50, 25),
  'opus-4.5': rates(5, 6.25, 10, 0.50, 25),
  // Legacy Opus (deprecated/retired) priced 3x higher
  'opus-4.1': rates(15, 18.75, 30, 1.50, 75),
  'opus-4':   rates(15, 18.75, 30, 1.50, 75),

  // Sonnet 5 is effective-dated: introductory pricing lapses 2026-09-01.
  // Handled below in resolveRates(); this entry is the post-introductory card.
  'sonnet-5':   rates(3, 3.75, 6, 0.30, 15),
  'sonnet-4.6': rates(3, 3.75, 6, 0.30, 15),
  'sonnet-4.5': rates(3, 3.75, 6, 0.30, 15),
  'sonnet-4':   rates(3, 3.75, 6, 0.30, 15),

  'haiku-4.5': rates(1, 1.25, 2, 0.10, 5),
  'haiku-3.5': rates(0.80, 1.00, 1.60, 0.08, 4),

  // ── OpenAI / Codex (gpt-5.x) leg ────────────────────────────────────────
  // Pooled ChatGPT-subscription traffic through pool.example.com/openai/*.
  // Codex has no cache-write concept; cacheWrite fields mirror input so the
  // shared costOf() math stays well-defined. cacheRead = OpenAI cached-input.
  // Rates are the published gpt-5.x API list prices (USD/MTok) as a pricing
  // PROXY for subscription burn — weights start = anthropic per lane rules.
  // SOURCE: https://platform.openai.com/docs/pricing (gpt-5 family).
  'gpt-5.6':       rates(1.25, 1.25, 1.25, 0.125, 10),
  'gpt-5.6-codex': rates(1.25, 1.25, 1.25, 0.125, 10),
  'gpt-5.6-terra': rates(1.25, 1.25, 1.25, 0.125, 10),
  'gpt-5.6-sol':   rates(1.25, 1.25, 1.25, 0.125, 10),
  'gpt-5.5':       rates(1.25, 1.25, 1.25, 0.125, 10),
  'gpt-5':         rates(1.25, 1.25, 1.25, 0.125, 10),
  'gpt-5-mini':    rates(0.25, 0.25, 0.25, 0.025, 2),
  'gpt-5-nano':    rates(0.05, 0.05, 0.05, 0.005, 0.40),
};

// Effective-dated overrides. Anthropic's Sonnet 5 introductory pricing ($2/$10)
// runs through 2026-08-31; from 2026-09-01 the standard card above applies.
// Costing a request uses the rate in force at the REQUEST's timestamp, so
// historical aggregates stay correct after the window closes.
const EFFECTIVE_DATED = {
  'sonnet-5': [
    { until: '2026-09-01', rates: rates(2, 2.50, 4, 0.20, 10), note: 'introductory pricing through 2026-08-31' },
  ],
};

// Family fallback when a specific version is unknown (e.g. a model that ships
// after LAST_VERIFIED). Uses the current flagship card for that family, which
// is the closest honest guess, and is always flagged `exact: false`.
const FAMILY_FALLBACK = {
  fable: 'fable-5',
  mythos: 'mythos-5',
  opus: 'opus-5',
  sonnet: 'sonnet-5',
  haiku: 'haiku-4.5',
  gpt: 'gpt-5.6',
};

/**
 * Reduce a wire model id to a canonical `family-version` key.
 *
 * Handles: `claude-opus-4-8`, `claude-opus-4.8`, `claude-fable-5-20260101`,
 * `claude-3-5-haiku-20241022`, `anthropic/claude-sonnet-5`, bare `opus-5`.
 * Returns { family, version, canonical } with nulls when unresolvable.
 */
function canonicalize(model) {
  if (!model || typeof model !== 'string') return { family: null, version: null, canonical: null };
  let m = model.toLowerCase().trim();
  m = m.replace(/^[a-z0-9_-]*\//, '');           // strip provider prefix
  m = m.replace(/[@:](latest|beta|preview)$/, '');
  m = m.replace(/-\d{8}$/, '');                   // strip trailing date stamp
  m = m.replace(/^claude-/, '');
  m = m.replace(/^openai-/, '');

  // OpenAI/Codex models: gpt-5.6-codex, gpt-5.6-terra, gpt-5.6-sol, gpt-5-mini.
  // These carry a sub-variant AFTER the version (codex/terra/sol/mini/nano) that
  // the generic version grabber below would drop, so resolve them explicitly.
  const gpt = m.match(/\bgpt-(\d+(?:[.-]\d+)?)(?:-(codex|terra|sol|mini|nano))?\b/);
  if (gpt) {
    const ver = gpt[1].replace('-', '.');
    const sub = gpt[2] ? `-${gpt[2]}` : '';
    return { family: 'gpt', version: `${ver}${sub}`, canonical: `gpt-${ver}${sub}` };
  }

  const family = (m.match(/\b(fable|mythos|opus|sonnet|haiku)\b/) || [])[1] || null;
  if (!family) return { family: null, version: null, canonical: null };

  // Version digits may appear before the family (claude-3-5-haiku) or after
  // it (claude-opus-4-8 / claude-opus-4.8 / claude-sonnet-5).
  const after = m.slice(m.indexOf(family) + family.length);
  const before = m.slice(0, m.indexOf(family));
  const grab = (s) => {
    const hit = s.match(/(\d+)(?:[.-](\d+))?/);
    if (!hit) return null;
    return hit[2] !== undefined ? `${hit[1]}.${hit[2]}` : hit[1];
  };
  const version = grab(after) || grab(before);
  return { family, version, canonical: version ? `${family}-${version}` : null };
}

/**
 * Resolve the rate card for a model at a point in time.
 * Returns { rates, key, exact, dated, note } — `exact:false` means a family
 * fallback was used and the number is an approximation.
 */
function resolveRates(model, atIso) {
  const { family, canonical } = canonicalize(model);
  if (!family) return { rates: null, key: null, exact: false, reason: 'unrecognized model id' };

  let key = canonical && CARDS[canonical] ? canonical : null;
  let exact = !!key;
  if (!key) {
    const fb = FAMILY_FALLBACK[family];
    if (!fb || !CARDS[fb]) return { rates: null, key: null, exact: false, reason: `no card for family ${family}` };
    key = fb;
  }

  const windows = EFFECTIVE_DATED[key];
  if (windows) {
    const at = atIso ? String(atIso).slice(0, 10) : new Date().toISOString().slice(0, 10);
    for (const w of windows) {
      if (at < w.until) return { rates: w.rates, key, exact, dated: true, note: w.note };
    }
  }
  return { rates: CARDS[key], key, exact, dated: false };
}

/**
 * Cost in USD for one request's token counts.
 *
 * `cacheCreation` is priced at the 5-minute write rate: the Messages API
 * reports `cache_creation_input_tokens` as a single number without saying
 * which TTL was used, and 5m is both the default and the common case. When the
 * detailed `cache_creation` breakdown IS present it is used instead, via
 * `tokens.cacheCreation5m` / `cacheCreation1h`.
 */
function costOf(tokens, model, atIso) {
  const r = resolveRates(model, atIso);
  const t = tokens || {};
  if (!r.rates) {
    return {
      usd: 0,
      priced: false,
      model: model || null,
      rateKey: null,
      exact: false,
      unpricedTokens: (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreation || 0),
      reason: r.reason || 'no rate card',
    };
  }
  const P = r.rates;
  const M = 1e6;
  const w5 = t.cacheCreation5m != null ? t.cacheCreation5m : (t.cacheCreation1h != null ? 0 : (t.cacheCreation || 0));
  const w1 = t.cacheCreation1h || 0;
  const usd =
    ((t.input || 0) * P.input +
     (t.output || 0) * P.output +
     (t.cacheRead || 0) * P.cacheRead +
     w5 * P.cacheWrite5m +
     w1 * P.cacheWrite1h) / M;
  return {
    usd,
    priced: true,
    model: model || null,
    rateKey: r.key,
    exact: r.exact,
    dated: !!r.dated,
    note: r.note || null,
    unpricedTokens: 0,
  };
}

/** Round to cent-fraction precision suitable for JSON display. */
function usd(n) {
  const v = Number(n) || 0;
  if (v === 0) return 0;
  if (Math.abs(v) < 0.01) return Number(v.toFixed(6));
  return Number(v.toFixed(4));
}

/**
 * Human-facing string, never used for math.
 *
 * Sub-cent amounts keep significant digits rather than a fixed decimal count:
 * a fixed `toFixed(5)` renders a real $0.000001 budget as "$0.00000", which
 * reads as zero and made the budget-cap error message self-contradictory
 * ("$0.00090 spent of $0.00000"). Never render a non-zero amount as zero.
 */
function fmtUsd(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (v === 0) return '$0.00';
  if (a < 1e-4) {
    // Two significant digits, e.g. $0.0000010 / $0.000042
    const digits = Math.min(20, Math.max(2, 2 - Math.floor(Math.log10(a)) - 1));
    return `$${v.toFixed(digits)}`;
  }
  if (a < 0.01) return `$${v.toFixed(5)}`;
  if (a < 1) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Full published table, for /meter/pricing and the docs. */
function table() {
  const rows = [];
  for (const [key, r] of Object.entries(CARDS)) {
    const row = { model: key, ...r, unit: 'USD per million tokens' };
    if (EFFECTIVE_DATED[key]) {
      row.effectiveDated = EFFECTIVE_DATED[key].map((w) => ({ until: w.until, note: w.note, ...w.rates }));
    }
    rows.push(row);
  }
  return {
    lastVerified: LAST_VERIFIED,
    source: PRICING_SOURCE,
    unit: 'USD per million tokens (MTok)',
    cacheCreationAssumption: '5-minute cache write rate (1.25x input) unless the API reports a 1h breakdown',
    notModelled: ['batch API 50% discount', 'fast mode premium', 'data residency 1.1x multiplier'],
    familyFallback: FAMILY_FALLBACK,
    cards: rows,
  };
}

module.exports = {
  LAST_VERIFIED, PRICING_SOURCE, CARDS, EFFECTIVE_DATED, FAMILY_FALLBACK,
  canonicalize, resolveRates, costOf, usd, fmtUsd, table,
};
