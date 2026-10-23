/**
 * hud: route each request to the cheapest capable model, and say so.
 *
 * Two halves that share one piece of state.
 *
 * The readout draws above the prompt: which model is in play, how full the
 * context is, and how much of each rate-limit window is gone. All of it comes
 * from `$.session.usage()`, which Claude Code already knows, so nothing is
 * polled and nothing is counted by hand.
 *
 * The routing reads each prompt, decides whether it is small work, everyday
 * work or a planning job, and sends that turn's requests to the matching
 * model. It stands down the moment you choose a model yourself, because a mod
 * that overrode your own `/model` on the next message would be intolerable.
 */

import { layout, barPieces, tone, percentText, badgeText, shortKind, resetText, planBar, planBarFrame,
    headerBar, BAND_BG, BAND_FG, BAND_DIM as BAND_DIM_COLOR, PLAN_ACCENT as TERMINAL_ACCENT } from './hud-format.js';
import { gaugeSvg, gaugeAlt, planSvg, progressAlt, PLAN_ACCENT, PLAN_DONE } from './hud-svg.js';
import { MODELS, shortModel, resolveModel } from './hud-models.js';
import { classify, chooseModel } from './hud-route.js';
import { record, logLines, tuneLines, signalsIn, snippet } from './hud-log.js';
import { buildSuggestPrompt, parseSuggestions } from './hud-suggest.js';
import { readUsage, describeUsage } from './hud-usage.js';
import { spawned, addTokens, tokensOf, merge, visible, prune, shares, comparable,
    elapsedText, tokenText, statusColor, isAlive } from './hud-agents.js';
import { assess, previewFor, countLines, describe, warningFor, recordGuard, RAN, CANCELLED, PASSED } from './hud-blast.js';
import { shouldCheck, buildHeadsPrompt, parseHeadsUp } from './hud-heads.js';
import { readingsFor, worstLevel, needsClock, leadNote, clockText,
    CALM, WATCH, URGENT } from './hud-focus.js';
import { todosFrom, stepsFrom, progressOf, planListRows, countText, worthShowing, applyTaskTool, todosFromTasks, planReport,
    replayPlan, trackingNudge, TRACK_SECTION, reminderStep, reminderText, HUD_TOOL, HUD_TOOL_NAME } from './hud-progress.js';
import { buildPanel, PANE_ID, DEFAULT_COLLAPSED } from './hud-panel.js';
import { emptyStats, addTurn, sessionOf, contextText, statsView, moneyText, spanText } from './hud-stats.js';
import { projectionText } from './hud-pace.js';
import { helpLines } from './hud-help.js';

/** The colour down the left of every terminal row of the HUD: the badge's own, so the two read as one. */
const RAIL_COLOR = TERMINAL_ACCENT;
/** What the bar costs a row, in columns. */
const RAIL_COLS = 1;
/** And the space between it and the row, so the row does not run into it. */
const RAIL_GAP = 1;
/** More lines of bar than the HUD can ever be tall; what is past its bottom is clipped. */
const RAIL_LINES = 40;

/** The edge itself: a thin bar per line, or a plain one for a terminal not in UTF-8. */
function railText(ascii) {
    return Array(RAIL_LINES).fill(ascii ? '|' : '\u258e').join('\n');
}

/**
 * What the strip draws from.
 *
 * Module scope, so it resets when the module reloads. That is the right
 * lifetime: every value here is either about this session or is re-read from
 * Claude Code within a turn.
 */
const state = {
    /** True once you have picked a model by hand. Routing then leaves it alone. */
    pinned: false,
    /** Whether routing is on at all, from the setting and the /hud command. */
    routing: true,
    /** The model routing picked for the current turn, or null before the first prompt. */
    chosen: null,
    /** Why it picked that, for /hud to explain. */
    reason: '',
    /** True when a planning job was held back to spare the five-hour window. */
    held: false,
    contextPercent: null,
    rateLimits: [],
    clockWanted: false,
    clockRunning: false,
    /**
     * What you said when the window was nearly gone, kept for the rest of
     * that window. It used to ask on every prompt and remember nothing, so
     * one answer became ten of the same question at 95%, 97%, 97%.
     */
    quotaDecision: null,
    /**
     * The plan the turn is working through, from the todo list.
     *
     * Null when there is no plan: most turns answer a question and need no
     * bar. See hud-progress.js for why the todo list is the one honest
     * denominator available.
     */
    plan: null,
    /**
     * The tasks the newer task tools have made, which arrive one at a time.
     * TodoWrite sends a whole list and needs none of this; TaskCreate and
     * TaskUpdate send pieces, so the plan has to be kept between calls.
     */
    tasks: [],
    /** The plan item by item, for the sidebar. The bar only needs counts. */
    planItems: [],
    /** How many calls of each plan tool have passed, for `/hud plan`. */
    planSeen: { TodoWrite: 0, TaskCreate: 0, TaskUpdate: 0, TaskList: 0, progress: 0, last: '' },
    /**
     * The sidebar. `paneDismissed` is set when the person closes it, so it is
     * not reopened behind their back; `paneTried` makes the one attempt from
     * the band happen once. `collapsed` is which cards they have folded.
     */
    paneDismissed: false,
    paneTried: false,
    collapsed: { ...DEFAULT_COLLAPSED },
    /** The last few routing decisions, for `/hud log` and `/hud tune`. */
    log: [],
    /** Follow-ups offered under the strip, and whether to ask for them. */
    suggestions: [],
    suggestOn: true,
    /**
     * Whether to stop and ask when the window is nearly gone.
     *
     * On by default, because spending the last of a window on a frontier
     * model is the one decision worth a pause - but only ever once per
     * window, and `/hud confirm off` turns it off for good. Off means the
     * routed model is used without asking.
     */
    confirmOn: true,
    /** The last usage() reply, for `/hud raw`. */
    lastUsage: null,
    /** Subagents this session has seen, and whether a poll is running. */
    agents: [],
    agentTimer: false,
    /** The current heads-up note, and what decides when to look for one. */
    headsNote: null,
    headsOn: true,
    headsSinceLast: 0,
    turnToolCalls: 0,
    /** Whether a destructive command is measured before it runs. */
    blastOn: true,
    /**
     * Whether Claude is asked to keep a task list for a long job, which is the
     * only thing the progress bar can count. Off, the bar shows only when
     * Claude keeps one on its own.
     */
    trackOn: true,
    /** Tool calls with no plan, and reminders sent, for the mid-job reminder. */
    remind: { calls: 0, reminders: 0 },
    /** The tools the last request offered, learned when the prompt was composed. */
    offered: null,
    /**
     * Whether Claude is in the middle of a turn: from the moment a request is
     * sent to the moment its answer lands. The progress bar moves only while
     * this is true, so a bar standing still means nobody is working on it.
     */
    working: false,
    /** Whether the last render drew the terminal's bar, the only one that animates from here. */
    liveBar: false,
    /** What the guard has looked at: how many commands, and the ones it stopped on. */
    guardSeen: 0,
    guards: [],
    /** What the session's turns have spent, for the sidebar. */
    stats: emptyStats(),
};

/**
 * Past this much of the five-hour window, an expensive turn asks first.
 *
 * The holdback is off by default, which is the right call: the tier a
 * prompt earns is the tier it gets. The failure mode that leaves is
 * spending the last of a window on something you would happily have run
 * cheaper, so instead of refusing, it asks - and only when the window is
 * nearly gone and the prompt earned an expensive tier, which is rare
 * enough not to nag.
 */
const CONFIRM_ABOVE = 85;

/**
 * Everything the mod can be told, in one place.
 *
 * These were nine `userConfig` fields, which Claude Code prompts for when a
 * plugin is enabled: installing the mod ended in a notice that nine settings
 * were not filled in and a suggestion to run `/plugin configure`. The mod
 * worked regardless - the defaults were passed in - but a readout you have
 * to configure before it will read anything is a bad trade for options most
 * people will never change. They are constants now, the install is silent,
 * and the only ones worth changing mid-session have `/hud` commands.
 *
 * Edit here to retune.
 *
 * **These must be full model ids, not the aliases.** `haiku`, `sonnet`,
 * `opus` and `fable` are resolved by the command line, for `--model` and
 * `/model`. A `turn.step` hook sets the model on the request itself, which
 * is a layer below that, so an alias arrives as a literal name and the
 * engine answers `There's an issue with the selected model (sonnet). It may
 * not exist` and falls back to something else. The strip shortens these for
 * display, so the readout still says `sonnet 5.5`.
 */
