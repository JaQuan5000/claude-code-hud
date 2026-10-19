/**
 * The models a tier can be set to, and the names people actually type.
 *
 * Two things live here because they are the same problem seen from both
 * ends. A `turn.step` hook sets the model on the request, which wants a full
 * id such as `claude-sonnet-5-5`. Nobody wants to type that, and the strip
 * has ten columns to draw it in. So: a catalogue of ids, a shortener for the
 * readout, and a resolver that turns whatever you typed into an id.
 *
 * The alias trap this exists to close: `haiku`, `sonnet`, `opus` and `fable`
 * are resolved by the command line for `--model` and `/model`. They are not
 * resolved on the request, so a mod that passes one through gets `There's an
 * issue with the selected model (sonnet). It may not exist` and a silent
 * fallback to something else. Everything here resolves to an id first.
 */

/**
 * Every model a tier can be set to, newest first within each family.
 *
 * `claude-mythos-*` is deliberately absent: it is limited to one access
 * program, so offering it would put a model in the list that almost nobody
 * can select.
 */
export const MODELS = [
    { id: 'claude-fable-5-1', short: 'fable 5.1', family: 'fable', note: 'the flagship, for the hardest work' },
    { id: 'claude-fable-5', short: 'fable 5', family: 'fable', note: 'the previous flagship' },
    { id: 'claude-opus-5-5', short: 'opus 5.5', family: 'opus', note: 'complex work and everyday tasks' },
    { id: 'claude-opus-5', short: 'opus 5', family: 'opus', note: 'the previous Opus' },
    { id: 'claude-opus-4-8', short: 'opus 4.8', family: 'opus', note: 'older Opus' },
    { id: 'claude-opus-4-7', short: 'opus 4.7', family: 'opus', note: 'older Opus' },
    { id: 'claude-opus-4-6', short: 'opus 4.6', family: 'opus', note: 'older Opus' },
    { id: 'claude-sonnet-5-5', short: 'sonnet 5.5', family: 'sonnet', note: 'the everyday workhorse' },
    { id: 'claude-sonnet-5', short: 'sonnet 5', family: 'sonnet', note: 'the previous Sonnet' },
    { id: 'claude-sonnet-4-6', short: 'sonnet 4.6', family: 'sonnet', note: 'older Sonnet' },
    { id: 'claude-haiku-5-5', short: 'haiku 5.5', family: 'haiku', note: 'fastest, for small work' },
    { id: 'claude-haiku-4-5', short: 'haiku 4.5', family: 'haiku', note: 'older Haiku' },
];

/** The newest model of each family, which is what a bare family name means. */
export const NEWEST = {
    fable: 'claude-fable-5-1',
    opus: 'claude-opus-5-5',
    sonnet: 'claude-sonnet-5-5',
    haiku: 'claude-haiku-5-5',
};

/**
 * A model id as the strip should print it.
 *
 * `claude-sonnet-5-5` becomes `sonnet 5.5`, which is exactly the ten columns
 * the model column has. Anything not of that shape is returned unchanged, so
 * a model released after this file was written still prints something
 * sensible rather than an empty string.
 */
export function shortModel(id) {
    const s = String(id || '');
    const known = MODELS.find((m) => m.id === s);
    if (known) return known.short;
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(s);
    if (!m) return s;
    return m[3] ? m[1] + ' ' + m[2] + '.' + m[3] : m[1] + ' ' + m[2];
}

/**
 * Whatever someone typed, as a model id, or null.
 *
 * Accepts a full id, a family name such as `sonnet` (which means that
 * family's newest), a printed short name such as `sonnet 5.5`, and the same
 * with a dot or a dash. Returns null rather than guessing when nothing
 * matches, because setting a tier to a model that does not exist fails on
 * the next request rather than here, where it would be obvious.
 */
export function resolveModel(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) return null;
    if (NEWEST[raw]) return NEWEST[raw];
    if (raw === 'best' || raw === 'flagship') return NEWEST.fable;

    const byId = MODELS.find((m) => m.id === raw);
    if (byId) return byId.id;

    const tidy = raw.replace(/\s+/g, ' ');
    const byShort = MODELS.find((m) => m.short === tidy);
    if (byShort) return byShort.id;

    // `sonnet-5-5`, `sonnet 5 5`, `claude-sonnet-5.5` and so on.
    const loose = raw.replace(/^claude[-\s]*/, '').replace(/[.\s]/g, '-');
    const byLoose = MODELS.find((m) => m.id === 'claude-' + loose);
    if (byLoose) return byLoose.id;

    return null;
}
