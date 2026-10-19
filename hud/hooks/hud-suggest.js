/**
 * What you might want to do next.
 *
 * After a turn ends, the mod can offer two or three follow-ups to press
 * rather than type. The useful ones are specific to what just happened -
 * "run the tests for the parser you just changed" rather than "continue" -
 * so they come from a model reading the turn, not from a list of stock
 * phrases.
 *
 * The cost is deliberately tiny and deliberately disclosed. The request goes
 * to the cheap model with a short slice of the turn and a ceiling of a few
 * dozen output tokens. In a mod whose purpose is to spend less, a feature
 * that spends has to earn it, so this is the one place that calls a model,
 * it uses the cheapest one, and `/hud suggest off` stops it.
 *
 * The prompt building and the parsing live here, away from the API, because
 * they are the parts that can be wrong in ways worth testing: a model that
 * answers with prose, numbering, quotes or ten suggestions instead of three
 * should still produce a clean, short list or nothing at all.
 */

/** How many to offer. Three fits the band and the hotkeys 1, 2, 3. */
export const WANTED = 3;

/** Longer than this and it stops being a button and starts being a paragraph. */
export const MAX_LENGTH = 64;

/** How much of the turn to send. Enough for context, not enough to cost. */
const SLICE = 900;

/**
 * The request sent to the cheap model.
 *
 * It asks for bare lines because every other shape has to be cleaned up
 * afterwards, and it says what the answer is for, because suggestions that
 * ignore what just happened are worse than none.
 */
export function buildSuggestPrompt(userText, answerText) {
    const asked = String(userText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const answered = String(answerText || '').replace(/\s+/g, ' ').trim().slice(-SLICE);
    if (!asked && !answered) return null;

    return [
        'A developer just finished this exchange in a coding session.',
        '',
        'They asked: ' + (asked || '(nothing recorded)'),
        '',
        'The assistant answered: ' + (answered || '(nothing recorded)'),
        '',
        'Suggest ' + WANTED + ' things they would plausibly ask for next, each one a',
        'short instruction they could send as-is. Be specific to this work: name the',
        'file, test or idea involved rather than saying "continue" or "keep going".',
        'Answer with ' + WANTED + ' lines and nothing else. No numbering, no bullets,',
        'no quotes, no explanation. Each line under ' + MAX_LENGTH + ' characters.',
    ].join('\n');
}

/**
 * The model's answer as a clean list, or an empty list.
 *
 * Everything here is defensive on purpose. The reply is text from a model,
 * so it may arrive numbered, bulleted, quoted, prefaced with "Sure!", or as
 * one long paragraph. Anything that does not look like a short instruction
 * is dropped rather than shown, because a bad suggestion costs more
 * attention than a missing one.
 */
export function parseSuggestions(raw) {
    const text = typeof raw === 'string' ? raw : (raw && (raw.text || raw.content)) || '';
    const out = [];

    for (let line of String(text).split('\n')) {
        line = line.trim();
        if (!line) continue;

        // Strip the shapes a model reaches for even when told not to.
        line = line.replace(/^[-*•]\s+/, '');
        line = line.replace(/^\d+[.)]\s+/, '');
        line = line.replace(/^["'`]+|["'`]+$/g, '');
        line = line.trim();

        if (!line) continue;
        if (line.length > MAX_LENGTH) continue;
        // A preamble or a sign-off rather than an instruction.
        if (/^(sure|here|certainly|of course|okay|ok)\b/i.test(line)) continue;
        if (line.endsWith(':')) continue;
        // Needs at least a couple of words to be an instruction.
        if (line.split(/\s+/).length < 2) continue;

        if (!out.includes(line)) out.push(line);
        if (out.length === WANTED) break;
    }

    return out;
}
