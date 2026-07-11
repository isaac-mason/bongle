/**
 * Screen-center crosshair HUD, four thin `<div>` ticks driven from a
 * `CrosshairConfig`. It stays DOM (not the gpucat overlay pass) because it
 * must paint above HtmlTrait world overlays, which are DOM, and a
 * canvas-rendered layer can never sit above DOM.
 *
 * Each `Crosshair` owns its DOM + animation state: `updateCrosshair` lerps
 * the three source scalars (spread/length/thickness, CSS px) toward the
 * config and only rewrites the tick styles when a scalar drifts past an
 * epsilon or the color changes, so a stable crosshair is free. Animating
 * transform/size on four tiny elements is far cheaper than a full-viewport
 * canvas clear+repaint.
 */

import type { ScriptContext } from '../api/scripts';
import { UILayer } from './ui-layers';

export type CrosshairConfig = {
    /** show the four-tick crosshair HUD. */
    enabled: boolean;
    /** distance from screen center to inner edge of each tick (CSS px). */
    spread: number;
    /** length of each tick (CSS px). */
    length: number;
    /** width of each tick (CSS px). */
    thickness: number;
    /** tick fill, straight rgba each in 0..1. */
    color: [number, number, number, number];
    /** how quickly the boxes lerp toward target geometry; higher = snappier. */
    lerpSpeed: number;
};

/** fresh config with the stock defaults. controller traits use this as the
 *  factory for their `crosshair` bundle. */
export function defaultCrosshairConfig(): CrosshairConfig {
    return {
        enabled: true,
        spread: 0,
        length: 6,
        thickness: 2,
        color: [1, 1, 1, 0.95],
        lerpSpeed: 18,
    };
}

/** rewrite the tick styles only when a lerped scalar drifts past this many
 *  CSS px, so a stable crosshair costs nothing per frame. */
const REWRITE_EPS = 0.25;

/** rgba tuple (0..1) → CSS color string for a tick's background. */
function cssRgba(c: [number, number, number, number]): string {
    return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;
}

/** position + size one tick via transform (compositor) + width/height (crisp),
 *  relative to the 0×0 root anchored at screen center. background is written
 *  separately (only when the color changes), so geometry animation doesn't
 *  re-set an unchanged color and a color flash doesn't re-set geometry. */
function applyTickGeometry(el: HTMLDivElement, w: number, h: number, x: number, y: number): void {
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.transform = `translate(${x}px, ${y}px)`;
}

export type Crosshair = {
    ctx: ScriptContext;
    /** 0×0 anchor div at screen center; null while hidden/unmounted. */
    root: HTMLDivElement | null;
    /** the four tick divs (top, bottom, left, right) parented to `root`. */
    ticks: HTMLDivElement[];
    /** lerped source scalars, CSS px. */
    spread: number;
    length: number;
    thickness: number;
    /** false until the first update after (re)mount, so geometry snaps to
     *  config rather than lerping in from stale values. */
    lerpInit: boolean;
    /** last-written geometry, gating style rewrites via `REWRITE_EPS`. */
    lastSpread: number;
    lastLength: number;
    lastThickness: number;
    /** last-applied color components; the CSS string is rebuilt only when a
     *  component changes, so steady-state frames compare numbers and
     *  allocate nothing. */
    lastColor: [number, number, number, number];
};

export function createCrosshairImpl(ctx: ScriptContext): Crosshair {
    return {
        ctx,
        root: null,
        ticks: [],
        spread: 0,
        length: 0,
        thickness: 0,
        lerpInit: false,
        lastSpread: -1,
        lastLength: -1,
        lastThickness: -1,
        lastColor: [-1, -1, -1, -1],
    };
}

