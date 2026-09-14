import type { Formatter } from '../format';

/** a value that, once crossed, colors the widget. list ascending by `at`. */
export type Threshold = { at: number; color: string };

// semantic names map to theme tokens; anything else is treated as a literal css color.
const TOKENS: Record<string, string> = {
    ok: '--dc-success',
    warn: '--dc-warn',
    danger: '--dc-danger',
    accent: '--dc-accent',
    muted: '--dc-fg-muted',
    border: '--dc-border',
    fg: '--dc-fg',
};

/** resolves a semantic name (`ok`/`warn`/`danger`/`accent`/`muted`/`border`/`fg`) to a theme token, or passes through a literal css color. One-off; use `colorResolver` for hot paths. */
export function resolveColor(el: HTMLElement, color: string, fallback = '#2b5fd9'): string {
    const token = TOKENS[color];
    if (!token) return color;
    return getComputedStyle(el).getPropertyValue(token).trim() || fallback;
}

/** cached color resolver for per-frame drawing; theme tokens hit `getComputedStyle` at most once per `ttl` ms. Create one per widget and call it in paint. */
export function colorResolver(el: HTMLElement, ttl = 1000): (color: string) => string {
    const cache = new Map<string, { v: string; at: number }>();
    return (color) => {
        if (!TOKENS[color]) return color; // literal, never touch the dom
        const now = performance.now();
        const hit = cache.get(color);
        if (hit && now - hit.at < ttl) return hit.v;
        const v = resolveColor(el, color);
        cache.set(color, { v, at: now });
        return v;
    };
}

// distinct hues for multi-series widgets, readable on the dark surface.
const PALETTE = ['#4c8bf5', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#f472b6', '#94a3b8'];

/** the i-th series color, cycling the palette. */
export const paletteColor = (i: number): string => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

/** the color of the highest threshold `at` the value has reached (order-independent), or undefined when none apply. */
export function thresholdColor(value: number, thresholds?: Threshold[]): string | undefined {
    if (!thresholds || thresholds.length === 0) return undefined;
    let best: string | undefined;
    let bestAt = -Infinity;
    for (const t of thresholds) {
        if (value >= t.at && t.at >= bestAt) {
            bestAt = t.at;
            best = t.color;
        }
    }
    return best;
}

// same scope key always gets the same hue, so a scope reads as one color across the flame graph and the time series.
export function hashHue(s: string): number {
    let h = 2166136261; // FNV-1a
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 360;
}

/** a stable css color for a name (fixed saturation, `lightness` tunable per widget). */
export function hashColor(s: string, lightness = 52): string {
    return `hsl(${hashHue(s)} 55% ${lightness}%)`;
}

// faint horizontal rules at the min / mid / max of the current y-range.
export function drawGrid(g: CanvasRenderingContext2D, w: number, h: number, stroke: string) {
    g.strokeStyle = stroke;
    g.globalAlpha = 0.4;
    g.lineWidth = 1;
    g.beginPath();
    for (const y of [0.5, h / 2, h - 0.5]) {
        g.moveTo(0, y);
        g.lineTo(w, y);
    }
    g.stroke();
    g.globalAlpha = 1;
}

// min / mid / max value labels down the left edge so the scale is readable at a glance.
export function drawScaleLabels(
    g: CanvasRenderingContext2D,
    _w: number,
    h: number,
    lo: number,
    hi: number,
    fmt: Formatter,
    fill: string,
) {
    g.fillStyle = fill;
    g.globalAlpha = 1;
    g.font = '9px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(fmt(hi), 3, 1);
    g.textBaseline = 'middle';
    g.fillText(fmt((lo + hi) / 2), 3, h / 2);
    g.textBaseline = 'bottom';
    g.fillText(fmt(lo), 3, h - 1);
    g.textBaseline = 'alphabetic';
}

export function drawBaseline(g: CanvasRenderingContext2D, w: number, _h: number, y: number, stroke: string) {
    g.strokeStyle = stroke;
    g.globalAlpha = 0.5;
    g.setLineDash([3, 3]);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
}
