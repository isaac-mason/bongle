import { base, type Control } from '../control';
import { clamp, decimalsForStep, el, on, snap } from '../dom';
import { scrub } from '../scrub';

export type NumberOptions = {
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    hint?: string;
    /** override the display formatting of the numeric field. */
    format?: (value: number) => string;
};

function build(ranged: boolean, opts: NumberOptions): Control<number> {
    return (ctx, prop) => {
        const b = base<number>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        const { min, max } = opts;
        const step = opts.step ?? 1;
        const decimals = opts.step !== undefined ? decimalsForStep(step) : 3;
        const format = opts.format ?? ((v: number) => (Number.isFinite(v) ? v.toFixed(decimals) : String(v)));

        const commit = (raw: number, finished: boolean) => {
            let n = raw;
            if (!Number.isFinite(n)) n = min ?? 0;
            if (opts.step !== undefined) n = snap(n, step);
            if (min !== undefined) n = Math.max(min, n);
            if (max !== undefined) n = Math.min(max, n);
            b.handle.set(n, finished);
        };

        const isSlider = ranged && min !== undefined && max !== undefined;

        if (isSlider) {
            // one field that is both the slider and the value: the fill is the
            // field's background, the number sits on top. drag = slide, click = type.
            const input = el('input', 'dc-input dc-slidernum', { type: 'number' });
            input.step = String(opts.step ?? (max - min) / 100);
            input.min = String(min);
            input.max = String(max);
            on(input, 'input', () => commit(Number(input.value), false));
            on(input, 'change', () => commit(Number(input.value), true));

            const setFromX = (clientX: number, finished: boolean) => {
                const r = input.getBoundingClientRect();
                commit(min + clamp((clientX - r.left) / r.width, 0, 1) * (max - min), finished);
            };
            on(input, 'pointerdown', (e) => {
                if (ctx.doc.activeElement === input) return; // typing — leave the caret
                e.preventDefault();
                const startX = e.clientX;
                let moved = false;
                const move = (ev: PointerEvent) => {
                    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
                    moved = true;
                    setFromX(ev.clientX, false);
                };
                const up = (ev: PointerEvent) => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                    if (moved) setFromX(ev.clientX, true);
                    else {
                        input.focus();
                        input.select();
                    }
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
            });
            b.controlEl.append(input);

            b.render(() => {
                const v = prop.get();
                if (ctx.doc.activeElement !== input) input.value = format(v);
                const t = clamp((v - min) / (max - min), 0, 1) * 100;
                input.style.background = `linear-gradient(to right, var(--dc-fill) ${t}%, var(--dc-surface-muted) ${t}%)`;
            });
        } else {
            const input = el('input', 'dc-input dc-input--num', { type: 'number' });
            if (opts.step !== undefined) input.step = String(step);
            if (min !== undefined) input.min = String(min);
            if (max !== undefined) input.max = String(max);
            on(input, 'input', () => commit(Number(input.value), false));
            on(input, 'change', () => commit(Number(input.value), true));
            b.onDispose(scrub(input, { get: () => prop.get(), set: commit, step, min, max }));
            b.controlEl.append(input);

            b.render(() => {
                const v = prop.get();
                if (ctx.doc.activeElement !== input) input.value = format(v);
            });
        }

        b.handle.refresh();
        return b.handle;
    };
}

/** a numeric input (drag to scrub, or type). `min`/`max` clamp on commit. */
export function number(opts: NumberOptions = {}): Control<number> {
    return build(false, opts);
}

/** a fill-backed slider: one field that slides on drag and types on click. requires `min`/`max`. */
export function slider(opts: NumberOptions = {}): Control<number> {
    return build(true, opts);
}
