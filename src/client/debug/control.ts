import { el } from './dom';
import type { Prop } from './prop';
import type { Ticker } from './ticker';

/** shared services handed to every control when it mounts. */
export type Context = {
    ticker: Ticker;
    doc: Document;
    /** the `.dashcat` host element, mount popovers/overlays here (scoped + overflow-safe). */
    layer: HTMLElement;
};

/** the live handle returned when a control is mounted. everything chains. */
export type Handle<T> = {
    readonly row: HTMLElement;
    get(): T;
    set(value: T, finished?: boolean): Handle<T>;
    onChange(fn: (value: T) => void): Handle<T>;
    onFinishChange(fn: (value: T) => void): Handle<T>;
    /** fires once when an edit begins (drag start / first change of an interaction). */
    onEditStart(fn: (value: T) => void): Handle<T>;
    name(label: string): Handle<T>;
    hint(text: string): Handle<T>;
    listen(enable?: boolean): Handle<T>;
    show(visible: boolean | (() => boolean)): Handle<T>;
    disable(disabled?: boolean | (() => boolean)): Handle<T>;
    /** flip the active editor of a switchable control (no-op otherwise). */
    view(which: string | number): Handle<T>;
    /** clear buffered history on a watch widget (graph/lines/…); no-op otherwise. */
    reset(): Handle<T>;
    refresh(): Handle<T>;
    destroy(): void;
};

/**
 * a control is a widget for a `Prop<T>`. it's a plain factory: given a context
 * and a prop, it builds its dom and returns a live handle. built-in and custom
 * controls are the same shape, so they mount identically.
 */
export type Control<T> = (ctx: Context, prop: Prop<T>) => Handle<T>;

/** the kit a control author composes: row, label, handle, wiring. */
export type Base<T> = {
    row: HTMLElement;
    labelEl: HTMLElement;
    controlEl: HTMLElement;
    handle: Handle<T>;
    /** register how the control reflects the prop value into the dom. */
    render(fn: () => void): void;
    /** register cleanup run on destroy. */
    onDispose(fn: () => void): void;
    /** fire change (and finish) handlers, for controls that emit without `set`. */
    fire(value: T, finished: boolean): void;
    /** let a control (e.g. switch) implement `view()`. */
    setView(fn: (which: string | number) => void): void;
    /** let a watch widget implement `reset()` (e.g. clear its sampler). */
    setReset(fn: () => void): void;
};

/**
 * build the shared control scaffolding. `label` defaults to the prop's name
 * (the obj+key adapter fills that in), so `prop(obj, 'speed')` labels itself.
 */
export function base<T>(ctx: Context, prop: Prop<T>, label: string = prop.name ?? ''): Base<T> {
    const changeHandlers: Array<(value: T) => void> = [];
    const finishHandlers: Array<(value: T) => void> = [];
    const editStartHandlers: Array<(value: T) => void> = [];
    const disposers: Array<() => void> = [];
    let editing = false;
    let render = () => {};
    let viewFn: ((which: string | number) => void) | undefined;
    let resetFn: (() => void) | undefined;
    let stopListen: (() => void) | undefined;
    let stopShow: (() => void) | undefined;
    let stopDisable: (() => void) | undefined;

    const labelEl = el('div', 'dc-label', { textContent: label, title: label });
    const controlEl = el('div', 'dc-control');
    const row = el('div', 'dc-row', undefined, [labelEl, controlEl]);

    const fire = (value: T, finished: boolean) => {
        if (!editing) {
            editing = true;
            for (const fn of editStartHandlers) fn(value);
        }
        for (const fn of changeHandlers) fn(value);
        if (finished) {
            editing = false;
            for (const fn of finishHandlers) fn(value);
        }
    };

    const handle: Handle<T> = {
        row,
        get: () => prop.get(),
        set(value, finished = true) {
            prop.set?.(value);
            render();
            fire(value, finished);
            return handle;
        },
        onChange(fn) {
            changeHandlers.push(fn);
            return handle;
        },
        onFinishChange(fn) {
            finishHandlers.push(fn);
            return handle;
        },
        onEditStart(fn) {
            editStartHandlers.push(fn);
            return handle;
        },
        name(text) {
            labelEl.textContent = text;
            labelEl.title = text;
            return handle;
        },
        hint(text) {
            row.title = text;
            return handle;
        },
        listen(enable = true) {
            stopListen?.();
            stopListen = undefined;
            if (!enable) return handle;
            if (prop.subscribe) {
                stopListen = prop.subscribe(render);
            } else {
                let last = snapshot(prop.get());
                stopListen = ctx.ticker.add(() => {
                    const current = prop.get();
                    if (!same(current, last)) {
                        last = snapshot(current);
                        render();
                    }
                });
            }
            return handle;
        },
        show(visible) {
            stopShow?.();
            stopShow = undefined;
            if (typeof visible === 'function') {
                const update = () => row.classList.toggle('dc-row--hidden', !visible());
                update();
                stopShow = ctx.ticker.add(update);
            } else {
                row.classList.toggle('dc-row--hidden', !visible);
            }
            return handle;
        },
        disable(disabled = true) {
            stopDisable?.();
            stopDisable = undefined;
            if (typeof disabled === 'function') {
                const update = () => row.classList.toggle('dc-row--disabled', disabled());
                update();
                stopDisable = ctx.ticker.add(update);
            } else {
                row.classList.toggle('dc-row--disabled', disabled);
            }
            return handle;
        },
        view(which) {
            viewFn?.(which);
            return handle;
        },
        reset() {
            resetFn?.();
            render();
            return handle;
        },
        refresh() {
            render();
            return handle;
        },
        destroy() {
            stopListen?.();
            stopShow?.();
            stopDisable?.();
            for (const dispose of disposers) dispose();
            row.remove();
        },
    };

    return {
        row,
        labelEl,
        controlEl,
        handle,
        render(fn) {
            render = fn;
        },
        onDispose(fn) {
            disposers.push(fn);
        },
        fire,
        setView(fn) {
            viewFn = fn;
        },
        setReset(fn) {
            resetFn = fn;
        },
    };
}

/* structural helpers so `listen()` diffs primitives and tuple values alike. */

function snapshot<T>(value: T): T {
    return Array.isArray(value) ? ([...value] as unknown as T) : value;
}

function same(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }
    return a === b;
}
