import { el } from './dom';

export type PopoverOptions = {
    /** where to mount: the `.dashcat` host (scoped styles, escapes overflow). */
    layer: HTMLElement;
    onClose?: () => void;
};

/**
 * open a floating popover anchored below (or above, if no room) an element.
 * dismisses on outside-pointerdown or escape. returns a `close` disposer.
 * the shared primitive behind the color picker, select dropdown, and joystick.
 */
export function openPopover(anchor: HTMLElement, content: HTMLElement, opts: PopoverOptions): () => void {
    const pop = el('div', 'dc-popover', undefined, [content]);
    opts.layer.append(pop);

    // position under the anchor, flip up / clamp into the viewport
    const a = anchor.getBoundingClientRect();
    pop.style.left = `${a.left}px`;
    pop.style.top = `${a.bottom + 4}px`;
    const r = pop.getBoundingClientRect();
    if (r.right > window.innerWidth) pop.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) pop.style.top = `${Math.max(4, a.top - r.height - 4)}px`;

    let closed = false;
    const onDown = (e: PointerEvent) => {
        const t = e.target as Node;
        if (pop.contains(t) || anchor.contains(t)) return;
        close();
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') close();
    };
    const close = () => {
        if (closed) return;
        closed = true;
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('keydown', onKey);
        pop.remove();
        opts.onClose?.();
    };

    // defer so the opening click doesn't immediately dismiss it
    setTimeout(() => {
        if (closed) return;
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey);
    }, 0);

    return close;
}

/**
 * an explanatory hover tooltip anchored above (or below) an element. `content`
 * is html. returns a disposer that unbinds the hover handlers.
 */
export function tooltip(anchor: HTMLElement, content: string, layer: HTMLElement): () => void {
    let tip: HTMLElement | null = null;
    let timer = 0;
    const hide = () => {
        clearTimeout(timer);
        timer = 0;
        tip?.remove();
        tip = null;
    };
    const show = () => {
        if (tip) return;
        tip = el('div', 'dc-popover dc-tip');
        tip.innerHTML = content;
        layer.append(tip);
        const a = anchor.getBoundingClientRect();
        const r = tip.getBoundingClientRect();
        const left = Math.max(4, Math.min(a.left + a.width / 2 - r.width / 2, window.innerWidth - r.width - 4));
        const above = a.top - r.height - 6;
        tip.style.left = `${left}px`;
        tip.style.top = `${above > 4 ? above : a.bottom + 6}px`;
    };
    const enter = () => {
        timer = window.setTimeout(show, 350);
    };
    anchor.addEventListener('pointerenter', enter);
    anchor.addEventListener('pointerleave', hide);
    anchor.addEventListener('pointerdown', hide);
    return () => {
        hide();
        anchor.removeEventListener('pointerenter', enter);
        anchor.removeEventListener('pointerleave', hide);
        anchor.removeEventListener('pointerdown', hide);
    };
}
