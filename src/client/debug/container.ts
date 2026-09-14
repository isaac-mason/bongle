import type { Context, Control, Handle } from './control';
import { boolean } from './controls/boolean';
import { button as buttonControl, buttonGroup as buttonGroupControl } from './controls/button';
import { color } from './controls/color';
import { element as elementControl, html as htmlControl } from './controls/html';
import { interval } from './controls/interval';
import { number, slider } from './controls/number';
import { euler, quaternion } from './controls/rotation';
import { select } from './controls/select';
import { switchControl } from './controls/switch';
import { text } from './controls/text';
import { spherical, vec2, vec3, vec4 } from './controls/vec';
import { el, on } from './dom';
import { type BarsOptions, bars as barsControl } from './monitors/bars';
import { type FlameFrame, type FlameOptions, flame as flameControl } from './monitors/flame';
import { type GaugeOptions, gauge as gaugeControl } from './monitors/gauge';
import { type GraphOptions, graph as graphControl } from './monitors/graph';
import { type HistogramOptions, histogram as histogramControl } from './monitors/histogram';
import { type LinesOptions, lines as linesControl } from './monitors/lines';
import { type LogEntry, type LogOptions, log as logControl } from './monitors/log';
import { type MonitorOptions, monitor as monitorControl } from './monitors/monitor';
import { type SeriesOptions, series as seriesControl } from './monitors/series';
import { type StatOptions, stat as statControl } from './monitors/stat';
import { type StatesOptions, type StateValue, states as statesControl } from './monitors/states';
import type { Prop } from './prop';

/** the built-in control names valid for a value of type T. */
export type ControlName<T> =
    | 'select'
    | (T extends number
          ? 'number' | 'slider'
          : T extends boolean
            ? 'toggle'
            : T extends string
              ? 'text' | 'color'
              : T extends readonly number[]
                ? 'vec2' | 'vec3' | 'vec4' | 'spherical' | 'euler' | 'quaternion' | 'color' | 'interval'
                : never);

/** a read/write accessor, the not-owned lens form for derived/nested state. */
export type Accessor<T> = { get(): T; set?(value: T): void; name?: string };

/** options for `add`. the widget is auto-detected from the value; `control` overrides it. */
export type AddOptions<T> = {
    label?: string;
    hint?: string;
    listen?: boolean;
    show?: boolean | (() => boolean);
    disable?: boolean | (() => boolean);
    onChange?: (value: T) => void;
    onFinishChange?: (value: T) => void;
    /** fires once when an edit begins; `onEditEnd` is an alias of `onFinishChange`. */
    onEditStart?: (value: T) => void;
    onEditEnd?: (value: T) => void;
    /** show a checkbox that toggles the value on/off (sets it to `null` when off). needs a non-null initial value. */
    optional?: boolean;
    /** explicit ordering within the panel/folder (lower first; default insertion order). */
    order?: number;
    /** columns to span inside a grid container (`tiles`); ignored elsewhere. */
    span?: number;
    /** override the widget: a built-in name, a custom `Control<T>`, or a list → a flip switch. */
    control?: ControlName<T> | Control<T> | Array<ControlName<T> | Control<T>>;
    // widget config. each control reads what it needs
    min?: number;
    max?: number;
    step?: number;
    options?: readonly T[] | Record<string, T>;
    space?: 'linear' | 'srgb';
    format?: (value: T) => string;
};

type Common = {
    label?: string;
    hint?: string;
    show?: boolean | (() => boolean);
    disable?: boolean | (() => boolean);
    order?: number;
    /** columns to span inside a grid container (`tiles`); ignored elsewhere. */
    span?: number;
};

// typed to only the fields `wire` reads; widget option bags (lines/bars/…) carry
// extra, differently-typed fields that aren't AddOptions<T>.
type Wireable<T> = Common & {
    onChange?: (value: T) => void;
    onFinishChange?: (value: T) => void;
    onEditStart?: (value: T) => void;
    onEditEnd?: (value: T) => void;
    listen?: boolean;
};

