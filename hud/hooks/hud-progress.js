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

// =====================================================================
// The newer task tools
//
// An interactive session does not write one whole todo list. It adds a task
// at a time with TaskCreate and flips each by id with TaskUpdate, and
// TodoWrite is the older path that is not used there. A bar that listens only
// for TodoWrite therefore never sees a plan in the sessions that most need
// one, which is how a long job ran with no bar at all.
//
// These keep the same plan from the pieces. The ids come back in a tool's
// *result*, so the hook reads that after the call has run.
// =====================================================================

/** One field of a tool's input, wherever the event happens to carry it. */
function inputField(event, key) {
    if (!event || typeof event !== 'object') return undefined;
    const holders = [event, event.input, event.args, event.arguments, event.params, event.parameters];
    for (const holder of holders) {
        if (holder && typeof holder === 'object' && holder[key] !== undefined) return holder[key];
    }
    return undefined;
}

/** What a tool call answered with, whether or not it is wrapped. */
function resultOf(result) {
    if (!result || typeof result !== 'object') return {};
    const inner = result.result;
    return inner && typeof inner === 'object' ? inner : result;
}

function statusName(value) {
    return String(value || '').toLowerCase().replace(/[\s-]/g, '_');
}

/**
 * The plan after one task tool has run.
 *
 * `tasks` is an array of `{ id, subject, activeForm, status }` and is never
 * changed in place. Anything unrecognised returns it as it was, because a
 * progress bar is decoration and a surprise shape is not worth a wrong one.
 */
export function applyTaskTool(tasks, tool, event, result) {
    const list = Array.isArray(tasks) ? tasks : [];
    // A call that errored changed nothing: an update to an id that does not
    // exist must not become a task of its own.
    if (result && typeof result === 'object' && result.isError) return list;
    const out = resultOf(result);

    if (tool === 'TaskCreate') {
        const made = out.task && typeof out.task === 'object' ? out.task : null;
        const id = made && made.id != null ? String(made.id) : '';
        // No id means the call did not create anything, so there is nothing to
        // track. Guessing one would let a later update land on the wrong task.
        if (!id) return list;
        // A new job after a finished one starts a fresh plan. Otherwise the
        // five tasks that were done last hour would be counted in the total
        // and the bar would open at 60% on work not yet begun.
        const base = list.length && list.every((t) => t.status === 'completed') ? [] : list;
        return base.filter((t) => t.id !== id).concat([{
            id,
            subject: String((made.subject != null ? made.subject : inputField(event, 'subject')) || ''),
            activeForm: String(inputField(event, 'activeForm') || ''),
            status: 'pending',
        }]);
    }

    if (tool === 'TaskUpdate') {
        const id = String(inputField(event, 'taskId') != null ? inputField(event, 'taskId') : (out.taskId || ''));
        if (!id) return list;
        // A refused update changed nothing.
        if (out.success === false) return list;

        const status = statusName(inputField(event, 'status'));
        if (status === 'deleted') return list.filter((t) => t.id !== id);

        const known = list.find((t) => t.id === id);
        const patch = {};
        if (status) patch.status = status;
        const subject = inputField(event, 'subject');
        const form = inputField(event, 'activeForm');
        if (typeof subject === 'string') patch.subject = subject;
        if (typeof form === 'string') patch.activeForm = form;

        if (known) return list.map((t) => (t.id === id ? { ...t, ...patch } : t));
        // A task made before the mod was watching. Its name is unknown, but it
        // still counts: a plan with a hole in it reports the wrong total.
        return list.concat([{ id, subject: '', activeForm: '', status: patch.status || 'pending', ...patch }]);
    }

    if (tool === 'TaskList') {
        const all = Array.isArray(out.tasks) ? out.tasks : null;
        if (!all) return list;
        // The list is the whole truth, so it replaces what was inferred.
        const known = new Map(list.map((t) => [t.id, t]));
        return all.map((t) => {
            const id = String(t.id);
            const before = known.get(id);
            return {
                id,
                subject: String(t.subject || (before && before.subject) || ''),
                activeForm: (before && before.activeForm) || '',
                status: statusName(t.status) || 'pending',
            };
        });
    }

    return list;
}

