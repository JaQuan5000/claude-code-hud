/**
 * A plan for the progress bar when Claude never wrote one.
 *
 * The bar counts a task list, and a model working through a long job often
 * does not keep one: asked in the system prompt and reminded mid-job, a model
 * with hours of task-less history carries on as it has been and ignores both.
 * A bar that appears only when the model cooperates is a bar that is mostly
 * not there, so this works out the plan from the work itself.
 *
 * The cheap model is handed what is visible from outside: the request, the
 * subagents dispatched (their descriptions say what each was for), the files
 * touched, and the last thing Claude said. It answers with the steps of the
 * whole job and which are done. The answer is an estimate and is drawn as one,
 * with a tilde before the count. A plan Claude writes itself always wins.
 *
 * **What is sent is deliberately narrow.** Commands are never included, since
 * a command can carry a token or a password. Files are named by their last path
 * segment only. Everything is trimmed to a few lines.
 *
 * Pure on purpose: prompts and parsing in, text and numbers out. The model
 * call itself lives in register.js.
 */

/** The steps worth listing: fewer is no plan, more is a wall. */
export const MIN_STEPS = 3;
export const MAX_STEPS = 12;

/** How much of anything is sent. */
const MAX_REQUEST = 600;
const MAX_ANSWER = 900;
const MAX_LINES = 28;
const MAX_STEP = 70;

/** When to look, so a job costs a handful of small requests and not one per step. */
export const INFER_EVERY_CALLS = 5;
export const INFER_MIN_GAP_MS = 30000;
export const INFER_TURN_TOOL_CALLS = 3;

/** One line, no control characters, no longer than asked. */
function tidy(text, max) {
    const s = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** The last segment of a path, so a name is shown and a directory layout is not. */
function baseName(path) {
    const s = String(path || '');
    const parts = s.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
}

/**
 * What Claude has been doing, as short lines.
 *
 * `messages` is the transcript as `$.session.messages()` returns it. Only the
 * tools whose input says what the work is are named with their detail:
 * a subagent's description, a skill, a task subject, a file's name. Every
 * other tool is only counted, so a command is never carried into a request.
 */
export function recentWork(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    const lines = [];
    const counts = {};

    for (const m of rows) {
        if (!m || m.role !== 'assistant' || !Array.isArray(m.toolUses)) continue;
        for (const use of m.toolUses) {
            if (!use || typeof use !== 'object') continue;
            const input = use.input && typeof use.input === 'object' ? use.input : {};
            let line = '';
            if (use.tool === 'Agent' || use.tool === 'Task') {
                line = 'subagent: ' + tidy(input.description || input.subagent_type || '', 90);
            } else if (use.tool === 'Skill') {
                line = 'skill: ' + tidy(input.skill || '', 60);
            } else if (use.tool === 'TaskCreate') {
                line = 'task made: ' + tidy(input.subject || '', 80);
            } else if (use.tool === 'Write' || use.tool === 'Edit' || use.tool === 'NotebookEdit') {
                const name = baseName(input.file_path || input.notebook_path);
                line = name ? 'edited: ' + tidy(name, 60) : '';
            } else {
                counts[use.tool] = (counts[use.tool] || 0) + 1;
            }
            if (line.endsWith(': ') || line === '') continue;
            lines.push(line);
        }
    }

    // The same line twice in a row says nothing the first did not.
    const out = [];
    for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
    const recent = out.slice(-MAX_LINES);

    const others = Object.entries(counts).filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([name, n]) => name + ' x' + n);
    if (others.length) recent.push('other tools used: ' + others.join(', '));
    return recent;
}

/** The text of the last message from one side, trimmed. */
function lastText(messages, role, max) {
    const rows = Array.isArray(messages) ? messages : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const m = rows[i];
        if (m && m.role === role && typeof m.text === 'string' && m.text.trim()) {
            return tidy(m.text, max);
        }
    }
    return '';
}

/** The person's most recent request, which is what the job is. */
export function latestRequest(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const m = rows[i];
        if (!m || m.role !== 'user' || typeof m.text !== 'string') continue;
        // A subagent's report handed back, or another session's message, is not the job.
        if (m.text.includes('<agent-message') || m.text.startsWith('Another Claude session sent')) continue;
        // The engine wraps notes of its own around a prompt; they are not the person's words.
        const bare = m.text.split('<system-reminder>').map((part, i) => {
            if (i === 0) return part;
            const end = part.indexOf('</system-reminder>');
            return end < 0 ? '' : part.slice(end + 18);
        }).join(' ');
        // A row that is only a tool's result carries no words of the person's.
        const text = tidy(bare, MAX_REQUEST);
        if (text) return text;
    }
    return '';
}

/**
 * The request to the cheap model, or null when there is nothing to go on.
 *
 * `previous` is the list from last time, so the same job keeps the same steps
 * and only their state moves, which is what stops the bar jumping about.
 */
