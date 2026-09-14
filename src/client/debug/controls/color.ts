import { base, type Control } from '../control';
import { clamp, el, on } from '../dom';
import { openPopover } from '../popover';

export type ColorOptions = {
    /**
     * how the bound `[r,g,b]` array is stored.
     * - `linear` (default): linear sRGB in 0..1 — math's `Color` layout.
     * - `srgb`: gamma-encoded sRGB in 0..1.
     */
    space?: 'linear' | 'srgb';
    label?: string;
    hint?: string;
};

// sRGB transfer functions (IEC 61966-2-1), matching math's colorspace module.
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const toHex = (srgb: [number, number, number]): string => {
    const byte = (v: number) =>
        clamp(Math.round(v * 255), 0, 255)
            .toString(16)
            .padStart(2, '0');
    return `#${byte(srgb[0])}${byte(srgb[1])}${byte(srgb[2])}`;
};
const parseHex = (input: string): [number, number, number] | null => {
    let s = input.trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    const n = Number.parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// sRGB 0..1 <-> HSV (h in degrees, s/v in 0..1)
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) [r, g] = [c, x];
    else if (h < 120) [r, g] = [x, c];
    else if (h < 180) [g, b] = [c, x];
    else if (h < 240) [g, b] = [x, c];
    else if (h < 300) [r, b] = [x, c];
    else [r, b] = [c, x];
    return [r + m, g + m, b + m];
}

/** an rgb color control: a swatch that opens a custom picker, plus a hex field. math-linear by default. */
export function color(opts: ColorOptions = {}): Control<number[]> {
    return (ctx, prop) => {
        const linear = (opts.space ?? 'linear') === 'linear';
        const b = base<number[]>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);

        const readSrgb = (): [number, number, number] => {
            const a = prop.get();
            return [linear ? linearToSrgb(a[0]) : a[0], linear ? linearToSrgb(a[1]) : a[1], linear ? linearToSrgb(a[2]) : a[2]];
        };
        const writeSrgb = (srgb: number[], finished: boolean) => {
            const a = prop.get();
            for (let i = 0; i < 3; i++) a[i] = linear ? srgbToLinear(clamp(srgb[i], 0, 1)) : clamp(srgb[i], 0, 1);
            b.handle.set(a, finished);
        };

        const swatch = el('button', 'dc-swatch', { type: 'button' });
        const hex = el('input', 'dc-input dc-color-hex', { type: 'text', spellcheck: false });
        b.controlEl.append(el('div', 'dc-color', undefined, [swatch, hex]));

        on(hex, 'change', () => {
            const v = parseHex(hex.value);
            if (v) writeSrgb(v, true);
            else b.handle.refresh();
        });

        let closePicker: (() => void) | undefined;
        const openPicker = () => {
            closePicker?.();
            const srgb = readSrgb();
            let [h, s, v] = rgbToHsv(srgb[0], srgb[1], srgb[2]);

            const cursor = el('div', 'dc-cp-cursor');
            const sv = el('div', 'dc-cp-sv', undefined, [cursor]);
            const hueCursor = el('div', 'dc-cp-hue-cursor');
            const hueStrip = el('div', 'dc-cp-hue', undefined, [hueCursor]);
            const content = el('div', 'dc-cp', undefined, [sv, hueStrip]);

            const paint = (finished: boolean, write = true) => {
                sv.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
                cursor.style.left = `${s * 100}%`;
                cursor.style.top = `${(1 - v) * 100}%`;
                hueCursor.style.left = `${(h / 360) * 100}%`;
                if (write) writeSrgb(hsvToRgb(h, s, v), finished);
            };

            const dragSV = (e: PointerEvent) => {
                const r = sv.getBoundingClientRect();
                s = clamp((e.clientX - r.left) / r.width, 0, 1);
                v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
                paint(false);
            };
            const dragHue = (e: PointerEvent) => {
                const r = hueStrip.getBoundingClientRect();
                h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
                paint(false);
            };
            const drag = (elmt: HTMLElement, fn: (e: PointerEvent) => void) =>
                on(elmt, 'pointerdown', (e) => {
                    e.preventDefault();
                    fn(e);
                    const mv = (ev: PointerEvent) => fn(ev);
                    const up = () => {
                        paint(true);
                        window.removeEventListener('pointermove', mv);
                        window.removeEventListener('pointerup', up);
                    };
                    window.addEventListener('pointermove', mv);
                    window.addEventListener('pointerup', up);
                });
            drag(sv, dragSV);
            drag(hueStrip, dragHue);

            paint(false, false);
            closePicker = openPopover(swatch, content, {
                layer: ctx.layer,
                onClose: () => {
                    closePicker = undefined;
                },
            });
        };
        on(swatch, 'click', openPicker);
        b.onDispose(() => closePicker?.());

        b.render(() => {
            const hx = toHex(readSrgb());
            swatch.style.background = hx;
            if (ctx.doc.activeElement !== hex) hex.value = hx;
        });
        b.handle.refresh();
        return b.handle;
    };
}
