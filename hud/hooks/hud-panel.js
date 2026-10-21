/**
 * The sidebar: the whole HUD as a stack of cards, for the desktop app.
 *
 * The strip above the prompt is one line, so it has to choose what to leave
 * out. A sidebar does not: it has the height to say everything the strip says,
 * and the room to say what the strip cannot - the plan item by item, each agent
 * by name, what the session has spent, why a turn went to the model it did,
 * what the guard stopped on - and to hold the controls, so the switches and the
 * models can be changed where they are read.
 *
 * It is built to sit beside the cards the desktop app already draws (rounded,
 * quiet, a title with a chevron that folds the card, a figure on the right).
 * Nothing here picks a colour for a background, so it follows the app's light
 * and dark themes.
 *
 * **Pure on purpose.** It is handed the element factories and a plain object,
 * and returns a tree. It reads no state and calls no API, which is what lets
 * it be tested without an app, and what keeps a redraw as cheap as a redraw
 * can be: no request, no wait, only arithmetic on numbers already gathered.
 * Every press is a function the caller put in `data`, so this file decides
 * what is drawn and the caller decides what a press does.
 */

import { percentText, tone } from './hud-format.js';
import { clockText, CALM, WATCH, URGENT } from './hud-focus.js';
import { gaugeSvg, gaugeAlt, planSvg, meterSvg, progressAlt, PLAN_ACCENT, PLAN_DONE } from './hud-svg.js';
import { elapsedText, tokenText, statusColor } from './hud-agents.js';
import { countText } from './hud-progress.js';
import { RAN, CANCELLED } from './hud-blast.js';

/** The id the pane is opened under, and the key its render hook answers to. */
export const PANE_ID = 'hud';

/**
 * A gauge's drawn size in pixels.
 *
 * The Svg is given no width of its own, so it takes the picture's own width up
 * to the room the card has: a sidebar dragged narrower shrinks the bar with it
 * instead of clipping it. The viewBox keeps the proportions, so this is wide
 * enough to fill a sidebar of the usual width and thin enough to stay a bar.
 */
const GAUGE_W = 400;
const GAUGE_H = 8;

/** Which cards start folded: the ones that are reference, not news. */
export const DEFAULT_COLLAPSED = { guard: true, models: true };

/** How many plan items to list before saying "and N more", and how many finished to keep in view. */
const MAX_ITEMS = 7;
const MAX_DONE = 3;

/** How many routing decisions to show. */
const MAX_RECENT = 5;

function levelColor(level) {
    if (level === URGENT) return 'red';
    if (level === WATCH) return 'yellow';
    return 'green';
}

/**
 * One card: a header that folds it, then its body.
 *
 * The header is a Button so the whole title is the target, which is what the
 * desktop app's own cards do. The summary sits on the right so a folded card
 * still says the one thing worth knowing about it.
 */
function card(ui, data, key, title, summary, summaryColor, body) {
    const { Box, Text, Button } = ui;
    const folded = !!(data.collapsed && data.collapsed[key]);

    const header = Box({
        key: 'h-' + key,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: 2,
        children: [
            Button({
                key: 'b-' + key,
                label: (folded ? '▸ ' : '▾ ') + title,
                plain: true,
                onPress: () => data.toggle && data.toggle(key),
            }),
            summary
                ? Text({
                    key: 's-' + key,
                    color: summaryColor,
                    dimColor: !summaryColor,
                    tabular: true,
                    weight: 'medium',
                    wrap: 'truncate',
                    children: [summary],
                })
                : null,
        ].filter(Boolean),
    });

    return Box({
        key: 'card-' + key,
        flexDirection: 'column',
        rowGap: 1,
        paddingX: 1,
        paddingY: 1,
        borderStyle: 'round',
        borderDimColor: true,
        children: folded ? [header] : [header, ...body],
    });
}

