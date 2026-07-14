// editor/ui/components/Desktop.tsx — the desktop: registers the fixed windows,
// renders them + any launched app windows + the taskbar. Windows are absolutely
// positioned over the full desktop; the taskbar overlays the left edge.

import { Code, Logs, MonitorPlay } from 'lucide-react';
import { type ReactNode, useEffect, useMemo } from 'react';
import type { Filesystem } from '../../fs';
import { useClients } from '../../stores/clients';
import { useEditor } from '../../stores/editor';
import { useLaunched } from '../../stores/launched';
import { useSystemWindows } from '../../stores/system-windows';
import { useTabDrag } from '../../stores/tab-drag';
import { snapRect, useSnapPreview, useWindows } from '../../stores/windows';
import { appById, blockbenchApp } from '../apps';
import { ClientView } from './ClientView';
import { CodePane } from './CodePane';
import { TASKBAR_W, Taskbar, type TaskbarItem } from './Taskbar';
import { Window } from './Window';

/** a torn-off editor pane in its own window; title tracks its active file. */
function EditorPaneWindow({ pid, fs }: { pid: string; fs: Filesystem }) {
    const title = useEditor((s) => {
        const p = s.panes[pid];
        const active = p ? s.groups[p.activeGroup]?.active : null;
        return active ? (active.split('/').pop() ?? 'editor') : 'editor';
    });
    return (
        <Window id={pid} title={title} onClose={() => useEditor.getState().closePane(pid)}>
            <CodePane fs={fs} pane={pid} />
        </Window>
    );
}

export type WindowDef = {
    id: string;
    title: string;
    glyph: ReactNode;
    initial: { x: number; y: number; w: number; h: number };
    content: ReactNode;
};

