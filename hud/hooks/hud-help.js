/**
 * `/hud help`: what the mod does and how to get the most from it.
 *
 * Plain text, because a command can answer with nothing else, and written to
 * be read once from top to bottom: the guide first, in the order you meet the
 * things, then one page per topic for the detail. Static on purpose. It says
 * what the mod does, not what it is doing now (that is `/hud`, `/hud plan`
 * and `/hud log`), so it can never disagree with a reading.
 *
 * Kept apart from register.js so the words can be tested for one rule: every
 * command the mod answers appears here, and every command named here exists.
 */

/** Every verb `/hud` answers, in the order the guide lists them. */
export const COMMANDS = [
    ['', 'what is routed, why, and the numbers'],
    ['help [topic]', 'this guide, or one page of it'],
    ['off | auto', 'stop routing, or hand the choice back'],
    ['models', 'every model a tier can be set to'],
    ['set <tier> <model>', 'point one tier at another model'],
    ['log', 'what was routed where, and why'],
    ['tune', 'what the log says about your patterns'],
    ['plan', 'what the progress bar has seen, and why it is or is not showing'],
    ['track on | off', 'ask Claude to keep a task list for long jobs'],
    ['agents', 'every subagent this session has run'],
    ['suggest on | off', 'follow-ups under the strip'],
    ['know on | off', 'one thing you may have missed, after a big turn'],
    ['blast on | off', 'measure a destructive command before it runs'],
    ['confirm on | off', 'the question near the limit'],
    ['panel [off]', 'the desktop sidebar'],
    ['raw', 'what usage() reported, if a reading is missing'],
];

/** The verbs, alone: what the usage line and the tests compare against. */
export const VERBS = ['help', 'on', 'off', 'auto', 'models', 'set', 'log', 'tune', 'plan', 'track', 'agents',
    'suggest', 'know', 'heads', 'blast', 'confirm', 'panel', 'raw'];

