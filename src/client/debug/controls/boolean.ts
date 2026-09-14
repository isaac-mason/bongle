import { base, type Control } from '../control';
import { el, on } from '../dom';

export type BooleanOptions = { label?: string; hint?: string };

/** a custom squared checkbox (fills with accent + a check when on). */
export function boolean(opts: BooleanOptions = {}): Control<boolean> {
    return (ctx, prop) => {
        const b = base<boolean>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        const box = el('button', 'dc-check', { type: 'button', role: 'checkbox' });
        b.onDispose(on(box, 'click', () => b.handle.set(!prop.get(), true)));
        b.controlEl.append(box);
        b.render(() => {
            const on_ = Boolean(prop.get());
            box.classList.toggle('dc-check--on', on_);
            box.setAttribute('aria-checked', String(on_));
            box.textContent = on_ ? '✓' : '';
        });
        b.handle.refresh();
        return b.handle;
    };
}
