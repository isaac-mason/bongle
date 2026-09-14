import { type Container, createContainer } from '../container';
import type { Context } from '../control';
import { el, on } from '../dom';
import { injectStyles } from '../theme';
import { createTicker } from '../ticker';

/** a panel is a floating window that is itself a container of controls. */
export type Panel = Container & {
    /** the floating window element. */
    readonly root: HTMLElement;
    title(text: string): Panel;
    /** collapse the body to just the title bar. */
    collapse(collapsed?: boolean): Panel;
    /** detach the panel but keep it alive (reopen from a panel's right-click menu, or `show()`). */
    hide(): Panel;
    /** re-attach a hidden panel and raise it to the front. */
    show(): Panel;
    /** close and dispose the panel permanently. */
    close(): void;
};

export type PanelOptions = {
    title?: string;
    /** window position `[x, y]` in px (relative to the viewport). default cascades from the top-left. */
    position?: [number, number];
    /** start collapsed to just the title bar. */
    collapsed?: boolean;
    /** show a close (hide) button (default true). */
    closable?: boolean;
    /** allow dragging the bottom-right corner to resize the window. */
    resizable?: boolean;
};

export type Dashboard = {
    /** the layer element that hosts every floating panel. */
    readonly root: HTMLElement;
    /** open a floating panel. */
    panel(opts?: PanelOptions): Panel;
    /** the live floating panels (visible + hidden). */
    readonly panels: Panel[];
    /** panels that have been hidden (reopenable). */
    readonly hidden: Panel[];
    /** the shared per-frame ticker (listen / monitors / predicates). */
    readonly context: Context;
    /** drive one frame in `clock: 'manual'` mode: samples every widget once. pass your loop's
     * timestamp (ms) to make `interval` throttling honor your clock. no-op under 'auto'. */
    update(now?: number): void;
    /** hold the shared ticker while the dashboard is out of view: no widget samples
     *  or repaints until it resumes. gates the rAF loop only, so `update()` still
     *  drives a frame by hand. */
    pause(paused?: boolean): void;
    destroy(): void;
};

export type DashboardOptions = {
    /** mount the panel layer into a target instead of the document body. */
    target?: HTMLElement;
    /**
     * how the shared ticker is driven. 'auto' (default) runs its own rAF loop.
     * 'manual' never self-drives — call `dashboard.update()` once per frame to
     * sample every widget in phase with your own loop.
     */
    clock?: 'auto' | 'manual';
};

type MenuItem = { label: string; action: () => void } | { separator: true };

