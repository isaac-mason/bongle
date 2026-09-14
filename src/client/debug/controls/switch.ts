import { base, type Control } from '../control';
import { el, on } from '../dom';

export type SwitchOptions = {
    /** short label per editor, shown on the flip toggle (defaults to 1, 2, 3…). */
    views?: string[];
    label?: string;
};

/**
 * flip one prop through several editors. each child control binds the same prop;
 * only the active one shows, and a small toggle cycles them. a switch is itself a
 * `Control<T>`, so custom editors compose in with no special-casing.
 */
export function switchControl<T>(controls: Control<T>[], opts: SwitchOptions = {}): Control<T> {
    return (ctx, prop) => {
        const b = base<T>(ctx, prop, opts.label);
        const children = controls.map((control) => control(ctx, prop));
        for (const child of children) child.name(''); // switch owns the label
        // if the editors stack (vec / rotation), the switch stacks too so they get full width
        if (children.some((c) => c.row.classList.contains('dc-row--stacked'))) {
            b.row.classList.add('dc-row--stacked');
        }
        const views = opts.views ?? controls.map((_, i) => String(i + 1));

        let active = 0;
        const toggle = el('button', 'dc-switch-toggle', { type: 'button' });
        const stack = el('div', 'dc-switch');
        for (const child of children) stack.append(child.row);
        b.controlEl.append(toggle, stack);

        const setActive = (i: number) => {
            active = ((i % children.length) + children.length) % children.length;
            toggle.textContent = views[active];
            children.forEach((child, idx) => {
                child.row.classList.toggle('dc-row--hidden', idx !== active);
            });
        };
        b.onDispose(on(toggle, 'click', () => setActive(active + 1)));
        b.setView((which) => {
            const i = typeof which === 'number' ? which : views.indexOf(String(which));
            if (i >= 0) setActive(i);
        });
        setActive(0);

        b.render(() => children[active].refresh());
        return b.handle;
    };
}