/** The tracked tasks in the shape progressOf reads. */
export function todosFromTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : []).map((t) => ({
        content: t.subject,
        activeForm: t.activeForm || t.subject,
        status: t.status,
    }));
}

/**
 * What the progress bar has seen, in words, for `/hud plan`.
 *
 * The bar is silent when there is no plan, which is also exactly what it does
 * when something upstream is wrong: the mod is out of date, the tool is not
 * being called, a result came back in a shape it does not read. From the
 * outside those look identical, and finding out which took a round trip each
 * time. This says which, by counting what actually arrived.
 *
 * `seen` is how many calls of each plan tool have gone past this session;
 * `tracking` is whether Claude is being asked to keep a task list.
 */
export function planReport({ seen, tasks, plan, tracking }) {
    const counts = seen || {};
    const total = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']
        .reduce((n, k) => n + (counts[k] || 0), 0);
    const tracked = Array.isArray(tasks) ? tasks.length : 0;

    const lines = [];
    lines.push(plan
        ? 'plan: ' + plan.done + '/' + plan.total + ' done (' + Math.round(plan.percent) + '%)'
            + (plan.complete ? ', finished' : '')
        : 'plan: none');
    lines.push('tasks tracked from the task tools: ' + tracked);
    lines.push('plan tracking: ' + (tracking ? 'on, Claude is asked to keep a task list for long jobs' : 'off'));
    lines.push('plan tool calls seen this session: TaskCreate ' + (counts.TaskCreate || 0)
        + ', TaskUpdate ' + (counts.TaskUpdate || 0)
        + ', TaskList ' + (counts.TaskList || 0)
        + ', TodoWrite ' + (counts.TodoWrite || 0)
        + (counts.last ? ', last was ' + counts.last : ''));
    lines.push('');

    if (total === 0) {
        lines.push('No plan tool has been called in this session, so there is nothing to draw.');
        lines.push('The bar counts a task list, and a job run without one - often one handed to');
        lines.push('subagents a step at a time - has nothing to count.');
        if (tracking) {
            lines.push('Plan tracking is on, so Claude is asked to keep one for any job of three or more');
            lines.push('steps, from its next request. A job already under way may need asking directly:');
            lines.push('"keep a task list for the rest of this".');
        } else {
            lines.push('Plan tracking is off. /hud track on asks Claude to keep one for long jobs.');
        }
    } else if (!plan) {
        lines.push('Tasks have been seen, but there is no bar. A plan needs two or more tasks,');
        lines.push('and the bar goes the moment the last one is done.');
    } else if (plan.complete) {
        lines.push('The plan is finished, so the bar has gone. It returns with the next job.');
    } else {
        lines.push('The bar should be showing' + ' above the strip, or in the sidebar on the desktop.');
    }
    return lines;
}

// =====================================================================
// Getting the plan back after a reload
//
// Everything above learns the plan by watching the calls go past. A mod that
// is reloaded, or a Claude Code that is restarted and resumed, starts with
// nothing: the tasks were all created before it was listening, so the bar
// stayed away until Claude happened to call TaskList, which it may never do.
// The transcript has every one of those calls with its result, so the plan is
// read back out of it once, at the start.
// =====================================================================

/** The tools that build a plan. */
const PLAN_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'];

/**
 * A call's result as applyTaskTool reads it, from what the transcript kept.
 *
 * The typed record is preferred. Where only the text the model read survived,
 * TaskCreate's "Task #3 created successfully: ..." still names the id, which
 * is all an update needs to land on the right task.
 */
function storedResult(use) {
    if (use.result !== undefined && use.result !== null) return { result: use.result };
    if (use.tool === 'TaskCreate' && typeof use.text === 'string') {
        const m = /Task #([A-Za-z0-9_-]+) created/.exec(use.text);
        if (m) return { result: { task: { id: m[1] } } };
    }
    return null;
}