// the built-in registry is deliberately untyped; `add`'s public signature is strict.
const BUILTINS: Record<string, (opts: any) => Control<any>> = {
    number,
    slider,
    text,
    toggle: boolean,
    select,
    vec2,
    vec3,
    vec4,
    spherical,
    euler,
    quaternion,
    color,
    interval,
};

function resolveControl(value: unknown, options: any): Control<any> {
    const c = options.control;
    if (typeof c === 'function') return c;
    if (Array.isArray(c)) {
        return switchControl(c.map((entry) => (typeof entry === 'function' ? entry : BUILTINS[entry](options))));
    }
    if (typeof c === 'string') return BUILTINS[c](options);

    // auto-detect
    if (options.options) return select(options);
    if (typeof value === 'number')
        return options.min !== undefined && options.max !== undefined ? slider(options) : number(options);
    if (typeof value === 'boolean') return boolean(options);
    if (typeof value === 'string') return text(options);
    if (Array.isArray(value)) return value.length <= 2 ? vec2(options) : value.length === 3 ? vec3(options) : vec4(options);
    return text(options);
}

/** the mount surface shared by panels and folders. */
export type Container = {
    /** the element controls are appended into. */
    readonly el: HTMLElement;

    /** bind `target[key]`; the widget is auto-detected unless `options.control` overrides it. */
    add<O, K extends keyof O>(target: O, key: K, options?: AddOptions<O[K]>): Handle<O[K]>;
    /** bind a get/set accessor (nested / derived / unit-converted state). */
    add<T>(accessor: Accessor<T>, options?: AddOptions<T>): Handle<T>;

    /** a read-only live readout of a getter. */
    monitor<T>(getter: () => T, options?: MonitorOptions<T> & Common): Handle<T>;
    /** a live line graph of a numeric getter. */
    graph(getter: () => number, options?: GraphOptions & Common): Handle<number>;
    /** a tail-following log view over a getter of your own `(string | Log)[]` array. */
    log(source: () => LogEntry[], options?: LogOptions & Common): Handle<LogEntry[]>;
    /** several named numeric series over time (multi-line graph). */
    lines(source: () => Record<string, number>, options?: LinesOptions & Common): Handle<Record<string, number>>;
    /** the same chart driven by a caller-owned history rather than an internal sampler. */
    series(source: () => Record<string, number[]>, options?: SeriesOptions & Common): Handle<Record<string, number[]>>;
    /** a flame graph of one frame's span tree (nested bars, zoom/pan/hover). */
    flame(source: () => FlameFrame | null, options?: FlameOptions & Common): Handle<FlameFrame | null>;
    /** a live bar per category, no history. */
    bars(source: () => Record<string, number>, options?: BarsOptions & Common): Handle<Record<string, number>>;
    /** a headline number with optional sparkline, delta, and threshold color. */
    stat(getter: () => number, options?: StatOptions & Common): Handle<number>;
    /** the distribution of a scalar over a recent window, as bucketed bars. */
    histogram(getter: () => number, options?: HistogramOptions & Common): Handle<number>;
    /** a scalar on a min..max arc with threshold zones. */
    gauge(getter: () => number, options?: GaugeOptions & Common): Handle<number>;
    /** an enum/bool over time, as a colored strip. */
    states(getter: () => StateValue, options?: StatesOptions & Common): Handle<StateValue>;
    /** an action button. */
    button(label: string, action: () => void): Handle<void>;
    /** a row of action buttons. */
    buttonGroup(actions: Record<string, () => void>): Handle<void>;
    /** drop in an html string / dom node as a full-width row. */
    html(markup: string): Handle<void>;
    element(node: Node): Handle<void>;

    /** add a search field at the top that hides controls whose label doesn't match. */
    filter(placeholder?: string): HTMLInputElement;

    folder(title: string, options?: FolderOptions): Folder;
    /** a collapsible container whose children lay out in a responsive grid, a HUD of tiles.
     * best for compact widgets (stat / gauge / small graph); children take `{ span }` to widen. */
    tiles(title: string, options?: TilesOptions): Folder;
    /** a tabbed region: `tab(name)` returns a container, shown one at a time. a layout primitive
     * like `tiles`, composable and nestable. inactive tabs are detached, so their widgets pause. */
    tabs(): TabGroup;
    refresh(): void;
    destroy(): void;
    readonly controls: Handle<unknown>[];
    readonly folders: Folder[];
};

