import { base, type Control } from '../control';
import { clamp, el, on, snap } from '../dom';
import { scrub } from '../scrub';

// math Quat is [x, y, z, w]. these controls edit a quaternion prop.

export type RotationOptions = { step?: number; label?: string; hint?: string };

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// quaternion <-> euler (radians), XYZ order — matches three.js / math.
function quatToEuler(q: number[]): [number, number, number] {
    const [x, y, z, w] = q;
    const m11 = 1 - 2 * (y * y + z * z);
    const m12 = 2 * (x * y - w * z);
    const m13 = 2 * (x * z + w * y);
    const m22 = 1 - 2 * (x * x + z * z);
    const m23 = 2 * (y * z - w * x);
    const m32 = 2 * (y * z + w * x);
    const m33 = 1 - 2 * (x * x + y * y);
    const ey = Math.asin(clamp(m13, -1, 1));
    if (Math.abs(m13) < 0.9999999) return [Math.atan2(-m23, m33), ey, Math.atan2(-m12, m11)];
    return [Math.atan2(m32, m22), ey, 0];
}

function eulerToQuat(ex: number, ey: number, ez: number, out: number[]): void {
    const c1 = Math.cos(ex / 2);
    const s1 = Math.sin(ex / 2);
    const c2 = Math.cos(ey / 2);
    const s2 = Math.sin(ey / 2);
    const c3 = Math.cos(ez / 2);
    const s3 = Math.sin(ez / 2);
    out[0] = s1 * c2 * c3 + c1 * s2 * s3;
    out[1] = c1 * s2 * c3 - s1 * c2 * s3;
    out[2] = c1 * c2 * s3 + s1 * s2 * c3;
    out[3] = c1 * c2 * c3 - s1 * s2 * s3;
}

function rotation(asEuler: boolean, opts: RotationOptions): Control<number[]> {
    return (ctx, prop) => {
        const step = opts.step ?? (asEuler ? 1 : 0.01);
        const axes = asEuler ? ['x°', 'y°', 'z°'] : ['x', 'y', 'z', 'w'];
        const decimals = asEuler ? 1 : 3;
        const b = base<number[]>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        b.row.classList.add('dc-row--stacked');

        const inputs: HTMLInputElement[] = [];
        const grid = el('div', 'dc-vec');
        axes.forEach((axis) => {
            const input = el('input', 'dc-input', { type: 'number', step: String(step) });
            b.onDispose(on(input, 'input', () => commit(false)));
            b.onDispose(on(input, 'change', () => commit(true)));
            b.onDispose(
                scrub(input, {
                    get: () => Number(input.value) || 0,
                    set: (v, finished) => {
                        input.value = v.toFixed(decimals);
                        commit(finished);
                    },
                    step,
                }),
            );
            inputs.push(input);
            grid.append(el('div', 'dc-vec-field', undefined, [el('span', 'dc-vec-axis', { textContent: axis }), input]));
        });
        b.controlEl.append(grid);

        const commit = (finished: boolean) => {
            const q = prop.get();
            const raw = inputs.map((input) => (Number.isFinite(Number(input.value)) ? Number(input.value) : 0));
            if (asEuler) {
                eulerToQuat(raw[0] * DEG2RAD, raw[1] * DEG2RAD, raw[2] * DEG2RAD, q);
            } else {
                for (let i = 0; i < 4; i++) q[i] = snap(raw[i], step);
            }
            b.handle.set(q, finished);
        };

        b.render(() => {
            const q = prop.get();
            if (!q) return;
            const values = asEuler ? quatToEuler(q).map((r) => r * RAD2DEG) : q;
            for (let i = 0; i < inputs.length; i++) {
                if (ctx.doc.activeElement === inputs[i]) continue;
                inputs[i].value = (values[i] ?? 0).toFixed(decimals);
            }
        });
        b.handle.refresh();
        return b.handle;
    };
}

/** edit a quaternion as euler angles in degrees (XYZ order). */
export function euler(opts: RotationOptions = {}): Control<number[]> {
    return rotation(true, opts);
}

/** edit a quaternion as raw x/y/z/w components. */
export function quaternion(opts: RotationOptions = {}): Control<number[]> {
    return rotation(false, opts);
}
