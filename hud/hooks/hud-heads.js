/**
 * One thing you might have missed.
 *
 * Claude Code has this built in, and it reads your whole context with the
 * model your session is using, which is as good as it gets and bills
 * several thousand tokens of instructions plus a reply on every check. In a
 * mod whose entire purpose is to spend less, that is the wrong shape.
 *
 * So this is the cheap version: a slice of the recent conversation, read by
 * the small model, asked for exactly one thing or nothing at all. It will
 * catch less. It is also roughly a fortieth of the price, and it can be
 * turned off with a command rather than left on because nobody remembers
 * how to stop it.
 *
 * Two rules keep it from becoming noise, and both are enforced here rather
 * than left to the model:
 *
 *   - it only looks at turns big enough to hide a mistake in
 *   - it answers with nothing far more often than with something, and an
 *     answer that is not a short concrete note is discarded
 */

/** How many turns must pass before it looks again. */
export const EVERY_N_TURNS = 3;

/** A turn smaller than this has nowhere for a mistake to hide. */
export const MIN_TOOL_CALLS = 3;
export const MIN_ANSWER = 600;

/** Longer than this and it is an essay, not a heads-up. */
export const MAX_NOTE = 160;

/** How much of the conversation to send. */
const SLICE = 2400;

/**
 * Is this turn worth a check?
 *
 * Both halves matter. The counter stops it running on every turn of a long
 * session, and the size test stops it burning a request on "yes, done" -
 * there is nothing in a two-line exchange that you missed.
 */
export function shouldCheck(turn) {
    if (!turn || turn.on === false) return false;
    if (turn.sinceLast < EVERY_N_TURNS) return false;
    const big = (turn.toolCalls || 0) >= MIN_TOOL_CALLS
        || String(turn.answer || '').length >= MIN_ANSWER;
    return big;
}

/**
 * The request, built from the recent conversation.
 *
 * It asks for silence by default and says so twice, because a model asked
 * for an observation will always find one, and a heads-up that fires every
 * time is a heads-up nobody reads.
 */
export function buildHeadsPrompt(messages) {
    const text = flatten(messages).slice(-SLICE);
    if (text.trim().length < 200) return null;

    return [
        'Here is the recent part of a coding session.',
        '',
        text,
        '',
        'Name one thing the developer may have missed: a tradeoff taken without',
        'saying so, a test that no longer matches the code, an edge case left',
        'open, a change with a consequence elsewhere.',
        '',
        'Most of the time there is nothing worth raising, and the right answer is',
        'the single word NONE. Only speak up if a competent reviewer would stop',
        'and point at it.',
        '',
        'Answer with one sentence under ' + MAX_NOTE + ' characters, or NONE.',
        'No preamble, no bullet, no quotes.',
    ].join('\n');
}

/**
 * The conversation as plain text.
 *
 * Content blocks arrive in several shapes depending on what a turn did, so
 * each one is reduced to whatever text it carries and the rest is dropped.
 */
export function flatten(messages) {
    const rows = Array.isArray(messages) ? messages : [];
    const out = [];

    for (const m of rows) {
        if (!m || typeof m !== 'object') continue;
        const role = m.role === 'assistant' ? 'Assistant' : (m.role === 'user' ? 'Developer' : null);
        if (!role) continue;

        const body = textOf(m.content);
        if (body) out.push(role + ': ' + body);
    }
    return out.join('\n');
}

/** The text inside a message's content, whatever shape it came in. */
export function textOf(content) {
    if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
    if (!Array.isArray(content)) return '';

    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') parts.push(block);
        else if (block && typeof block.text === 'string') parts.push(block.text);
        else if (block && typeof block.content === 'string') parts.push(block.content);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The note, or null.
 *
 * Everything that is not a short, concrete sentence is thrown away: the
 * refusals to answer, the preambles, the restatements of the question, the
 * paragraphs. A missing heads-up costs nothing; a bad one costs attention
 * every time you glance at the prompt.
 */
export function parseHeadsUp(raw) {
    const text = typeof raw === 'string' ? raw : (raw && (raw.text || raw.content)) || '';
    let note = String(text).trim();
    if (!note) return null;

    // The model was asked for one line. Take the first real one.
    note = note.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
    note = note.replace(/^[-*•]\s+/, '').replace(/^["'`]+|["'`]+$/g, '').trim();

    if (!note) return null;
    if (/^none\b/i.test(note)) return null;
    if (note.length > MAX_NOTE) return null;
    if (note.split(/\s+/).length < 4) return null;
    if (/^(sure|here|okay|ok|certainly|i |as an)/i.test(note)) return null;
    // A question is not an observation.
    if (note.endsWith('?')) return null;

    return note;
}