export function buildPlanPrompt(messages, previous) {
    const request = latestRequest(messages);
    const work = recentWork(messages);
    const said = lastText(messages, 'assistant', MAX_ANSWER);
    if (!request && !work.length) return null;

    const lines = [
        'You are watching a coding assistant work, to keep a progress bar honest.',
        '',
        'The person\'s latest request: ' + (request || '(not shown)'),
        '',
        'What the assistant has done recently, oldest first:',
        ...(work.length ? work.map((l) => '- ' + l) : ['- (nothing named yet)']),
        '',
        'What the assistant last said: ' + (said || '(nothing yet)'),
    ];

    if (previous && Array.isArray(previous.steps) && previous.steps.length) {
        lines.push('', 'The list you gave last time:');
        previous.steps.forEach((s, i) => lines.push((i + 1) + '. [' + s.s + '] ' + s.t));
        lines.push('If this is still the same job, keep these steps in this order, change only which are done, and add steps that have since appeared. A step that was done stays done.');
    }

    lines.push(
        '',
        'Decide whether the assistant is carrying out a multi-step job. If it is, list the steps of the WHOLE job,',
        'between ' + MIN_STEPS + ' and ' + MAX_STEPS + ' of them, in order, each under 60 characters and naming the work,',
        'and mark each one done, doing or todo from what is shown above. Use only what is shown. Do not invent steps.',
        'If it is answering a question or making one small change, answer exactly NONE.',
        '',
        'Answer with JSON only, no other words: {"title": "short name of the job", "steps": [{"t": "step", "s": "done"}]}',
    );
    return lines.join('\n');
}

/** Did the model answer that there is no job, as opposed to answering badly? */
export function isNone(raw) {
    const text = typeof raw === 'string' ? raw : (raw && (raw.text || raw.content)) || '';
    return /^none\b/i.test(String(text).trim());
}

const STATUS = { done: 'done', doing: 'doing', todo: 'todo', pending: 'todo', in_progress: 'doing', completed: 'done' };

/**
 * The answer as a plan, or null.
 *
 * A model answering JSON still wraps it in a fence or a sentence now and
 * then, so the object is found rather than assumed. Anything that is not a
 * list of enough short steps is refused: a bar drawn from a guess that went
 * wrong is worse than no bar.
 */
export function parsePlan(raw) {
    const text = typeof raw === 'string' ? raw : (raw && (raw.text || raw.content)) || '';
    const trimmed = String(text).trim();
    if (!trimmed || /^none\b/i.test(trimmed)) return null;

    const a = trimmed.indexOf('{');
    const b = trimmed.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    let data;
    try {
        data = JSON.parse(trimmed.slice(a, b + 1));
    } catch {
        return null;
    }
    if (!data || !Array.isArray(data.steps)) return null;

    const steps = [];
    for (const s of data.steps) {
        if (!s || typeof s !== 'object') continue;
        const t = tidy(s.t != null ? s.t : (s.step != null ? s.step : s.title), MAX_STEP);
        const st = STATUS[String(s.s != null ? s.s : s.status).toLowerCase().replace(/[\s-]/g, '_')];
        if (!t || !st) continue;
        steps.push({ t, s: st });
        if (steps.length >= MAX_STEPS) break;
    }
    if (steps.length < MIN_STEPS) return null;
    return { title: tidy(data.title, 80), steps };
}

/** Words of a step, for telling whether two lists mean the same step. */
function words(text) {
    return new Set(String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1));
}

function alike(a, b) {
    const x = words(a);
    const y = words(b);
    if (!x.size || !y.size) return false;
    let shared = 0;
    for (const w of x) if (y.has(w)) shared += 1;
    return shared / Math.min(x.size, y.size) >= 0.6;
}

/**
 * The new list, with what was already finished kept finished.
 *
 * A step that was done does not become undone because a later guess was less
 * sure of it: work does not un-happen, and a bar that goes backwards looks
 * broken. A new list that shares almost nothing with the old one is a new job
 * and replaces it whole.
 */
export function stabilise(previous, next) {
    if (!next) return null;
    if (!previous || !Array.isArray(previous.steps) || !previous.steps.length) return next;

    const matched = next.steps.filter((n) => previous.steps.some((p) => alike(p.t, n.t))).length;
    if (matched / next.steps.length < 0.4) return next;

    const steps = next.steps.map((n) => {
        const before = previous.steps.find((p) => alike(p.t, n.t));
        return before && before.s === 'done' ? { t: n.t, s: 'done' } : n;
    });
    return { title: next.title || previous.title, steps };
}

/** The plan as the todo list shape the bar already reads. */
export function toTodos(plan) {
    if (!plan || !Array.isArray(plan.steps)) return [];
    return plan.steps.map((s) => ({
        content: s.t,
        activeForm: s.t,
        status: s.s === 'done' ? 'completed' : s.s === 'doing' ? 'in_progress' : 'pending',
    }));
}

/**
 * Is it time to ask again?
 *
 * Only with no plan of Claude's own, only after a stretch of work, and never
 * more than twice a minute, so a long job costs a handful of small requests.
 * `turnEnded` is the other moment worth looking: a finished turn that did real
 * work. The caller passes `lastAt: 0` there, because the end of a turn is not
 * held back by the gap: see `inferPlan`'s `final`.
 */
export function inferDue({ on, planned, busy, calls, turnToolCalls, turnEnded, lastAt, now }) {
    if (!on || planned || busy) return false;
    if (now - lastAt < INFER_MIN_GAP_MS) return false;
    if (turnEnded) return turnToolCalls >= INFER_TURN_TOOL_CALLS;
    return calls >= INFER_EVERY_CALLS;
}