/**
 * The plan as the transcript left it: `{ tasks, todos, source, counts }`.
 *
 * `source` is whichever kind of list was written last, `tasks` or `todos`, so
 * a session that moved from one to the other shows the one in use. Errored
 * calls changed nothing and are skipped. Only the main conversation is read,
 * because a subagent's todo list is its own and is not the job you are
 * watching.
 */
export function replayPlan(messages) {
    let tasks = [];
    let todos = [];
    let source = '';
    const counts = { TodoWrite: 0, TaskCreate: 0, TaskUpdate: 0, TaskList: 0, last: '' };

    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || message.role !== 'assistant' || !Array.isArray(message.toolUses)) continue;
        for (const use of message.toolUses) {
            if (!use || typeof use !== 'object' || use.isError) continue;
            if (!PLAN_TOOLS.includes(use.tool)) continue;
            const input = use.input && typeof use.input === 'object' ? use.input : {};

            if (use.tool === 'TodoWrite') {
                todos = todosFrom(input);
                source = 'todos';
            } else {
                const result = storedResult(use);
                // A create with no id, or a list with no answer, is unreadable:
                // skipped rather than guessed at.
                if (!result && use.tool !== 'TaskUpdate') continue;
                tasks = applyTaskTool(tasks, use.tool, input, result || {});
                source = 'tasks';
            }
            counts[use.tool] += 1;
            counts.last = use.tool;
        }
    }
    return { tasks, todos, source, counts };
}

// =====================================================================
// Asking for a plan
//
// The bar can only count what Claude writes down. A long job run without a
// task list - most often one handed out to subagents a step at a time - has
// no denominator, and from the outside that looks exactly like a broken bar.
// So the mod asks, in one short section of the system prompt, for the task
// list a long job should have anyway. `/hud track off` stops asking.
// =====================================================================

/** The id of the section in the system prompt. */
export const TRACK_SECTION = 'hud:progress';

/**
 * The words added to the system prompt, or '' when there is nothing to ask
 * for because the session offers no way to keep a list.
 *
 * The wording was tried against real sessions, and the two things in it that
 * matter are the two a softer version lacked. It is an instruction ("before
 * your first tool call"), not a suggestion: a model that is merely told it
 * could keep a list mostly does not. And it says how to load the task tools,
 * because Claude Code lists them but keeps their schemas behind ToolSearch, so
 * a model has to fetch them first and, unprompted, rarely does.
 *
 * Fixed text for each kind of session, so the prompt cache sees the same
 * section on every request and it costs its few tokens once.
 */
export function trackingNudge(tools) {
    const offered = Array.isArray(tools) ? tools : [];
    const hasTasks = offered.includes('TaskCreate') && offered.includes('TaskUpdate');
    const hasTodos = offered.includes('TodoWrite');
    const canLoad = offered.includes('ToolSearch');
    if (!hasTasks && !hasTodos && !canLoad) return '';

    const lead = 'Progress tracking is required here. Before your first tool call on any request with three or more steps, '
        + 'or when you are carrying out a written plan, create the task list: ';
    const tail = ' Keep the list in the main conversation even when the steps are handed to subagents, and update it '
        + 'as each step\'s work is accepted. The person watches a progress bar that counts exactly these tasks, '
        + 'so work without them is invisible to them. Skip this for questions and single small edits.';

    if (hasTasks || (canLoad && !hasTodos)) {
        const load = canLoad
            ? 'if TaskCreate and TaskUpdate are not loaded yet, load them with ToolSearch (query "select:TaskCreate,TaskUpdate"), then '
            : '';
        return lead + load + 'call TaskCreate once per step. Mark each task in_progress with TaskUpdate when you begin it '
            + 'and completed as soon as it is done.' + tail;
    }
    return lead + 'write the steps with TodoWrite, and write the list again as each step starts and finishes, '
        + 'with exactly one in_progress at a time.' + tail;
}
