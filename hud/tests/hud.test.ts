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

import { classify, chooseModel, LONG_PROMPT } from '../hooks/hud-route.js';
import { bar, fit, layout, buildGroups, percentText, modelText, resetText, tone, width } from '../hooks/hud-format.js';

const OPTS = {
    fastModel: 'haiku',
    baseModel: 'sonnet',
    deepModel: 'opus',
    spareAbove: 85,
    barCells: 10,
    ascii: false,
};

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

test('a bar is always its stated width', async () => {
    for (const pct of [0, 1, 37, 99, 100, -5, 140]) {
        expect(bar(pct, 10).length).toBe(10);
        expect(bar(pct, 8).length).toBe(8);
    }
});

test('a bar distinguishes empty, nearly empty, nearly full and full', async () => {
    // 4% drawing as empty would read as a window nobody has touched.
    expect(bar(0, 10)).toBe('\u2591'.repeat(10));
    expect(bar(4, 10).indexOf('\u2588')).toBe(0);
    expect(bar(99, 10).indexOf('\u2591') >= 0).toBe(true);
    expect(bar(100, 10)).toBe('\u2588'.repeat(10));
});

test('the ascii bar is for a terminal that is not in UTF-8', async () => {
    expect(bar(50, 4, true)).toBe('##..');
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
    expect(tone(0)).toBe('green');
    expect(tone(59)).toBe('green');
    expect(tone(60)).toBe('yellow');
    expect(tone(84)).toBe('yellow');
    expect(tone(85)).toBe('red');
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
    const pieces = layout(FULL, 120, OPTS);
    expect(pieces.some((p) => p.text.length === OPTS.barCells && /^[█░]+$/.test(p.text))).toBe(true);
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
