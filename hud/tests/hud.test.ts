/**
 * What has to keep working.
 *
 * The two things this mod gets wrong in ways nobody notices are routing a
 * planning job to a small model, and a strip that jitters or overflows. Both
 * are decided by pure functions, so both are tested here without a session.
 *
 * Run with: claude plugin test
 */

import { expect, test } from 'claude-code/testing';

import { classify, chooseModel, LONG_PROMPT, BRIEF_PROMPT } from '../hooks/hud-route.js';
import { barText, barPieces, fit, layout, buildGroups, percentText, modelText, resetText, tone, width } from '../hooks/hud-format.js';

const OPTS = {
    fastModel: 'haiku',
    baseModel: 'sonnet',
    deepModel: 'opus',
    topModel: 'fable',
    routeToTop: true,
    spareAbove: 85,
    barCells: 10,
    ascii: false,
};

const ROOMY = { rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: 0 }] };
const TIGHT = { rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: 0 }] };

test('planning work reads as deep', async () => {
    expect(classify('plan out the migration for the sync layer')).toBe('deep');
    expect(classify('why does this deadlock on the second connection?')).toBe('deep');
    expect(classify('refactor the bookmarks panel')).toBe('deep');
});

test('a typo fix reads as fast', async () => {
    expect(classify('fix the typo in the footer copy')).toBe('fast');
    expect(classify('rename this variable to sessionRowId')).toBe('fast');
});

test('anything else is everyday work, not the cheapest model', async () => {
    // The uncertain case must not fall to the small model: a real task sent
    // there wastes the whole turn, where the reverse wastes a few cents.
    expect(classify('add a column for the last sync time')).toBe('base');
    expect(classify('')).toBe('base');
});

test('a long prompt is deep however it is worded', async () => {
    const long = 'tidy up this file. '.repeat(Math.ceil(LONG_PROMPT / 19) + 1);
    expect(long.length >= LONG_PROMPT).toBe(true);
    expect(classify(long)).toBe('deep');
});

test('a planning prompt that also says rename is still deep', async () => {
    // Both patterns match, and the expensive signal is the reliable one.
    expect(classify('plan the rename of every bookmark field')).toBe('deep');
});

test('asking for the best model in words is enough on its own', async () => {
    // Second-guessing someone who wrote "use the best model" is not thrift.
    expect(classify('use the best model for this')).toBe('top');
    expect(classify('think really hard about this one')).toBe('top');
    expect(classify('use fable here')).toBe('top');
    expect(classify('no shortcuts on this')).toBe('top');
});

test('planning plus whole-system scope reaches the flagship', async () => {
    expect(classify('design the architecture for the entire system')).toBe('top');
    expect(classify('plan a rewrite of the whole codebase')).toBe('top');
    expect(classify('design the schema from scratch')).toBe('top');
});

test('planning plus real stakes reaches the flagship', async () => {
    expect(classify('plan the migration of the production database')).toBe('top');
    expect(classify('design a fix for the data loss in the sync layer')).toBe('top');
});

test('a long planning-shaped brief reaches the flagship', async () => {
    const brief = 'plan this out. ' + 'here is more context about the system. '.repeat(40);
    expect(brief.length >= BRIEF_PROMPT).toBe(true);
    expect(classify(brief)).toBe('top');
});

test('planning on its own is only deep, never the flagship', async () => {
    // Otherwise every design question would go to the most expensive model.
    expect(classify('plan out the migration for the sync layer')).toBe('deep');
    expect(classify('refactor the bookmarks panel')).toBe('deep');
    expect(classify('why does this deadlock?')).toBe('deep');
});

test('scope or stakes without planning is not the flagship', async () => {
    expect(classify('run the tests for the entire project')).not.toBe('top');
    expect(classify('restart production')).not.toBe('top');
});

test('the flagship tier routes to the flagship when there is room', async () => {
    const picked = chooseModel('top', ROOMY, OPTS);
    expect(picked.model).toBe('fable');
    expect(picked.held).toBe(false);
});

test('a thin window steps the flagship down one rung, not to the cheap end', async () => {
    // Whole-system work is still whole-system work when quota is short.
    const picked = chooseModel('top', TIGHT, OPTS);
    expect(picked.model).toBe('opus');
    expect(picked.tier).toBe('deep');
    expect(picked.held).toBe(true);
});

test('turning route_to_top off makes the flagship tier behave as deep', async () => {
    const off = { ...OPTS, routeToTop: false };
    expect(chooseModel('top', ROOMY, off).model).toBe('opus');
    expect(chooseModel('top', TIGHT, off).model).toBe('sonnet');
});

test('an empty top_model also falls back to deep', async () => {
    expect(chooseModel('top', ROOMY, { ...OPTS, topModel: '' }).model).toBe('opus');
});

