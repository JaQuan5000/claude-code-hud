/**
 * Deciding which model a prompt deserves.
 *
 * This reads the prompt's words, and nothing else. It could instead ask a
 * model to classify each prompt, which would be more accurate and would also
 * spend a request to save a request, so the cheap reading comes first and the
 * patterns below are meant to be edited by whoever owns the quota.
 *
 * The bias is deliberate: when the reading is uncertain the answer is the
 * everyday model, never the cheapest. A planning job sent to a small model
 * wastes the whole turn and your time, where a typo fix sent to a large one
 * wastes a few cents.
 *
 * Both patterns are written as regular expression literals rather than built
 * from strings. A string carries its own escape layer, so a word boundary has
 * to be written there as a doubled backslash, and anything that copies or
 * generates the file can quietly drop one of the two: the pattern then matches
 * nothing and every prompt looks like everyday work. A literal has no such
 * layer, and a damaged one fails to parse rather than failing silently.
 */

/** Work that is worth the expensive model. */
const DEEP = /\b(plan|planning|design|architect|architecture)\b|\b(refactor|restructure|rewrite|migrat\w*)\b|\b(debug|diagnose|investigate|root cause|race condition|deadlock)\b|\bwhy (is|does|did|would|are)\b|\b(trade.?offs?|approach|strategy)\b/i;

/**
 * You asked for the best model in so many words.
 *
 * This alone is enough. When someone writes "use the best model", second
 * guessing them with a cheaper one is not thrift, it is ignoring them.
 */
const TOP_EXPLICIT = /\b(best model|flagship|frontier model|use fable|think (really|very) hard|no shortcuts)\b/i;

/**
 * Work whose scope is a whole thing rather than a part of one.
 *
 * One optional word is allowed between the size and the thing, because
 * "the entire billing schema" is the same claim as "the entire
 * schema" and the stricter pattern only saw the second. Exactly one:
 * allowing any number would let "the entire point of this small fix" in.
 */
const TOP_SCOPE = /\b(entire|whole|complete)\s+(\w+\s+)?(code ?base|repo(sitory)?|project|system|app(lication)?|stack|schema|pipeline|service)\b|\bfrom scratch\b|\bgreenfield\b|\bend.to.end\b|\bground up\b/i;

/** Work where being wrong costs more than the tokens ever could. */
const TOP_STAKES = /\b(production|mission.critical|business.critical|safety.critical)\b|\bsecurity (audit|review|model)\b|\b(data loss|data corruption|corrupt the)\b|\bmoney\b/i;

/** Work that a small model finishes correctly. */
const FAST = /\b(typo|spelling|misspell\w*)\b|\b(rename|renaming)\b|\b(format|formatting|lint|prettier|indent\w*)\b|\b(comment|docstring)\b|\b(bump|version number)\b/i;

/** Past this many characters, a prompt is carrying a real problem. */
export const LONG_PROMPT = 400;

/** Past this many, it is a brief rather than a request. */
export const BRIEF_PROMPT = 1200;

/** Past this many, it is no longer the one-line request a small model suits. */
export const SHORT_PROMPT = 120;

/**
 * Which tier of work a prompt is: `fast`, `base`, `deep` or `top`.
 *
 * Order matters, and it runs from the most expensive signal down. A prompt
 * that reads as planning is deep even when it also says "rename", because
 * the expensive signal is the reliable one, and length is checked before the
 * small-work patterns so a long prompt that happens to mention a typo is not
 * treated as a typo fix.
 *
 * `top` is the flagship model, and it is deliberately harder to reach than
 * the rest. Asking for it in words is enough on its own. Otherwise the work
 * has to be planning-shaped *and* big: a whole system rather than a part of
 * one, something that breaks production if it is wrong, or a brief long
 * enough that the person writing it clearly thought it mattered. Planning
 * alone is not enough, or every design question would go to the most
 * expensive model there is.
 */
export function classify(text) {
    const s = String(text || '');
    if (!s.trim()) return 'base';
    if (TOP_EXPLICIT.test(s)) return 'top';
    if (DEEP.test(s) && (TOP_SCOPE.test(s) || TOP_STAKES.test(s) || s.length >= BRIEF_PROMPT)) return 'top';
    if (DEEP.test(s)) return 'deep';
    if (s.length >= LONG_PROMPT) return 'deep';
    if (s.length <= SHORT_PROMPT && FAST.test(s)) return 'fast';
    return 'base';
}

/**
 * The model for a tier, given what is left of the quota.
 *
 * `spareAbove` is the point where routing stops reaching for the deep model
 * on its own. The five-hour window is the one that bites, and the saving is
 * the whole point of the mod, so running it down to nothing automatically
 * would defeat it. You can still pick the deep model by hand: this only
 * governs what the mod chooses for you.
 */
export function chooseModel(tier, state, opts) {
    const models = {
        fast: opts.fastModel,
        base: opts.baseModel,
        deep: opts.deepModel,
        top: opts.topModel,
    };

    const five = (state.rateLimits || []).find((l) => l.kind === 'five_hour');
    const used = five && typeof five.percentUsed === 'number' ? five.percentUsed : 0;

    // The flagship tier steps down one rung at a time rather than all the way
    // to the cheap end: work that read as a whole-system job is still a
    // whole-system job when the quota is thin.
    if (tier === 'top') {
        if (!opts.routeToTop || !models.top) return chooseModel('deep', state, opts);
        if (used >= opts.spareAbove) {
            return { model: models.deep, tier: 'deep', held: true };
        }
        return { model: models.top, tier: 'top', held: false };
    }

    if (tier === 'deep' && used >= opts.spareAbove) {
        return { model: models.base, tier: 'base', held: true };
    }

    return { model: models[tier] || models.base, tier, held: false };
}