export type FolderOptions = { collapsed?: boolean };

/** a tabbed region. `tab(title)` adds a tab and returns its container; tabs show one at a time. */
export type TabGroup = {
    /** the tabbed region element. */
    readonly root: HTMLElement;
    /** add a tab and return its container. */
    tab(title: string): Container;
    /** switch the active tab by name or index. */
    active(which: string | number): TabGroup;
    /** called when the active tab changes. */
    onChange(fn: (name: string, index: number) => void): TabGroup;
};

export type TilesOptions = FolderOptions & {
    /** fixed column count; omit for responsive auto-fit. */
    columns?: number;
    /** min tile width in px for responsive auto-fit (default 90). ignored when `columns` is set. */
    min?: number;
    /** grid gap in px (default 6). */
    gap?: number;
};

export type Folder = Container & {
    readonly root: HTMLElement;
    title(text: string): Folder;
    open(open?: boolean): Folder;
};

const voidProp: Prop<void> = { get: () => undefined };

export function createContainer(ctx: Context, body: HTMLElement): Container {
    const controls: Handle<unknown>[] = [];
    const folders: Folder[] = [];
    // tab groups (and other nested regions) that need refresh/destroy to cascade
    const nested: Array<{ refresh(): void; destroy(): void }> = [];

    // apply the universal (non-widget) options and mount the row.
    const wire = <T>(handle: Handle<T>, options: Wireable<T>): Handle<T> => {
        if (options.onChange) handle.onChange(options.onChange);
        if (options.onFinishChange) handle.onFinishChange(options.onFinishChange);
        if (options.onEditStart) handle.onEditStart(options.onEditStart);
        if (options.onEditEnd) handle.onFinishChange(options.onEditEnd);
        if (options.show !== undefined) handle.show(options.show);
        if (options.disable !== undefined) handle.disable(options.disable);
        if (options.listen) handle.listen(true);
        if (options.order !== undefined) handle.row.style.order = String(options.order);
        if (options.span !== undefined) handle.row.style.gridColumn = `span ${options.span}`;
        body.append(handle.row);
        controls.push(handle as Handle<unknown>);
        return handle;
    };

    // implementation behind the strict overloads.
    const add = (a: any, b?: any, c?: any): Handle<any> => {
        let prop: Prop<unknown>;
        let value: unknown;
        let options: AddOptions<unknown>;
        if (typeof b === 'string') {
            const target = a as Record<string, unknown>;
            const key = b as string;
            options = (c ?? {}) as AddOptions<unknown>;
            value = target[key];
            prop = { get: () => target[key], set: (v) => (target[key] = v), name: options.label ?? key };
        } else {
            const accessor = a as Accessor<unknown>;
            options = (b ?? {}) as AddOptions<unknown>;
            value = accessor.get();
            prop = { get: accessor.get, set: accessor.set, name: options.label ?? accessor.name };
        }

        // `optional`: bind the control to a shadow value (never null, so the widget
        // keeps rendering the last value) and toggle the real prop between it and null.
        let bindProp = prop;
        let mountOptional: ((row: HTMLElement) => void) | undefined;
        if (options.optional) {
            const shadow = { v: prop.get() };
            let enabled = prop.get() != null;
            bindProp = {
                get: () => shadow.v,
                set: (v) => {
                    shadow.v = v;
                    if (enabled) prop.set?.(v);
                },
                name: prop.name,
            };
            value = shadow.v;
            mountOptional = (row) => {
                const box = el('button', 'dc-check dc-optional', { type: 'button' });
                const controlEl = row.querySelector('.dc-control');
                const sync = () => {
                    box.classList.toggle('dc-check--on', enabled);
                    box.textContent = enabled ? '✓' : '';
                    controlEl?.classList.toggle('dc-control--disabled', !enabled);
                };
                on(box, 'click', () => {
                    enabled = !enabled;
                    prop.set?.(enabled ? shadow.v : (null as unknown));
                    sync();
                });
                row.prepend(box);
                sync();
            };
        }

        const control = resolveControl(value, options);
        const handle = control(ctx, bindProp);
        mountOptional?.(handle.row);
        return wire(handle, options);
    };

    return {
        el: body,
        add: add as Container['add'],
        monitor<T>(getter: () => T, options: MonitorOptions<T> & Common = {}) {
            const prop: Prop<T> = { get: getter, name: options.label };
            return wire(monitorControl<T>(options)(ctx, prop), options);
        },
        graph(getter: () => number, options: GraphOptions & Common = {}) {
            const prop: Prop<number> = { get: getter, name: options.label };
            return wire(graphControl(options)(ctx, prop), options);
        },
        log(source: () => LogEntry[], options: LogOptions & Common = {}) {
            const prop: Prop<LogEntry[]> = { get: source, name: options.label };
            return wire(logControl(options)(ctx, prop), options);
        },
        lines(source: () => Record<string, number>, options: LinesOptions & Common = {}) {
            const prop: Prop<Record<string, number>> = { get: source, name: options.label };
            return wire(linesControl(options)(ctx, prop), options);
        },
        series(source: () => Record<string, number[]>, options: SeriesOptions & Common = {}) {
            const prop: Prop<Record<string, number[]>> = { get: source, name: options.label };
            return wire(seriesControl(options)(ctx, prop), options);
        },
        flame(source: () => FlameFrame | null, options: FlameOptions & Common = {}) {
            const prop: Prop<FlameFrame | null> = { get: source, name: options.label };
            return wire(flameControl(options)(ctx, prop), options);
        },
        bars(source: () => Record<string, number>, options: BarsOptions & Common = {}) {
            const prop: Prop<Record<string, number>> = { get: source, name: options.label };
            return wire(barsControl(options)(ctx, prop), options);
        },
        stat(getter: () => number, options: StatOptions & Common = {}) {
            const prop: Prop<number> = { get: getter, name: options.label };
            return wire(statControl(options)(ctx, prop), options);
        },
        histogram(getter: () => number, options: HistogramOptions & Common = {}) {
            const prop: Prop<number> = { get: getter, name: options.label };
            return wire(histogramControl(options)(ctx, prop), options);
        },
        gauge(getter: () => number, options: GaugeOptions & Common = {}) {
            const prop: Prop<number> = { get: getter, name: options.label };
            return wire(gaugeControl(options)(ctx, prop), options);
        },
        states(getter: () => StateValue, options: StatesOptions & Common = {}) {
            const prop: Prop<StateValue> = { get: getter, name: options.label };
            return wire(statesControl(options)(ctx, prop), options);
        },
        button(label, action) {
            return wire(buttonControl(label, action)(ctx, voidProp), {});
        },
        buttonGroup(actions) {
            return wire(buttonGroupControl(actions)(ctx, voidProp), {});
        },
        html(markup) {
            return wire(htmlControl(markup)(ctx, voidProp), {});
        },
        element(node) {
            return wire(elementControl(node)(ctx, voidProp), {});
        },
        filter(placeholder = 'filter…') {
            const input = el('input', 'dc-input dc-filter', { type: 'text', placeholder });
            body.prepend(el('div', 'dc-filter-row', undefined, [input]));
            const collect = (c: { controls: Handle<unknown>[]; folders: Folder[] }, out: Handle<unknown>[]) => {
                out.push(...c.controls);
                for (const f of c.folders) collect(f, out);
                return out;
            };
            on(input, 'input', () => {
                const q = input.value.trim().toLowerCase();
                for (const c of collect({ controls, folders }, [])) {
                    const label = (c.row.querySelector('.dc-label')?.textContent ?? '').toLowerCase();
                    c.row.classList.toggle('dc-row--filtered', q !== '' && !label.includes(q));
                }
            });
            return input;
        },
        folder(title, options = {}) {
            const folder = createFolder(ctx, title, options);
            body.append(folder.root);
            folders.push(folder);
            return folder;
        },
        tiles(title, options = {}) {
            const folder = createFolder(ctx, title, { ...options, grid: options });
            body.append(folder.root);
            folders.push(folder);
            return folder;
        },
        tabs() {
            const tabsWrap = el('div', 'dc-tabs');
            const strip = el('div', 'dc-tabstrip', undefined, [tabsWrap]);
            const holder = el('div', 'dc-tabs-content');
            const region = el('div', 'dc-tabs-region', undefined, [strip, holder]);
            body.append(region);

            const items: { name: string; container: Container; body: HTMLElement; btn: HTMLElement }[] = [];
            const changeHandlers: Array<(name: string, index: number) => void> = [];

            // only the active tab's body is mounted; detaching the rest pauses their widgets
            const show = (i: number) => {
                if (i < 0 || i >= items.length) return;
                holder.replaceChildren(items[i].body);
                items.forEach((it, k) => {
                    it.btn.classList.toggle('dc-tab--active', k === i);
                });
            };

            const group: TabGroup & { refresh(): void; destroy(): void } = {
                root: region,
                tab(title: string) {
                    const tabBody = el('div', 'dc-tab-panel');
                    const container = createContainer(ctx, tabBody);
                    const index = items.length;
                    const btn = el('button', 'dc-tab', { type: 'button' }, [el('span', 'dc-tab-title', { textContent: title })]);
                    on(btn, 'click', () => {
                        show(index);
                        for (const fn of changeHandlers) fn(title, index);
                    });
                    tabsWrap.append(btn);
                    items.push({ name: title, container, body: tabBody, btn });
                    if (items.length === 1) show(0);
                    return container;
                },
                active(which: string | number) {
                    show(typeof which === 'number' ? which : items.findIndex((it) => it.name === which));
                    return group;
                },
                onChange(fn) {
                    changeHandlers.push(fn);
                    return group;
                },
                refresh() {
                    for (const it of items) it.container.refresh();
                },
                destroy() {
                    for (const it of items) it.container.destroy();
                    region.remove();
                },
            };
            nested.push(group);
            return group;
        },
        controls,
        folders,
        refresh() {
            for (const c of controls) c.refresh();
            for (const f of folders) f.refresh();
            for (const n of nested) n.refresh();
        },
        destroy() {
            for (const c of controls) c.destroy();
            for (const f of folders) f.destroy();
            for (const n of nested) n.destroy();
        },
    };
}

