import { base, type Control } from '../control';

/** drop an html string into a full-width row. prop-less. */
export function html(markup: string): Control<void> {
    return (ctx, prop) => {
        const b = base<void>(ctx, prop, '');
        b.labelEl.remove();
        b.controlEl.innerHTML = markup;
        return b.handle;
    };
}

/** drop an existing dom node into a full-width row. prop-less. */
export function element(node: Node): Control<void> {
    return (ctx, prop) => {
        const b = base<void>(ctx, prop, '');
        b.labelEl.remove();
        b.controlEl.append(node);
        return b.handle;
    };
}
