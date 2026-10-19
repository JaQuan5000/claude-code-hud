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
import { classify, chooseModel } from './hud-route.js';

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
};

export function register(on, options = {}) {
    const opts = {
        fastModel: options.fast_model || 'haiku',
        baseModel: options.base_model || 'sonnet',
        deepModel: options.deep_model || 'opus',
        topModel: options.top_model || 'fable',
        routeToTop: options.route_to_top !== false,
        spareAbove: typeof options.spare_quota_above === 'number' ? options.spare_quota_above : 85,
        barCells: typeof options.bar_cells === 'number' ? options.bar_cells : 10,
        ascii: !!options.ascii,
    };
    state.routing = options.routing !== false;

    // Everything this mod does at session start, in one hook: registering two
    // hooks on the same event without matchers is a load error.
    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'hud',
            description: 'Show what hud is doing, or turn routing on, off, or back to auto',
            argumentHint: '[on|off|auto]',
        });
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
        if (!state.routing || state.pinned) {
            state.chosen = null;
            state.reason = state.pinned ? 'you picked this model' : 'routing is off';
            return next(e);
        }
        const tier = classify(e.text);
        const picked = chooseModel(tier, state, opts);
        state.chosen = picked.model;
        state.held = picked.held;
        state.reason = picked.held
            ? tier + ' work, held at ' + picked.model + ' to spare the five-hour window'
            : tier + ' work';
        $.ui.invalidate('ui.render');
        return next(e);
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
        const arg = String((e && e.args) || '').trim().toLowerCase();
        if (arg === 'off') {
            state.routing = false;
            state.chosen = null;
            $.ui.invalidate('ui.render');
            return { text: 'Routing off. The readout stays, and the model is whatever you set.' };
        }
        if (arg === 'on' || arg === 'auto') {
            state.routing = true;
            state.pinned = false;
            $.ui.invalidate('ui.render');
            return {
                text: 'Routing on. Small work goes to ' + opts.fastModel
                    + ', planning to ' + opts.deepModel
                    + (opts.routeToTop ? ', whole-system work to ' + opts.topModel : '')
                    + '.',
            };
        }
        const lines = [
            'routing: ' + (state.routing ? 'on' : 'off') + (state.pinned ? ', standing down because you picked a model' : ''),
            'next request: ' + (state.chosen || 'whatever the session is on') + (state.reason ? ' (' + state.reason + ')' : ''),
            'context: ' + (state.contextPercent == null ? 'unknown' : Math.round(state.contextPercent) + '% used'),
        ];
        for (const limit of state.rateLimits) {
            lines.push(limit.kind + ': ' + Math.round(limit.percentUsed) + '% used');
        }
        if (!state.rateLimits.length) {
            lines.push('quota: not reported for this account');
        }
        lines.push('/hud off to stop routing, /hud auto to hand the choice back to hud');
        return { text: lines.join('\n') };
    });

    // The strip itself. Drawn from `state` alone, so this stays cheap: the
    // numbers were gathered when they changed, not here.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        // No early return for "nothing measured yet": the model is always
        // worth saying, and a strip that appears a turn late looks broken.
        const { Box, Text, Svg } = $.ui.resolve(e);
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
            const pieces = layout({ ...state, model }, e.props && e.props.bodyColumns, opts);
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

        // Keep whatever the mods after this one drew in the band, above the
        // strip, rather than taking the band for ourselves.
        const theirs = await next(e);
        if (!theirs) return strip;
        return Box({ flexDirection: 'column', children: [theirs, strip] });
    });
}