const DEFAULTS = {
    /** Typos, renames, formatting, comments. */
    fastModel: 'claude-haiku-5-5',
    /** Everyday work, and anything the reading is uncertain about. */
    baseModel: 'claude-sonnet-5-5',
    /** Planning, refactors, debugging, root causes. */
    deepModel: 'claude-opus-5-5',
    /** Whole-system briefs, and whenever you ask for the best model. */
    topModel: 'claude-fable-5-1',
    /** Whether the flagship tier is reachable without asking for it by name. */
    routeToTop: true,
    /**
     * The percentage of the five-hour window past which routing stops
     * reaching for a more expensive model on its own.
     *
     * 100 means never hold back: the tier a prompt earns is the tier it
     * gets, even at 99% of the window. Lower it to keep a reserve for work
     * you pick by hand.
     */
    spareAbove: 100,
    /** Bar width in columns, brackets included. */
    barCells: 10,
    /** Draw with plain ASCII, for a terminal that is not in UTF-8. */
    ascii: false,
};

const TIER_KEYS = { fast: 'fastModel', base: 'baseModel', deep: 'deepModel', top: 'topModel' };
const NEWEST_OPUS = 'claude-opus-5-5';

/**
 * Keep the subagent row live, and stop entirely when nothing is running.
 *
 * A fixed timer would tick for the whole session to show a row that is
 * almost never there. This reschedules itself only while an agent is
 * alive, so a session with no subagents runs no timer at all.
 */
/**
 * Look for one thing the last turn may have hidden.
 *
 * Declared at the top level so it can be handed the mods API: a helper
 * defined inside a hook cannot take `$`.
 */
const opts = {};

/**
 * How often the terminal's progress bar redraws while Claude is working, in
 * milliseconds. Five frames a second is enough to read as movement and costs
 * a few rows of text per frame; nothing runs while Claude is idle.
 */
const BAR_FRAME_MS = 200;

async function headsUp($, e) {
    const turn = {
        on: state.headsOn,
        sinceLast: state.headsSinceLast,
        toolCalls: (state.lastTurn && state.lastTurn.toolCalls) || 0,
        answer: e && e.answer,
    };
    if (!shouldCheck(turn)) return;

    state.headsSinceLast = 0;
    try {
        const ask = buildHeadsPrompt(await $.session.messages());
        if (!ask) return;
        const reply = await $.model.complete({ model: opts.fastModel, prompt: ask, maxTokens: 100 });
        const note = parseHeadsUp(reply);
        if (note) {
            state.headsNote = note;
            $.ui.invalidate('ui.render');
        }
    } catch {
        // Silence is the default answer anyway.
    }
}

/** Green while nothing needs you, amber when something does, red when it is nearly gone. */
function readingColor(level) {
    if (level === URGENT) return 'red';
    if (level === WATCH) return 'yellow';
    return 'green';
}

/**
 * Where the fill would be if the window were being spent evenly.
 *
 * Fill past the mark means spending faster than the clock. Without a pace to
 * draw from the gauge keeps its own default mark, which is the edge of the
 * red band - still a useful thing to see coming.
 */
function markFor(reading) {
    const elapsed = reading.pace && reading.pace.elapsed;
    if (typeof elapsed !== 'number') return undefined;
    return Math.max(0, Math.min(100, elapsed * 100));
}

/** The reset, written the way this distance from it deserves. */
function resetFor(reading) {
    if (reading.resetForm === 'countdown') {
        const t = resetText(reading.resetsAt);
        return t ? '↻ ' + t : '';
    }
    if (reading.resetForm === 'clock') {
        const t = clockText(reading.resetsAt);
        return t ? '↻ ' + t : '';
    }
    return '';
}

/**
 * Run the per-minute redraw only while a countdown is on screen.
 *
 * The strip used to redraw every minute from startup to shutdown, whether or
 * not anything on it changed by the minute - roughly 1,400 wake-ups a day to
 * keep two numbers honest. Now the loop is started by the first countdown
 * and stops itself when the last one goes, so the usual state costs nothing.
 */
function wantClock($, wanted) {
    state.clockWanted = !!wanted;
    if (!wanted || state.clockRunning) return;
    state.clockRunning = true;
    const tick = () => {
        if (!state.clockWanted) {
            state.clockRunning = false;
            return;
        }
        $.ui.invalidate('ui.render');
        $.clock.after(60000, tick);
    };
    $.clock.after(60000, tick);
}

/**
 * The switches a person has set, kept across sessions.
 *
 * Nothing the mod was told used to survive a restart. `/hud suggest off`,
 * `/hud know off` and `/hud blast off` all quietly went back to on the next
 * time Claude Code opened, and the README said they stuck. This keeps the four
 * feature switches in the mods store, which is the host's and outlives the
 * module. Routing itself is deliberately not saved: turning it off is
 * something you do for a task, not a standing preference.
 *
 * Every read and write is allowed to fail. A store that is unavailable means
 * the defaults, never a broken session.
 */
const PREF_KEYS = ['suggestOn', 'headsOn', 'blastOn', 'confirmOn', 'trackOn'];
let lastSavedPrefs = '';

async function loadPrefs($) {
    try {
        const saved = await $.store.get('prefs');
        if (saved && typeof saved === 'object') {
            for (const key of PREF_KEYS) {
                // Only a real boolean is believed. Anything else is a value
                // some other version wrote, and the default is safer.
                if (typeof saved[key] === 'boolean') state[key] = saved[key];
            }
        }
        lastSavedPrefs = JSON.stringify(prefsNow());
    } catch {
        // No store: the defaults stand.
    }
}

function prefsNow() {
    const out = {};
    for (const key of PREF_KEYS) out[key] = !!state[key];
    return out;
}

async function savePrefs($) {
    try {
        const now = JSON.stringify(prefsNow());
        // Nothing changed, nothing written: most /hud commands are lookups.
        if (now === lastSavedPrefs) return;
        await $.store.set('prefs', prefsNow());
        lastSavedPrefs = now;
    } catch {
        // Not saved this time. The switch still works for this session.
    }
}

/**
 * The /hud command.
 *
 * A top-level declaration rather than a closure inside register, because
 * Claude Code only lets a function receive `$` if it is declared at the top
 * of the module: a helper defined where it is used cannot be handed the API.
 */
