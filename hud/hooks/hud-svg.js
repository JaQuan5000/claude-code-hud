/**
 * The same readings, drawn as vector art for the Desktop app.
 *
 * The terminal gets characters because characters are all it has. The Desktop
 * app draws an `Svg` element, so there is no reason to make it pretend to be
 * a terminal: it gets a real gauge with rounded caps, a continuous fill, and
 * a colour that slides from green through amber to red along the track rather
 * than stepping cell by cell.
 *
 * Two rules shape everything here.
 *
 * **Nothing in the picture may assume a background.** The Desktop app has a
 * light theme and a dark one, and an `Svg` is a picture, not themed text, so
 * anything drawn in near-white vanishes on light and anything in near-black
 * vanishes on dark. Every neutral below is a mid grey at an opacity that
 * reads on both. The labels are not in the picture at all: they are `Text`
 * elements beside it, which follow the theme on their own.
 *
 * **Nothing here runs per keystroke.** The strings are built from four
 * numbers and no state, so a redraw costs a template literal.
 */

import { AMBER_FROM, RED_FROM } from './hud-format.js';

/** The three zone colours, chosen to read on a light and a dark theme. */
const GREEN = '#3fa45b';
const AMBER = '#d79020';
const RED = '#d9534f';

/** The track: a mid grey, never a near-white or near-black. */
const TRACK = '#8a8a8a';

/**
 * One gauge, as an SVG document.
 *
 * The gradient is laid over the whole track rather than over the fill, so a
 * given percentage is always the same colour wherever the fill happens to
 * end. Both stops at each boundary share a position, which gives a clean
 * step between zones instead of a wash; raising the second stop by a few
 * percent would blend them if you prefer that.
 *
 * The fill is clipped rather than resized so the rounded right cap stays
 * round at every width, including the sliver at 1%.
 */
export function gaugeSvg(percent, opts = {}) {
    const w = opts.width || 96;
    const h = opts.height || 10;
    const r = h / 2;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const filled = Math.max(p > 0 ? h : 0, (p / 100) * w);
    const id = 'g' + Math.round(p * 100);
    // The bands change where the printed number would round over, so the
    // picture and the text agree: amber from 56 means the colour turns at
    // 55.5, not at 56.
    const amberAt = (AMBER_FROM - 0.5) / 100;
    const redAt = (RED_FROM - 0.5) / 100;
    const markX = ((opts.markAt == null ? RED_FROM - 1 : opts.markAt) / 100) * w;

    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">',
        '<defs>',
        '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="' + w + '" y2="0">',
        '<stop offset="0" stop-color="' + GREEN + '"/>',
        '<stop offset="' + amberAt + '" stop-color="' + GREEN + '"/>',
        '<stop offset="' + amberAt + '" stop-color="' + AMBER + '"/>',
        '<stop offset="' + redAt + '" stop-color="' + AMBER + '"/>',
        '<stop offset="' + redAt + '" stop-color="' + RED + '"/>',
        '<stop offset="1" stop-color="' + RED + '"/>',
        '</linearGradient>',
        '<clipPath id="c' + id + '"><rect x="0" y="0" width="' + filled.toFixed(2) + '" height="' + h + '"/></clipPath>',
        '</defs>',
        '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="' + r + '" fill="' + TRACK + '" fill-opacity="0.22"/>',
        '<rect x="' + markX.toFixed(2) + '" y="1" width="1" height="' + (h - 2) + '" fill="' + TRACK + '" fill-opacity="0.45"/>',
        '<g clip-path="url(#c' + id + ')">',
        '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="' + r + '" fill="url(#' + id + ')"/>',
        '</g>',
        '</svg>',
    ].join('');
}

/** What a screen reader is told, since the picture carries a reading. */
export function gaugeAlt(label, percent) {
    return label + ' ' + Math.round(percent) + ' percent used';
}
