/**
 * Turning numbers into the strip that sits above the prompt.
 *
 * Everything here is a pure function of its arguments, for two reasons. It is
 * the part worth testing, and the mods API may only be passed to functions
 * declared at the top level of the hooks module itself, so a helper that took
 * `$` could not live in this file at all.
 */

/**
 * Where green becomes amber, and amber becomes red.
 *
 * Read each as the first percentage of its band: green runs to 55, amber
 * covers 56 to 85, and red is 86 and up.
 */
export const AMBER_FROM = 56;
export const RED_FROM = 86;

/** How wide the strip is, in terminal cells. */
export function width(pieces) {
    return pieces.reduce((n, p) => n + p.text.length, 0);
}

/**
 * The bar widths to try, widest first, before anything is dropped.
 *
 * A narrow window should lose detail, not data: five cells still reads as a
 * bar, where losing the seven-day window means the strip no longer answers
 * the question it exists to answer.
 */
export const NARROW_STEPS = [8, 6, 5, 4];

/**
 * A colour for a percentage.
 *
 * The reading is rounded before it is compared, because the number printed
 * beside the bar is rounded too. Without this, 85.6 prints as `86%` in red
 * while the bar beside it stays amber, and a readout that disagrees with
 * itself is worse than one that is slightly coarse.
 */
export function tone(percent) {
    const n = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
    if (n >= RED_FROM) return 'red';
    if (n >= AMBER_FROM) return 'yellow';
    return 'green';
}

/** The eighth-blocks, from a sliver to seven eighths of a cell. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/**
 * How much of a bar is filled, in whole cells plus a leading edge.
 *
 * The leading edge is what lets ten columns say more than eleven things.
 * Rounding to whole cells, 40% through 43% all draw the same bar, and so do
 * 77% through 81% - which is exactly where you most want to see movement.
 * With eighths the same ten columns distinguish 81 states.
 *
 * A reading above zero always shows something, and a reading below 100 never
 * shows a full bar: an almost-empty window that drew as untouched, or an
 * almost-full one that drew as done, would both be lies at the only moments
 * that matter.
 */
export function fillOf(percent, cells) {
    const exact = (Math.max(0, Math.min(100, Number(percent) || 0)) / 100) * cells;
    let full = Math.floor(exact);
    let edge = EIGHTHS[Math.round((exact - full) * 8)] || '';
    if (edge === '█') { full += 1; edge = ''; }
    if (percent > 0 && full === 0 && !edge) edge = '▏';
    if (percent < 100 && full >= cells) { full = cells - 1; edge = '▉'; }
    full = Math.max(0, Math.min(full, cells));
    return { full, edge: full >= cells ? '' : edge };
}

/**
 * A bar, as coloured pieces: `[`, the fill, the track, `]`.
 *
 * Three things are going on, and each one earned its place.
 *
 * **The brackets** give the bar edges, so it reads as a gauge with a known
 * extent rather than as text that happens to be blocks. Without them you
 * cannot see where a nearly empty bar ends.
 *
 * **The fill is coloured by zone, not by reading.** Each cell takes the
 * colour of the percentage it represents, so a window at 91% draws green,
 * then amber, then red along its length. You see not just that you are in
 * trouble but how much of the window went by before you got there. Cells of
 * the same colour are merged into one piece, so this costs three elements at
 * worst.
 *
 * **The track is a middle dot**, which is unambiguously empty and cannot be
 * mistaken for a short or thin block - the mistake that a light shade makes
 * in a lot of fonts.
 */
export function barPieces(percent, cells = 10, ascii = false) {
    const inner = Math.max(1, cells - 2);
    const { full, edge } = fillOf(percent, inner);
    const open = ascii ? '[' : '[';
    const dot = ascii ? '.' : '·';
    const block = ascii ? '#' : '█';
    const pieces = [{ text: open, dim: true }];

    // One piece per run of same-coloured cells, rather than one per cell.
    let run = '';
    let runTone = null;
    for (let i = 0; i < full; i += 1) {
        const at = ((i + 1) / inner) * 100;
        const t = ascii ? tone(percent) : tone(at);
        if (t !== runTone && run) {
            pieces.push({ text: run, color: runTone });
            run = '';
        }
        runTone = t;
        run += block;
    }
    if (run) pieces.push({ text: run, color: runTone });
    if (edge) pieces.push({ text: ascii ? block : edge, color: tone(percent) });

    const used = full + (edge ? 1 : 0);
    if (used < inner) pieces.push({ text: dot.repeat(inner - used), dim: true });
    pieces.push({ text: ']', dim: true });
    return pieces;
}

/** The same bar as plain text, for tests, documentation and width maths. */
export function barText(percent, cells = 10, ascii = false) {
    return barPieces(percent, cells, ascii).map((p) => p.text).join('');
}

/**
 * A percentage in a fixed four cells.
 *
 * Padded because the strip is redrawn constantly, and a number that changes
 * width drags everything to its right sideways while you are reading it.
 */
export function percentText(percent) {
    const n = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
    return String(n + '%').padStart(4, ' ');
}

/** A model name in a fixed ten cells, for the same reason. */
export function modelText(name, width = 10) {
    const s = String(name || '?');
    return s.length > width ? s.slice(0, width) : s.padEnd(width, ' ');
}