async function hudCommand($, e) {
    const words = String((e && e.args) || '').trim().split(/\s+/).filter(Boolean);
    const verb = (words[0] || '').toLowerCase();

    if (verb === 'off') {
        state.routing = false;
        state.chosen = null;
        $.ui.invalidate('ui.render');
        return { text: 'Routing off. The readout stays, and the model is whatever you set.' };
    }

    if (verb === 'on' || verb === 'auto') {
        state.routing = true;
        state.pinned = false;
        $.ui.invalidate('ui.render');
        return {
            text: 'Routing on. Small work goes to ' + shortModel(opts.fastModel)
                + ', planning to ' + shortModel(opts.deepModel)
                + (opts.routeToTop ? ', whole-system work to ' + shortModel(opts.topModel) : '')
                + '.',
        };
    }

    if (verb === 'help' || verb === '?' || verb === 'guide') {
        return { text: helpLines(words.slice(1).join(' ')).join('\n') };
    }

    if (verb === 'know' || verb === 'heads') {
        const how = (words[1] || '').toLowerCase();
        if (how === 'off') {
            state.headsOn = false;
            state.headsNote = null;
            $.ui.invalidate('ui.render');
            return { text: 'Heads up off. Nothing will be checked and nothing will be spent on it.' };
        }
        if (how === 'on') {
            state.headsOn = true;
            return {
                text: 'Heads up on, checked by ' + shortModel(opts.fastModel) + ' every few substantial turns.',
            };
        }
        return { text: 'Heads up is ' + (state.headsOn ? 'on' : 'off') + '. Use /hud know on or /hud know off.' };
    }

    if (verb === 'blast') {
        const how = (words[1] || '').toLowerCase();
        if (how === 'off') {
            state.blastOn = false;
            return { text: 'Blast radius off. Destructive commands go straight to the usual permission prompt.' };
        }
        if (how === 'on') {
            state.blastOn = true;
            return { text: 'Blast radius on. A destructive command is measured before you are asked.' };
        }
        return { text: 'Blast radius is ' + (state.blastOn ? 'on' : 'off') + '. Use /hud blast on or /hud blast off.' };
    }

    if (verb === 'agents') {
        const seen = state.agents;
        if (!seen.length) return { text: 'No subagents have run in this session.' };
        const rows = seen.map((a) => '  ' + a.name.padEnd(11) + String(a.status).padEnd(11)
            + elapsedText(a.startedAt).padStart(6) + '  ' + tokenText(a.tokens).padStart(7));
        return { text: ['Subagents this session:', ...rows].join(String.fromCharCode(10)) };
    }

    if (verb === 'raw') {
        // What usage() actually returned, for when a field is renamed
        // again and a reading quietly stops appearing.
        return { text: describeUsage(state.lastUsage).join("\n") };
    }

    if (verb === 'log') {
        return { text: ["What the router decided, newest last:", ...logLines(state.log)].join("\n") };
    }

    if (verb === 'tune') {
        return { text: tuneLines(state.log).join("\n") };
    }

    if (verb === 'plan') {
        return {
            text: planReport({ seen: state.planSeen, tasks: state.tasks, plan: state.plan, tracking: state.trackOn,
                items: state.planItems, working: state.working }).join('\n'),
        };
    }

    if (verb === 'track') {
        const how = (words[1] || '').toLowerCase();
        if (how === 'off' || how === 'on') {
            state.trackOn = how === 'on';
            return {
                text: state.trackOn
                    ? 'Plan tracking on. From the next request Claude is asked to keep a task list for any job of three or more steps, and the bar follows it.'
                    : 'Plan tracking off. Nothing is added to the prompt; the bar shows only when Claude keeps a task list on its own.',
            };
        }
        return { text: 'Plan tracking is ' + (state.trackOn ? 'on' : 'off') + '. Use /hud track on or /hud track off.' };
    }

    if (verb === 'panel') {
        const how = (words[1] || '').toLowerCase();
        if (how === 'off' || how === 'close') {
            state.paneDismissed = true;
            try { await $.ui.close({ id: PANE_ID }); } catch { /* not open */ }
            $.ui.invalidate('ui.render');
            return { text: 'Sidebar closed. The strip is back above the prompt.' };
        }
        // Asked for by name, so it is placed at any width.
        state.paneDismissed = false;
        let opened = null;
        try { opened = await $.ui.open({ id: PANE_ID, title: 'HUD' }); } catch { /* no surface */ }
        if (opened && opened.isPlaced) {
            $.ui.invalidate('ui.render');
            return { text: 'Sidebar open. /hud panel off puts the strip back above the prompt.' };
        }
        return { text: 'Nothing here can draw a sidebar. It is made for the desktop app; the strip above the prompt stays.' };
    }

    if (verb === 'confirm') {
        const how = (words[1] || '').toLowerCase();
        if (how === 'off') {
            state.confirmOn = false;
            return { text: 'No more questions near the limit. Work goes to the model it was routed to, and a window that runs out simply waits for its reset.' };
        }
        if (how === 'on') {
            state.confirmOn = true;
            return { text: 'It will ask once per window, when the five-hour window passes ' + CONFIRM_ABOVE + '% and the work is expensive.' };
        }
        return { text: 'Asking near the limit is ' + (state.confirmOn ? 'on, once per window' : 'off') + '. Use /hud confirm on or /hud confirm off.' };
    }

    if (verb === 'suggest') {
        const how = (words[1] || '').toLowerCase();
        if (how === 'off') {
            state.suggestOn = false;
            state.suggestions = [];
            $.ui.invalidate('ui.render');
            return { text: 'Follow-up suggestions off. Nothing will call a model on your behalf.' };
        }
        if (how === 'on') {
            state.suggestOn = true;
            return { text: 'Follow-up suggestions on, asked of ' + shortModel(opts.fastModel) + ' after each turn.' };
        }
        return { text: 'Suggestions are ' + (state.suggestOn ? 'on' : 'off') + '. Use /hud suggest on or /hud suggest off.' };
    }

    if (verb === 'models') {
        const rows = MODELS.map((m) => '  ' + m.short.padEnd(11) + m.id.padEnd(20) + m.note);
        return {
            text: ['Models a tier can be set to:', ...rows,
                '', 'Set one with /hud set <tier> <model>, as in /hud set deep opus 4.8.',
                'A bare family name means its newest: opus is ' + shortModel(NEWEST_OPUS) + '.'].join('\n'),
        };
    }

    if (verb === 'set') {
        const tier = (words[1] || '').toLowerCase();
        const key = TIER_KEYS[tier];
        if (!key) {
            return { text: 'Which tier? One of: fast, base, deep, top. As in /hud set deep opus.' };
        }
        const wanted = resolveModel(words.slice(2).join(' '));
        if (!wanted) {
            return {
                text: 'No model by that name. Run /hud models to see the list, or give a full id such as claude-opus-5-5.',
            };
        }
        opts[key] = wanted;
        // The tier of the turn already decided is stale now.
        state.chosen = null;
        $.ui.invalidate('ui.render');
        return {
            text: tier + ' work now goes to ' + shortModel(wanted) + ' (' + wanted + ')'
                + ' for this session. Edit DEFAULTS in register.js to make it permanent.',
        };
    }

    const lines = [
        'routing: ' + (state.routing ? 'on' : 'off') + (state.pinned ? ', standing down because you picked a model' : ''),
        'next request: ' + (state.chosen ? shortModel(state.chosen) : 'whatever the session is on')
            + (state.reason ? ' (' + state.reason + ')' : ''),
        '',
        '  fast  ' + shortModel(opts.fastModel),
        '  base  ' + shortModel(opts.baseModel),
        '  deep  ' + shortModel(opts.deepModel),
        '  top   ' + (opts.routeToTop ? shortModel(opts.topModel) : 'off'),
        '',
        'context: ' + (state.contextPercent == null ? 'unknown' : Math.round(state.contextPercent) + '% used'),
    ];
    for (const limit of state.rateLimits) {
        lines.push(limit.kind + ': ' + Math.round(limit.percentUsed) + '% used');
    }
    if (!state.rateLimits.length) {
        lines.push('quota: not reported for this account');
    }
    lines.push('');
    lines.push('');
    lines.push('  /hud help [topic]        everything the mod does and how to use it best');
    lines.push('  /hud off | auto          stop routing, or hand the choice back');
    lines.push('  /hud models              every model a tier can be set to');
    lines.push('  /hud set <tier> <model>  point one tier somewhere else');
    lines.push('  /hud log                 what was routed where, and why');
    lines.push('  /hud tune                what the log says about the patterns');
    lines.push('  /hud suggest on | off    follow-ups under the strip');
    lines.push('  /hud confirm on | off    the question near the limit (asked once per window)');
    lines.push('  /hud panel [off]         the desktop sidebar: open it, or put the strip back');
    lines.push('  /hud plan                what the progress bar has seen, and why it is or is not showing');
    lines.push('  /hud track on | off      ask Claude to keep a task list for long jobs, so the bar can show');
    lines.push('  /hud know on | off       one thing you may have missed, after a big turn');
    lines.push('  /hud blast on | off      measure a destructive command before running it');
    lines.push('  /hud agents              every subagent this session has run');
    lines.push('  /hud raw                 what usage() reported, if a reading is missing');
    return { text: lines.join('\n') };
}

/**
 * The model's name, as the strip and the sidebar both say it.
 *
 * What was chosen for this turn if routing chose one, else what the session
 * reports, else a question mark. Asked in one place so the two cannot name
 * different models.
 */
async function modelName($) {
    if (state.chosen) return shortModel(state.chosen);
    try {
        const current = await $.session.model();
        const raw = typeof current === 'string'
            ? current
            : (current && (current.display_name || current.displayName || current.id)) || '?';
        return shortModel(raw);
    } catch {
        return '?';
    }
}

/**
 * Open the sidebar, unless the person closed it.
 *
 * Only ever called for the desktop app. The terminal never attaches through
 * `session.attach` and is never offered this, which is what keeps it exactly
 * as it was: panes exist there too, so opening one unconditionally would
 * have changed a terminal that was already right.
 */
async function openSidebar($) {
    if (state.paneDismissed) return false;
    try {
        const opened = await $.ui.open({ id: PANE_ID, title: 'HUD' });
        return !!(opened && opened.isPlaced);
    } catch {
        return false;
    }
}

/**
 * Is the sidebar actually on screen right now?
 *
 * Asked of the engine each time rather than remembered, because it changes
 * without us: a narrow window leaves it opened but undrawn, and the person can
 * close it. The strip above the prompt steps aside only while this is true, so
 * the information is never missing from both places at once.
 */
async function sidebarShown($) {
    try {
        const panes = await $.ui.panes();
        return panes.some((pane) => pane.id === PANE_ID && pane.isPlaced);
    } catch {
        return false;
    }
}

/**
 * The switches the sidebar shows, in the order it shows them.
 *
 * Each is the same switch the /hud command flips, so there is one rule for
 * what turning it on or off does and the sidebar cannot disagree with the
 * command. `field` is where the switch lives in `state`.
 */
