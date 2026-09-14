import { base, type Control } from '../control';
import { decimalsForStep, el, on, snap } from '../dom';
import { openPopover, tooltip } from '../popover';
import { scrub } from '../scrub';

// feather-style "link" icon, drawn with currentColor so it follows the button state
const LINK_ICON =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

export type VecOptions = {
    /** override the per-component axis labels (also sets the arity). */
    axes?: readonly string[];
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    hint?: string;
};

/**
 * an n-component numeric tuple control — the backbone for math shapes stored
 * as plain arrays: vec2 `[x,y]`, vec3 `[x,y,z]`, vec4 `[x,y,z,w]`, spherical
 * `[r,θ,φ]`. the bound array is mutated in place so shared references stay valid.
 * vec2/vec3 also get a 2D joystick pad; a link toggle moves all components together.
 */
function vecControl(defaultAxes: readonly string[], enablePad: boolean) {
    return (opts: VecOptions = {}): Control<number[]> =>
        (ctx, prop) => {
            const axes = opts.axes ?? defaultAxes;
            const step = opts.step ?? 0.01;
            const decimals = decimalsForStep(step);
            const b = base<number[]>(ctx, prop, opts.label);
            if (opts.hint) b.handle.hint(opts.hint);
            b.row.classList.add('dc-row--stacked');

            let locked = false;

            const commit = (index: number, raw: number, finished: boolean) => {
                let n = raw;
                if (!Number.isFinite(n)) n = 0;
                n = snap(n, step);
                if (opts.min !== undefined) n = Math.max(opts.min, n);
                if (opts.max !== undefined) n = Math.min(opts.max, n);
                const current = prop.get();
                if (locked) {
                    const delta = n - current[index];
                    for (let j = 0; j < current.length; j++) current[j] += delta;
                } else {
                    current[index] = n;
                }
                b.handle.set(current, finished);
            };

            const inputs: HTMLInputElement[] = [];
            const grid = el('div', 'dc-vec');
            axes.forEach((axis, i) => {
                const input = el('input', 'dc-input', { type: 'number', step: String(step) });
                if (opts.min !== undefined) input.min = String(opts.min);
                if (opts.max !== undefined) input.max = String(opts.max);
                b.onDispose(on(input, 'input', () => commit(i, Number(input.value), false)));
                b.onDispose(on(input, 'change', () => commit(i, Number(input.value), true)));
                b.onDispose(
                    scrub(input, {
                        get: () => prop.get()?.[i] ?? 0,
                        set: (v, finished) => commit(i, v, finished),
                        step,
                        min: opts.min,
                        max: opts.max,
                    }),
                );
                inputs.push(input);
                grid.append(el('div', 'dc-vec-field', undefined, [el('span', 'dc-vec-axis', { textContent: axis }), input]));
            });
            b.controlEl.append(grid);

            // 2D joystick pad (vec2 only — a 2D pad maps cleanly to a 2-component value)
            if (enablePad && axes.length === 2) {
                const padBtn = el('button', 'dc-vec-tool', { type: 'button', textContent: '⌖' });
                b.onDispose(tooltip(padBtn, '<b>joystick</b> — drag the pad to set x and y together', ctx.layer));
                const bounded = opts.min !== undefined && opts.max !== undefined;
                let closePad: (() => void) | undefined;
                on(padBtn, 'click', () => {
                    closePad?.();
                    const cursor = el('div', 'dc-pad-cursor');
                    const pad = el('div', 'dc-pad', undefined, [cursor]);
                    const paint = () => {
                        const a = prop.get();
                        if (bounded) {
                            const tx = (a[0] - opts.min!) / (opts.max! - opts.min!);
                            const ty = 1 - (a[1] - opts.min!) / (opts.max! - opts.min!);
                            cursor.style.left = `${Math.max(0, Math.min(1, tx)) * 100}%`;
                            cursor.style.top = `${Math.max(0, Math.min(1, ty)) * 100}%`;
                        } else {
                            cursor.style.left = '50%';
                            cursor.style.top = '50%';
                        }
                    };
                    const setAbs = (e: PointerEvent, finished: boolean) => {
                        const r = pad.getBoundingClientRect();
                        const tx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                        const ty = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
                        const a = prop.get();
                        a[0] = snap(opts.min! + tx * (opts.max! - opts.min!), step);
                        a[1] = snap(opts.min! + (1 - ty) * (opts.max! - opts.min!), step);
                        b.handle.set(a, finished);
                        paint();
                    };
                    const setRel = (e: PointerEvent) => {
                        const a = prop.get();
                        a[0] = snap(a[0] + (e.movementX || 0) * step, step);
                        a[1] = snap(a[1] - (e.movementY || 0) * step, step);
                        b.handle.set(a, false);
                    };
                    on(pad, 'pointerdown', (e) => {
                        e.preventDefault();
                        if (bounded) setAbs(e, false);
                        const mv = (ev: PointerEvent) => (bounded ? setAbs(ev, false) : setRel(ev));
                        const up = () => {
                            b.handle.set(prop.get(), true);
                            window.removeEventListener('pointermove', mv);
                            window.removeEventListener('pointerup', up);
                        };
                        window.addEventListener('pointermove', mv);
                        window.addEventListener('pointerup', up);
                    });
                    paint();
                    closePad = openPopover(padBtn, pad, {
                        layer: ctx.layer,
                        onClose: () => {
                            closePad = undefined;
                        },
                    });
                });
                b.controlEl.append(padBtn);
                b.onDispose(() => closePad?.());
            }

            // link toggle — move all components together by the same delta
            const lockBtn = el('button', 'dc-vec-tool', { type: 'button' });
            lockBtn.innerHTML = LINK_ICON;
            on(lockBtn, 'click', () => {
                locked = !locked;
                lockBtn.classList.toggle('dc-vec-tool--on', locked);
            });
            b.onDispose(
                tooltip(lockBtn, '<b>link</b> — edit one component and the rest move with it (e.g. uniform scale)', ctx.layer),
            );
            b.controlEl.append(lockBtn);

            b.render(() => {
                const arr = prop.get();
                if (!arr) return;
                for (let i = 0; i < inputs.length; i++) {
                    if (ctx.doc.activeElement === inputs[i]) continue;
                    const v = arr[i];
                    inputs[i].value = Number.isFinite(v) ? v.toFixed(decimals) : String(v ?? 0);
                }
            });
            b.handle.refresh();
            return b.handle;
        };
}

export const vec2 = vecControl(['x', 'y'], true);
export const vec3 = vecControl(['x', 'y', 'z'], false);
export const vec4 = vecControl(['x', 'y', 'z', 'w'], false);
export const spherical = vecControl(['r', 'θ', 'φ'], false);