const PAGES = {
    bar: {
        title: 'The progress bar',
        lines: [
            'It shows how far Claude is through a job, and only while Claude is working.',
            '',
            '  ● Wiring the panel   █████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░  Tasks 4/12  33%',
            '',
            'Solid blocks are finished steps, the medium shade is the step in hand, the light shade is what is left.',
            'While Claude works it moves. The moment its turn ends, or you interrupt it, the bar goes.',
            '',
            'Where the numbers come from: the list Claude writes down before it starts and ticks as it goes.',
            'Nothing is estimated. No list, no bar. One step is not a job, so it needs two or more.',
            '',
            'Why the bar can be missing:',
            '  - Claude is not keeping a list. Run /hud plan, it says so. /hud track on asks Claude to keep one.',
            '  - Claude is idle. The bar is hidden on purpose, so it can never stand at 6/9 under a finished answer.',
            '  - The job is already complete, or has under two steps.',
            '',
            'If the count looks wrong, /hud plan prints the list itself, [done] [doing] [todo], one line each.',
            'A [todo] there is a step Claude never ticked or never did; the bar was right about the list and the list was wrong.',
        ],
    },
    routing: {
        title: 'Model routing',
        lines: [
            'Each request goes to the cheapest model that can do it, chosen from the words in your prompt.',
            '',
            '  fast  a typo, a rename, formatting, a comment, a version bump',
            '  base  everyday work (and anything uncertain, never fast)',
            '  deep  planning, design, a refactor, a migration, debugging, or a long prompt',
            '  top   whole-system briefs, or when you ask for it',
            '',
            'You can ask for the flagship in the prompt: "use the best model", "use fable", "think really hard", "no shortcuts".',
            'There is no phrase to force a model down. Use /model haiku, or /hud off.',
            '',
            'It reads words, not intent, so it is sometimes wrong. Your options:',
            '  /model <name>   pick for the session; routing stands down and the badge reads pin',
            '  /hud off        stop routing, keep the readout',
            '  /hud auto       hand the choice back',
            '  /hud log        see what it chose and which words decided it',
            '  /hud tune       see which patterns it keeps getting wrong, then edit hud-route.js',
        ],
    },
    quota: {
        title: 'Quota, pace and the confirmation',
        lines: [
            'The strip shows context, and each rate-limit window with when it resets:',
            '',
            '  Ctx [██▌·····]  31% │ Session [█▌······]  18% ↻ 1h41m │ Week [████▍···]  55% ↻ 3d,11h',
            '',
            'Session is the five-hour window, Week the seven-day one.',
            'The ╎ mark on a bar is where the fill would be if you were spending evenly. Past it, you are ahead of the clock.',
            'Above 1.5x pace it says so ("3.5x pace, dry in 8m"). Below that it stays quiet, and a nearly spent window is not a warning.',
            '',
            'Near the limit (five-hour window past 85% and a prompt that earned an expensive tier) it asks once which model to use.',
            'The answer holds until the window resets. /hud confirm off stops the question.',
            'A reading missing from the strip? /hud raw shows exactly what Claude Code reported.',
        ],
    },
    safety: {
        title: 'Blast radius',
        lines: [
            'Before a destructive command runs, it is measured and you are told the size of what you are agreeing to:',
            '',
            '  This deletes 1,240 files under build.',
            '  rm -rf build        [Run it] [Cancel]',
            '',
            'It recognises rm -rf, git reset --hard, git clean -f, force pushes, DROP TABLE and raw device writes.',
            'It never flags --force-with-lease, never guesses at a command that builds its own arguments,',
            'and never blocks you if the measurement fails: you simply get the usual permission prompt.',
            '',
            '/hud blast off turns it off, and then nothing in the mod can start a process.',
        ],
    },
    agents: {
        title: 'Subagents',
        lines: [
            'While subagents are running, a row appears under the strip:',
            '',
            '  ⟳ 2 agents │ explore [████▌···]  18s 4.1k │ review [██······]   5s 1.2k',
            '',
            'Each bar is that agent\'s share of the tokens spent across all of them. It is not progress:',
            'nothing knows how much work a subagent has left. It tells you which one is doing the heavy lifting.',
            'When they finish the row lingers a few seconds and goes. With none running, nothing is drawn or polled.',
            '/hud agents lists every subagent the session has run, finished ones too.',
        ],
    },
    extras: {
        title: 'Follow-ups and the heads-up',
        lines: [
            'Follow-ups: after a turn, two or three next steps appear under the strip, one key each.',
            'They are written by the cheap model reading the turn, so they are about your work, not stock phrases.',
            '/hud suggest off stops them (this is the one thing that spends a little on your behalf each turn).',
            '',
            'Heads-up: after a substantial turn the cheap model rereads the conversation and raises at most one',
            'thing you may have missed. It is asked for silence by default and checks at most every third turn.',
            '/hud know off stops it. With both off, the mod calls no model on your behalf.',
        ],
    },
    panel: {
        title: 'The desktop sidebar',
        lines: [
            'In the Claude desktop app the whole HUD lives in a panel beside the conversation, as cards you can fold:',
            'Model, Heads up, Usage, Progress, Agents, Next steps, Activity, Routing, Blast radius, Models, Settings.',
            'A card with nothing to say is left out. The Settings card holds the same switches as the commands.',
            '',
            '/hud panel opens it; /hud panel off closes it and puts the strip back above the prompt.',
            'The terminal is never touched: it only ever gets the strip, the bar and the rows.',
        ],
    },
    tips: {
        title: 'Getting the most from it',
        lines: [
            '1. Leave tracking on (it is by default). The bar is only as true as the list Claude writes, and the mod',
            '   asks Claude to keep that list honest: tick what it did, delete what it dropped, before it stops.',
            '2. When a count looks off, run /hud plan before anything else. It lists the tasks and says whether Claude',
            '   is working or idle. Most surprises are a task that was done but never ticked.',
            '3. Let routing run, and glance at /hud log now and then. If it keeps choosing wrong for the way you write,',
            '   /hud tune shows which words, and hud-route.js is meant to be edited.',
            '4. Say "use the best model" for the one hard prompt instead of switching the whole session.',
            '5. Watch the pace mark, not the percentage. 91% with twenty minutes left is fine; 50% at 3x pace is not.',
            '6. Switch off what you do not use: /hud suggest off and /hud know off stop every background model call;',
            '   /hud blast off stops the guard. Your choices are remembered for next time.',
            '7. On the desktop, open /hud panel and keep it open; the strip steps aside so nothing is said twice.',
            '8. Doing a long job unattended? Give it a clear multi-step brief, and the bar will tell you at a glance',
            '   whether it is moving, without reading the transcript.',
        ],
    },
};