test('routing up is held back when the five-hour window is nearly gone', async () => {
    const tight = { rateLimits: [{ kind: 'five_hour', percentUsed: 91, resetsAt: 0 }] };
    const picked = chooseModel('deep', tight, OPTS);
    expect(picked.model).toBe('sonnet');
    expect(picked.held).toBe(true);
});

test('and is not held back when there is room', async () => {
    const roomy = { rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: 0 }] };
    const picked = chooseModel('deep', roomy, OPTS);
    expect(picked.model).toBe('opus');
    expect(picked.held).toBe(false);
});

test('small work is never held back, since holding it saves nothing', async () => {
    const tight = { rateLimits: [{ kind: 'five_hour', percentUsed: 99, resetsAt: 0 }] };
    expect(chooseModel('fast', tight, OPTS).model).toBe('haiku');
});

test('a bar is always its stated width, brackets included', async () => {
    for (const pct of [0, 1, 37, 99, 100, -5, 140]) {
        for (const cells of [10, 8]) {
            expect(barText(pct, cells).length).toBe(cells);
        }
    }
});

test('a bar is bracketed, so its extent is visible even when nearly empty', async () => {
    // Without the frame you cannot see where a 4% bar ends, and the strip
    // reads as loose characters rather than as a gauge.
    for (const pct of [0, 4, 50, 100]) {
        const text = barText(pct, 10);
        expect(text.startsWith('[')).toBe(true);
        expect(text.endsWith(']')).toBe(true);
    }
});

test('a bar distinguishes empty, nearly empty, nearly full and full', async () => {
    // 4% drawing as empty would read as a window nobody has touched, and
    // 99% drawing as full would read as one already gone.
    expect(barText(0, 10)).toBe('[········]');
    expect(barText(100, 10)).toBe('[████████]');
    expect(barText(4, 10).indexOf('·') > 1).toBe(true);
    expect(barText(99, 10).indexOf('·')).toBe(-1);
    expect(barText(99, 10)).not.toBe(barText(100, 10));
});

test('the leading edge is what makes ten columns say more than eleven things', async () => {
    // Whole cells give 11 distinct bars across the range. Eighths give 81,
    // which is the difference between seeing 77% move to 81% and not.
    const seen = new Set();
    for (let p = 0; p <= 100; p += 1) seen.add(barText(p, 10));
    expect(seen.size > 60).toBe(true);
    expect(barText(40, 10)).not.toBe(barText(43, 10));
    expect(barText(77, 10)).not.toBe(barText(79, 10));
});

test('the fill is coloured by zone, so a full window shows how it got there', async () => {
    // At 91% the bar runs green, then amber, then red along its length.
    const colours = barPieces(91, 10).filter((p) => p.color).map((p) => p.color);
    expect(colours.includes('green')).toBe(true);
    expect(colours.includes('yellow')).toBe(true);
    expect(colours.includes('red')).toBe(true);

    // At 31% there is nothing but green in it.
    const calm = barPieces(31, 10).filter((p) => p.color).map((p) => p.color);
    expect(calm.every((c) => c === 'green')).toBe(true);
});

test('same-coloured cells are merged, so a bar is a few elements not ten', async () => {
    expect(barPieces(100, 10).length <= 6).toBe(true);
});

test('the bar uses no ambiguous-width character, which would break alignment', async () => {
    // Filled and hollow squares or circles would read better, and are East
    // Asian Ambiguous width: some terminals draw them double-width and the
    // whole strip loses its columns.
    const AMBIGUOUS = /[■□▪▫●○◼◻⬛⬜]/;
    for (const ascii of [false, true]) {
        for (const pct of [0, 33, 66, 100]) {
            expect(AMBIGUOUS.test(barText(pct, 10, ascii))).toBe(false);
        }
    }
});

test('the ascii bar is for a terminal that is not in UTF-8', async () => {
    expect(barText(50, 10, true)).toBe('[####....]');
    expect(/[^\x20-\x7e]/.test(barText(50, 10, true))).toBe(false);
});

test('percentages and model names keep a fixed width, so nothing jitters', async () => {
    expect(percentText(7).length).toBe(4);
    expect(percentText(100).length).toBe(4);
    expect(modelText('haiku').length).toBe(10);
    expect(modelText('sonnet 5.5').length).toBe(10);
    expect(modelText('a-very-long-model-name').length).toBe(10);
});

test('a reset inside the day is a clock time, and beyond it a weekday', async () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    const soon = Math.floor((now + 90 * 60000) / 1000);
    const later = Math.floor((now + 50 * 3600000) / 1000);
    expect(/^\d\d:\d\d$/.test(resetText(soon, now))).toBe(true);
    expect(/^\d\d:\d\d$/.test(resetText(later, now))).toBe(false);
    expect(resetText(0, now)).toBe('');
});

