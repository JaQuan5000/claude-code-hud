/**
 * What the strip should make of the numbers, before anything is drawn.
 *
 * The old strip gave every reading the same weight: same size, same colour,
 * same gauge, all on one line. Nothing was hidden, but nothing was findable
 * either - a window at 2% and a window at 91% looked alike, so the eye had
 * to read all of it every time to learn that none of it mattered.
 *
 * This keeps every reading on screen and changes only how loudly each one is
 * said. A calm window is dim and small. One worth watching takes its colour
 * back. One about to run out gains a sentence saying so. The reader is told
 * where to look rather than being handed a row and left to search it.
 *
 * **The reset times are also where the mod stops costing anything.** A
 * countdown has to be redrawn every minute or it is wrong, and the strip
 * used to run that timer from startup to shutdown whether or not a countdown
 * was on screen. A reset two days out does not need minute precision: it is
 * drawn as the time of day it happens, which is correct until it changes. So
 * the clock is asked for only while something on screen genuinely counts
 * down, which is the last couple of hours of a window and no longer.
 */

import { AMBER_FROM, RED_FROM } from './hud-format.js';
import { paceOf, paceText } from './hud-pace.js';

/** Dim and quiet. Coloured and legible. Loud, with a reason attached. */
export const CALM = 'calm';
export const WATCH = 'watch';
export const URGENT = 'urgent';

/**
 * Inside this much of a reset, a countdown is the useful form and the strip
 * accepts the per-minute redraw that comes with it. Outside it, the time of
 * day says more and costs nothing.
 */
export const COUNTDOWN_WITHIN_MS = 2 * 60 * 60 * 1000;

/**
 * How much attention a percentage has earned.
 *
 * The same two thresholds the colours already use, so the weight of a
 * reading and its colour can never disagree.
 */
export function levelOf(percent) {
    const p = Math.round(Math.max(0, Math.min(100, Number(percent) || 0)));
    if (p >= RED_FROM) return URGENT;
    if (p >= AMBER_FROM) return WATCH;
    return CALM;
}

/** `none` when there is no reset to show, else how to write it. */
export function resetFormFor(resetsAt, now = Date.now()) {
    if (!resetsAt) return 'none';
    const ms = Number(resetsAt) * 1000;
    if (!Number.isFinite(ms)) return 'none';
    const left = ms - now;
    if (left <= 0) return 'none';
    return left <= COUNTDOWN_WITHIN_MS ? 'countdown' : 'clock';
}

/**
 * A reset as a time of day, for the long way out.
 *
 * Short and local: `Wed 5:00 PM` reads as a plan, where `1d,15h` reads as
 * arithmetic you have to do yourself. Within the day the day name is left
 * off, because "today" is the only thing it could mean.
 */
export function clockText(resetsAt, now = Date.now()) {
    if (!resetsAt) return '';
    const ms = Number(resetsAt) * 1000;
    if (!Number.isFinite(ms)) return '';
    const at = new Date(ms);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sameDay = at.toDateString() === new Date(now).toDateString();
    if (sameDay) return time;
    const day = at.toLocaleDateString([], { weekday: 'short' });
    return day + ' ' + time;
}

/**
 * Every reading the strip carries, in the order it reads them.
 *
 * Context leads because it is the one you can act on this minute; the
 * windows follow in the order the API gives them, which is shortest first.
 * Nothing is dropped - a reading with no percentage is simply not a reading.
 */
export function readingsFor({ contextPercent, rateLimits = [], labelOf, now = Date.now() }) {
    const out = [];

    if (typeof contextPercent === 'number') {
        out.push({
            key: 'ctx',
            label: 'Ctx',
            percent: contextPercent,
            level: levelOf(contextPercent),
            // Context is not a window. It has no reset and no pace: it ends
            // when the conversation is compacted, not when a clock runs out.
            resetsAt: null,
            resetForm: 'none',
            note: '',
        });
    }

    for (const limit of rateLimits) {
        const label = labelOf ? labelOf(limit.kind) : limit.kind;
        if (!label) continue;
        const level = levelOf(limit.percentUsed);
        const pace = paceOf(label, limit.percentUsed, limit.resetsAt, now);
        out.push({
            key: label.toLowerCase(),
            label,
            percent: limit.percentUsed,
            level,
            resetsAt: limit.resetsAt || null,
            resetForm: resetFormFor(limit.resetsAt, now),
            // Only when it will actually run dry before the reset. "1.6x
            // pace" with room to spare is arithmetic nobody asked for; "dry
            // in 4h" changes what you do next.
            note: pace && pace.dryInMinutes !== null ? paceText(pace) : '',
            pace,
        });
    }

    return out;
}

/** The loudest thing on the strip, which is what the status dot reports. */
export function worstLevel(readings) {
    let worst = CALM;
    for (const r of readings || []) {
        if (r.level === URGENT) return URGENT;
        if (r.level === WATCH) worst = WATCH;
    }
    return worst;
}

/**
 * Is a per-minute redraw earning its keep?
 *
 * True only while something on screen is counting down in minutes. Every
 * other state - and that is nearly every state - needs no timer at all,
 * because a time of day does not go stale and a percentage is redrawn by the
 * events that change it.
 */
export function needsClock(readings) {
    return (readings || []).some((r) => r.resetForm === 'countdown');
}

/**
 * The one line worth saying under the strip, or nothing.
 *
 * At most one: a readout that stacks three warnings has told you to ignore
 * all three. The most urgent wins, and ties go to the window that empties
 * soonest, since that is the one you will hit first.
 */
export function leadNote(readings) {
    const spoken = (readings || []).filter((r) => r.note);
    if (!spoken.length) return null;
    spoken.sort((a, b) => {
        const rank = (x) => (x.level === URGENT ? 0 : x.level === WATCH ? 1 : 2);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        const dry = (x) => (x.pace && x.pace.dryInMinutes != null ? x.pace.dryInMinutes : Infinity);
        return dry(a) - dry(b);
    });
    return spoken[0];
}
