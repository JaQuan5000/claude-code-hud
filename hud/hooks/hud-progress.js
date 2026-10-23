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
 * The tool the mod registers itself, listed up front in every session.
 *
 * Claude Code's own task tools are not in every session (a 2.1.307 session
 * on a server was found with none, and where they exist they sit behind
 * ToolSearch, which a long job does not go and look in), so the bar had
 * nothing to count. This one is always there, takes the whole list each time
 * like TodoWrite does, and is the same honest denominator: the steps Claude
 * itself says the job has, and which of them it says are done.
 */
export const HUD_TOOL_NAME = 'progress';
export const HUD_TOOL = 'mcp__hud__progress';

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
        const list = holder.todos || holder.todoList || holder.steps || holder.items || holder.tasks;
        if (Array.isArray(list)) return list;
    }
    return [];
}

/**
 * The steps out of a call to the hud tool, as the todo shape the bar reads.
 *
 * Only a step with words and a status it knows is a step: a list of blanks
 * must draw no bar, not an empty one. The statuses are the tool's own
 * (todo, doing, done) and, leniently, the names Claude Code's task tools use.
 */
export function stepsFrom(event) {
    const out = [];
    for (const step of todosFrom(event)) {
        if (!step || typeof step !== 'object') continue;
        // Words only: a step title is drawn in the terminal, so control
        // characters (an escape sequence, a bell) are replaced by a space and
        // the length is capped, whatever the model wrote.
        const title = String(step.title || step.content || step.text || '')
            .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 200);
        const raw = String(step.status || step.state || '').toLowerCase().replace(/[\s-]/g, '_');
        const status = ['done', 'completed', 'complete', 'finished'].includes(raw) ? 'completed'
            : ['doing', 'in_progress', 'active', 'running'].includes(raw) ? 'in_progress'
            : ['todo', 'pending', 'not_started'].includes(raw) ? 'pending' : '';
        if (!title || !status) continue;
        out.push({ content: title, activeForm: title, status });
    }
    return out;
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
export function planReport({ seen, tasks, plan, tracking, items, working }) {
    const counts = seen || {};
    const total = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'progress']
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
        + ', progress ' + (counts.progress || 0)
        + (counts.last ? ', last was ' + counts.last : ''));
    lines.push('Claude is ' + (working ? 'working now' : 'idle'));
    lines.push('');

    // The list itself, so a count that looks wrong can be checked against what is on it.
    const listed = Array.isArray(items) ? items.filter((i) => i && typeof i === 'object') : [];
    if (listed.length) {
        lines.push('the list, as the bar counts it:');
        for (const item of listed.slice(0, 40)) {
            const s = statusName(item.status);
            const mark = s === 'completed' || s === 'done' ? '[done] ' : s === 'in_progress' || s === 'doing' ? '[doing]' : '[todo] ';
            const text = String(item.content || item.activeForm || item.subject || '(no name)').replace(/\s+/g, ' ').slice(0, 90);
            lines.push('  ' + mark + ' ' + text);
        }
        if (listed.length > 40) lines.push('  ... and ' + (listed.length - 40) + ' more');
        lines.push('');
    }

    if (total === 0) {
        lines.push('No plan tool has been called in this session, so there is nothing to draw.');
        lines.push('The bar counts the steps Claude writes down, and a job run without any steps has nothing to count.');
        lines.push('It never guesses a plan: no steps, no bar.');
        if (tracking) {
            lines.push('Plan tracking is on, so Claude is asked to keep one for any job of three or more');
            lines.push('steps, from its next request. A job already under way may need asking directly:');
            lines.push('"keep a task list for the rest of this", or "report your steps with the progress tool".');
        } else {
            lines.push('Plan tracking is off. /hud track on asks Claude to keep one for long jobs.');
        }
    } else if (!plan) {
        lines.push('Tasks have been seen, but there is no bar. A plan needs two or more tasks,');
        lines.push('and the bar goes the moment the last one is done.');
    } else if (plan.complete) {
        lines.push('The plan is finished, so the bar has gone. It returns with the next job.');
    } else if (!working) {
        lines.push('Claude is idle, so the bar is hidden: it shows only while Claude is working, and comes back with its next step.');
        lines.push('Anything above marked todo or doing is a task Claude left unfinished on its list, whether or not the work was done.');
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
const PLAN_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', HUD_TOOL];

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
    const counts = { TodoWrite: 0, TaskCreate: 0, TaskUpdate: 0, TaskList: 0, progress: 0, last: '' };

    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || message.role !== 'assistant' || !Array.isArray(message.toolUses)) continue;
        for (const use of message.toolUses) {
            if (!use || typeof use !== 'object' || use.isError) continue;
            if (!PLAN_TOOLS.includes(use.tool)) continue;
            const input = use.input && typeof use.input === 'object' ? use.input : {};

            if (use.tool === 'TodoWrite' || use.tool === HUD_TOOL) {
                todos = use.tool === HUD_TOOL ? stepsFrom(input) : todosFrom(input);
                source = 'todos';
            } else {
                const result = storedResult(use);
                // A create with no id, or a list with no answer, is unreadable:
                // skipped rather than guessed at.
                if (!result && use.tool !== 'TaskUpdate') continue;
                tasks = applyTaskTool(tasks, use.tool, input, result || {});
                source = 'tasks';
            }
            const key = use.tool === HUD_TOOL ? 'progress' : use.tool;
            counts[key] += 1;
            counts.last = key;
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

    const lead = 'Progress tracking is required here. Before your first tool call on any request with three or more steps, '
        + 'or when you are carrying out a written plan, create the task list: ';
    const tail = ' Keep the list in the main conversation even when the steps are handed to subagents, and update it '
        + 'as each step\'s work is accepted. The person watches a progress bar that counts exactly these tasks, '
        + 'so work without them is invisible to them. ' + FINISH + ' Skip this for questions and single small edits.';

    // Where there is no task tool to be had and nothing to look for one with, the mod's own is the one that is always there.
    if (!hasTasks && !hasTodos && !canLoad) return lead + HUD_STEPS + tail;

    if (hasTasks || (canLoad && !hasTodos)) {
        const load = canLoad
            ? 'if TaskCreate and TaskUpdate are not loaded yet, load them with ToolSearch (query "select:TaskCreate,TaskUpdate"), then '
            : '';
        return lead + load + 'call TaskCreate once per step. Mark each task in_progress with TaskUpdate when you begin it '
            + 'and completed as soon as it is done.' + (canLoad ? HUD_FALLBACK : ' ') + tail;
    }
    return lead + 'write the steps with TodoWrite, and write the list again as each step starts and finishes, '
        + 'with exactly one in_progress at a time.' + tail;
}

