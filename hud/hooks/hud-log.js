/**
 * What the router decided, why, and what that says about the patterns.
 *
 * The routing is a pile of regular expressions, and when one gets a prompt
 * wrong there is nothing to look at. This keeps the last few decisions with
 * the words that triggered them, so a misroute is visible instead of
 * mysterious, and then reads the same records back to say which patterns are
 * doing nothing and which words keep landing in the middle tier.
 *
 * It holds a snippet of each prompt, never the whole thing, and nothing
 * leaves the process.
 */

/** How many decisions to keep. Enough to see a pattern, small enough to read. */
export const KEEP = 20;

/** How much of a prompt to keep, for recognising it in a list. */
const SNIPPET = 52;

/**
 * The words that mean something to the router, by the tier they argue for.
 *
 * This is a readable mirror of the patterns in `hud-route.js`, kept here so
 * a decision can say *which* word fired rather than only which tier won.
 * They are checked as whole words, so `planet` does not read as `plan`.
 */
export const SIGNALS = {
    top: ['best model', 'flagship', 'frontier model', 'use fable', 'think really hard',
        'think very hard', 'no shortcuts', 'entire', 'whole', 'complete', 'from scratch',
        'greenfield', 'end to end', 'ground up', 'production', 'mission critical',
        'security audit', 'security review', 'data loss', 'data corruption'],
    deep: ['plan', 'planning', 'design', 'architect', 'architecture', 'refactor',
        'restructure', 'rewrite', 'migrate', 'migration', 'debug', 'diagnose',
        'investigate', 'root cause', 'race condition', 'deadlock', 'why does',
        'why is', 'trade off', 'tradeoff', 'approach', 'strategy'],
    fast: ['typo', 'spelling', 'misspelled', 'rename', 'renaming', 'format',
        'formatting', 'lint', 'prettier', 'indent', 'comment', 'docstring',
        'bump', 'version number'],
};

/** Which known words a prompt actually contains. */
export function signalsIn(text) {
    const s = String(text || '').toLowerCase();
    const found = [];
    for (const tier of ['top', 'deep', 'fast']) {
        for (const word of SIGNALS[tier]) {
            const pattern = new RegExp('(^|[^a-z])' + word.replace(/ /g, '\\s+') + '([^a-z]|$)');
            if (pattern.test(s)) found.push(word);
        }
    }
    return found;
}

/** A prompt, shortened to something recognisable on one line. */
export function snippet(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length <= SNIPPET ? s : s.slice(0, SNIPPET - 1) + '…';
}

/** Add a decision, keeping only the most recent ones. */
export function record(log, entry) {
    const next = log.concat([entry]);
    return next.length > KEEP ? next.slice(next.length - KEEP) : next;
}

/** The log as lines, newest last, for `/hud log`. */
export function logLines(log) {
    if (!log.length) return ['Nothing routed yet this session.'];
    return log.map((e) => {
        const why = e.signals && e.signals.length ? e.signals.slice(0, 3).join(', ') : 'no signal';
        const quoted = '"' + e.text + '"';
        return '  ' + String(e.tier).padEnd(5) + String(e.short || '').padEnd(12)
            + quoted.padEnd(56) + '  [' + why + ']';
    });
}

/**
 * What the record says about the patterns, as suggestions.
 *
 * Every line here is drawn from the session's own prompts rather than from
 * an opinion about how people write. The three things worth knowing:
 *
 *   - a tier that never fires is a tier whose words are too narrow
 *   - a tier that fires for almost everything is too broad
 *   - a word that keeps appearing in the middle tier is a candidate for
 *     one of the others, and the mod can only point at it; whether `docs`
 *     means cheap work is a judgement the patterns cannot make
 */
export function tuneLines(log) {
    if (log.length < 5) {
        return ['Not enough routed yet to say anything useful. Come back after a few more prompts.'];
    }

    const counts = { fast: 0, base: 0, deep: 0, top: 0 };
    for (const e of log) counts[e.tier] = (counts[e.tier] || 0) + 1;
    const total = log.length;
    const pct = (n) => Math.round((n / total) * 100) + '%';

    const out = [
        'From the last ' + total + ' prompts this session:',
        '  fast ' + pct(counts.fast) + '   base ' + pct(counts.base)
            + '   deep ' + pct(counts.deep) + '   top ' + pct(counts.top),
        '',
    ];

    if (counts.fast === 0) {
        out.push('Nothing reached the cheap tier. Either you are not doing small work, or the');
        out.push('fast patterns are too narrow to catch it. The words below may help.');
    }
    if (counts.base / total > 0.8) {
        out.push('Almost everything landed in the middle tier, which means the patterns are');
        out.push('deciding very little. The words below are the ones that keep turning up there.');
    }
    if (counts.top / total > 0.3) {
        out.push('The flagship tier is firing often. Check /hud log: if those prompts are not');
        out.push('really whole-system work, the scope words are matching too loosely.');
    }

    const words = commonWords(log.filter((e) => e.tier === 'base'));
    if (words.length) {
        out.push('');
        out.push('Words that keep appearing in middle-tier prompts, with how often:');
        for (const [word, n] of words) out.push('  ' + String(n).padStart(2) + '  ' + word);
        out.push('');
        out.push('If one of those reliably means small work, add it to FAST in hud-route.js.');
        out.push('If one means a big job, add it to TOP_SCOPE or TOP_STAKES.');
    }

    if (out[out.length - 1] === '') out.pop();
    return out;
}

/** Words the router ignores, so they never get suggested as signals. */
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'you',
    'your', 'can', 'are', 'was', 'our', 'out', 'use', 'make', 'need', 'want', 'should',
    'would', 'could', 'please', 'just', 'now', 'when', 'what', 'where', 'then', 'than',
    'have', 'has', 'its', 'it', 'is', 'in', 'on', 'of', 'to', 'a', 'an', 'be', 'do',
    'add', 'get', 'set', 'run', 'see', 'look', 'also', 'but', 'not', 'all', 'any',
    'file', 'files', 'code', 'line', 'lines', 'one', 'two', 'new', 'old']);

/**
 * The words that recur across prompts, commonest first.
 *
 * A word has to appear in at least two separate prompts to count: one prompt
 * mentioning `kubernetes` says nothing about how you work, and suggesting a
 * pattern from a single sample is how you get a router that overfits to
 * whatever you did last.
 */
export function commonWords(entries, limit = 6) {
    const seen = new Map();
    for (const e of entries) {
        const words = new Set(String(e.text || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || []);
        for (const w of words) {
            if (STOP.has(w)) continue;
            seen.set(w, (seen.get(w) || 0) + 1);
        }
    }
    return [...seen.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit);
}