/** A label on the left and a figure on the right, the shape of every row. */
function line(ui, key, left, right, rightColor) {
    const { Box, Text } = ui;
    return Box({
        key,
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: 2,
        children: [
            Text({ key: key + '-l', size: 'caption', wrap: 'truncate-end', children: [left] }),
            Text({
                key: key + '-r',
                size: 'caption',
                tabular: true,
                dimColor: !rightColor,
                color: rightColor,
                wrap: 'truncate',
                children: [right],
            }),
        ],
    });
}

/** A quiet sub-heading inside a card. */
function label(ui, key, text) {
    const { Text } = ui;
    return Text({ key, size: 'footnote', weight: 'medium', dimColor: true, wrap: 'truncate', children: [text] });
}

/** A sentence that is allowed to run to as many lines as it needs. */
function sentence(ui, key, text, opts) {
    const { Text } = ui;
    return Text({ key, size: 'caption', wrap: 'wrap', dimColor: true, ...(opts || {}), children: [text] });
}

// ----------------------------------------------------------------- the cards

/**
 * Which model, how it was chosen, and what the session has cost.
 *
 * The first thing in the sidebar, and the verdict in one glyph: the dot is
 * green while nothing needs you, amber when something does, red when a window
 * is nearly gone.
 */
function headCard(ui, data) {
    const { Box, Text, Button } = ui;
    const dot = levelColor(data.worst);
    const badge = data.pinned ? 'pinned' : data.routingOn ? 'auto' : 'manual';

    const rows = [
        Box({
            key: 'hd-id',
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [
                Box({
                    key: 'hd-name',
                    flexDirection: 'row',
                    alignItems: 'center',
                    columnGap: 1,
                    flexShrink: 1,
                    minWidth: 0,
                    children: [
                        Text({ key: 'hd-dot', color: dot, wrap: 'truncate', children: ['●'] }),
                        Text({ key: 'hd-m', size: 'heading', weight: 'semibold', wrap: 'truncate-end', children: [data.model || '?'] }),
                    ],
                }),
                Text({
                    key: 'hd-b',
                    size: 'caption',
                    weight: 'medium',
                    dimColor: !data.pinned,
                    color: data.pinned ? 'yellow' : undefined,
                    wrap: 'truncate',
                    children: [badge],
                }),
            ],
        }),
    ];

    if (data.reason) rows.push(sentence(ui, 'hd-r', data.reason));
    if (data.held) {
        rows.push(sentence(ui, 'hd-held', 'Held back to spare the five-hour window.', { color: 'yellow', dimColor: false }));
    }

    // What the session is, in one quiet line: what it has cost, how long it
    // has run, how many turns it has taken.
    const facts = [
        data.session && data.session.cost,
        data.session && data.session.age,
        data.stats && data.stats.turns ? data.stats.turns + (data.stats.turns === 1 ? ' turn' : ' turns') : '',
    ].filter(Boolean);
    if (facts.length) {
        rows.push(Text({
            key: 'hd-facts',
            size: 'caption',
            tabular: true,
            dimColor: true,
            wrap: 'truncate',
            children: [facts.join('  ·  ')],
        }));
    }

    // Picking a model by hand stops routing. One press hands it back.
    if (data.pinned && data.onAuto) {
        rows.push(Box({
            key: 'hd-auto-row',
            flexDirection: 'row',
            children: [Button({
                key: 'hd-auto',
                label: '↺ Back to auto routing',
                plain: true,
                onPress: () => data.onAuto(),
            })],
        }));
    }

    return Box({
        key: 'card-hud',
        flexDirection: 'column',
        rowGap: 1,
        paddingX: 1,
        paddingY: 1,
        borderStyle: 'round',
        borderDimColor: true,
        children: rows,
    });
}

/**
 * Every gauge, with what each one means beneath it: when a window resets,
 * where it is heading at the pace so far, and for context how many tokens that
 * percentage is.
 */
