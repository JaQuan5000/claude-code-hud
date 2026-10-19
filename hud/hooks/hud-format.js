/**
 * Turning numbers into the strip that sits above the prompt.
 *
 * Everything here is a pure function of its arguments, for two reasons. It is
 * the part worth testing, and the mods API may only be passed to functions
 * declared at the top level of the hooks module itself, so a helper that took
 * `$` could not live in this file at all.
 */

/** Where green becomes amber, and amber becomes red. */
export const WARN_AT = 60;
export const ALARM_AT = 85;

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

/** A colour for a percentage, by those thresholds. */
export function tone(percent) {
    if (percent >= ALARM_AT) return 'red';
    if (percent >= WARN_AT) return 'yellow';
    return 'green';
}

/**
 * A bar, as two runs of the same character.
 *
 * Ten cells by default, which puts one block to a clean ten percent. The
 * filled count rounds rather than truncating, so anything above zero shows at
 * least part of a block: a window at 4% that drew as empty would read as
 * untouched. The reverse guard keeps 99% from drawing as full.
 *
 * Both runs are the **same** glyph, and only the colour differs. An earlier
 * version paired a full block with a shade character, and whether those two
 * look like one bar depends entirely on the terminal's font: the shade is
 * drawn with less ink, so in some fonts it reads as shorter or thinner and
 * the bar looks like a broken staircase rather than a track with a fill. One
 * glyph cannot disagree with itself.
 */
export function bar(percent, cells = 10, ascii = false) {
    const glyph = ascii ? '#' : '█';
    const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
    let filled = Math.round((clamped / 100) * cells);
    if (clamped > 0 && filled === 0) filled = 1;
    if (clamped < 100 && filled === cells) filled = cells - 1;
    return { filled: glyph.repeat(filled), empty: glyph.repeat(cells - filled), cells };
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

    /**
     * The two runs of a bar, as pieces.
     *
     * The filled run takes the colour for the reading and the empty run is
     * dimmed, which is what makes one glyph read as a track with a fill. A
     * run of length zero is left out rather than pushed as an empty `Text`,
     * which would be a child with nothing in it.
     */
    const barPieces = (percent) => {
        const parts = bar(percent, cells, ascii);
        const out = [];
        if (parts.filled) out.push({ text: parts.filled, color: tone(percent) });
        if (parts.empty) out.push({ text: parts.empty, dim: true });
        return out;
    };

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
                ...barPieces(state.contextPercent),
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
                ...barPieces(pct),
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
