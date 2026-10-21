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

/**
 * The plan's colours, the same two savvy-progress uses: a soft violet while
 * the work is under way and a green once it is finished. Not the quota
 * gauges' green-amber-red, deliberately: those mean "how close to a limit",
 * and progress is not a limit. A job at 90% is nearly done, not in trouble.
 */
export const PLAN_ACCENT = '#8f8cf4';
export const PLAN_DONE = '#5fbf8f';

/** The bar's height, and the size of one dither cell, in pixels. */
const PLAN_H = 16;
const CELL = 3;

/**
 * A fixed pseudo-random number for a cell, so the dither is the same on every
 * redraw instead of shimmering each time a number changes.
 */
function noise(x, y) {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
}

/**
 * The progress bar, as an SVG document, in savvy-progress's style.
 *
 * The design, the colours and the dither follow savvy-progress by johnnyvizz
 * (github.com/JohnnyVizz/claude-kit, MIT licensed).
 *
 * A rounded track, filled with a dither of small squares in the plan's
 * colour that thickens towards the head of the fill, so the bar reads as
 * work piling up rather than a flat slab. Behind it, a fainter scatter
 * reaches as far as the work that is in hand. Thin ticks mark where each
 * task not yet reached begins, so how much is left is countable at a glance.
 * A pill riding the head of the fill carries the count, `4/12`.
 *
 * Built so it cannot clash with either theme: the track and the ticks are a
 * mid grey at low opacity, the fill is the plan's colour, and the only text
 * is white on that colour. The title and the percentage are left to the
 * caller as Text, which follows the app's theme by itself.
 *
 * The squares twinkle gently in four out-of-step groups; `prefers-reduced-
 * motion` stills them.
 */
export function planSvg(plan, opts = {}) {
    const W = Math.max(60, Math.round(Number(opts.width) || 400));
    const H = PLAN_H;
    const total = Math.max(0, Math.round((plan && plan.total) || 0));
    const done = Math.max(0, Math.min(total, Math.round((plan && plan.done) || 0)));
    const doing = Math.max(0, Math.round((plan && plan.doing) || 0));
    const complete = !!(plan && plan.complete);
    const ratio = complete ? 1 : total ? done / total : 0;
    const color = complete ? PLAN_DONE : PLAN_ACCENT;

    const fillW = Math.round(W * ratio);
    const reachW = total ? Math.round((W * Math.min(total, done + doing)) / total) : 0;
    const cols = Math.floor(fillW / CELL);
    const rows = Math.floor(H / CELL);

    // Dense at the head of the fill, sparse at its start.
    const dots = [];
    for (let c = 0; c < cols; c += 1) {
        const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2);
        for (let r = 0; r < rows; r += 1) {
            if (noise(c, r) < density) {
                dots.push('<rect class="t' + Math.floor(noise(r, c) * 4) + '" x="' + (c * CELL + 1)
                    + '" y="' + (r * CELL + 1) + '" width="2" height="2"/>');
            }
        }
    }

    // In hand but not finished: a faint second layer.
    const faint = [];
    for (let c = cols; c < Math.floor(reachW / CELL); c += 1) {
        for (let r = 0; r < rows; r += 1) {
            if (noise(c + 7, r + 3) < 0.2) {
                faint.push('<rect x="' + (c * CELL + 1) + '" y="' + (r * CELL + 1) + '" width="1.7" height="1.7"/>');
            }
        }
    }

    // Where each task still ahead begins.
    const ticks = [];
    for (let i = 1; i < total; i += 1) {
        const x = Math.round((W * i) / total);
        if (x > fillW + 4) {
            ticks.push('<rect x="' + x + '" y="' + (H / 2 - 4) + '" width="1.5" height="8" rx="0.75"/>');
        }
    }

    const label = total ? done + '/' + total : '';
    const pillW = label ? Math.round(18 + label.length * 6.6) : 0;
    const pillX = Math.max(0, Math.min(W - pillW, fillW - pillW));
    const twinkle = complete ? 3.2 : 2.2;
    const id = 'p' + total + '-' + done + '-' + doing;

    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">',
        '<style>',
        '.t0,.t1,.t2,.t3{animation:tw ' + twinkle + 's ease-in-out infinite}',
        '.t1{animation-duration:' + (twinkle + 0.6) + 's;animation-delay:-.7s}',
        '.t2{animation-duration:' + (twinkle - 0.3) + 's;animation-delay:-1.3s}',
        '.t3{animation-duration:' + (twinkle + 1.1) + 's;animation-delay:-.4s}',
        '@keyframes tw{0%,100%{opacity:1}50%{opacity:' + (complete ? 0.8 : 0.3) + '}}',
        '@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}',
        '</style>',
        '<defs><clipPath id="c' + id + '"><rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + H / 2 + '"/></clipPath></defs>',
        '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="' + H / 2 + '" fill="' + TRACK + '" fill-opacity="0.22"/>',
        '<g clip-path="url(#c' + id + ')">',
        '<g fill="' + color + '">' + dots.join('') + '</g>',
        '<g fill="' + color + '" opacity="0.45">' + faint.join('') + '</g>',
        '<g fill="' + TRACK + '" fill-opacity="0.55">' + ticks.join('') + '</g>',
        '</g>',
        label ? '<rect x="' + pillX + '" y="0" width="' + pillW + '" height="' + H + '" rx="' + H / 2 + '" fill="' + color + '"/>' : '',
        label ? '<text x="' + (pillX + pillW / 2) + '" y="' + (H / 2 + 4) + '" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif" font-size="11" font-weight="600" fill="#ffffff">' + label + '</text>' : '',
        '</svg>',
    ].join('');
}

/**
 * A plain meter in the plan's colour, for a share that is good when high,
 * such as how much of the input the prompt cache served. Not a quota gauge:
 * a full one is good news.
 */
export function meterSvg(percent, opts = {}) {
    const w = Math.max(20, Math.round(Number(opts.width) || 400));
    const h = opts.height || 8;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const fill = p > 0 ? Math.max(h, (p / 100) * w) : 0;
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">',
        '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="' + h / 2 + '" fill="' + TRACK + '" fill-opacity="0.22"/>',
        fill ? '<rect x="0" y="0" width="' + fill.toFixed(2) + '" height="' + h + '" rx="' + h / 2 + '" fill="' + PLAN_ACCENT + '"/>' : '',
        '</svg>',
    ].join('');
}

/** What a screen reader is told, since the picture carries the count. */
export function progressAlt(plan) {
    if (!plan) return 'progress';
    return 'Step ' + plan.done + ' of ' + plan.total + ', ' + Math.round(plan.percent) + ' percent done';
}