function usageCard(ui, data) {
    const { Box, Text, Svg } = ui;
    const readings = data.readings || [];
    if (!readings.length) return null;

    const body = [];
    for (const r of readings) {
        const reset = r.resetForm === 'countdown'
            ? (data.resetCountdown ? data.resetCountdown(r.resetsAt) : '')
            : r.resetForm === 'clock'
                ? clockText(r.resetsAt)
                : '';
        const projection = (data.projections && data.projections[r.key]) || '';
        const ctx = r.key === 'ctx' ? (data.contextDetail || '') : '';

        const dim = [ctx, reset ? 'resets ' + reset : ''].filter(Boolean).join('  ·  ');
        // A projection that ends in a dry window is the one thing here worth
        // colour; a calm one is just information.
        const projectionColor = r.note ? tone(r.percent) : undefined;

        const detail = [];
        if (dim) detail.push(Text({ key: 'u-d-' + r.key, size: 'caption', dimColor: true, wrap: 'truncate-end', children: [dim] }));
        if (projection) {
            detail.push(Text({
                key: 'u-p-' + r.key,
                size: 'caption',
                dimColor: !projectionColor,
                color: projectionColor,
                wrap: 'truncate-end',
                children: [projection],
            }));
        } else if (r.note) {
            detail.push(Text({ key: 'u-n-' + r.key, size: 'caption', color: tone(r.percent), wrap: 'truncate-end', children: [r.note] }));
        }

        body.push(Box({
            key: 'u-' + r.key,
            flexDirection: 'column',
            rowGap: 0,
            children: [
                line(ui, 'u-l-' + r.key, r.label, percentText(r.percent), r.level === CALM ? undefined : tone(r.percent)),
                Svg({
                    key: 'u-g-' + r.key,
                    alt: gaugeAlt(r.label, r.percent),
                    source: gaugeSvg(r.percent, { width: GAUGE_W, height: GAUGE_H, markAt: r.pace ? r.pace.elapsed * 100 : undefined }),
                }),
                ...detail,
            ],
        }));
    }

    // The one figure that still tells you something when the card is folded:
    // the busiest of them.
    const busiest = readings.reduce((a, b) => (b.percent > a.percent ? b : a), readings[0]);
    return card(ui, data, 'usage', 'Usage', percentText(busiest.percent),
        busiest.level === CALM ? undefined : tone(busiest.percent), body);
}

/**
 * The plan, item by item: what is under way, what is waiting, and the last few
 * things that were finished, so a long job reads as a trail and not just a
 * number.
 */
function progressCard(ui, data) {
    const { Box, Text, Svg } = ui;
    const plan = data.plan;
    if (!plan) return null;

    const items = Array.isArray(data.planItems) ? data.planItems : [];
    const doing = items.filter((t) => t.status === 'in_progress');
    const waiting = items.filter((t) => t.status === 'pending');
    const finished = items.filter((t) => t.status === 'completed').slice(-MAX_DONE);
    const shown = doing.concat(waiting).slice(0, MAX_ITEMS);
    const hidden = doing.length + waiting.length - shown.length;

    const body = [];
    if (plan.label) {
        body.push(Text({ key: 'p-label', size: 'caption', weight: 'medium', wrap: 'wrap', children: [plan.label] }));
    }
    body.push(Svg({
        key: 'p-bar',
        alt: progressAlt(plan),
        source: planSvg(plan, { width: GAUGE_W }),
    }));

    const row = (key, mark, markColor, text, active, dimmed) => Box({
        key,
        flexDirection: 'row',
        columnGap: 1,
        children: [
            Text({ key: key + '-m', color: markColor, dimColor: !markColor, wrap: 'truncate', children: [mark] }),
            Text({
                key: key + '-t',
                size: 'caption',
                weight: active ? 'medium' : 'regular',
                dimColor: dimmed,
                wrap: 'wrap',
                children: [text],
            }),
        ],
    });

    for (let i = 0; i < shown.length; i += 1) {
        const t = shown[i];
        const active = t.status === 'in_progress';
        body.push(row('p-i' + i, active ? '▸' : '○', active ? PLAN_ACCENT : undefined,
            (active && t.activeForm) || t.content || t.subject || 'task', active, !active));
    }
    if (hidden > 0) {
        body.push(Text({ key: 'p-more', size: 'caption', dimColor: true, wrap: 'truncate', children: ['and ' + hidden + ' more'] }));
    }
    if (finished.length) {
        body.push(label(ui, 'p-done-h', 'Done'));
        finished.forEach((t, i) => body.push(row('p-d' + i, '✓', 'green', t.content || t.subject || 'task', false, true)));
        if (plan.done > finished.length) {
            body.push(Text({
                key: 'p-done-more',
                size: 'caption',
                dimColor: true,
                wrap: 'truncate',
                children: ['and ' + (plan.done - finished.length) + ' earlier'],
            }));
        }
    }

    return card(ui, data, 'progress', 'Progress', countText(plan) + '  ' + percentText(plan.percent),
        plan.complete ? PLAN_DONE : PLAN_ACCENT, body);
}

