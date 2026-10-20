/**
 * How far through the job you are, from the only honest denominator there is.
 *
 * I argued against this once, in a comment in hud-agents.js, and the argument
 * was half right: nothing knows how much work a subagent has left, so a bar
 * drawn from a running agent is a lie told in a convincing shape. What I
 * missed is that the denominator does not have to come from the agent. The
 * mods that do this well get it from the plan - savvy-progress reads the
 * plan savvy-flow declares, and shows accepted tasks against planned ones.
 *
 * Claude Code already keeps that plan: the todo list. It is written before
 * the work starts and updated as each item lands, so it carries a real
 * total, a real count done, and the name of the thing happening right now.
 * That is a progress bar with nothing invented in it.
 *
 * **It appears only when there is a plan to report.** One todo is not a
 * plan, and a bar that shows 0/1 on every small question is noise. Below two
 * items this says nothing at all, which is most turns.
 */

/** A list shorter than this is a note to self, not a plan worth drawing. */
export const MIN_PLAN = 2;

/**
 * The todo list out of a tool call, whatever the event happens to call it.
 *
 * Read across spellings on purpose. The field names on these events have
 * moved before - that is how the context reading and every reset time went
 * missing from a working strip - and a progress bar that silently stops
 * appearing is the same failure wearing a different hat.
 */
export function todosFrom(event) {
    if (!event || typeof event !== 'object') return [];
    const holders = [event, event.input, event.args, event.arguments, event.params, event.parameters];
    for (const holder of holders) {
        if (!holder || typeof holder !== 'object') continue;
        const list = holder.todos || holder.todoList || holder.items || holder.tasks;
        if (Array.isArray(list)) return list;
    }
    return [];
}

/** The status of one item, normalised. */
function statusOf(todo) {
    if (!todo || typeof todo !== 'object') return '';
    return String(todo.status || todo.state || '').toLowerCase().replace(/[\s-]/g, '_');
}

/** What the item says it is, for the line above the bar. */
function textOf(todo) {
    if (!todo || typeof todo !== 'object') return '';
    return String(todo.activeForm || todo.active_form || todo.content || todo.title || todo.text || '').trim();
}

/**
 * The plan as something drawable, or null when there is nothing to draw.
 *
 * `done` and `doing` are counted separately so the bar can show them
 * separately: work finished is solid, work in hand is faint behind it. The
 * two together are how far along the job actually is, and keeping them apart
 * is the difference between "seven done" and "six done and one running".
 */
export function progressOf(todos) {
    const list = Array.isArray(todos) ? todos.filter((t) => t && typeof t === 'object') : [];
    if (list.length < MIN_PLAN) return null;

    let done = 0;
    let doing = 0;
    let label = '';
    for (const todo of list) {
        const status = statusOf(todo);
        if (status === 'completed' || status === 'done') {
            done += 1;
        } else if (status === 'in_progress' || status === 'active' || status === 'running') {
            doing += 1;
            // The first one in hand names the bar. With several running the
            // first is as good a choice as any, and better than a count.
            if (!label) label = textOf(todo);
        }
    }

    const total = list.length;
    // The bar reaches the end when the work does, not when the last item is
    // picked up: `doing` is drawn behind `done`, never added to it.
    const percent = total ? (done / total) * 100 : 0;

    return {
        total,
        done,
        doing,
        percent,
        donePercent: percent,
        reachedPercent: total ? ((done + doing) / total) * 100 : 0,
        label: label || '',
        complete: done >= total,
    };
}

/** `7/12`, which is the part people read before the percentage. */
export function countText(plan) {
    if (!plan) return '';
    return plan.done + '/' + plan.total;
}

/**
 * Is this plan worth the two lines it takes?
 *
 * Not once everything is done: a finished bar is a receipt, and the turn
 * ending is receipt enough. It goes the moment the last item lands.
 */
export function worthShowing(plan) {
    return !!plan && plan.total >= MIN_PLAN && !plan.complete;
}
