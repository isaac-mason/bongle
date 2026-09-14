import { base, type Control } from '../control';
import { clamp, decimalsForStep, el, on, snap } from '../dom';
import { scrub } from '../scrub';

export type IntervalOptions = {
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    hint?: string;
};

/** a `[lo, hi]` interval on one track with two handles, plus lo/hi number fields. */
export function interval(opts: IntervalOptions = {}): Control<number[]> {
    return (ctx, prop) => {
        const min = opts.min ?? 0;
        const max = opts.max ?? 1;
        const step = opts.step ?? ((max - min) / 100 || 0.01);
        const decimals = decimalsForStep(step);
        const b = base<number[]>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        b.row.classList.add('dc-row--stacked');

        const posOf = (v: number) => (max > min ? clamp((v - min) / (max - min), 0, 1) : 0);
        const setPair = (lo: number, hi: number, finished: boolean) => {
            lo = clamp(snap(lo, step), min, max);
            hi = clamp(snap(hi, step), min, max);
            if (lo > hi) [lo, hi] = [hi, lo];
            const a = prop.get();
            a[0] = lo;
            a[1] = hi;
            b.handle.set(a, finished);
        };

        const loInput = el('input', 'dc-input dc-input--num', { type: 'number', step: String(step) });
        const hiInput = el('input', 'dc-input dc-input--num', { type: 'number', step: String(step) });
        const fill = el('div', 'dc-slider-fill');
        const loThumb = el('div', 'dc-slider-thumb');
        const hiThumb = el('div', 'dc-slider-thumb');
        const track = el('div', 'dc-slider', undefined, [fill, loThumb, hiThumb]);
        b.controlEl.append(loInput, track, hiInput);

        const dragTo = (which: 'lo' | 'hi', clientX: number, finished: boolean) => {
            const r = track.getBoundingClientRect();
            const t = r.width > 0 ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
            const v = min + t * (max - min);
            const a = prop.get();
            if (which === 'lo') setPair(v, a[1], finished);
            else setPair(a[0], v, finished);
        };
        on(track, 'pointerdown', (e) => {
            e.preventDefault();
            const r = track.getBoundingClientRect();
            const t = (e.clientX - r.left) / r.width;
            const a = prop.get();
            const which: 'lo' | 'hi' = Math.abs(t - posOf(a[0])) <= Math.abs(t - posOf(a[1])) ? 'lo' : 'hi';
            dragTo(which, e.clientX, false);
            const mv = (ev: PointerEvent) => dragTo(which, ev.clientX, false);
            const up = (ev: PointerEvent) => {
                dragTo(which, ev.clientX, true);
                window.removeEventListener('pointermove', mv);
                window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', mv);
            window.addEventListener('pointerup', up);
        });

        on(loInput, 'change', () => setPair(Number(loInput.value), prop.get()[1], true));
        on(hiInput, 'change', () => setPair(prop.get()[0], Number(hiInput.value), true));
        b.onDispose(scrub(loInput, { get: () => prop.get()[0], set: (v, f) => setPair(v, prop.get()[1], f), step, min, max }));
        b.onDispose(scrub(hiInput, { get: () => prop.get()[1], set: (v, f) => setPair(prop.get()[0], v, f), step, min, max }));

        b.render(() => {
            const a = prop.get();
            if (!a) return;
            const lo = posOf(a[0]);
            const hi = posOf(a[1]);
            loThumb.style.left = `${lo * 100}%`;
            hiThumb.style.left = `${hi * 100}%`;
            fill.style.left = `${lo * 100}%`;
            fill.style.width = `${Math.max(0, hi - lo) * 100}%`;
            if (ctx.doc.activeElement !== loInput) loInput.value = a[0].toFixed(decimals);
            if (ctx.doc.activeElement !== hiInput) hiInput.value = a[1].toFixed(decimals);
        });
        b.handle.refresh();
        return b.handle;
    };
}