function agentsCard(ui, data) {
    const { Box, Text } = ui;
    const agents = data.agents || [];
    if (!agents.length) return null;

    const body = agents.map((a, i) => Box({
        key: 'a-' + i,
        flexDirection: 'column',
        children: [
            Box({
                key: 'a-r' + i,
                flexDirection: 'row',
                justifyContent: 'space-between',
                columnGap: 2,
                children: [
                    Box({
                        key: 'a-n' + i,
                        flexDirection: 'row',
                        columnGap: 1,
                        flexShrink: 1,
                        minWidth: 0,
                        children: [
                            Text({ key: 'a-d' + i, color: statusColor(a.status), wrap: 'truncate', children: ['●'] }),
                            Text({ key: 'a-nm' + i, size: 'caption', wrap: 'truncate-end', children: [a.name] }),
                        ],
                    }),
                    Text({
                        key: 'a-t' + i,
                        size: 'caption',
                        tabular: true,
                        dimColor: true,
                        wrap: 'truncate',
                        children: [elapsedText(a.startedAt) + '  ' + tokenText(a.tokens)],
                    }),
                ],
            }),
            data.agentShares && data.agentShares.length > 1
                ? Text({
                    key: 'a-sh' + i,
                    size: 'caption',
                    dimColor: true,
                    wrap: 'truncate',
                    children: [Math.round((data.agentShares[i] || 0) * 100) + '% of all agent work'],
                })
                : null,
        ].filter(Boolean),
    }));

    return card(ui, data, 'agents', 'Agents', agents.length + ' running', 'cyan', body);
}

/**
 * The one thing you may have missed, until you dismiss it.
 *
 * Not foldable: a note that can be folded away is a note that can be missed
 * again, and the dismiss button is the control it needs.
 */
function headsCard(ui, data) {
    const { Box, Text, Button } = ui;
    if (!data.headsNote) return null;

    return Box({
        key: 'card-heads',
        flexDirection: 'column',
        rowGap: 1,
        paddingX: 1,
        paddingY: 1,
        borderStyle: 'round',
        borderColor: 'yellow',
        children: [
            Box({
                key: 'hh-head',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                columnGap: 2,
                children: [
                    Text({ key: 'hh-t', color: 'yellow', weight: 'medium', wrap: 'truncate', children: ['✦ Heads up'] }),
                    Button({
                        key: 'hh-x',
                        label: 'Dismiss',
                        plain: true,
                        dimColor: true,
                        onPress: () => data.onDismissHeads && data.onDismissHeads(),
                    }),
                ],
            }),
            Text({ key: 'hh-n', wrap: 'wrap', children: [data.headsNote] }),
        ],
    });
}

/**
 * The follow-ups the last turn offered. One press sends it: a suggestion you
 * have to retype is a reminder, not a suggestion.
 */
