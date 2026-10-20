/**
 * What the subagents are doing, while there are any.
 *
 * A subagent runs out of sight: you see the spinner and then, some minutes
 * later, an answer. Three of them run and you cannot tell whether one is
 * stuck, which is spending your quota, or how long this has been going on.
 *
 * So this keeps a small record of each one and draws a row while any are
 * alive. The row disappears completely when they finish - not a row saying
 * "no agents", which would be a permanent reminder of nothing.
 *
 * **There is no honest progress bar here.** A progress bar needs a
 * denominator and nothing knows how much work a subagent has left. The bar
 * each agent gets shows its share of the tokens spent across all of them,
 * which is a real number and answers the question you actually have: which
 * of these is doing the heavy lifting. Calling it progress would be a lie
 * told in a convincing shape.
 */

/** How long a finished agent stays on screen before it goes. */
export const LINGER_MS = 6000;

/** The statuses that mean an agent is still working. */
const ALIVE = new Set(['pending', 'running', 'waiting', 'idle']);

/** The statuses that mean it is over, one way or another. */
const DONE = new Set(['completed', 'failed', 'killed']);

/** Is this agent still going? */
export function isAlive(status) {
    return ALIVE.has(String(status || '').toLowerCase());
}

/** A new record for an agent that has just started. */
export function spawned(agents, entry, now = Date.now()) {
    const id = String(entry && (entry.agentId || entry.id) || '');
    if (!id) return agents;
    if (agents.some((a) => a.id === id)) return agents;

    return agents.concat([{
        id,
        name: shortName(entry),
        model: (entry && entry.model) || '',
        startedAt: now,
        finishedAt: null,
        tokens: 0,
        status: 'running',
    }]);
}

/**
 * A name short enough for a row.
 *
 * Subagent types are named like `general-purpose` or `code-reviewer`, which
 * is more than a row has space for and more than you need to tell two apart.
 */
export function shortName(entry) {
    const raw = String((entry && (entry.subagent_type || entry.agentType || entry.type || entry.name)) || 'agent');
    const first = raw.split(/[-_\s]/)[0] || 'agent';
    return first.slice(0, 9).toLowerCase();
}

/** Add the tokens one request spent to the agent that spent them. */
export function addTokens(agents, agentId, tokens) {
    const id = String(agentId || '');
    const n = Number(tokens) || 0;
    if (!id || n <= 0) return agents;
    return agents.map((a) => (a.id === id ? { ...a, tokens: a.tokens + n } : a));
}

/**
 * How many tokens one response cost, from whatever the usage names them.
 *
 * Cache reads are counted at full weight here deliberately. This number is
 * not a bill, it is a measure of how much work an agent is doing, and a
 * cached read is still a read.
 */
export function tokensOf(usage) {
    if (!usage || typeof usage !== 'object') return 0;
    const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
        'inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
    let total = 0;
    for (const key of keys) {
        const value = usage[key];
        if (typeof value === 'number' && Number.isFinite(value)) total += value;
    }
    return total;
}

/**
 * Fold in what `$.agent.list()` says, which is the only source of truth for
 * a status. An agent the list knows about but the events missed is added, so
 * a monitor is never blind to something that is plainly running.
 */
export function merge(agents, listed, now = Date.now()) {
    const byId = new Map(agents.map((a) => [a.id, a]));

    for (const item of Array.isArray(listed) ? listed : []) {
        const id = String((item && (item.id || item.agentId)) || '');
        if (!id) continue;
        const status = String((item && item.status) || 'running').toLowerCase();
        const known = byId.get(id);

        if (!known) {
            byId.set(id, {
                id,
                name: shortName(item),
                model: (item && item.model) || '',
                startedAt: now,
                finishedAt: isAlive(status) ? null : now,
                tokens: 0,
                status,
            });
            continue;
        }

        const finishing = DONE.has(status) && known.finishedAt === null;
        byId.set(id, { ...known, status, finishedAt: finishing ? now : known.finishedAt });
    }

    return [...byId.values()];
}

/**
 * The agents worth drawing, and nothing else.
 *
 * Running ones always, finished ones for a few seconds so you see how they
 * ended rather than having them vanish mid-glance. Anything older than that
 * is dropped from the record entirely, so a long session does not
 * accumulate hundreds of them.
 */
export function visible(agents, now = Date.now()) {
    return agents.filter((a) => isAlive(a.status) || (a.finishedAt && now - a.finishedAt < LINGER_MS));
}

/** Drop what will never be drawn again, so the record stays small. */
export function prune(agents, now = Date.now()) {
    return agents.filter((a) => isAlive(a.status) || (a.finishedAt && now - a.finishedAt < LINGER_MS));
}

/**
 * Does a share bar say anything here?
 *
 * A share needs something to be a share of. One agent is always the whole of
 * the agent tokens, so its bar is always full - and it is drawn in the same
 * language as the quota bars, where full means spent. The row read as an
 * agent that had exhausted something when it only meant it had no company.
 * From two agents on, the bar shows the split and earns its place.
 */
export function comparable(agents) {
    return (agents || []).length > 1;
}

/**
 * Each agent's share of the tokens spent across all of them, 0 to 1.
 *
 * With nothing spent yet every share is 0, which draws empty bars rather
 * than dividing by zero or inventing a number.
 */
export function shares(agents) {
    const total = agents.reduce((n, a) => n + (a.tokens || 0), 0);
    if (!total) return agents.map(() => 0);
    return agents.map((a) => (a.tokens || 0) / total);
}

/** How long it has been running, short enough for a row. */
export function elapsedText(startedAt, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm' + (seconds % 60 ? (seconds % 60) + 's' : '');
    return Math.floor(minutes / 60) + 'h' + (minutes % 60 ? (minutes % 60) + 'm' : '');
}

/** Tokens as something readable at a glance: 4.1k, 950, 1.2m. */
export function tokenText(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'm';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(v));
}

/** The colour a status should read as. */
export function statusColor(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'failed' || s === 'killed') return 'red';
    if (s === 'waiting' || s === 'idle' || s === 'pending') return 'yellow';
    if (s === 'completed') return undefined;
    return 'green';
}
