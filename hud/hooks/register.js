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

import { layout, tone, percentText, badgeText, shortKind, resetText } from './hud-format.js';
import { gaugeSvg, gaugeAlt } from './hud-svg.js';
import { MODELS, shortModel, resolveModel } from './hud-models.js';
import { classify, chooseModel } from './hud-route.js';
import { record, logLines, tuneLines, signalsIn, snippet } from './hud-log.js';
import { buildSuggestPrompt, parseSuggestions } from './hud-suggest.js';

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
    /** The last few routing decisions, for `/hud log` and `/hud tune`. */
    log: [],
    /** Follow-ups offered under the strip, and whether to ask for them. */
    suggestions: [],
    suggestOn: true,
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

export function register(on) {
    const opts = { ...DEFAULTS };

    // Everything this mod does at session start, in one hook: registering two
    // hooks on the same event without matchers is a load error.
    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'hud',
            description: 'Show what hud is doing, change a tier, or turn routing on and off',
            argumentHint: '[on|off|auto|models|set|log|tune|suggest]',
        });

        // The only timer in the mod, and it exists for one reason: the reset
        // times are a countdown now, and a countdown nobody redraws is wrong
        // within a minute. Everything else here is driven by events. One
        // redraw a minute reads the numbers already in `state`, so it costs a
        // hook call and no requests.
        $.clock.every(60000, () => $.ui.invalidate('ui.render'));
        try {
            const usage = await $.session.usage();
            state.contextPercent = usage && usage.context ? usage.context.percent : null;
            state.rateLimits = (usage && usage.rateLimits) || [];
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
            state.contextPercent = usage && usage.context ? usage.context.percent : null;
            state.rateLimits = (usage && usage.rateLimits) || [];
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
        const result = await next(e);
        if (!state.suggestOn || e.agentId || e.isAborted) return result;

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
        return result;
    });

    // A turn makes one request per step, and each one is redirected. Written as
    // a generator because the response streams: yield* forwards it and gives
    // back the finished result.
    on('turn.step', async function* ($, e, next) {
        // A subagent resolves its own model, from its definition or from
        // whoever spawned it. Routing the main conversation should not quietly
        // downgrade a subagent somebody chose a model for.
        if (e.agentId) return yield* next(e);
        if (!state.routing || state.pinned || !state.chosen) return yield* next(e);
        if (state.chosen === e.model) return yield* next(e);
        return yield* next({ ...e, model: state.chosen });
    });

    // This fires only for a switch you asked for: /model, the picker, Option+P.
    // Automatic fallbacks do not reach it, which is what makes it a reliable
    // signal that the choice is now yours.
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

        let strip;
        if (e.surface === 'desktop' && typeof Svg === 'function') {
            // The Desktop app draws vector art, so it gets a real gauge
            // rather than a drawing made of characters. Labels stay as Text,
            // which follows the app's light or dark theme; only the gauges
            // are pictures, and nothing in them assumes a background.
            const row = [];
            const label = (text) => Text({ key: 'l' + row.length, dimColor: true, children: [text] });
            const reading = (name, percent) => {
                row.push(label(name));
                row.push(Svg({
                    key: 'g' + name,
                    alt: gaugeAlt(name, percent),
                    width: 96,
                    height: 10,
                    source: gaugeSvg(percent),
                }));
                row.push(Text({ key: 'p' + name, color: tone(percent), children: [percentText(percent)] }));
            };

            row.push(Text({ key: 'model', color: state.pinned ? 'yellow' : 'cyan', children: [model] }));
            row.push(Text({
                key: 'badge',
                color: state.pinned ? 'yellow' : 'green',
                children: [badgeText(state.pinned, state.routing).trim()],
            }));
            if (typeof state.contextPercent === 'number') reading('ctx', state.contextPercent);
            for (const limit of state.rateLimits) {
                const short = shortKind(limit.kind);
                if (!short) continue;
                reading(short, limit.percentUsed);
                const reset = resetText(limit.resetsAt);
                if (reset) row.push(label('↻ ' + reset));
            }
            strip = Box({ flexDirection: 'row', alignItems: 'center', columnGap: 1, children: row });
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

        // The follow-ups, if the last turn produced any. Buttons rather than
        // text, so one press sends it: a suggestion you have to retype is
        // not a suggestion, it is a reminder.
        const rows = [strip];
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
