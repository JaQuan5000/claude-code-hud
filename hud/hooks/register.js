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

import { layout, barPieces, tone, percentText, badgeText, shortKind, resetText, planBar } from './hud-format.js';
import { gaugeSvg, gaugeAlt, progressSvg, progressAlt } from './hud-svg.js';
import { MODELS, shortModel, resolveModel } from './hud-models.js';
import { classify, chooseModel } from './hud-route.js';
import { record, logLines, tuneLines, signalsIn, snippet } from './hud-log.js';
import { buildSuggestPrompt, parseSuggestions } from './hud-suggest.js';
import { readUsage, describeUsage } from './hud-usage.js';
import { spawned, addTokens, tokensOf, merge, visible, prune, shares, comparable,
    elapsedText, tokenText, statusColor, isAlive } from './hud-agents.js';
import { assess, previewFor, countLines, describe, warningFor } from './hud-blast.js';
import { shouldCheck, buildHeadsPrompt, parseHeadsUp } from './hud-heads.js';
import { readingsFor, worstLevel, needsClock, leadNote, clockText,
    CALM, WATCH, URGENT } from './hud-focus.js';
import { todosFrom, progressOf, countText, worthShowing } from './hud-progress.js';

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
     * The plan the turn is working through, from the todo list.
     *
     * Null when there is no plan: most turns answer a question and need no
     * bar. See hud-progress.js for why the todo list is the one honest
     * denominator available.
     */
    plan: null,
    /** The last few routing decisions, for `/hud log` and `/hud tune`. */
    log: [],
    /** Follow-ups offered under the strip, and whether to ask for them. */
    suggestions: [],
    suggestOn: true,
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
            argumentHint: '[on|off|auto|models|set|log|tune|suggest|know|blast|agents]',
        });

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
        state.held = false;
        // Last turn's follow-ups are about last turn.
        state.suggestions = [];

        if (!state.routing || state.pinned) {
            state.chosen = null;
            state.reason = state.pinned ? 'you picked this model' : 'routing is off';
            return next(e);
        }

        // Only what the suggester can use, so the whole prompt is not held
        // in memory until the next one replaces it.
        state.lastPrompt = String(e.text || '').slice(0, 300);
        const tier = classify(e.text);
        let picked = chooseModel(tier, state, opts);

        // An expensive turn with the window nearly gone is the one case worth
        // interrupting for. Waiting inside `$.ui.ask` does not count against
        // the hook's time limit; waiting on a promise of our own would.
        const five = (state.rateLimits || []).find((l) => l.kind === 'five_hour');
        const used = five && typeof five.percentUsed === 'number' ? five.percentUsed : 0;
        const expensive = picked.tier === 'top' || picked.tier === 'deep';
        if (expensive && used >= CONFIRM_ABOVE) {
            const cheaper = picked.tier === 'top' ? opts.deepModel : opts.baseModel;
            const goOn = 'Use ' + shortModel(picked.model);
            const instead = 'Use ' + shortModel(cheaper) + ' instead';
            let answer = goOn;
            try {
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
                return { drop: 'Cancelled, so the window keeps what was left of it.' };
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
        if (state.plan && state.plan.complete) state.plan = null;

        const result = await next(e);
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
            const plan = progressOf(todosFrom(e));
            if (plan) {
                state.plan = plan;
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

    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
        state.turnToolCalls += 1;
        if (!state.blastOn) return next(e);

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
            return next(e);
        }
        if (answer !== 'Run it') {
            return { deny: 'The user cancelled this command after seeing what it would affect.' };
        }
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

    on('command.run', { command: 'hud' }, async ($, e) => {
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
        lines.push('  /hud off | auto          stop routing, or hand the choice back');
        lines.push('  /hud models              every model a tier can be set to');
        lines.push('  /hud set <tier> <model>  point one tier somewhere else');
        lines.push('  /hud log                 what was routed where, and why');
        lines.push('  /hud tune                what the log says about the patterns');
        lines.push('  /hud suggest on | off    follow-ups under the strip');
        lines.push('  /hud know on | off       one thing you may have missed, after a big turn');
        lines.push('  /hud blast on | off      measure a destructive command before running it');
        lines.push('  /hud agents              every subagent this session has run');
        lines.push('  /hud raw                 what usage() reported, if a reading is missing');
        return { text: lines.join('\n') };
    });

    // The strip itself. Drawn from `state` alone, so this stays cheap: the
    // numbers were gathered when they changed, not here.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        // No early return for "nothing measured yet": the model is always
        // worth saying, and a strip that appears a turn late looks broken.
        const { Box, Text, Svg, Button } = $.ui.resolve(e);
        let model = state.chosen;
        if (!model) {
            try {
                const current = await $.session.model();
                model = typeof current === 'string'
                    ? current
                    : (current && (current.display_name || current.displayName || current.id)) || '?';
            } catch {
                model = '?';
            }
        }
        // The column is ten wide and the ids are not: 'claude-sonnet-5-5'
        // would draw as 'claude-son'.
        model = shortModel(model);

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

        let strip;
        if (e.surface === 'desktop' && typeof Svg === 'function') {
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
            const columns = (e.props && e.props.bodyColumns)
                || (e.viewport && e.viewport.columns)
                || 80;
            const pieces = layout({ ...state, model }, columns, opts);
            strip = Box({
                flexDirection: 'row',
                children: pieces.map((p, i) => Text({
                    key: 'hud-' + i,
                    color: p.color,
                    dimColor: !!p.dim,
                    children: [p.text],
                })),
            });
        }

        const rows = [];

        // The plan first, because it is the thing you are actually watching
        // while a long job runs. It is absent on an ordinary turn.
        if (worthShowing(state.plan)) {
            const plan = state.plan;
            const bar = [];
            if (e.surface === 'desktop' && typeof Svg === 'function') {
                bar.push(Svg({
                    key: 'pg-b',
                    alt: progressAlt(plan),
                    width: 180,
                    height: 8,
                    source: progressSvg(plan.donePercent, plan.reachedPercent, { width: 180, height: 8 }),
                }));
            } else {
                for (const piece of planBar(plan, opts.ascii)) {
                    bar.push(Text({
                        key: 'pg-c' + bar.length,
                        color: piece.color,
                        dimColor: !!piece.dim,
                        children: [piece.text],
                    }));
                }
            }
            bar.push(Text({ key: 'pg-c', dimColor: true, tabular: true, wrap: 'truncate', children: [countText(plan)] }));
            bar.push(Text({ key: 'pg-p', color: 'blue', weight: 'medium', tabular: true, wrap: 'truncate', children: [percentText(plan.percent)] }));

            // The task's name is the one thing here allowed to give way. It
            // can be as long as a sentence, so it truncates with an ellipsis
            // when the band is narrow, while the bar, the count and the
            // percentage stay together as a block that never shrinks - a
            // progress bar torn across two lines says nothing.
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
                            Text({ key: 'pg-i', color: 'blue', children: ['▸'] }),
                            ...(plan.label
                                ? [Text({ key: 'pg-n', wrap: 'truncate-end', children: [plan.label] })]
                                : []),
                        ],
                    }),
                    Box({
                        key: 'pg-tail',
                        flexDirection: 'row',
                        alignItems: 'center',
                        columnGap: 1,
                        flexShrink: 0,
                        children: bar,
                    }),
                ],
            }));
        }

        rows.push(strip);

        // One line, only when a window will actually run out before it
        // resets. Three stacked warnings are three warnings nobody reads.
        if (lead) {
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
        if (running.length) {
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
        if (state.headsNote) {
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
        if (state.suggestions.length) {
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
        const mine = rows.length === 1 ? strip : Box({ flexDirection: 'column', children: rows });

        // Keep whatever the mods after this one drew in the band, above
        // ours, rather than taking the band for ourselves.
        const theirs = await next(e);
        if (!theirs) return mine;
        return Box({ flexDirection: 'column', children: [theirs, mine] });
    });
}