function nextCard(ui, data) {
    const { Box, Button } = ui;
    const picks = data.suggestions || [];
    if (!picks.length) return null;

    const body = picks.map((text, i) => Box({
        key: 'n-r' + i,
        flexDirection: 'row',
        children: [Button({
            key: 'n-' + i,
            label: '› ' + text,
            plain: true,
            onPress: () => data.onSuggestion && data.onSuggestion(text),
        })],
    }));

    return card(ui, data, 'next', 'Next steps', picks.length + (picks.length === 1 ? ' idea' : ' ideas'), undefined, body);
}

/**
 * What the session has spent: turns, tokens, how much of the input the prompt
 * cache served, and how long a turn takes. Left out until there is a turn to
 * report, since a card of zeros says nothing.
 */
function activityCard(ui, data) {
    const { Box, Svg } = ui;
    const s = data.stats;
    if (!s || !s.turns) return null;

    const body = [
        line(ui, 'ac-turns', 'Turns', String(s.turns)),
        line(ui, 'ac-in', 'Tokens in', s.input),
        line(ui, 'ac-out', 'Tokens out', s.output),
    ];

    if (s.cacheHit !== null && s.cacheHit !== undefined) {
        body.push(Box({
            key: 'ac-cache',
            flexDirection: 'column',
            children: [
                line(ui, 'ac-cache-l', 'Served from cache', Math.round(s.cacheHit) + '%'),
                Svg({
                    key: 'ac-cache-g',
                    alt: 'Cache served ' + Math.round(s.cacheHit) + ' percent of the input',
                    source: meterSvg(s.cacheHit, { width: GAUGE_W, height: GAUGE_H }),
                }),
            ],
        }));
    }

    if (s.average) body.push(line(ui, 'ac-avg', 'Average turn', s.average));
    if (s.last) body.push(line(ui, 'ac-last', 'Last turn', s.last));

    return card(ui, data, 'activity', 'Activity', s.turns + (s.turns === 1 ? ' turn' : ' turns'), undefined, body);
}

/**
 * Why the last few prompts went where they did: the tier it was judged to be,
 * the model that got it, and the words that decided it.
 */
function routingCard(ui, data) {
    const { Box, Text } = ui;
    if (!data.tiers) return null;

    const recent = (data.log || []).slice(0, MAX_RECENT);
    const body = [];

    if (!data.routingOn) {
        body.push(sentence(ui, 'r-off', 'Routing is off. Prompts go to whatever model the session is on.'));
    }

    if (recent.length) {
        body.push(label(ui, 'r-hd', 'Recent'));
        recent.forEach((r, i) => {
            const why = r.signals && r.signals.length ? r.signals.slice(0, 3).join(', ') : r.text || 'no signal';
            body.push(Box({
                key: 'r-rec' + i,
                flexDirection: 'column',
                children: [
                    line(ui, 'r-rec-l' + i, r.tier, r.short),
                    Text({ key: 'r-rec-w' + i, size: 'caption', dimColor: true, wrap: 'truncate-end', children: [why] }),
                ],
            }));
        });
    } else {
        body.push(sentence(ui, 'r-none', 'Nothing routed yet this session.'));
    }

    return card(ui, data, 'routing', 'Routing', data.routingOn ? 'on' : 'off',
        data.routingOn ? undefined : 'yellow', body);
}

/**
 * The blast-radius guard: whether it is on, how many commands it has looked
 * at, and the ones it stopped on with what you chose.
 */
function guardCard(ui, data) {
    const { Box, Text } = ui;
    const g = data.guard;
    if (!g) return null;

    const flagged = g.flagged || [];
    const body = [];

    if (!g.on) {
        body.push(sentence(ui, 'g-off', 'Off. A destructive command goes straight to the usual permission prompt.'));
    } else {
        body.push(line(ui, 'g-seen', 'Commands checked', String(g.seen || 0)));
        body.push(line(ui, 'g-flag', 'Stopped on', String(flagged.length), flagged.length ? 'yellow' : undefined));
    }

    flagged.forEach((f, i) => {
        const ran = f.outcome === RAN;
        const cancelled = f.outcome === CANCELLED;
        body.push(Box({
            key: 'g-f' + i,
            flexDirection: 'column',
            children: [
                sentence(ui, 'g-f-t' + i, f.text, { dimColor: false }),
                Text({
                    key: 'g-f-o' + i,
                    size: 'caption',
                    color: ran ? 'yellow' : undefined,
                    dimColor: !ran,
                    wrap: 'truncate',
                    children: [ran ? 'you ran it' : cancelled ? 'you cancelled it' : 'not asked, went to the usual prompt'],
                }),
            ],
        }));
    });

    const summary = !g.on ? 'off' : flagged.length ? flagged.length + ' flagged' : 'on';
    return card(ui, data, 'guard', 'Blast radius', summary, !g.on ? 'yellow' : undefined, body);
}

