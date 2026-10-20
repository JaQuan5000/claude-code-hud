/**
 * The sidebar: the whole HUD as a stack of cards, for the desktop app.
 *
 * The strip above the prompt is one line, so it has to choose what to leave
 * out. A sidebar does not: it has the height to say everything the strip says,
 * and the room to say what the strip cannot, such as the plan item by item,
 * each agent by name, and why a turn went to the model it did.
 *
 * It is built to sit beside the cards the desktop app already draws there
 * (Environment, Context, Outputs, Changes): rounded, quiet, a title with a
 * chevron that folds the card, and a number on the right. Nothing here picks a
 * colour for its background, so it follows the app's light and dark themes.
 *
 * **Pure on purpose.** It is handed the element factories and a plain object,
 * and returns a tree. It reads no state and calls no API, which is what lets
 * it be tested without an app, and what keeps a redraw as cheap as a redraw
 * can be: no request, no wait, only arithmetic on numbers already gathered.
 */

import { percentText, tone } from './hud-format.js';
import { clockText, CALM, WATCH, URGENT } from './hud-focus.js';
import { gaugeSvg, gaugeAlt, progressSvg, progressAlt } from './hud-svg.js';
import { elapsedText, tokenText, statusColor } from './hud-agents.js';
import { countText } from './hud-progress.js';

/** The id the pane is opened under, and the key its render hook answers to. */
export const PANE_ID = 'hud';

/**
 * A gauge's width in pixels. Fixed rather than fluid because an Svg is a
 * picture of a set size; narrow enough to sit inside a card in a sidebar of
 * the width the app gives it.
 */
const GAUGE_W = 176;

/** Which cards start folded. Everything but the routing detail is open. */
export const DEFAULT_COLLAPSED = { routing: true };

/** How many plan items to list before saying "and N more". */
const MAX_ITEMS = 7;

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

// ----------------------------------------------------------------- the cards

function headCard(ui, data) {
    const { Box, Text } = ui;
    const dot = levelColor(data.worst);
    const badge = data.pinned ? 'pinned' : data.routingOn ? 'auto' : 'manual';

    const rows = [
        Box({
            key: 'hd-id',
            flexDirection: 'row',
            alignItems: 'center',
            columnGap: 1,
            children: [
                Text({ key: 'hd-dot', color: dot, wrap: 'truncate', children: ['●'] }),
                Text({ key: 'hd-m', weight: 'semibold', wrap: 'truncate-end', children: [data.model || '?'] }),
                Text({
                    key: 'hd-b',
                    size: 'caption',
                    dimColor: !data.pinned,
                    color: data.pinned ? 'yellow' : undefined,
                    wrap: 'truncate',
                    children: [badge],
                }),
            ],
        }),
    ];
    if (data.reason) {
        rows.push(Text({ key: 'hd-r', size: 'caption', dimColor: true, wrap: 'truncate-end', children: [data.reason] }));
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
        const detail = [reset ? 'resets ' + reset : '', r.note || ''].filter(Boolean).join('  ·  ');

        body.push(Box({
            key: 'u-' + r.key,
            flexDirection: 'column',
            rowGap: 0,
            children: [
                line(ui, 'u-l-' + r.key, r.label, percentText(r.percent), r.level === CALM ? undefined : tone(r.percent)),
                Svg({
                    key: 'u-g-' + r.key,
                    alt: gaugeAlt(r.label, r.percent),
                    width: GAUGE_W,
                    height: 6,
                    source: gaugeSvg(r.percent, { width: GAUGE_W, height: 6, markAt: r.pace ? r.pace.elapsed * 100 : undefined }),
                }),
                detail
                    ? Text({ key: 'u-d-' + r.key, size: 'caption', dimColor: true, wrap: 'truncate-end', children: [detail] })
                    : null,
            ].filter(Boolean),
        }));
    }

    // The one figure that still tells you something when the card is folded:
    // the busiest of them.
    const busiest = readings.reduce((a, b) => (b.percent > a.percent ? b : a), readings[0]);
    return card(ui, data, 'usage', 'Usage', percentText(busiest.percent),
        busiest.level === CALM ? undefined : tone(busiest.percent), body);
}

function progressCard(ui, data) {
    const { Box, Text, Svg } = ui;
    const plan = data.plan;
    if (!plan) return null;

    const items = Array.isArray(data.planItems) ? data.planItems : [];
    const doing = items.filter((t) => t.status === 'in_progress');
    const waiting = items.filter((t) => t.status === 'pending');
    const shown = doing.concat(waiting).slice(0, MAX_ITEMS);
    const hidden = doing.length + waiting.length - shown.length;

    const body = [
        Svg({
            key: 'p-bar',
            alt: progressAlt(plan),
            width: GAUGE_W,
            height: 6,
            source: progressSvg(plan.donePercent, plan.reachedPercent, { width: GAUGE_W, height: 6 }),
        }),
    ];

    for (let i = 0; i < shown.length; i += 1) {
        const t = shown[i];
        const active = t.status === 'in_progress';
        body.push(Box({
            key: 'p-i' + i,
            flexDirection: 'row',
            columnGap: 1,
            children: [
                Text({ key: 'p-m' + i, color: active ? 'blue' : undefined, dimColor: !active, wrap: 'truncate', children: [active ? '▸' : '○'] }),
                Text({
                    key: 'p-t' + i,
                    size: 'caption',
                    weight: active ? 'medium' : 'regular',
                    dimColor: !active,
                    wrap: 'truncate-end',
                    children: [(active && t.activeForm) || t.content || t.subject || 'task'],
                }),
            ],
        }));
    }
    if (hidden > 0) {
        body.push(Text({ key: 'p-more', size: 'caption', dimColor: true, wrap: 'truncate', children: ['and ' + hidden + ' more'] }));
    }
    if (plan.done > 0) {
        body.push(Text({ key: 'p-done', size: 'caption', dimColor: true, wrap: 'truncate', children: [plan.done + ' done'] }));
    }

    return card(ui, data, 'progress', 'Progress', countText(plan) + '  ' + percentText(plan.percent), 'blue', body);
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

function routingCard(ui, data) {
    const t = data.tiers;
    if (!t) return null;

    const body = [
        line(ui, 'r-fast', 'fast', t.fast),
        line(ui, 'r-base', 'base', t.base),
        line(ui, 'r-deep', 'deep', t.deep),
        line(ui, 'r-top', 'top', t.top || 'off'),
    ];

    const recent = (data.log || []).slice(0, 4);
    if (recent.length) {
        const { Text } = ui;
        body.push(Text({ key: 'r-hd', size: 'caption', dimColor: true, wrap: 'truncate', children: ['Recent'] }));
        recent.forEach((r, i) => body.push(line(ui, 'r-rec' + i, r.tier, r.short)));
    }

    return card(ui, data, 'routing', 'Routing', data.routingOn ? 'on' : 'off',
        data.routingOn ? undefined : 'yellow', body);
}

/**
 * The whole sidebar.
 *
 * Cards that have nothing to say are left out, not drawn empty: no plan means
 * no Progress card, no agents means no Agents card. An empty card is a
 * permanent reminder of nothing.
 */
export function buildPanel(ui, data) {
    const { Box } = ui;
    const cards = [
        headCard(ui, data),
        usageCard(ui, data),
        progressCard(ui, data),
        agentsCard(ui, data),
        routingCard(ui, data),
    ].filter(Boolean);

    return Box({ flexDirection: 'column', rowGap: 1, children: cards });
}