/** create a dashboard: a manager for many floating panels. */
export function dashboard(opts: DashboardOptions = {}): Dashboard {
    injectStyles();
    // a full-cover layer that passes pointer events through except over its panels
    const layer = el('div', 'dashcat dc-layer');
    if (opts.target) layer.classList.add('dc-layer--target');
    (opts.target ?? document.body).append(layer);

    const ctx: Context = { ticker: createTicker({ manual: opts.clock === 'manual' }), doc: document, layer };
    const panels: Panel[] = [];
    const hidden: Panel[] = [];
    const nameOf = new Map<Panel, () => string>();
    let cascade = 0;
    let zTop = 10;

    // the layer's box in viewport space: the window when the layer is fixed
    // full-cover, the target element when mounted into one
    const bounds = () => {
        const r = layer.getBoundingClientRect();
        return r.width && r.height ? r : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    };

    // keep a panel within the layer AND cap its height to the room below its
    // top edge, so the body scrolls inside the viewport wherever the panel
    // sits rather than running off the bottom. runs on mount, show, drag,
    // resize, window resize and whenever the panel's own size changes.
    const MARGIN = 4;
    const MIN_HEIGHT = 80;
    const fitPanel = (root: HTMLElement) => {
        const b = bounds();
        const r = root.getBoundingClientRect();
        if (!r.width) return;
        const left = Math.max(MARGIN, Math.min(b.width - r.width - MARGIN, r.left - b.left));
        // the cap comes from where the panel wants to sit, and the clamp then
        // uses the CAPPED height: a tall panel keeps its top and scrolls,
        // rather than being shoved up to the margin to make room
        const wantedTop = Math.max(MARGIN, r.top - b.top);
        const maxHeight = Math.max(MIN_HEIGHT, b.height - wantedTop - MARGIN);
        const height = Math.min(r.height, maxHeight);
        const top = Math.max(MARGIN, Math.min(b.height - height - MARGIN, wantedTop));
        root.style.left = `${left}px`;
        root.style.top = `${top}px`;
        root.style.maxHeight = `${maxHeight}px`;
    };
    const fitAllPanels = () => {
        for (const p of panels) if (!hidden.includes(p)) fitPanel(p.root);
    };
    const stopResize = on(window, 'resize', fitAllPanels);
    // content growing (a tab with more rows, a chart added) changes the
    // panel's height; re-fit so the cap follows
    const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(fitAllPanels) : null;

    /* ---- context menu (reopen hidden panels) ---- */
    let menuEl: HTMLElement | null = null;
    let menuCleanup: (() => void) | null = null;
    const closeMenu = () => {
        menuCleanup?.();
        menuCleanup = null;
        menuEl?.remove();
        menuEl = null;
    };
    const openMenu = (x: number, y: number, items: MenuItem[]) => {
        closeMenu();
        const menu = el('div', 'dc-menu');
        for (const item of items) {
            if ('separator' in item) {
                menu.append(el('div', 'dc-menu-sep'));
                continue;
            }
            const row = el('div', 'dc-menu-item', { textContent: item.label });
            on(row, 'click', () => {
                closeMenu();
                item.action();
            });
            menu.append(row);
        }
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        layer.append(menu);
        const r = menu.getBoundingClientRect();
        if (r.right > window.innerWidth) menu.style.left = `${x - r.width}px`;
        if (r.bottom > window.innerHeight) menu.style.top = `${y - r.height}px`;
        menuEl = menu;
        const onDown = (e: PointerEvent) => {
            if (!menu.contains(e.target as Node)) closeMenu();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeMenu();
        };
        window.addEventListener('pointerdown', onDown, true);
        window.addEventListener('keydown', onKey);
        menuCleanup = () => {
            window.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('keydown', onKey);
        };
    };

    const startDrag = (handle: HTMLElement, root: HTMLElement) => {
        on(handle, 'pointerdown', (e) => {
            const ev = e as PointerEvent;
            if ((ev.target as HTMLElement).closest('button')) return; // let the chrome buttons work
            ev.preventDefault();
            const rect = root.getBoundingClientRect();
            const offX = ev.clientX - rect.left;
            const offY = ev.clientY - rect.top;
            const move = (m: PointerEvent) => {
                const b = bounds();
                const x = Math.max(0, Math.min(b.width - 40, m.clientX - b.left - offX));
                const y = Math.max(0, Math.min(b.height - 20, m.clientY - b.top - offY));
                root.style.left = `${x}px`;
                root.style.top = `${y}px`;
                // the height cap follows the drag, so pulling the panel down
                // shrinks it onto its scrollbar instead of pushing it offscreen
                root.style.maxHeight = `${Math.max(MIN_HEIGHT, b.height - y - MARGIN)}px`;
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                fitPanel(root);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });
    };

    const startResize = (handle: HTMLElement, root: HTMLElement) => {
        on(handle, 'pointerdown', (e) => {
            const ev = e as PointerEvent;
            ev.preventDefault();
            const rect = root.getBoundingClientRect();
            const startW = rect.width;
            const startH = rect.height;
            const sx = ev.clientX;
            const sy = ev.clientY;
            const move = (m: PointerEvent) => {
                const b = bounds();
                const maxW = b.right - rect.left - MARGIN;
                const maxH = b.bottom - rect.top - MARGIN;
                root.style.width = `${Math.max(160, Math.min(maxW, startW + m.clientX - sx))}px`;
                root.style.height = `${Math.max(MIN_HEIGHT, Math.min(maxH, startH + m.clientY - sy))}px`;
            };
            const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });
    };

    const openPanelMenu = (e: MouseEvent, panel: Panel) => {
        const items: MenuItem[] = [{ label: 'hide', action: () => panel.hide() }];
        if (hidden.length) {
            items.push({ separator: true });
            for (const h of hidden) items.push({ label: `reopen: ${nameOf.get(h)?.() ?? 'panel'}`, action: () => h.show() });
        }
        openMenu(e.clientX, e.clientY, items);
    };

    const createPanel = (options: PanelOptions): Panel => {
        const nameEl = el('span', 'dc-panel-name', { textContent: options.title ?? 'panel' });
        const chevron = el('button', 'dc-panel-collapse', { type: 'button', textContent: '▾', title: 'collapse' });
        const titleChildren: HTMLElement[] = [nameEl, chevron];
        let closeEl: HTMLElement | undefined;
        if (options.closable !== false) {
            closeEl = el('button', 'dc-panel-close', { type: 'button', textContent: '✕', title: 'hide' });
            titleChildren.push(closeEl);
        }
        const titleBar = el('div', 'dc-panel-title', undefined, titleChildren);
        const content = el('div', 'dc-content');
        const root = el('div', 'dc-panel', undefined, [titleBar, content]);
        if (options.resizable) root.append(el('div', 'dc-panel-resize', { title: 'resize' }));

        const step = 26;
        const k = cascade++ % 8;
        root.style.left = `${options.position ? options.position[0] : 16 + k * step}px`;
        root.style.top = `${options.position ? options.position[1] : 16 + k * step}px`;
        root.style.zIndex = String(++zTop);
        if (options.collapsed) root.classList.add('dc-panel--collapsed');

        on(root, 'pointerdown', () => {
            root.style.zIndex = String(++zTop);
        });
        startDrag(titleBar, root);
        if (options.resizable) startResize(root.lastElementChild as HTMLElement, root);
        on(chevron, 'click', () => {
            const collapsed = root.classList.toggle('dc-panel--collapsed');
            chevron.textContent = collapsed ? '▸' : '▾';
        });
        on(titleBar, 'contextmenu', (e) => {
            e.preventDefault();
            openPanelMenu(e, panel);
        });

        const container = createContainer(ctx, content);
        const panel: Panel = Object.assign(container, {
            root,
            title(text: string) {
                nameEl.textContent = text;
                return panel;
            },
            collapse(collapsed = true) {
                root.classList.toggle('dc-panel--collapsed', collapsed);
                chevron.textContent = collapsed ? '▸' : '▾';
                return panel;
            },
            hide() {
                sizeObserver?.unobserve(root);
                root.remove();
                if (!hidden.includes(panel)) hidden.push(panel);
                return panel;
            },
            show() {
                const i = hidden.indexOf(panel);
                if (i >= 0) hidden.splice(i, 1);
                layer.append(root);
                root.style.zIndex = String(++zTop);
                fitPanel(root);
                sizeObserver?.observe(root);
                return panel;
            },
            close() {
                sizeObserver?.unobserve(root);
                container.destroy();
                root.remove();
                nameOf.delete(panel);
                for (const list of [panels, hidden]) {
                    const i = list.indexOf(panel);
                    if (i >= 0) list.splice(i, 1);
                }
            },
        });
        nameOf.set(panel, () => nameEl.textContent ?? 'panel');
        if (closeEl) on(closeEl, 'click', () => panel.hide());
        return panel;
    };

    return {
        root: layer,
        context: ctx,
        panels,
        hidden,
        panel(options: PanelOptions = {}) {
            const p = createPanel(options);
            layer.append(p.root);
            panels.push(p);
            fitPanel(p.root);
            sizeObserver?.observe(p.root);
            return p;
        },
        update(now?: number) {
            ctx.ticker.tick(now);
        },
        pause(paused = true) {
            ctx.ticker.pause(paused);
        },
        destroy() {
            closeMenu();
            stopResize();
            sizeObserver?.disconnect();
            for (const p of [...panels]) p.close();
            ctx.ticker.destroy();
            layer.remove();
        },
    };
}