/**
 * When a window resets, as something readable at a glance.
 *
 * An absolute time rather than a countdown, deliberately: a countdown would
 * have to be redrawn on a timer for ever, and the strip is meant to cost
 * nothing while you are not looking at it. Inside a day it is the clock time,
 * beyond that the weekday, which is as much as anyone needs from the
 * seven-day window.
 */
export function resetText(resetsAt, now = Date.now()) {
    if (!resetsAt) return '';
    const at = new Date(Number(resetsAt) * 1000);
    if (Number.isNaN(at.getTime())) return '';
    const hours = (at.getTime() - now) / 3600000;
    if (hours <= 0) return 'now';
    if (hours > 20) return at.toLocaleDateString(undefined, { weekday: 'short' });
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
}

/** The word after the model name: who chose it. */
export function badgeText(pinned, routing) {
    if (pinned) return 'pin ';
    return routing ? 'auto' : '    ';
}

/**
 * The strip, as groups of pieces.
 *
 * A piece is `{ text, color, dim }` and becomes one `Text` element. A group is
 * one reading, with `extra` holding the part that can be shed first when the
 * window is narrow: the reset time is the least useful thing on the line, so
 * it goes before a whole reading does.
 */
export function buildGroups(state, opts = {}) {
    const cells = opts.barCells || 10;
    const ascii = !!opts.ascii;
    const now = opts.now || Date.now();
    const groups = [];

    const drawBar = (percent) => barPieces(percent, cells, ascii);

    groups.push({
        key: 'model',
        pieces: [
            { text: modelText(state.model), color: state.pinned ? 'yellow' : 'cyan' },
            { text: ' ' },
            { text: badgeText(state.pinned, state.routing), color: state.pinned ? 'yellow' : 'green' },
        ],
        extra: [],
    });

    if (typeof state.contextPercent === 'number') {
        groups.push({
            key: 'ctx',
            pieces: [
                { text: 'ctx ', dim: true },
                ...drawBar(state.contextPercent),
                { text: ' ' },
                { text: percentText(state.contextPercent), color: tone(state.contextPercent) },
            ],
            extra: [],
        });
    }

    for (const limit of state.rateLimits || []) {
        const label = shortKind(limit.kind);
        if (!label) continue;
        const pct = limit.percentUsed;
        const reset = resetText(limit.resetsAt, now);
        groups.push({
            key: label,
            pieces: [
                { text: label + ' ', dim: true },
                ...drawBar(pct),
                { text: ' ' },
                { text: percentText(pct), color: tone(pct) },
            ],
            extra: reset ? [{ text: ' ' + (ascii ? '~' : '↻') + ' ' + reset, dim: true }] : [],
        });
    }

    return groups;
}

/**
 * The names the readout uses for the windows the API reports.
 *
 * An unknown kind is left out rather than printed raw: a new window appearing
 * one day should not put `spend_limit_v2` on the line.
 */
export function shortKind(kind) {
    const k = String(kind || '');
    if (k === 'five_hour' || k === 'fiveHour') return '5h';
    if (k === 'seven_day' || k === 'sevenDay') return '7d';
    return '';
}

/**
 * Fit the groups to the window, shedding rather than wrapping.
 *
 * Wrapping a strip this wide looks like a mistake, so it sheds instead: first
 * every reset time, then whole readings from the right. The model is never
 * dropped, because a readout that cannot say which model you are on has
 * nothing left to say.
 */
export function fit(groups, columns, ascii = false) {
    const sep = { text: ascii ? ' | ' : ' │ ', dim: true };
    const join = (list, withExtra) => {
        const out = [];
        list.forEach((g, i) => {
            if (i > 0) out.push(sep);
            out.push(...g.pieces);
            if (withExtra) out.push(...g.extra);
        });
        return out;
    };

    const room = Number(columns) > 0 ? Number(columns) : Infinity;
    let pieces = join(groups, true);
    if (width(pieces) <= room) return pieces;

    pieces = join(groups, false);
    if (width(pieces) <= room) return pieces;

    const kept = groups.slice();
    while (kept.length > 1) {
        kept.pop();
        pieces = join(kept, false);
        if (width(pieces) <= room) return pieces;
    }
    return pieces;
}

/**
 * The strip, laid out for a window of a given width.
 *
 * The order of sacrifice matters, and it is detail before data. First the
 * bars narrow, because a five-cell bar still answers "roughly how much is
 * left" and costs nothing to read. Only when even the narrowest bars will not
 * fit does `fit` start shedding reset times and then whole readings.
 *
 * Before this, a 70-column pane dropped the seven-day window to save nine
 * characters it could have found in the bars.
 */
export function layout(state, columns, opts = {}) {
    const room = Number(columns) > 0 ? Number(columns) : Infinity;
    const widest = opts.barCells || 10;
    const steps = [widest, ...NARROW_STEPS].filter((c, i, all) => c <= widest && all.indexOf(c) === i);

    let pieces = [];
    for (const cells of steps) {
        pieces = fit(buildGroups(state, { ...opts, barCells: cells }), Infinity, opts.ascii);
        if (width(pieces) <= room) return pieces;
    }

    const smallest = steps[steps.length - 1];
    return fit(buildGroups(state, { ...opts, barCells: smallest }), room, opts.ascii);
}