/** Words people try, mapped to the page that answers them. */
const ALIASES = {
    progress: 'bar', plan: 'bar', tasks: 'bar', track: 'bar', tracking: 'bar',
    route: 'routing', model: 'routing', models: 'routing', tier: 'routing', tiers: 'routing',
    pace: 'quota', limit: 'quota', limits: 'quota', usage: 'quota', confirm: 'quota', context: 'quota',
    blast: 'safety', guard: 'safety', destructive: 'safety', delete: 'safety',
    agent: 'agents', subagent: 'agents', subagents: 'agents',
    suggest: 'extras', suggestions: 'extras', followups: 'extras', know: 'extras', heads: 'extras', headsup: 'extras',
    sidebar: 'panel', desktop: 'panel', pane: 'panel',
    best: 'tips', tip: 'tips', advice: 'tips', howto: 'tips',
};

/** The page names, in the order the guide lists them. */
export const TOPICS = Object.keys(PAGES);

/** The page a word asks for, or null. */
export function topicFor(word) {
    const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return null;
    if (PAGES[w]) return w;
    return ALIASES[w] || null;
}

function commandRows() {
    return COMMANDS.map(([verb, what]) => '  ' + ('/hud ' + verb).trimEnd().padEnd(26) + what);
}

/**
 * The whole guide: what it is, what each part does in a line or two, the
 * commands, and the pages that go deeper.
 */
export function guideLines() {
    return [
        'hud: a status bar, a progress bar and a model router for Claude Code',
        '',
        'WHAT YOU SEE',
        '  Header      model, routing mode, and the five-hour reset, as a bar across the top',
        '  Strip       context used, and each rate-limit window with its reset time and pace',
        '  Progress    how far Claude is through a multi-step job, while it works (help bar)',
        '  Agents      a row while subagents run, and nothing when none do (help agents)',
        '  Next steps  follow-ups under the strip, one key each (help extras)',
        '',
        'WHAT IT DOES FOR YOU',
        '  Routes every request to the cheapest capable model: haiku, sonnet, opus, fable (help routing)',
        '  Warns before you run dry, using pace and not just percent (help quota)',
        '  Measures a destructive command before it runs (help safety)',
        '  Raises one thing you may have missed after a big turn (help extras)',
        '  On the desktop, shows all of it in a sidebar (help panel)',
        '',
        'COMMANDS',
        ...commandRows(),
        '',
        'MORE: /hud help <' + TOPICS.join('|') + '>',
        'Start with /hud help tips if you only read one page.',
    ];
}

/** One page, or the guide when no topic is given, or a pointer when the word is unknown. */
export function helpLines(topic) {
    const asked = String(topic || '').trim();
    if (!asked) return guideLines();
    const key = topicFor(asked);
    if (!key) {
        return ['No help page called "' + asked.slice(0, 40).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ') + '".',
            'Pages: ' + TOPICS.join(', ') + '. /hud help on its own gives the whole guide.'];
    }
    const page = PAGES[key];
    return [page.title.toUpperCase(), '', ...page.lines, '', 'Back to the guide: /hud help'];
}