test('the colour changes at the thresholds and nowhere else', async () => {
    // Green to 55, amber 56 to 85, red 86 and up.
    expect(tone(0)).toBe('green');
    expect(tone(55)).toBe('green');
    expect(tone(56)).toBe('yellow');
    expect(tone(85)).toBe('yellow');
    expect(tone(86)).toBe('red');
    expect(tone(100)).toBe('red');
});

test('a fractional reading takes the colour of the number that is printed', async () => {
    // 85.6 prints as 86%, so it has to be red. Comparing before rounding
    // would put a red number beside an amber bar.
    expect(tone(55.4)).toBe('green');
    expect(tone(55.6)).toBe('yellow');
    expect(tone(85.4)).toBe('yellow');
    expect(tone(85.6)).toBe('red');
    expect(percentText(85.6).trim()).toBe('86%');
});

const FULL = {
    model: 'haiku',
    pinned: false,
    routing: true,
    contextPercent: 31,
    rateLimits: [
        { kind: 'five_hour', percentUsed: 18, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        { kind: 'seven_day', percentUsed: 42, resetsAt: Math.floor(Date.now() / 1000) + 200000 },
    ],
};

test('the whole strip fits a wide window', async () => {
    const pieces = fit(buildGroups(FULL, OPTS), 200);
    expect(width(pieces) <= 200).toBe(true);
    expect(pieces.some((p) => p.text.indexOf('5h') === 0)).toBe(true);
});

test('a narrow window sheds the reset times before a whole reading', async () => {
    const groups = buildGroups(FULL, OPTS);
    const full = width(fit(groups, 200));
    const pieces = fit(groups, full - 4);
    expect(pieces.some((p) => p.text.indexOf('\u21bb') >= 0)).toBe(false);
    expect(pieces.some((p) => p.text.indexOf('7d') === 0)).toBe(true);
});

test('a very narrow window keeps the model and drops the rest', async () => {
    const pieces = fit(buildGroups(FULL, OPTS), 16);
    expect(pieces.length > 0).toBe(true);
    expect(pieces[0].text.indexOf('haiku')).toBe(0);
    expect(pieces.some((p) => p.text.indexOf('7d') === 0)).toBe(false);
});

test('a window with no readings at all still names the model', async () => {
    const bare = { model: 'sonnet', pinned: true, routing: false, contextPercent: null, rateLimits: [] };
    const pieces = fit(buildGroups(bare, OPTS), 80);
    expect(pieces[0].text.indexOf('sonnet')).toBe(0);
    expect(pieces.some((p) => p.text.trim() === 'pin')).toBe(true);
});

test('an unknown rate-limit window is left out rather than printed raw', async () => {
    const odd = { ...FULL, rateLimits: [{ kind: 'spend_limit', percentUsed: 10, resetsAt: 0 }] };
    const pieces = fit(buildGroups(odd, OPTS), 200);
    expect(pieces.some((p) => p.text.indexOf('spend') >= 0)).toBe(false);
});

test('a roomy window gets the full bar width', async () => {
    // The bar is several pieces now, so measure from bracket to bracket.
    const pieces = layout(FULL, 120, OPTS);
    const open = pieces.findIndex((p) => p.text === '[');
    expect(open >= 0).toBe(true);
    let w = 0;
    let k = open;
    while (k < pieces.length) { w += pieces[k].text.length; if (pieces[k].text === ']') break; k += 1; }
    expect(w).toBe(OPTS.barCells);
});

test('a narrow window narrows the bars rather than losing a reading', async () => {
    // The seven-day window used to be dropped to save nine characters that
    // were sitting in the bars.
    const pieces = layout(FULL, 70, OPTS);
    expect(width(pieces) <= 70).toBe(true);
    expect(pieces.some((p) => p.text.indexOf('5h') === 0)).toBe(true);
    expect(pieces.some((p) => p.text.indexOf('7d') === 0)).toBe(true);
});

test('the strip never overflows, at any width', async () => {
    for (let cols = 12; cols <= 200; cols += 1) {
        const pieces = layout(FULL, cols, OPTS);
        expect(width(pieces) <= cols || pieces.length <= 3).toBe(true);
    }
});

test('an unmeasured window draws at full width rather than collapsing', async () => {
    for (const columns of [undefined, 0, null]) {
        const pieces = layout(FULL, columns as number, OPTS);
        expect(pieces.some((p) => p.text.indexOf('7d') === 0)).toBe(true);
    }
});

test('/hud says whether it is routing, and stops when told to', async ($) => {
    const status = await $.command.run({ command: 'hud', args: '' });
    expect(status.text.indexOf('routing: on') >= 0).toBe(true);

    const off = await $.command.run({ command: 'hud', args: 'off' });
    expect(off.text.indexOf('Routing off') >= 0).toBe(true);

    const back = await $.command.run({ command: 'hud', args: 'auto' });
    expect(back.text.indexOf('Routing on') >= 0).toBe(true);
});
