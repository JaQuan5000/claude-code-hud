/**
 * What the session has spent, in words the sidebar can print.
 *
 * Everything here is arithmetic on numbers Claude Code already hands over:
 * `$.session.usage()` for the cost and the context window, and each finished
 * turn's own `usage` for the token counts. Nothing is requested, nothing is
 * polled and no model is asked, so keeping this up to date costs a few
 * additions per turn and nothing in between.
 *
 * Pure on purpose, like the rest of the readout: numbers in, text out, which
 * is what lets every figure be checked without a session.
 */

import { elapsedText, tokenText } from './hud-agents.js';

/** A session with nothing spent yet. */
export function emptyStats() {
    return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, busyMs: 0, lastMs: 0 };
}

/** A count, or zero. A field the response left out reads as nothing spent. */
function count(n) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Add one finished turn.
 *
 * Returns a new object rather than changing the old one, so a redraw that is
 * holding the previous stats can never see a half-updated set. A turn that
 * reported neither usage nor a duration (an interrupt, an API error) adds
 * nothing and is not counted: it spent nothing worth a line.
 */
export function addTurn(stats, event) {
    const base = stats || emptyStats();
    const usage = event && event.usage && typeof event.usage === 'object' ? event.usage : null;
    const ms = count(event && event.durationMs);
    if (!usage && !ms) return base;

    return {
        turns: base.turns + 1,
        input: base.input + count(usage && usage.input_tokens),
        output: base.output + count(usage && usage.output_tokens),
        cacheRead: base.cacheRead + count(usage && usage.cache_read_input_tokens),
        cacheWrite: base.cacheWrite + count(usage && usage.cache_creation_input_tokens),
        busyMs: base.busyMs + ms,
        lastMs: ms || base.lastMs,
    };
}

/**
 * Every input token the session has been answered over: the fresh ones, the
 * ones the cache served and the ones written to it.
 */
export function inputTotal(stats) {
    if (!stats) return 0;
    return stats.input + stats.cacheRead + stats.cacheWrite;
}

/**
 * How much of the input the prompt cache served, as a percentage, or null
 * before anything has been read. A high number is cheap and fast; a low one
 * after many turns means the cache keeps being lost.
 */
export function cacheHit(stats) {
    const total = inputTotal(stats);
    if (!total) return null;
    return Math.max(0, Math.min(100, (stats.cacheRead / total) * 100));
}

/** Money as a short figure: under a cent says so, and pennies stop mattering at a hundred. */
export function moneyText(usd) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return '';
    if (usd === 0) return '$0.00';
    if (usd < 0.01) return '<$0.01';
    if (usd < 100) return '$' + usd.toFixed(2);
    return '$' + Math.round(usd).toLocaleString('en-US');
}

/** A span of time as a short figure: 45s, 12m, 1h05m. */
export function spanText(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
    const text = elapsedText(0, ms);
    // 1h5m reads as 1h 5m; pad the minutes so the hours do not run into them.
    return text.replace(/^(\d+h)(\d)m$/, (all, h, m) => h + '0' + m + 'm');
}

/**
 * The facts of the session itself, read defensively out of `usage()`.
 *
 * `cost` is absent where the host keeps no ledger, and the context's tokens
 * are absent until the first response of a window, so each is null rather
 * than zero: "no cost" and "free" are not the same thing.
 */
export function sessionOf(usage) {
    const u = usage && typeof usage === 'object' ? usage : {};
    const ctx = u.context && typeof u.context === 'object' ? u.context : {};
    const cost = u.cost && typeof u.cost === 'object' ? u.cost.usd : null;
    const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
    return {
        costUsd: num(cost),
        startedAt: num(u.startedAt),
        contextTokens: num(ctx.tokens),
        contextWindow: num(ctx.window),
    };
}

/** "151k of 1.0m tokens", or nothing when either figure is unknown. */
export function contextText(session) {
    if (!session || session.contextTokens === null || !session.contextWindow) return '';
    return tokenText(session.contextTokens) + ' of ' + tokenText(session.contextWindow) + ' tokens';
}

/**
 * The stats as the rows the sidebar prints, so the card holds no arithmetic
 * of its own.
 */
export function statsView(stats) {
    const s = stats || emptyStats();
    const hit = cacheHit(s);
    return {
        turns: s.turns,
        input: tokenText(inputTotal(s)),
        output: tokenText(s.output),
        cacheHit: hit,
        average: s.turns ? spanText(s.busyMs / s.turns) : '',
        last: s.lastMs ? spanText(s.lastMs) : '',
    };
}
