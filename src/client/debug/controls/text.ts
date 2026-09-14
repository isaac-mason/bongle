import { base, type Control } from '../control';
import { el, on } from '../dom';

export type TextOptions = { placeholder?: string; label?: string; hint?: string };

/** a single-line text control. */
export function text(opts: TextOptions = {}): Control<string> {
    return (ctx, prop) => {
        const b = base<string>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        const input = el('input', 'dc-input', { type: 'text', placeholder: opts.placeholder ?? '' });
        b.onDispose(on(input, 'input', () => b.handle.set(input.value, false)));
        b.onDispose(on(input, 'change', () => b.handle.set(input.value, true)));
        b.controlEl.append(input);
        b.render(() => {
            const v = String(prop.get() ?? '');
            if (ctx.doc.activeElement !== input) input.value = v;
        });
        b.handle.refresh();
        return b.handle;
    };
}
