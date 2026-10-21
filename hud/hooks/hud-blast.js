/**
 * Measuring what a destructive command would do, before it does it.
 *
 * Claude Code already asks before a risky command. What it cannot tell you
 * is the size of the thing you are about to agree to: `rm -rf build` and
 * `rm -rf .` look alike in a prompt and differ by your afternoon. This finds
 * the shape of the command, picks a read-only way to measure it, and turns
 * the measurement into a sentence.
 *
 * **The security of this file is the argv list, and nothing else.** Every
 * preview is built as an array of arguments, never as a shell string, and
 * every command in it is a fixed verb chosen by which pattern matched. A
 * path taken from the command text is only ever passed as one element of
 * that array, so it cannot close a quote, start a subshell, or chain
 * another command - whatever it contains. Nothing here interpolates user
 * text into something a shell will parse.
 *
 * It also stays on the safe side of its own job: when it cannot work out
 * what a command would do, it says nothing and lets the usual permission
 * prompt handle it. A guard that blocks work because it got confused is
 * worse than no guard.
 */

/** Paths that make a delete catastrophic rather than merely large. */
const PRECIOUS = new Set(['/', '~', '.', '..', '/*', '~/', './', '$HOME', '/home', '/usr', '/etc', '/var', 'C:\\', 'C:/']);

/**
 * What kind of destruction this is, and what it is aimed at.
 *
 * Returns null for anything it does not recognise, which is most commands.
 * The patterns deliberately do not try to parse shell: a command with
 * substitution, a pipeline or an alias in it is not understood, and not
 * understanding it means staying quiet.
 */