const SWITCHES = [
    { key: 'routing', field: 'routing', label: 'Routing', hint: 'cheapest capable model for each prompt' },
    { key: 'suggest', field: 'suggestOn', label: 'Follow-ups', hint: 'three next steps after each turn' },
    { key: 'know', field: 'headsOn', label: 'Heads up', hint: 'one thing you may have missed' },
    { key: 'blast', field: 'blastOn', label: 'Blast radius', hint: 'measure a destructive command first' },
    { key: 'confirm', field: 'confirmOn', label: 'Ask near the limit', hint: 'once per window, when it is nearly gone' },
    { key: 'track', field: 'trackOn', label: 'Plan tracking', hint: 'ask Claude to report the steps of a long job' },
];

/**
 * Flip one switch, through the /hud command so the rule lives in one place,
 * and keep it for next time.
 *
 * Top level because it is handed `$`. It never throws: a press that fails
 * must not take the sidebar down with it.
 */
async function flipSwitch($, key) {
    const found = SWITCHES.find((s) => s.key === key);
    if (!found) return;
    try {
        const verb = state[found.field] ? 'off' : 'on';
        await hudCommand($, { args: key === 'routing' ? verb : key + ' ' + verb });
        await savePrefs($);
    } catch {
        // Not flipped. The next redraw shows the truth either way.
    }
    $.ui.invalidate('ui.render');
}

/** Point one tier at another model, through /hud set. Never throws. */
async function setTier($, tier, id) {
    try {
        await hudCommand($, { args: 'set ' + tier + ' ' + id });
    } catch {
        // Unchanged. The picker redraws with what the tier still is.
    }
    $.ui.invalidate('ui.render');
}

/** Hand control back to routing after a model was picked by hand. */
async function backToAuto($) {
    try {
        await hudCommand($, { args: 'auto' });
    } catch {
        // Still pinned; the badge says so.
    }
    $.ui.invalidate('ui.render');
}

/**
 * Remember a destructive command the guard stopped on, for the sidebar.
 * Top level because it is handed `$` to ask for the redraw.
 */
function flagGuard($, found, count, outcome) {
    state.guards = recordGuard(state.guards, { kind: found.kind, text: describe(found, count), outcome });
    $.ui.invalidate('ui.render');
}

/**
 * The plan as the transcript left it, read back once when the module starts.
 *
 * Top level because it is handed the API. Never throws: no transcript means the
 * plan in hand is left as it was.
 */
async function restorePlan($) {
    let found;
    try {
        found = replayPlan(await $.session.messages());
    } catch {
        // No transcript to read. Whatever is in hand stays.
        return;
    }
    // Replaced, not added to: the transcript is the whole truth. A session
    // that was cleared replays to nothing, which is exactly right.
    state.planSeen = { ...found.counts };
    state.tasks = found.tasks;
    const items = found.source === 'todos' ? found.todos : todosFromTasks(found.tasks);
    const plan = progressOf(items);
    state.plan = plan;
    state.planItems = plan ? items : [];
    $.ui.invalidate('ui.render');
}

/**
 * The plan to draw: the steps Claude wrote down, and nothing else.
 *
 * Never a guess. A bar that shows a count nobody counted is how a bar comes to
 * be distrusted, and an earlier version asked a small model to work a plan out
 * from the work and drew it with a tilde: it showed 4 of 9 under a finished
 * answer, with the 9 and the 4 both invented. No steps written, no bar.
 */
function shownPlan() {
    // Only while Claude is working. When it stops, a list that still has
    // tasks pending is not progress being made: it is either work waiting on
    // you, or tasks Claude finished without ticking or never meant to do, and
    // a bar that stands there saying 6/9 under a finished answer claims work
    // that is not there. The list is kept, so the bar is back, with the same
    // counts, the moment Claude takes its next step; `/hud plan` lists it.
    if (state.working && worthShowing(state.plan)) return { plan: state.plan, items: state.planItems };
    return { plan: null, items: [] };
}

/** Everything the sidebar draws, gathered from state that is already there. */
function panelData($, model) {
    const readings = readingsFor({
        contextPercent: state.contextPercent,
        rateLimits: state.rateLimits,
        labelOf: shortKind,
    });
    const agents = visible(state.agents);
    const session = sessionOf(state.lastUsage);
    const now = Date.now();
    const shown = shownPlan();
    return {
        model,
        pinned: state.pinned,
        routingOn: state.routing,
        reason: state.reason,
        held: state.held,
        readings,
        worst: worstLevel(readings),
        contextDetail: contextText(session),
        projections: Object.fromEntries(readings
            .filter((r) => r.pace)
            .map((r) => [r.key, projectionText(r.pace)])),
        session: {
            cost: session.costUsd === null ? '' : moneyText(session.costUsd),
            age: session.startedAt === null ? '' : spanText(now - session.startedAt),
        },
        stats: statsView(state.stats),
        plan: shown.plan,
        planItems: shown.items,
        agents,
        agentShares: shares(agents),
        headsNote: state.headsNote,
        suggestions: state.suggestions,
        guard: { on: state.blastOn, seen: state.guardSeen, flagged: state.guards.slice().reverse() },
        tiers: {
            fast: shortModel(opts.fastModel),
            base: shortModel(opts.baseModel),
            deep: shortModel(opts.deepModel),
            top: opts.routeToTop ? shortModel(opts.topModel) : 'off',
        },
        tierIds: { fast: opts.fastModel, base: opts.baseModel, deep: opts.deepModel },
        models: MODELS.map((m) => ({ value: m.id, label: m.short })),
        // Newest first, which is how a person reads "recent".
        log: state.log.slice().reverse().map((entry) => ({
            tier: entry.tier,
            short: entry.short,
            text: entry.text,
            signals: entry.signals,
        })),
        switches: SWITCHES.map((s) => ({ key: s.key, label: s.label, hint: s.hint, on: !!state[s.field] })),
        collapsed: state.collapsed,
        resetCountdown: resetText,
        toggle: (key) => {
            state.collapsed = { ...state.collapsed, [key]: !state.collapsed[key] };
            $.ui.invalidate('ui.render');
        },
        onSwitch: (key) => flipSwitch($, key),
        onTier: (tier, id) => setTier($, tier, id),
        onAuto: () => backToAuto($),
        onDismissHeads: () => {
            state.headsNote = null;
            $.ui.invalidate('ui.render');
        },
        onSuggestion: (text) => {
            state.suggestions = [];
            $.ui.invalidate('ui.render');
            $.prompt.submit({ text, asUser: true });
        },
    };
}

async function pollAgents($) {
    if (state.agentTimer) return;
    state.agentTimer = true;

    const step = async () => {
        try {
            state.agents = merge(state.agents, await $.agent.list());
        } catch {
            // The list is the only source of a status, but losing it for
            // one tick is not worth blanking the row over.
        }
        state.agents = prune(state.agents);
        $.ui.invalidate('ui.render');

        if (state.agents.some((a) => isAlive(a.status))) {
            $.clock.after(2000, step);
        } else {
            state.agentTimer = false;
            $.ui.invalidate('ui.render');
        }
    };

    $.clock.after(2000, step);
}

