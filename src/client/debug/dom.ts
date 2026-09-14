// tiny dom helpers. dashcat is vanilla — no framework, no vdom — so these
// keep element construction terse without pulling in a dependency.

/** create an element with a class, optional props, and optional children. */
export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    props?: Partial<HTMLElementTagNameMap[K]>,
    children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (props) Object.assign(node, props);
    if (children) {
        for (const child of children) {
            node.append(child);
        }
    }
    return node;
}

/** add a listener and return a disposer that removes it. */
export function on<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
): () => void {
    target.addEventListener(type, handler as EventListener, options);
    return () => target.removeEventListener(type, handler as EventListener, options);
}

/** clamp `n` into the inclusive range [min, max]. */
export function clamp(n: number, min: number, max: number): number {
    return n < min ? min : n > max ? max : n;
}

/** round `n` to the nearest multiple of `step` (step <= 0 is a no-op). */
export function snap(n: number, step: number): number {
    if (step <= 0) return n;
    return Math.round(n / step) * step;
}

/** number of decimal places implied by a step, for display formatting. */
export function decimalsForStep(step: number): number {
    if (!Number.isFinite(step) || step <= 0) return 3;
    const s = String(step);
    const dot = s.indexOf('.');
    return dot === -1 ? 0 : s.length - dot - 1;
}