/**
 * The model each tier sends to, changeable here. Folded by default: it is
 * something you set, not something you read.
 */
function modelsCard(ui, data) {
    const { Select } = ui;
    if (!data.tiers || !data.tierIds) return null;

    const body = ['fast', 'base', 'deep'].map((tier) => (typeof Select === 'function' && data.models && data.onTier
        ? Select({
            key: 'm-' + tier,
            label: tier + '  ',
            options: data.models,
            value: data.tierIds[tier],
            onSelect: (value) => data.onTier(tier, value),
        })
        : line(ui, 'm-' + tier, tier, data.tiers[tier])));
    body.push(line(ui, 'm-top', 'top', data.tiers.top));

    return card(ui, data, 'models', 'Models', data.tiers.base, undefined, body);
}

/**
 * The switches, each a press away. They are the same switches /hud flips, with
 * the same effects, kept for next time.
 */
function settingsCard(ui, data) {
    const { Box, Text, Button } = ui;
    const switches = data.switches || [];
    if (!switches.length) return null;

    const body = switches.map((s) => Box({
        key: 'sw-' + s.key,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: 2,
        children: [
            Box({
                key: 'sw-t-' + s.key,
                flexDirection: 'column',
                flexShrink: 1,
                minWidth: 0,
                children: [
                    Text({ key: 'sw-l-' + s.key, size: 'caption', wrap: 'truncate-end', children: [s.label] }),
                    Text({ key: 'sw-h-' + s.key, size: 'footnote', dimColor: true, wrap: 'truncate-end', children: [s.hint] }),
                ],
            }),
            Button({
                key: 'sw-b-' + s.key,
                plain: true,
                onPress: () => data.onSwitch && data.onSwitch(s.key),
                children: [Text({
                    key: 'sw-s-' + s.key,
                    size: 'caption',
                    weight: 'medium',
                    color: s.on ? 'green' : undefined,
                    dimColor: !s.on,
                    wrap: 'truncate',
                    children: [s.on ? '● on' : '○ off'],
                })],
            }),
        ],
    }));

    const on = switches.filter((s) => s.on).length;
    return card(ui, data, 'settings', 'Settings', on + ' of ' + switches.length + ' on', undefined, body);
}

/**
 * The whole sidebar.
 *
 * Cards that have nothing to say are left out, not drawn empty: no plan means
 * no Progress card, no agents means no Agents card. An empty card is a
 * permanent reminder of nothing. What needs you comes first, then what is
 * happening, then what happened, then the controls.
 */
export function buildPanel(ui, data) {
    const { Box, Text } = ui;
    const cards = [
        headCard(ui, data),
        headsCard(ui, data),
        usageCard(ui, data),
        progressCard(ui, data),
        agentsCard(ui, data),
        nextCard(ui, data),
        activityCard(ui, data),
        routingCard(ui, data),
        guardCard(ui, data),
        modelsCard(ui, data),
        settingsCard(ui, data),
    ].filter(Boolean);

    cards.push(Text({
        key: 'foot',
        size: 'footnote',
        dimColor: true,
        wrap: 'wrap',
        children: ['/hud lists every command. /hud panel off closes this and puts the strip back above the prompt.'],
    }));

    return Box({ flexDirection: 'column', rowGap: 1, children: cards });
}