export function Desktop({ windows, fs }: { windows: WindowDef[]; fs: Filesystem }) {
    const register = useWindows((s) => s.register);
    useEffect(() => {
        for (const w of windows) register(w.id, w.initial);
    }, [windows, register]);

    // re-derive layout on viewport resize: snapped windows re-tile their zone (so
    // split panes stay split), floating windows re-clamp so their title bar stays
    // reachable.
    useEffect(() => {
        const onResize = () => useWindows.getState().relayout();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // clicks inside an iframe don't bubble out, so a Window's pointerdown focus
    // never fires for iframe apps (blockbench, game client). When focus enters an
    // iframe the page blurs and it becomes document.activeElement — bring its
    // window to the front.
    useEffect(() => {
        const onBlur = () => {
            const el = document.activeElement;
            if (el?.tagName !== 'IFRAME') return;
            const id = el.closest('[data-window-id]')?.getAttribute('data-window-id');
            if (id) useWindows.getState().focus(id);
        };
        window.addEventListener('blur', onBlur);
        return () => window.removeEventListener('blur', onBlur);
    }, []);

    const launched = useLaunched((s) => s.windows);
    const dirty = useLaunched((s) => s.dirty);
    const closeLaunched = useLaunched((s) => s.close);

    const clients = useClients((s) => s.windows);
    const closeClient = useClients((s) => s.close);
    const openClient = useClients((s) => s.open);

    const focused = useWindows((s) => s.focused);

    const windowPanes = useEditor((s) => s.windowPanes);
    const panes = useEditor((s) => s.panes);
    const groupsById = useEditor((s) => s.groups);
    const paneTitle = (pid: string): string => {
        const p = panes[pid];
        const active = p ? groupsById[p.activeGroup]?.active : null;
        return active ? (active.split('/').pop() ?? 'editor') : 'editor';
    };

    const LOG_IDS = useMemo(() => new Set(['build', 'server', 'client']), []);
    const closed = useSystemWindows((s) => s.closed);
    const { open: openSystem, close: closeSystem } = useSystemWindows.getState();

    // right-click menu building blocks (show = focus/restore).
    const show = (id: string) => ({ label: 'Show', onClick: () => useWindows.getState().focus(id) });
    // build + server + client logs are one pinned 'logs' taskbar button; clicking
    // it opens (or raises) ALL of them, not just one.
    const LOG_WINDOWS = ['build', 'server', 'client'];
    const logsOpen = LOG_WINDOWS.some((id) => !closed[id]);
    const openLogs = () => {
        for (const id of LOG_WINDOWS) openSystem(id);
    };
    const closeLogs = () => {
        for (const id of LOG_WINDOWS) closeSystem(id);
    };
    // blockbench is pinned (always in the taskbar); running = its window is open.
    const bbRunning = launched.some((w) => w.appId === 'blockbench');
    const openBlockbench = () => useLaunched.getState().launch(blockbenchApp, '');

    const items: TaskbarItem[] = [
        // game clients come first — the default layout boots straight into one.
        // When none are open, keep one pinned (not-running) launcher so you can
        // still spawn a client.
        ...(clients.length
            ? clients.map((w) => ({
                  id: w.id,
                  title: w.title,
                  glyph: <MonitorPlay size={16} />,
                  menu: [
                      show(w.id),
                      { label: 'New client window', onClick: openClient },
                      ...(clients.length > 1
                          ? [
                                {
                                    label: 'Close all clients',
                                    onClick: () => {
                                        for (const c of clients) closeClient(c.id);
                                    },
                                },
                            ]
                          : []),
                      { label: 'Close', onClick: () => closeClient(w.id) },
                  ],
              }))
            : [
                  {
                      id: 'new-client',
                      title: 'client',
                      glyph: <MonitorPlay size={16} />,
                      running: false,
                      onClick: openClient,
                      menu: [{ label: 'New client window', onClick: openClient }],
                  },
              ]),
        // files + code: pinned + genuinely closable (reopen to last geometry).
        ...windows
            .filter((w) => !LOG_IDS.has(w.id))
            .map((w) => ({
                id: w.id,
                title: w.title,
                glyph: w.glyph,
                running: !closed[w.id],
                isActive: !closed[w.id] && focused === w.id,
                onClick: () => openSystem(w.id),
                menu: closed[w.id]
                    ? [{ label: 'Open', onClick: () => openSystem(w.id) }]
                    : [show(w.id), { label: 'Close', onClick: () => closeSystem(w.id) }],
            })),
        {
            id: 'logs',
            title: 'logs',
            glyph: <Logs size={18} />,
            running: logsOpen,
            isActive: logsOpen && focused != null && LOG_IDS.has(focused),
            onClick: openLogs,
            menu: logsOpen
                ? [
                      { label: 'Show all', onClick: openLogs },
                      { label: 'Close', onClick: closeLogs },
                  ]
                : [{ label: 'Open', onClick: openLogs }],
        },
        {
            id: 'blockbench',
            title: 'blockbench',
            glyph: blockbenchApp.glyph,
            running: bbRunning,
            isActive: focused === 'blockbench',
            onClick: () => (bbRunning ? useWindows.getState().focus('blockbench') : openBlockbench()),
            menu: bbRunning
                ? [show('blockbench'), { label: 'Close', onClick: () => closeLaunched('blockbench') }]
                : [{ label: 'Open', onClick: openBlockbench }],
        },
        ...launched
            .filter((w) => w.appId !== 'blockbench')
            .map((w) => ({
                id: w.id,
                title: w.title,
                glyph: appById(w.appId)?.glyph ?? null,
                menu: [show(w.id), { label: 'Close', onClick: () => closeLaunched(w.id) }],
            })),
        ...windowPanes.map((pid) => ({
            id: pid,
            title: paneTitle(pid),
            glyph: <Code size={16} />,
            menu: [show(pid), { label: 'Close', onClick: () => useEditor.getState().closePane(pid) }],
        })),
    ];

    return (
        // dropping a dragged tab on the desktop (not on a group / tab strip) tears it
        // off into its own editor window at the cursor.
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only tear-off drop target.
        <div
            className="absolute inset-0 overflow-hidden bg-desktop"
            onDragOver={(e) => {
                if (useTabDrag.getState().drag) e.preventDefault();
            }}
            onDrop={(e) => {
                const drag = useTabDrag.getState().drag;
                if (!drag) return;
                e.preventDefault();
                const pid = useEditor.getState().tearOff(drag.path, drag.group);
                useWindows.getState().register(pid, {
                    x: Math.max(TASKBAR_W + 8, e.clientX - 80),
                    y: Math.max(0, e.clientY - 13),
                    w: 720,
                    h: 520,
                });
                useTabDrag.getState().setDrag(null);
            }}
        >
            {windows
                .filter((w) => !closed[w.id])
                .map((w) => (
                    <Window key={w.id} id={w.id} title={w.title} onClose={() => closeSystem(w.id)}>
                        {w.content}
                    </Window>
                ))}
            {windowPanes.map((pid) => (
                <EditorPaneWindow key={pid} pid={pid} fs={fs} />
            ))}
            {launched.map((w) => {
                const app = appById(w.appId);
                if (!app) return null;
                return (
                    <Window key={w.id} id={w.id} title={w.title} dirty={dirty[w.id]} onClose={() => closeLaunched(w.id)}>
                        {app.render(fs, w.path, w.id)}
                    </Window>
                );
            })}
            {clients.map((w) => (
                <Window key={w.id} id={w.id} title={w.title} keepMounted onClose={() => closeClient(w.id)}>
                    <ClientView connection={w.connection} />
                </Window>
            ))}
            <SnapOverlay />
            <Taskbar items={items} />
        </div>
    );
}

/** the translucent ghost showing where a dragged window will snap. Absolute over
 *  the desktop, pointer-transparent so it never intercepts the in-flight drag. */
function SnapOverlay() {
    const zone = useSnapPreview((s) => s.zone);
    if (!zone) return null;
    const r = snapRect(zone);
    return (
        <div
            className="pointer-events-none absolute z-[9999] border-2 border-accent transition-all duration-75"
            style={{
                left: r.x,
                top: r.y,
                width: r.w,
                height: r.h,
                background: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
            }}
        />
    );
}