/**
 * What Claude is asked to do before it stops, in every wording of the request.
 *
 * The bar counts the list as written, so a job that is finished in fact and
 * unfinished on paper shows as unfinished: tasks left pending that Claude did,
 * or decided not to do, or that belong to an earlier job. Asking for a true
 * list at the end is what keeps the bar from claiming work that is not there.
 */
const FINISH = 'Before you finish a turn, make the list true: mark every task you did as completed, and delete every '
    + 'task you decided not to do or that belongs to an earlier job (TaskUpdate with status deleted, or leave it out of the next '
    + 'list), so nothing is left pending that you are not going to do.';

/** How to use the mod's own tool, said once. */
const HUD_STEPS = 'call ' + HUD_TOOL + ' with every step of the job, each with a status of todo, doing or done, and call it again with the '
    + 'whole list every time a step starts and every time one finishes, with exactly one step doing at a time. '
    + 'Call it one last time before you stop, with every step done and any step you dropped left out.';
/** Said beside the task tools, for the sessions where ToolSearch finds none. */
const HUD_FALLBACK = ' If ToolSearch finds no such tools, ' + HUD_STEPS + ' ';

// =====================================================================
// Reminding a model that is already deep in a job
//
// The note in the system prompt is enough for a fresh session and not for one
// that has been working for hours: its own history, hundreds of calls with no
// task list in them, is a far stronger signal than a paragraph at the top, and
// the work goes on the way it has been going. A reminder that arrives beside a
// tool result, in the middle of the work, is read as part of the work. Tried
// against a real session: with it, a model that had made six calls and no
// tasks began a task list on the next step; without it, it never did.
// =====================================================================

/** Main-thread tool calls with no plan before the first reminder. */
export const REMIND_AFTER = 8;
/** And how many more before another, if there is still none. */
export const REMIND_EVERY = 40;
/** The most reminders for one job. A model that has been asked four times has decided. */
export const REMIND_MAX = 4;

/**
 * One tool call's worth of bookkeeping.
 *
 * `r` is `{ calls, reminders }`; `planned` is whether a plan is being
 * tracked; `on` is the switch. Returns the next `r` and whether to speak.
 * Counting restarts whenever a plan exists, so a job that has one is never
 * reminded and the next job starts from nothing.
 */
export function reminderStep(r, { on, planned }) {
    const now = r && typeof r === 'object' ? r : { calls: 0, reminders: 0 };
    if (!on || planned) return { r: { calls: 0, reminders: 0 }, fire: false };

    const calls = now.calls + 1;
    const due = now.reminders === 0 ? REMIND_AFTER : REMIND_EVERY;
    if (calls >= due && now.reminders < REMIND_MAX) {
        return { r: { calls: 0, reminders: now.reminders + 1 }, fire: true };
    }
    return { r: { calls, reminders: now.reminders }, fire: false };
}

/**
 * The reminder, or '' when the session has nothing to keep a list with.
 *
 * `tools` is what the request offers, learned when the prompt was composed;
 * unknown means assume the task tools, which is what an interactive session has.
 */
export function reminderText(tools) {
    const offered = Array.isArray(tools) ? tools : null;
    const hasTasks = !offered || (offered.includes('TaskCreate') && offered.includes('TaskUpdate'));
    const hasTodos = !!offered && offered.includes('TodoWrite');
    const canLoad = !offered || offered.includes('ToolSearch');

    const lead = 'No task list exists for the work you are in the middle of, so the progress bar the person is watching '
        + 'is empty. Break what remains into at least three separate tasks now, one per step or item and never one task for everything: ';
    if (!hasTasks && !hasTodos && !canLoad) return lead + HUD_STEPS;
    if (hasTasks || (canLoad && !hasTodos)) {
        const load = canLoad
            ? 'if TaskCreate and TaskUpdate are not loaded yet, load them with ToolSearch (query "select:TaskCreate,TaskUpdate"), then '
            : '';
        return lead + load + 'call TaskCreate for each, mark the one you are on in_progress with TaskUpdate, and mark each '
            + 'completed as it is done, and before you stop mark every task done or delete it.' + (canLoad ? HUD_FALLBACK.trimEnd() : '');
    }
    return lead + 'write them with TodoWrite, with exactly one in_progress, write the list again as each one finishes, '
        + 'and write it once more before you stop with every finished item completed and any dropped item left out.';
}