export function register(on) {
    Object.assign(opts, DEFAULTS);

    // Everything this mod does at session start, in one hook: registering two
    // hooks on the same event without matchers is a load error.
    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'hud',
            description: 'Show what hud is doing, change a tier, or turn routing on and off',
            argumentHint: '[help|on|off|auto|models|set|log|tune|suggest|know|blast|confirm|panel|plan|track|agents]',
        });

        // What you switched off last time stays off.
        await loadPrefs($);

        // The mod's own tool for reporting the steps of a job: always listed,
        // never behind ToolSearch, so it is there in a session where Claude
        // Code has no task tools of its own. See HUD_TOOL in hud-progress.js.
        try {
            await $.tool.register({
                name: HUD_TOOL_NAME,
                description: 'Report the steps of the current job to the progress bar the person is watching. '
                    + 'Call it with every step, each with a status of todo, doing or done, before the first tool call of a job of three or more steps, '
                    + 'and again with the whole list each time a step starts and each time one finishes, with exactly one step doing at a time. '
                    + 'Call it one last time before you stop, with every step done and any step you dropped left out. '
                    + 'The bar counts these steps and nothing else. Skip it for a question or a single small edit.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        steps: {
                            type: 'array',
                            description: 'Every step of the job, in order, each time. Two or more.',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string', description: 'The step, a few words, in the present tense while it is being done.' },
                                    status: { type: 'string', enum: ['todo', 'doing', 'done'] },
                                },
                                required: ['title', 'status'],
                            },
                        },
                    },
                    required: ['steps'],
                },
                // Not behind ToolSearch: a long job does not go looking for it.
                isDeferred: false,
            });
        } catch {
            // A Claude Code without mod tools: the task tools still feed the bar.
        }

        // The terminal's bar moves while Claude works. One timer, asked for
        // once, and quiet unless a bar is on screen and a turn is running.
        $.clock.every(BAR_FRAME_MS, () => {
            if (state.liveBar && shownPlan().plan) $.ui.invalidate('ui.render');
        });

        // A reload or a resume starts this module with nothing, while the
        // session's task list carries on. Read it back so the bar is there now,
        // not after the next task call.
        // A new, cleared or resumed session keeps its own tally.
        state.remind = { calls: 0, reminders: 0 };
        state.working = false;
        state.stats = emptyStats();
        state.guardSeen = 0;
        state.guards = [];

        await restorePlan($);

        // The sidebar is for the desktop app. The terminal is not offered it,
        // so it is exactly as it was.
        try {
            if ((await $.session.surfaces()).includes('desktop')) await openSidebar($);
        } catch {
            // No surface to ask: nothing to open.
        }

        // No timer is started here any more. The strip asks for one while a
        // countdown is actually on screen and lets it go when the last one
        // leaves; see wantClock. Everything else is driven by events.
        try {
            const usage = await $.session.usage();
            // Read defensively: insisting on one spelling of these fields is
            // how the context reading and every reset time went missing from
            // a working strip.
            const read = readUsage(usage);
            state.contextPercent = read.contextPercent;
            state.rateLimits = read.rateLimits;
            state.lastUsage = usage;
        } catch {
            // No usage yet. The first turn's session.measure fills it in.
        }
        return next(e);
    });

    // Claude Code fires this after each turn and whenever a limit's percentage
    // moves, which is exactly when the strip is out of date. No timer, so the
    // readout costs nothing between turns.
    on('session.measure', async ($, e, next) => {
        try {
            const usage = await $.session.usage();
            // Read defensively: insisting on one spelling of these fields is
            // how the context reading and every reset time went missing from
            // a working strip.
            const read = readUsage(usage);
            state.contextPercent = read.contextPercent;
            state.rateLimits = read.rateLimits;
            state.lastUsage = usage;
            $.ui.invalidate('ui.render');
        } catch {
            // Leave the last known numbers up rather than blanking the strip.
        }
        return next(e);
    });

    // The prompt is the only place the task is visible: turn.step carries the
    // request, not the words that prompted it. So the decision is made here
    // and applied there.
    on('prompt.submit', async ($, e, next) => {
        // From here until its answer lands, Claude is working: the bar moves.
        state.working = true;
        state.held = false;
        // Last turn's follow-ups are about last turn.
        state.suggestions = [];

        // Kept whether or not routing acts on it: the follow-ups are about this
        // prompt even when the model was picked by hand. Only what the suggester
        // can use, so the whole prompt is not held in memory.
        state.lastPrompt = String(e.text || '').slice(0, 300);

        if (!state.routing || state.pinned) {
            state.chosen = null;
            state.reason = state.pinned ? 'you picked this model' : 'routing is off';
            return next(e);
        }

        const tier = classify(e.text);
        let picked = chooseModel(tier, state, opts);

        // An expensive turn with the window nearly gone is the one case worth
        // interrupting for. Waiting inside `$.ui.ask` does not count against
        // the hook's time limit; waiting on a promise of our own would.
        const five = (state.rateLimits || []).find((l) => l.kind === 'five_hour');
        const used = five && typeof five.percentUsed === 'number' ? five.percentUsed : 0;
        const expensive = picked.tier === 'top' || picked.tier === 'deep';
        // Below the line again means the window reset: the next time it is
        // nearly gone is a new question, asked once.
        if (used < CONFIRM_ABOVE) state.quotaDecision = null;

        if (expensive && used >= CONFIRM_ABOVE && state.confirmOn) {
            const cheaper = picked.tier === 'top' ? opts.deepModel : opts.baseModel;
            const goOn = 'Use ' + shortModel(picked.model);
            const instead = 'Use ' + shortModel(cheaper) + ' instead';
            let answer = goOn;
            if (state.quotaDecision) {
                // Already answered this window. A typed answer that was not
                // one of the options counts as "carry on", and either way
                // the point is that it is not asked again.
                answer = state.quotaDecision === 'cheaper' ? instead : goOn;
            } else try {
                answer = await $.ui.ask(
                    'The five-hour window is ' + Math.round(used) + '% used, and this reads as '
                        + picked.tier + ' work. Which model should it go to?',
                    [goOn, instead, 'Cancel this prompt'],
                );
            } catch {
                // Dismissed, or nobody there to ask in a -p run. Carry on as
                // chosen rather than silently downgrading a decision.
            }
            if (answer === 'Cancel this prompt') {
                // Cancelling one prompt is not a standing order.
                return { drop: 'Cancelled, so the window keeps what was left of it.' };
            }
            if (!state.quotaDecision) {
                state.quotaDecision = answer === instead ? 'cheaper' : 'go';
            }
            if (answer === instead) {
                picked = { model: cheaper, tier: picked.tier === 'top' ? 'deep' : 'base', held: true };
            }
        }

        state.chosen = picked.model;
        state.held = picked.held;
        state.reason = picked.held
            ? tier + ' work, held at ' + shortModel(picked.model) + ' to spare the five-hour window'
            : tier + ' work';
        state.log = record(state.log, {
            tier: picked.tier,
            short: shortModel(picked.model),
            text: snippet(e.text),
            signals: signalsIn(e.text),
        });
        $.ui.invalidate('ui.render');
        return next(e);
    });

    // Follow-ups, asked for once a turn has something to follow.
    on('turn.complete', async ($, e, next) => {
        // A finished plan is a receipt, and the turn ending is receipt
        // enough. An unfinished one stays: the work is still outstanding and
        // the next turn usually picks it up.
        if (state.plan && state.plan.complete) {
            state.plan = null;
            state.planItems = [];
        }

        // The turn is over, aborted or not: the bar stops where it is.
        if (!e.agentId) {
            state.working = false;
            $.ui.invalidate('ui.render');
        }

        const result = await next(e);
        // The main thread's own turns. A subagent's tokens are counted on its row.
        if (!e.agentId) {
            state.stats = addTurn(state.stats, e);
            $.ui.invalidate('ui.render');
        }
        if (e.agentId || e.isAborted) return result;


        state.headsSinceLast += 1;
        const toolCalls = state.turnToolCalls;
        state.turnToolCalls = 0;
        state.lastTurn = { answer: e.answer, toolCalls };

        if (!state.suggestOn) {
            await headsUp($, e);
            return result;
        }

        const ask = buildSuggestPrompt(state.lastPrompt, e.answer);
        if (!ask) return result;

        try {
            const reply = await $.model.complete({
                model: opts.fastModel,
                prompt: ask,
                maxTokens: 120,
            });
            const picked = parseSuggestions(reply);
            if (picked.length) {
                state.suggestions = picked;
                $.ui.invalidate('ui.render');
            }
        } catch {
            // No suggestions is a fine outcome. It is a convenience, and a
            // failure here must not colour the turn that just succeeded.
        }

        await headsUp($, e);
        return result;
    });

    // A turn makes one request per step, and each one is redirected. Written as
    // a generator because the response streams: yield* forwards it and gives
    // back the finished result.
    // A subagent starting is the only moment the monitor needs to wake up.
    on('agent.spawn', async ($, e, next) => {
        state.agents = spawned(state.agents, e);
        await pollAgents($);
        $.ui.invalidate('ui.render');
        return next(e);
    });

    on('turn.step', async function* ($, e, next) {
        // A subagent resolves its own model, from its definition or from
        // whoever spawned it. Routing the main conversation should not quietly
        // downgrade a subagent somebody chose a model for. Its spend is still
        // worth recording: that is what the monitor row is measuring.
        if (e.agentId) {
            const subResult = yield* next(e);
            state.agents = addTokens(state.agents, e.agentId, tokensOf(subResult && subResult.usage));
            return subResult;
        }
        if (!state.routing || state.pinned || !state.chosen) return yield* next(e);
        if (state.chosen === e.model) return yield* next(e);
        return yield* next({ ...e, model: state.chosen });
    });

    // This fires only for a switch you asked for: /model, the picker, Option+P.
    // Automatic fallbacks do not reach it, which is what makes it a reliable
    // signal that the choice is now yours.
    // Measure a destructive command before agreeing to it. Claude Code
    // already asks; what it cannot say is how big the thing is.
    // The plan, as it is written and as each item lands.
    //
    // No polling and no timer: the todo list only changes when this tool
    // writes it, so this hook is the whole mechanism. It reads the list and
    // gets out of the way - it never blocks or alters the call.
    on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
        try {
            // A subagent's todo list is its own, not the job you are watching.
            if (!e.agentId) {
                state.working = true;
                state.planSeen.TodoWrite += 1;
                state.planSeen.last = 'TodoWrite';
                const list = todosFrom(e);
                const plan = progressOf(list);
                // A list cut below two items is no plan: the old bar must not linger.
                state.plan = plan;
                state.planItems = plan ? list : [];
                $.ui.invalidate('ui.render');
            }
        } catch {
            // A shape this does not recognise is not worth a broken turn.
        }
        return next(e);
    }).catch(async ($, e, next) => {
        // Fails open, like the Bash hook: reading the plan is decoration,
        // and decoration must never be the reason a tool call fails.
        return next(e);
    });

    // The mod's own tool: the whole list, each time, like TodoWrite. The main
    // conversation's only; a subagent's steps are its own.
    on('tool.call', { tool: HUD_TOOL }, async ($, e) => {
        if (e.agentId) return { result: 'ignored: only the main session reports the steps of the job' };
        state.working = true;
        const list = stepsFrom(e);
        const plan = progressOf(list);
        state.planSeen.progress += 1;
        state.planSeen.last = 'progress';
        state.plan = plan;
        state.planItems = plan ? list : [];
        $.ui.invalidate('ui.render');
        if (!plan) return { result: 'ignored: a plan needs at least two steps, so no bar is drawn' };
        return { result: 'ok: ' + countText(plan) + ' done' + (plan.complete ? ', finished' : '') };
    }).catch(async () => ({ result: 'ignored: the steps could not be read' }));

    // Plan tracking. The bar can only count a task list, and a long job run
    // without one - most often one handed to subagents a step at a time - has
    // nothing to count. So the mod asks for one in a short section at the end
    // of the system prompt. Fixed text, so the prompt cache pays for it once.
    // /hud track off stops it.
    //
    // The task tools are placed behind ToolSearch by Claude Code, and a
    // tool.describe hook that answers isDeferred: false for them is run but
    // not honoured for a built-in tool (checked against a real session), so
    // the note says how to load them instead.
    on('prompt.compose', async ($, e, next) => {
        const out = await next(e);
        if (Array.isArray(e.tools)) state.offered = e.tools.slice();
        if (!state.trackOn || !out || !Array.isArray(out.sections)) return out;
        const text = trackingNudge(e.tools);
        if (!text || out.sections.some((section) => section.id === TRACK_SECTION)) return out;
        return { ...out, sections: [...out.sections, { id: TRACK_SECTION, text, scope: 'session' }] };
    }).catch(async ($, e, next) => next(e));

    // The reminder. A session that has been working for hours has hundreds
    // of calls with no task list in them, and the note in the system prompt
    // cannot outweigh that. This puts one sentence beside a tool result,
    // in the middle of the work, once the job has run for a while with no
    // plan; see reminderStep for how often. It never changes the result.
    on('tool.call', async ($, e, next) => {
        // A main-thread tool call is Claude at work, however the turn began
        // (a queued message, a resumed session): the bar must not depend on
        // having seen the prompt go out.
        if (!e.agentId) state.working = true;
        const result = await next(e);
        try {
            // A subagent's work is its own, and a refused or failed call
            // is not progress.
            if (e.agentId || !result || result.deny || result.isError) return result;
            if (e.tool === 'ToolSearch' || e.tool === 'TaskCreate' || e.tool === 'TaskUpdate'
                || e.tool === 'TaskList' || e.tool === 'TodoWrite' || e.tool === HUD_TOOL) return result;
            // With a bar showing there is nothing to nag about.
            const step = reminderStep(state.remind, { on: state.trackOn, planned: shownPlan().plan !== null });
            state.remind = step.r;
            if (!step.fire) return result;
            const text = reminderText(state.offered);
            if (!text) return result;
            return { ...result, context: [...(result.context || []), text] };
        } catch {
            // Decoration. Never the reason a tool call fails.
            return result;
        }
    }).catch(async ($, e, next) => next(e));

    // The desktop app joined the session: give it the sidebar. The terminal's
    // own attachment raises nothing, so this never fires for it.
    on('session.attach', async ($, e, next) => {
        if (e.surface === 'desktop') await openSidebar($);
        return next(e);
    }).catch(async ($, e, next) => next(e));

    // The person closed it. Remember, so it is not reopened behind their back;
    // the strip above the prompt comes back by itself, since the sidebar is no
    // longer shown. `/hud panel` opens it again.
    on('ui.close', async ($, e, next) => {
        if (e.id === PANE_ID && e.origin === 'person') {
            state.paneDismissed = true;
            $.ui.invalidate('ui.render');
        }
        return next(e);
    }).catch(async ($, e, next) => next(e));

    // The sidebar itself. Drawn from state alone, like the strip, so a redraw
    // is arithmetic on numbers already gathered and no request.
    //
    // The id is written out rather than taken from PANE_ID so the validator
    // can read it; a test pins the two together.
    on('ui.render', { component: 'Pane', requestId: 'hud' }, async ($, e, next) => {
        // Only the desktop app is given this. Anything else asking falls
        // through to whatever else would draw.
        if (e.surface !== 'desktop') return next(e);
        const ui = $.ui.resolve(e);
        if (typeof ui.Svg !== 'function') return next(e);
        return buildPanel(ui, panelData($, await modelName($)));
    });

    // The same plan, from the task tools an interactive session actually uses.
    //
    // TaskCreate adds one task and answers with its id; TaskUpdate flips one
    // by that id; TaskList answers with all of them. Each is read *after* it
    // has run, because the id only exists in the answer. The hook never
    // blocks, rewrites or delays the call, and a shape it does not recognise
    // leaves the bar as it was.
    for (const tool of ['TaskCreate', 'TaskUpdate', 'TaskList']) {
        on('tool.call', { tool }, async ($, e, next) => {
            const result = await next(e);
            // A subagent's task list is its own, not the job you are watching.
            if (e.agentId) return result;
            try {
                state.working = true;
                state.planSeen[tool] += 1;
                state.planSeen.last = tool;
                state.tasks = applyTaskTool(state.tasks, tool, e, result);
                const plan = progressOf(todosFromTasks(state.tasks));
                state.plan = plan;
                state.planItems = todosFromTasks(state.tasks);
                $.ui.invalidate('ui.render');
            } catch {
                // Decoration. Never the reason a tool call fails.
            }
            return result;
        }).catch(async ($, e, next) => next(e));
    }

    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
        // The heads-up check weighs the main thread's own work, not its subagents'.
        if (!e.agentId) state.turnToolCalls += 1;
        if (!state.blastOn) return next(e);
        state.guardSeen += 1;

        const found = assess(e.command);
        if (!found) return next(e);

        // The preview is argv, never a shell string, and every verb in it
        // is fixed by which pattern matched. The only part taken from the
        // command is the target, and it travels as one array element.
        let count = null;
        const preview = previewFor(found);
        if (preview) {
            try {
                const run = await $.process.run(preview.argv, { timeout: 10000 });
                if (run && run.exitCode === 0) count = countLines(run.stdout);
            } catch {
                // Unmeasurable. The question is still worth asking, just
                // without a number in it.
            }
        }

        const warning = warningFor(found);
        const question = describe(found, count) + (warning ? ' ' + warning : '')
            + '\n\n' + e.command;

        let answer = 'Run it';
        try {
            answer = await $.ui.ask(question, ['Run it', 'Cancel']);
        } catch {
            // Nobody to ask, as in a -p run. Fall through to the usual
            // permission prompt rather than blocking unattended work.
            flagGuard($, found, count, PASSED);
            return next(e);
        }
        if (answer !== 'Run it') {
            flagGuard($, found, count, CANCELLED);
            return { deny: 'The user cancelled this command after seeing what it would affect.' };
        }
        flagGuard($, found, count, RAN);
        return next(e);
    }).catch(async ($, e, next) => {
        // Fails open. A guard that blocks your work when it has a bug is
        // worse than no guard, and Claude Code still asks on its own.
        return next(e);
    });

    on('classic.PreModelSwitch', async ($, e, next) => {
        state.pinned = true;
        state.chosen = null;
        state.reason = 'you picked this model';
        $.ui.invalidate('ui.render');
        return next(e);
    });

    // Whatever the command changed is kept for next time.
    on('command.run', { command: 'hud' }, async ($, e) => {
        const out = await hudCommand($, e);
        await savePrefs($);
        return out;
    });

    // The strip itself. Drawn from `state` alone, so this stays cheap: the
    // numbers were gathered when they changed, not here.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        // No early return for "nothing measured yet": the model is always
        // worth saying, and a strip that appears a turn late looks broken.
        const { Box, Text, Svg, Button } = $.ui.resolve(e);
        // The column is ten wide and the ids are not: 'claude-sonnet-5-5'
        // would draw as 'claude-son'. modelName shortens it.
        const model = await modelName($);

        // On the desktop the strip moves into the sidebar, while the sidebar is
        // actually on screen. One attempt to open it from here covers a desktop
        // that attached before this module was listening.
        if (e.surface === 'desktop' && !state.paneTried) {
            state.paneTried = true;
            await openSidebar($);
        }
        const sidebar = e.surface === 'desktop' && (await sidebarShown($));
        // The terminal's rows each carry the HUD's colour down their left edge,
        // so what is the HUD is plain at a glance. The edge costs a column.
        const railOn = !sidebar && !(e.surface === 'desktop' && typeof Svg === 'function');
        const railCols = railOn ? RAIL_COLS + RAIL_GAP : 0;

        // Worked out once and used by both surfaces, so the terminal and the
        // desktop can never disagree about what matters.
        const readings = readingsFor({
            contextPercent: state.contextPercent,
            rateLimits: state.rateLimits,
            labelOf: shortKind,
        });
        const worst = worstLevel(readings);
        const lead = leadNote(readings);

        // The one timer in the mod, asked for only while something on screen
        // counts down by the minute. A reset two days out is drawn as the
        // time of day it happens, which does not go stale - so most of the
        // time this costs nothing at all.
        wantClock($, needsClock(readings));

        let strip = null;
        let header = null;
        if (sidebar) {
            // The sidebar carries the strip, the plan and the agents. Nothing
            // is built here, so a shown sidebar costs the band nothing.
        } else if (e.surface === 'desktop' && typeof Svg === 'function') {
            // The Desktop app draws vector art, so it gets a real gauge
            // rather than a drawing made of characters. Labels stay as Text,
            // which follows the app's light or dark theme; only the gauges
            // are pictures, and nothing in them assumes a background.
            // Every reading stays on screen. What changes is how loudly
            // each is said: a calm window is dim and narrow, one worth
            // watching takes its colour and its gauge back, and one about to
            // run dry gets a sentence under the strip.
            //
            // **Laid out in groups that never break.** This used to be one
            // flat row of loose pieces, so when the band was narrow every
            // piece shrank on its own and split mid-label: "opus 5" on two
            // lines, "6:30 AM" cut at the space. Each reading is now one
            // Box that refuses to shrink, holding its own label, gauge,
            // number and reset, and the row wraps *between* groups. Narrow
            // means a second line of whole readings, never a torn one.
            //
            // The terminal path below is untouched. `size`, `weight`,
            // `mono` and `tabular` are drawn by the desktop and ignored by
            // the terminal, which is why they are safe to use here and
            // nowhere else.
            const group = (key, children) => Box({
                key,
                flexDirection: 'row',
                alignItems: 'center',
                flexShrink: 0,
                columnGap: 1,
                children,
            });

            const groups = [];

            // The dot is the whole strip in one glyph: green while nothing
            // needs you, amber when something does, red when a window is
            // nearly gone. It leads the model so the first thing the eye
            // lands on is the verdict.
            groups.push(group('id', [
                Text({ key: 'dot', color: readingColor(worst), wrap: 'truncate', children: ['●'] }),
                Text({
                    key: 'model',
                    weight: 'semibold',
                    color: state.pinned ? 'yellow' : undefined,
                    wrap: 'truncate',
                    children: [model],
                }),
                Text({
                    key: 'badge',
                    size: 'caption',
                    dimColor: !state.pinned,
                    color: state.pinned ? 'yellow' : undefined,
                    wrap: 'truncate',
                    children: [badgeText(state.pinned, state.routing).trim()],
                }),
            ]));

            for (const r of readings) {
                const parts = [
                    Text({
                        key: 'l' + r.key,
                        size: 'caption',
                        dimColor: r.level === CALM,
                        wrap: 'truncate',
                        children: [r.label],
                    }),
                ];
                // A gauge is a picture of how close something is to its
                // limit. At 2% there is nothing to picture, so a calm
                // reading spends no pixels on one and says its number.
                if (r.level !== CALM) {
                    parts.push(Svg({
                        key: 'g' + r.key,
                        alt: gaugeAlt(r.label, r.percent),
                        width: 64,
                        height: 8,
                        source: gaugeSvg(r.percent, { width: 64, height: 8, markAt: markFor(r) }),
                    }));
                }
                parts.push(Text({
                    key: 'p' + r.key,
                    weight: 'medium',
                    tabular: true,
                    dimColor: r.level === CALM,
                    color: r.level === CALM ? undefined : tone(r.percent),
                    wrap: 'truncate',
                    children: [percentText(r.percent)],
                }));
                const reset = resetFor(r);
                if (reset) {
                    parts.push(Text({
                        key: 'r' + r.key,
                        size: 'caption',
                        dimColor: true,
                        wrap: 'truncate',
                        children: [reset],
                    }));
                }
                groups.push(group('rd' + r.key, parts));
            }

            // Wraps between groups, with a little air above a second line so
            // two rows read as two rows and not as one crowded one.
            strip = Box({
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: 3,
                rowGap: 'xs',
                children: groups,
            });
        } else {
            // How much room there is, in order of how much it can be
            // trusted. The band reports its own width; before the app has
            // measured its window it may report nothing at all, and a strip
            // drawn at full width is then clipped by whatever is narrower -
            // which is how the reset times disappeared off the right.
            const columns = ((e.props && e.props.bodyColumns)
                || (e.viewport && e.viewport.columns)
                || 80) - railCols;
            // The header bar says the model, so the strip does not. Both are
            // drawn here for the terminal alone: the desktop has its own.
            const pieces = layout({ ...state, model }, columns, { ...opts, withModel: false });
            strip = Box({
                flexDirection: 'row',
                children: pieces.map((p, i) => Text({
                    key: 'hud-' + i,
                    color: p.color,
                    dimColor: !!p.dim,
                    children: [p.text],
                })),
            });

            const head = headerBar({ ...state, model }, columns, opts);
            header = Box({
                key: 'hud-head',
                flexDirection: 'row',
                justifyContent: 'space-between',
                backgroundColor: BAND_BG,
                children: [
                    Box({
                        key: 'hh-l',
                        flexDirection: 'row',
                        flexShrink: 1,
                        minWidth: 0,
                        children: head.left.map((p, i) => Text({
                            key: 'hl' + i,
                            color: p.color || BAND_FG,
                            backgroundColor: p.bg,
                            bold: !!p.bold,
                            wrap: 'truncate',
                            children: [p.text],
                        })),
                    }),
                    head.right
                        ? Text({ key: 'hh-r', color: BAND_DIM_COLOR, wrap: 'truncate', children: [head.right] })
                        : null,
                ].filter(Boolean),
            });
        }

        const rows = [];

        // The terminal's header bar opens the HUD, so a long reply above
        // cannot be read as running into it.
        if (header) rows.push(header);

        // The plan first, because it is the thing you are actually watching
        // while a long job runs. It is absent on an ordinary turn.
        const shown = shownPlan();
        if (!sidebar && shown.plan) {
            const plan = shown.plan;
            // savvy-progress's row, on both surfaces: a dot and the task in
            // hand, the bar, "Tasks 4/12", the percentage. The colours are
            // its own too: a soft violet while the work is under way, green
            // once it is finished.
            // The terminal's own violet, not the desktop's: a sixteen-colour
            // terminal rounds the desktop's to white (see PLAN_ACCENT in hud-format.js).
            const color = plan.complete ? PLAN_DONE : (railOn ? TERMINAL_ACCENT : PLAN_ACCENT);
            const name = plan.label || 'Plan';
            // A tilde where the count is a worked-out guess and not a task list.
            const count = 'Tasks ' + countText(plan);
            const pct = percentText(plan.percent);
            const columns = ((e.props && e.props.bodyColumns)
                || (e.viewport && e.viewport.columns)
                || 80) - railCols;

            state.liveBar = !(e.surface === 'desktop' && typeof Svg === 'function');

            if (e.surface === 'desktop' && typeof Svg === 'function') {
                // The desktop draws the bar as a picture: the dithered fill,
                // the faint layer for work in hand, a tick for every task
                // still ahead and the count riding the head of the fill.
                // The name and the percentage stay Text, so they follow the
                // app's theme. The name is the one thing allowed to give way;
                // the bar and the percentage never shrink, because a progress
                // bar torn across two lines says nothing.
                const barW = Math.max(160, Math.min(900, columns * 8 - 320));
                rows.push(Box({
                    key: 'hud-progress',
                    flexDirection: 'row',
                    alignItems: 'center',
                    columnGap: 2,
                    children: [
                        Box({
                            key: 'pg-head',
                            flexDirection: 'row',
                            alignItems: 'center',
                            columnGap: 1,
                            flexShrink: 1,
                            minWidth: 0,
                            children: [
                                Text({ key: 'pg-i', color, wrap: 'truncate', children: ['●'] }),
                                Text({ key: 'pg-n', weight: 'medium', wrap: 'truncate-end', children: [name] }),
                            ],
                        }),
                        Box({
                            key: 'pg-tail',
                            flexDirection: 'row',
                            alignItems: 'center',
                            columnGap: 2,
                            flexShrink: 0,
                            children: [
                                Svg({
                                    key: 'pg-b',
                                    alt: progressAlt(plan),
                                    width: barW,
                                    height: 16,
                                    source: planSvg(plan, { width: barW }),
                                }),
                                Text({ key: 'pg-p', dimColor: true, tabular: true, wrap: 'truncate', children: [pct] }),
                            ],
                        }),
                    ],
                }));
            } else {
                // The terminal: the same row in characters. The bar is a fixed
                // size for the window, so it starts in the same place on every
                // redraw, and the step in hand takes all the width the bar
                // does not need. (It used to be cut at thirty characters
                // with most of the row empty beside it.)
                const tier = columns >= 140 ? 40 : columns >= 110 ? 32 : columns >= 80 ? 20 : 12;
                const cells = Math.max(6, Math.min(tier, columns - 12 - count.length - pct.length - 6));
                const titleW = Math.max(8, columns - cells - count.length - pct.length - 6);
                // Alive while Claude works, still when it is not: see planBarFrame.
                const tick = Math.floor(Date.now() / BAR_FRAME_MS);
                const pieces = planBarFrame(plan, { ascii: opts.ascii, cells, working: true, tick });
                // The dot breathes with the bar. (The row is drawn only while Claude is working.)
                const dotDim = Math.floor(tick / 3) % 2 === 1;
                rows.push(Box({
                    key: 'hud-progress',
                    flexDirection: 'row',
                    columnGap: 2,
                    children: [
                        Box({
                            key: 'pg-head',
                            width: titleW,
                            flexShrink: 0,
                            flexDirection: 'row',
                            children: [
                                Text({ key: 'pg-i', color, dimColor: dotDim, children: [opts.ascii ? '* ' : '● '] }),
                                Text({ key: 'pg-n', wrap: 'truncate-end', children: [name] }),
                            ],
                        }),
                        Box({
                            key: 'pg-bar',
                            flexDirection: 'row',
                            flexShrink: 0,
                            children: pieces.map((p, i) => Text({ key: 'pg-c' + i, color: p.color, children: [p.text] })),
                        }),
                        Text({ key: 'pg-count', bold: true, wrap: 'truncate', children: [count] }),
                        Text({ key: 'pg-p', dimColor: true, wrap: 'truncate', children: [pct] }),
                    ],
                }));

                // The steps around it: last finished, next two, and how many
                // after. Only while the job is under way, and only where the
                // window is tall enough to spare them.
                if (!plan.complete) {
                    const listed = planListRows(shown.items, {
                        columns,
                        rows: e.viewport && Number(e.viewport.rows) > 0 ? Number(e.viewport.rows) : 0,
                        ascii: opts.ascii,
                    });
                    const look = { done: { color: PLAN_DONE }, rest: { dimColor: true }, faint: { dimColor: true }, dim: { dimColor: true }, fg: {} };
                    listed.forEach((pieces, r) => rows.push(Box({
                        key: 'hud-list-' + r,
                        flexDirection: 'row',
                        children: pieces.map((p, i) => Text({
                            key: 'pl-' + r + '-' + i,
                            wrap: 'truncate',
                            ...(look[p.role] || {}),
                            children: [p.text],
                        })),
                    })));
                }
            }
        }

        if (strip) rows.push(strip);

        // One line, only when a window will actually run out before it
        // resets. Three stacked warnings are three warnings nobody reads.
        if (!sidebar && lead) {
            rows.push(Box({
                key: 'hud-pace',
                flexDirection: 'row',
                columnGap: 1,
                children: [
                    Text({ key: 'pc-l', color: tone(lead.percent), children: ['↑'] }),
                    Text({ key: 'pc-t', children: [lead.label + ' ' + lead.note] }),
                ],
            }));
        }

        // The follow-ups, if the last turn produced any. Buttons rather than
        // text, so one press sends it: a suggestion you have to retype is
        // not a suggestion, it is a reminder.

        // The subagent row, while there is one. No row at all when there
        // is not: a line saying "no agents" is a permanent reminder of
        // nothing.
        const running = visible(state.agents);
        if (!sidebar && running.length) {
            const portions = shares(running);
            const cells = [
                Text({ key: 'ag-h', color: 'cyan', children: ['\u27f3 ' + running.length
                    + (running.length === 1 ? ' agent' : ' agents')] }),
            ];
            const showShare = comparable(running);
            // One Box per agent that refuses to shrink, and a row that wraps
            // between them. Loose pieces in a single row tore apart when the
            // band was narrow; this way a crowded row becomes two rows of
            // whole agents. Where everything fits - the terminal, nearly
            // always - it draws exactly as it did.
            const agentGroups = [cells[0]];
            running.forEach((a, i) => {
                const parts = [
                    Text({ key: 'ag-s' + i, dimColor: true, children: [' \u2502 '] }),
                    Text({ key: 'ag-n' + i, color: statusColor(a.status), wrap: 'truncate', children: [a.name] }),
                ];
                if (showShare) {
                    parts.push(Text({ key: 'ag-g' + i, children: [' '] }));
                    barPieces(portions[i] * 100, 10, opts.ascii).forEach((piece, j) => {
                        parts.push(Text({
                            key: 'ag-b' + i + '-' + j,
                            color: piece.color,
                            dimColor: !!piece.dim,
                            children: [piece.text],
                        }));
                    });
                }
                parts.push(Text({
                    key: 'ag-t' + i,
                    dimColor: true,
                    tabular: true,
                    wrap: 'truncate',
                    children: [' ' + elapsedText(a.startedAt) + ' ' + tokenText(a.tokens)],
                }));
                agentGroups.push(Box({
                    key: 'ag-grp' + i,
                    flexDirection: 'row',
                    flexShrink: 0,
                    children: parts,
                }));
            });
            rows.push(Box({
                key: 'hud-agents',
                flexDirection: 'row',
                flexWrap: 'wrap',
                children: agentGroups,
            }));
        }

        // One thing you may have missed, until you dismiss it.
        if (!sidebar && state.headsNote) {
            rows.push(Box({
                key: 'hud-heads',
                flexDirection: 'row',
                columnGap: 1,
                children: [
                    Text({ key: 'hh-i', color: 'yellow', children: ['\u2726 Heads up'] }),
                    Text({ key: 'hh-t', children: ['\u00b7 ' + state.headsNote] }),
                    Button({
                        key: 'hh-x',
                        label: 'dismiss',
                        hotkey: '0',
                        plain: true,
                        dimColor: true,
                        onPress: () => {
                            state.headsNote = null;
                            $.ui.invalidate('ui.render');
                        },
                    }),
                ],
            }));
        }
        if (!sidebar && state.suggestions.length) {
            rows.push(Box({
                key: 'hud-next',
                flexDirection: 'row',
                columnGap: 2,
                children: state.suggestions.map((text, i) => Button({
                    key: 'hud-next-' + i,
                    label: text,
                    hotkey: String(i + 1),
                    plain: true,
                    dimColor: true,
                    onPress: () => {
                        state.suggestions = [];
                        $.ui.invalidate('ui.render');
                        $.prompt.submit({ text, asUser: true });
                    },
                })),
            }));
        }
        // Nothing of ours to show: the sidebar has it all and there is no
        // follow-up or heads-up to offer. Leave the band to whoever else draws.
        if (!rows.length) return next(e);
        // On the terminal every row of ours, however many lines it wraps to,
        // has the HUD's colour down its left edge.
        //
        // A band may not switch off a border's sides (AbovePrompt refuses
        // borderTop and its kind), so the edge is drawn, not bordered: a
        // column of thin bars placed over the left column the rows leave
        // free. Placed absolutely from the top to the bottom of the block, it
        // takes the block's height whatever the rows wrap to, and the part of
        // it that is longer than that is clipped. It changes nothing about
        // where anything else sits.
        const mine = railOn
            ? Box({
                key: 'hud-rail',
                flexDirection: 'column',
                paddingLeft: RAIL_COLS + RAIL_GAP,
                children: [
                    Box({
                        key: 'hud-rail-bar',
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        bottom: 0,
                        width: RAIL_COLS,
                        overflow: 'hidden',
                        children: [Text({ key: 'hud-rail-t', color: RAIL_COLOR, children: [railText(opts.ascii)] })],
                    }),
                    ...rows,
                ],
            })
            : rows.length === 1 ? rows[0] : Box({ flexDirection: 'column', children: rows });

        // Keep whatever the mods after this one drew in the band, above
        // ours, rather than taking the band for ourselves.
        const theirs = await next(e);
        if (!theirs) return mine;
        return Box({ flexDirection: 'column', children: [theirs, mine] });
    });
}