export function assess(command) {
    const raw = String(command || '').trim();
    if (!raw) return null;

    // Anything that builds its own arguments is beyond static reading. Say
    // nothing rather than measure the wrong thing.
    if (/\$\(|`|\|\s*xargs|\beval\b/.test(raw)) return null;

    const rm = /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b\s*(.*)$/.exec(raw);
    if (rm) {
        const target = firstPath(rm[3]);
        if (!target) return null;
        return { kind: 'rm', target, precious: PRECIOUS.has(target), label: 'delete' };
    }

    if (/\bgit\s+reset\s+--hard\b/.test(raw)) {
        return { kind: 'git-reset', target: '.', precious: false, label: 'discard uncommitted work' };
    }

    if (/\bgit\s+clean\b.*-[a-zA-Z]*f/.test(raw)) {
        return { kind: 'git-clean', target: '.', precious: false, label: 'delete untracked files' };
    }

    if (/\bgit\s+push\b.*(--force\b(?!-with-lease)|(^|\s)-f(\s|$))/.test(raw)) {
        return { kind: 'git-force-push', target: '.', precious: false, label: 'overwrite the remote branch' };
    }

    if (/\bgit\s+checkout\s+--\s+\./.test(raw) || /\bgit\s+restore\s+\.\s*$/.test(raw)) {
        return { kind: 'git-reset', target: '.', precious: false, label: 'discard uncommitted work' };
    }

    if (/\bdrop\s+(table|database)\b/i.test(raw)) {
        return { kind: 'sql-drop', target: '', precious: true, label: 'drop a database object' };
    }

    if (/\b(mkfs|dd\s+if=)/.test(raw)) {
        return { kind: 'disk', target: '', precious: true, label: 'write to a device' };
    }

    return null;
}

/**
 * The first bare path in an argument list.
 *
 * Flags are skipped, and so is anything with a shell metacharacter in it:
 * a target this cannot read plainly is a target it will not measure.
 */
export function firstPath(args) {
    for (const word of String(args || '').trim().split(/\s+/)) {
        if (!word || word.startsWith('-')) continue;
        if (/["'<>|&;(){}*?!\\]/.test(word)) return null;
        return word;
    }
    return null;
}

/**
 * A read-only command that measures the damage, as argv.
 *
 * Each entry is a fixed verb with fixed flags; the only value that varies is
 * the target, and it travels as its own array element. Returns null when
 * there is nothing safe to run, in which case the caller describes the
 * command without a measurement rather than guessing at one.
 */
export function previewFor(assessment) {
    if (!assessment) return null;

    switch (assessment.kind) {
        case 'rm':
            // `find` counts without touching anything. The target is one
            // element, so a path containing spaces or symbols is still one
            // argument and still inert.
            return { argv: ['find', assessment.target, '-type', 'f'], reads: 'files' };

        case 'git-reset':
            return { argv: ['git', 'status', '--porcelain'], reads: 'changes' };

        case 'git-clean':
            // git's own dry run, which is exactly this question.
            return { argv: ['git', 'clean', '-nd'], reads: 'paths' };

        case 'git-force-push':
            return { argv: ['git', 'log', '--oneline', '@{u}..HEAD'], reads: 'commits' };

        default:
            return null;
    }
}

/** How many lines of output there were, which is the count in every case. */
export function countLines(stdout) {
    const text = String(stdout || '').trim();
    if (!text) return 0;
    return text.split('\n').filter((l) => l.trim()).length;
}

/**
 * The question to put to the user.
 *
 * Leads with the number, because the number is the whole point: "1,240
 * files" is the thing that makes you look twice, and a sentence that buries
 * it behind an explanation is a sentence nobody reads to the end of.
 */
export function describe(assessment, count) {
    if (!assessment) return '';

    const n = typeof count === 'number' ? count.toLocaleString('en-US') : null;
    const target = assessment.target && assessment.target !== '.' ? ' ' + assessment.target : '';

    switch (assessment.kind) {
        case 'rm':
            return n === null
                ? 'This deletes' + target + ' recursively, and the size could not be measured.'
                : 'This deletes ' + n + ' file' + (count === 1 ? '' : 's') + ' under' + target + '.';
        case 'git-reset':
            return n === null
                ? 'This discards every uncommitted change in the working tree.'
                : 'This discards ' + n + ' uncommitted change' + (count === 1 ? '' : 's') + '. They are not recoverable.';
        case 'git-clean':
            return n === null
                ? 'This deletes untracked files and directories.'
                : 'This deletes ' + n + ' untracked path' + (count === 1 ? '' : 's') + '. They are not in git, so they are gone.';
        case 'git-force-push':
            return n === null
                ? 'This overwrites the remote branch with yours.'
                : 'This overwrites the remote branch, replacing ' + n + ' commit' + (count === 1 ? '' : 's') + ' that are not in your history.';
        case 'sql-drop':
            return 'This drops a database object. There is no undo.';
        case 'disk':
            return 'This writes directly to a device. It can destroy a filesystem.';
        default:
            return 'This is a destructive command.';
    }
}

/** The extra line a catastrophic target deserves, or nothing. */
export function warningFor(assessment) {
    if (!assessment || !assessment.precious) return '';
    if (assessment.kind === 'rm') {
        return 'The target is ' + assessment.target + ', which is not a build directory. Read it twice.';
    }
    return 'This one cannot be undone by any means.';
}

/** How many guarded commands the sidebar remembers. */
export const GUARD_KEEP = 6;

/** What became of a command the guard stopped on. */
export const RAN = 'ran';
export const CANCELLED = 'cancelled';
export const PASSED = 'passed';

/**
 * Remember one command the guard looked at, newest last, keeping a few.
 *
 * Only the sentence the guard already showed you is kept: the kind of command
 * and what it would have touched, such as "This deletes 1,240 files under
 * build." The command line itself is never stored, since it can carry a
 * token or a password and nothing here needs it.
 *
 * `outcome` is `RAN` when you chose to run it, `CANCELLED` when you did not,
 * and `PASSED` when nobody could be asked and it went to the usual prompt.
 */
export function recordGuard(log, entry) {
    const next = (log || []).concat([{
        kind: String((entry && entry.kind) || ''),
        text: String((entry && entry.text) || ''),
        outcome: (entry && entry.outcome) || PASSED,
    }]);
    return next.length > GUARD_KEEP ? next.slice(next.length - GUARD_KEEP) : next;
}