/** mount the DOM if it isn't already; false while the client has no viewport. */
function ensureCrosshair(crosshair: Crosshair): boolean {
    const viewport = crosshair.ctx.client?.viewport;
    if (!viewport) return false;
    if (crosshair.root) return true;
    // a 0×0 anchor at screen center; ticks position relative to its origin.
    const anchor = document.createElement('div');
    anchor.style.cssText = [
        'position: absolute',
        'left: 50%',
        'top: 50%',
        'width: 0',
        'height: 0',
        'pointer-events: none',
        `z-index: ${UILayer.crosshair}`,
    ].join('; ');
    const ticks: HTMLDivElement[] = [];
    for (let i = 0; i < 4; i++) {
        const tick = document.createElement('div');
        tick.style.cssText = 'position: absolute; left: 0; top: 0; will-change: transform';
        anchor.appendChild(tick);
        ticks.push(tick);
    }
    viewport.appendChild(anchor);
    crosshair.root = anchor;
    crosshair.ticks = ticks;
    // force a full rewrite on the first frame after (re)creation: the fresh
    // divs have no geometry or background yet.
    crosshair.lastSpread = -1;
    crosshair.lastColor[0] = -1;
    return true;
}

/**
 * remove the DOM and reset the lerp so the crosshair snaps (rather than
 * crawls) from config when it next shows. idempotent, and a later
 * `updateCrosshair` remounts, so this doubles as "hide": call it on POV
 * loss and from `onDispose`.
 */
export function disposeCrosshair(crosshair: Crosshair): void {
    if (crosshair.root) {
        crosshair.root.remove();
        crosshair.root = null;
        crosshair.ticks = [];
    }
    crosshair.lerpInit = false;
}

/**
 * drive the crosshair from `cfg` for this frame: mounts the DOM on first
 * call, lerps geometry toward the config, hides while `cfg.enabled` is
 * false. call once per frame while this controller holds the POV.
 */
export function updateCrosshair(crosshair: Crosshair, cfg: CrosshairConfig, dt: number): void {
    if (!cfg.enabled) {
        disposeCrosshair(crosshair);
        return;
    }
    if (!ensureCrosshair(crosshair)) return;

    if (!crosshair.lerpInit) {
        crosshair.spread = cfg.spread;
        crosshair.length = cfg.length;
        crosshair.thickness = cfg.thickness;
        crosshair.lerpInit = true;
    } else {
        const alpha = 1 - Math.exp(-cfg.lerpSpeed * dt);
        crosshair.spread += (cfg.spread - crosshair.spread) * alpha;
        crosshair.length += (cfg.length - crosshair.length) * alpha;
        crosshair.thickness += (cfg.thickness - crosshair.thickness) * alpha;
    }

    const color = cfg.color;
    const lastColor = crosshair.lastColor;
    const colorChanged =
        color[0] !== lastColor[0] || color[1] !== lastColor[1] || color[2] !== lastColor[2] || color[3] !== lastColor[3];
    const moved =
        Math.abs(crosshair.spread - crosshair.lastSpread) > REWRITE_EPS ||
        Math.abs(crosshair.length - crosshair.lastLength) > REWRITE_EPS ||
        Math.abs(crosshair.thickness - crosshair.lastThickness) > REWRITE_EPS;
    if (!moved && !colorChanged) return;

    const ticks = crosshair.ticks;
    if (colorChanged) {
        const colorCss = cssRgba(color);
        lastColor[0] = color[0];
        lastColor[1] = color[1];
        lastColor[2] = color[2];
        lastColor[3] = color[3];
        ticks[0]!.style.background = colorCss;
        ticks[1]!.style.background = colorCss;
        ticks[2]!.style.background = colorCss;
        ticks[3]!.style.background = colorCss;
    }

    if (moved) {
        // ticks in CSS px, positioned from the centered root: top, bottom,
        // left, right. `spread` = gap from center to each tick's inner edge.
        const s = crosshair.spread;
        const len = crosshair.length;
        const th = crosshair.thickness;
        const half = th / 2;
        applyTickGeometry(ticks[0]!, th, len, -half, -(s + len)); // top
        applyTickGeometry(ticks[1]!, th, len, -half, s); // bottom
        applyTickGeometry(ticks[2]!, len, th, -(s + len), -half); // left
        applyTickGeometry(ticks[3]!, len, th, s, -half); // right

        crosshair.lastSpread = s;
        crosshair.lastLength = len;
        crosshair.lastThickness = th;
    }
}
