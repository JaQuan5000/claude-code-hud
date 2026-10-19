/**
 * Reading `$.session.usage()` without assuming its exact field names.
 *
 * The first version of this went straight for `usage.context.percent` and
 * `limit.resetsAt`, and in a real session both came back undefined: the
 * context reading and every reset time vanished from the strip while the
 * percentages beside them were fine. The readout was wrong in the quiet way,
 * showing less than it knew rather than erring.
 *
 * So nothing here insists on one spelling. Each value is looked for under
 * the names it plausibly has, and derived from the raw numbers when none of
 * them is there - a percentage can always be rebuilt from tokens and a
 * window. A reading that cannot be found at all becomes null, and the strip
 * leaves that one out rather than printing a zero it does not believe.
 *
 * This is deliberately forgiving rather than clever. The alternative is a
 * readout that breaks silently every time a field is renamed, which is
 * exactly what it must not do.
 */

/** The first of these keys that holds a usable number. */
function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
}

/**
 * A percentage, however it was expressed.
 *
 * A value between 0 and 1 is read as a fraction and scaled, because `0.31`
 * and `31` are both plausible spellings of the same reading and only one of
 * them is a percentage. The ambiguity at exactly 1 is resolved as 1%, which
 * is the safer mistake: reading it as 100% would paint the bar red and say
 * you were out of quota.
 */
export function asPercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value > 0 && value < 1) return value * 100;
    return Math.max(0, Math.min(100, value));
}

/**
 * How full the context is, as a percentage.
 *
 * Falls back to the arithmetic when no percentage is published: tokens over
 * window is the same number by another route.
 */
export function contextPercentOf(usage) {
    const ctx = usage && usage.context;
    if (!ctx || typeof ctx !== 'object') return null;

    const direct = asPercent(pick(ctx, [
        'percent', 'percentUsed', 'percent_used',
        'usedPercentage', 'used_percentage', 'usage',
    ]));
    if (direct !== null) return direct;

    const used = pick(ctx, ['tokens', 'used', 'usedTokens', 'used_tokens', 'currentUsage', 'current_usage', 'inputTokens', 'total_input_tokens']);
    const window = pick(ctx, ['window', 'size', 'windowSize', 'window_size', 'contextWindow', 'context_window_size', 'max', 'limit']);
    if (used !== null && window) return Math.max(0, Math.min(100, (used / window) * 100));

    const left = pick(ctx, ['remainingPercentage', 'remaining_percentage', 'remainingPercent']);
    const leftPct = asPercent(left);
    if (leftPct !== null) return 100 - leftPct;

    return null;
}

/**
 * The rate-limit windows, normalised to what the strip draws.
 *
 * `resetsAt` is returned as seconds since the epoch, whatever it arrived as:
 * a number in seconds, a number in milliseconds, or a date string. The
 * millisecond case is told apart by size, since any plausible reset in
 * seconds is far below the threshold and any in milliseconds is far above.
 */
export function limitsOf(usage) {
    const raw = usage && (usage.rateLimits || usage.rate_limits || usage.limits);
    if (!Array.isArray(raw)) return [];

    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;

        const percent = asPercent(pick(item, [
            'percentUsed', 'percent_used', 'percent',
            'usedPercentage', 'used_percentage', 'used',
        ]));
        if (percent === null) continue;

        out.push({
            kind: String(item.kind || item.type || item.name || item.window || ''),
            percentUsed: percent,
            resetsAt: epochSecondsOf(item),
        });
    }
    return out;
}

/** When a window resets, in seconds since the epoch, or null. */
export function epochSecondsOf(item) {
    const n = pick(item, ['resetsAt', 'resets_at', 'resetAt', 'reset_at', 'resetsAtSeconds', 'expiresAt', 'expires_at']);
    if (n !== null) {
        // Below this a value cannot be milliseconds for any date this side of
        // 1973, and above it cannot be seconds for any date before the year
        // 5138. Nothing real sits near the boundary.
        return n > 100000000000 ? Math.floor(n / 1000) : n;
    }

    for (const key of ['resetsAt', 'resets_at', 'resetAt', 'reset_at', 'expiresAt', 'expires_at']) {
        const value = item && item[key];
        if (typeof value === 'string' && value) {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
        }
    }
    return null;
}

/**
 * What the strip needs, from whatever `usage()` gave back.
 *
 * Returns both readings together because they fail together: a usage object
 * that is missing or malformed should leave the strip as it was rather than
 * blanking half of it.
 */
export function readUsage(usage) {
    return {
        contextPercent: contextPercentOf(usage),
        rateLimits: limitsOf(usage),
    };
}

/**
 * The shape of what came back, for `/hud raw`.
 *
 * Names and types only, never the numbers themselves beyond the two the
 * strip already shows. When a field has been renamed again, this is what
 * says so in one line instead of a debugging session.
 */
export function describeUsage(usage) {
    if (!usage || typeof usage !== 'object') return ['usage() returned nothing usable.'];

    const lines = ['usage() returned these keys: ' + Object.keys(usage).join(', ')];

    if (usage.context && typeof usage.context === 'object') {
        lines.push('  context: ' + Object.keys(usage.context).join(', '));
    } else {
        lines.push('  context: absent');
    }

    const raw = usage.rateLimits || usage.rate_limits || usage.limits;
    if (Array.isArray(raw) && raw.length) {
        lines.push('  limits: ' + raw.length + ', first one has: ' + Object.keys(raw[0] || {}).join(', '));
    } else {
        lines.push('  limits: none reported');
    }

    const read = readUsage(usage);
    lines.push('read as: context '
        + (read.contextPercent === null ? 'not found' : Math.round(read.contextPercent) + '%')
        + ', ' + read.rateLimits.length + ' window(s)');
    for (const l of read.rateLimits) {
        lines.push('  ' + (l.kind || '(unnamed)') + ' ' + Math.round(l.percentUsed) + '%'
            + (l.resetsAt ? ' resets at ' + new Date(l.resetsAt * 1000).toISOString() : ' with no reset time'));
    }
    return lines;
}