export function createFolder(ctx: Context, title: string, opts: FolderOptions & { grid?: TilesOptions } = {}): Folder {
    const bodyEl = el('div', 'dc-folder-body');
    // a `tiles` folder lays its children out in a responsive grid instead of a stack
    if (opts.grid) {
        const g = opts.grid;
        bodyEl.classList.add('dc-folder-body--grid');
        bodyEl.style.gridTemplateColumns = g.columns
            ? `repeat(${g.columns}, minmax(0, 1fr))`
            : `repeat(auto-fit, minmax(${g.min ?? 90}px, 1fr))`;
        if (g.gap !== undefined) bodyEl.style.gap = `${g.gap}px`;
    }
    const chevron = el('span', 'dc-folder-chevron', { textContent: '▾' });
    const titleSpan = el('span', undefined, { textContent: title });
    const titleEl = el('div', 'dc-folder-title', undefined, [chevron, titleSpan]);
    const root = el('div', 'dc-folder', undefined, [titleEl, bodyEl]);
    if (opts.collapsed) root.classList.add('dc-folder--collapsed');
    on(titleEl, 'click', () => root.classList.toggle('dc-folder--collapsed'));

    const container = createContainer(ctx, bodyEl);
    const inner = container.destroy;
    const folder: Folder = Object.assign(container, {
        root,
        title(text: string) {
            titleSpan.textContent = text;
            return folder;
        },
        open(open = true) {
            root.classList.toggle('dc-folder--collapsed', !open);
            return folder;
        },
        destroy() {
            inner();
            root.remove();
        },
    });
    return folder;
}
