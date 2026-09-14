import { base, type Control } from '../control';
import { el, on } from '../dom';
import { openPopover } from '../popover';

export type SelectOptions<T> = {
    /** allowed values — a list, or a label→value map. */
    options: readonly T[] | Record<string, T>;
    label?: string;
    hint?: string;
};

/** a custom dropdown (themed trigger + options popover) over a fixed set of options. */
export function select<T = unknown>(opts: SelectOptions<T>): Control<T> {
    return (ctx, prop) => {
        const b = base<T>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        const entries: [string, T][] = Array.isArray(opts.options)
            ? opts.options.map((v) => [String(v), v])
            : Object.entries(opts.options as Record<string, T>);

        const labelEl = el('span', 'dc-select-label');
        const trigger = el('button', 'dc-select', { type: 'button' }, [
            labelEl,
            el('span', 'dc-select-caret', { textContent: '▾' }),
        ]);
        b.controlEl.append(trigger);

        let close: (() => void) | undefined;
        on(trigger, 'click', () => {
            if (close) {
                close();
                return;
            }
            const list = el('div', 'dc-select-list');
            for (const [label, value] of entries) {
                const item = el('div', `dc-select-option${value === prop.get() ? ' dc-select-option--on' : ''}`, {
                    textContent: label,
                });
                on(item, 'click', () => {
                    b.handle.set(value, true);
                    close?.();
                });
                list.append(item);
            }
            list.style.minWidth = `${trigger.offsetWidth}px`;
            close = openPopover(trigger, list, {
                layer: ctx.layer,
                onClose: () => {
                    close = undefined;
                },
            });
        });
        b.onDispose(() => close?.());

        b.render(() => {
            const cur = prop.get();
            const found = entries.find(([, v]) => v === cur);
            labelEl.textContent = found ? found[0] : '';
        });
        b.handle.refresh();
        return b.handle;
    };
}
