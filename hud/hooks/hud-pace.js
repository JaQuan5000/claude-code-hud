/**
 * Are you spending a window faster than the clock is emptying it?
 *
 * The strip can say a window is 91% gone. That is not the question you
 * actually have, which is whether 91% is fine or a disaster: at 91% with
 * twenty minutes left it is fine, and at 91% with four hours left you are
 * about to lose an afternoon.
 *
 * Everything needed is already on the reading. `resetsAt` says when the
 * window empties, and each kind of window has a known length, so the start
 * is `resetsAt` minus that length and the fraction of the clock you have
 * used is arithmetic. Comparing that against the fraction of the quota you
 * have used turns a status into a warning.
 */

/** How long each window runs, in minutes. */
const WINDOW_MINUTES = {
    Session: 5 * 60,
    Week: 7 * 24 * 60,
    Fable: 7 * 24 * 60,
};

/**
 * Past this ratio, spending is fast enough to be worth saying out loud.
 *
 * 1.5 rather than something tighter because a readout that comments on
 * every mild overspend stops being read. At 1.5x you will empty the window
 * at two thirds of the way through it, which is worth knowing.
 */
export const FAST_RATIO = 1.5;

/**
 * Where the clock is, where the spend is, and what that implies.
 *
 * Returns null when it cannot be worked out - an unknown window, a missing
 * reset, a reading of zero - rather than guessing. A pace drawn from a guess
 * is worse than no pace at all.
 */
export function paceOf(label, percentUsed, resetsAt, now = Date.now()) {
    const minutes = WINDOW_MINUTES[label];
    if (!minutes || !resetsAt) return null;

    const resetMs = Number(resetsAt) * 1000;
    if (!Number.isFinite(resetMs)) return null;

    const startMs = resetMs - minutes * 60000;
    const elapsed = (now - startMs) / (minutes * 60000);
    if (!(elapsed > 0) || elapsed >= 1) return null;

    const used = Math.max(0, Math.min(100, Number(percentUsed) || 0)) / 100;
    const ratio = used / elapsed;

    // When will it run out at this rate? Only meaningful while spending.
    let dryInMinutes = null;
    if (used > 0) {
        const minutesLeftInWindow = (resetMs - now) / 60000;
        const perMinute = used / (elapsed * minutes);
        const minutesToDry = (1 - used) / perMinute;
        if (minutesToDry < minutesLeftInWindow) dryInMinutes = Math.max(0, Math.round(minutesToDry));
    }

    return { elapsed, used, ratio, dryInMinutes };
}

/**
 * The pace as a short line, or an empty string when there is nothing to say.
 *
 * It says nothing while you are inside the pace, which is almost always.
 * A readout that comments on every turn stops being read.
 */
export function paceText(pace) {
    if (!pace) return '';
    if (pace.dryInMinutes === null && pace.ratio < FAST_RATIO) return '';
    if (pace.ratio < FAST_RATIO) return '';

    const rate = pace.ratio >= 10 ? '10x+' : (Math.round(pace.ratio * 10) / 10) + 'x';
    if (pace.dryInMinutes === null) return rate + ' pace';

    const m = pace.dryInMinutes;
    const left = m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60 ? (m % 60) + 'm' : '') : m + 'm';
    return rate + ' pace, dry in ' + left;
}

/**
 * Where to put the pace mark in a bar, as a fraction of the track.
 *
 * This is where the fill would be if you were spending evenly. Fill past the
 * mark means you are ahead of the clock.
 */
export function paceMark(pace) {
    if (!pace) return null;
    return pace.elapsed;
}
