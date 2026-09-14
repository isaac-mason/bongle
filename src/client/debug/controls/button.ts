import { base, type Control } from '../control';
import { el, on } from '../dom';

/** an action button. prop-less — mount with `panel.add(control.button(...))`. */
export function button(label: string, action: () => void): Control<void> {
    return (ctx, prop) => {
        const b = base<void>(ctx, prop, '');
        b.labelEl.remove();
        const btn = el('button', 'dc-button', { type: 'button', textContent: label });
        b.onDispose(
            on(btn, 'click', () => {
                action();
                b.fire(undefined, true);
            }),
        );
        b.controlEl.append(btn);
        return b.handle;
    };
}

/** a row of action buttons. prop-less. */
export function buttonGroup(actions: Record<string, () => void>): Control<void> {
    return (ctx, prop) => {
        const b = base<void>(ctx, prop, '');
        b.labelEl.remove();
        for (const [label, action] of Object.entries(actions)) {
            const btn = el('button', 'dc-button', { type: 'button', textContent: label });
            b.onDispose(
                on(btn, 'click', () => {
                    action();
                    b.fire(undefined, true);
                }),
            );
            b.controlEl.append(btn);
        }
        return b.handle;
    };
}
