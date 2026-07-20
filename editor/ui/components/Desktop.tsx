// editor/ui/components/Desktop.tsx — the desktop: registers the fixed windows,
// renders them + any launched app windows + the taskbar. Windows are absolutely
// positioned over the full desktop; the taskbar overlays the left edge.

import { BookOpen, Code, FolderSync, Hammer, Logs, MonitorPlay, RefreshCw } from "../../../icons";
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useSession } from '../../backend';
import type { Filesystem } from '../../fs';
import { usePlatform } from '../../stores/platform';
import { useBoot } from '../../stores/boot';
import { useClients } from '../../stores/clients';
import { MAIN_PANE, useEditor } from '../../stores/editor';
import { useLaunched } from '../../stores/launched';
import { useSync } from '../../stores/sync';
import { useSystemWindows } from '../../stores/system-windows';
import { useTabDrag } from '../../stores/tab-drag';
import { snapRect, useSnapPreview, useWindows } from '../../stores/windows';
import { disconnect, syncSupported } from '../../sync/folder-sync';
import { appById, blockbenchApp, openPath } from '../apps';
import { ClientView } from './ClientView';
import { CodePane } from './CodePane';
import { BuildModal } from './BuildModal';
import { CommandPalette } from './CommandPalette';
import { PlatformWindow } from './PlatformWindow';
import { QuickOpen } from './QuickOpen';
import { SyncChooser } from './SyncChooser';
import { SyncPanel } from './SyncPanel';
import { Presence } from './Presence';
import { AdvancedMenu } from './AdvancedMenu';
import { MultiplayerMenu } from './MultiplayerMenu';
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

    // Cmd/Ctrl+P → file quick-open, Cmd/Ctrl+Shift+P → command palette. Capture
    // phase so they beat Monaco's own key handling, and preventDefault to swallow
    // the browser print dialog.
    const [quickOpen, setQuickOpen] = useState(false);
    const [palette, setPalette] = useState(false);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey || (e.key !== 'p' && e.key !== 'P')) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) setPalette(true);
            else setQuickOpen(true);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
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
    const geom = useWindows((s) => s.geom);

    // the taskbar stays hidden behind the BootScreen overlay until the dev env
    // finishes booting (the overlay fades out and reveals it).
    const bootReady = useBoot((s) => s.ready);

    // folder-sync: a bottom-pinned taskbar icon (Chromium only). Click when idle
    // opens the direction chooser; when live or errored it disconnects.
    const syncPhase = useSync((s) => s.phase);
    const syncFolder = useSync((s) => s.folder);
    // spin only during the initial reconcile; once live, a static icon with a
    // small green corner dot (no constant motion) marks the connected state.
    const syncGlyph =
        syncPhase === 'connecting' ? (
            <RefreshCw size={18} className="animate-spin" />
        ) : syncPhase === 'connected' ? (
            <span className="relative inline-flex">
                <RefreshCw size={18} />
                <span
                    className="absolute -top-1 -right-1 h-2 w-2 rounded-full border border-surface"
                    style={{ background: '#22c55e' }}
                />
            </span>
        ) : (
            <FolderSync size={18} />
        );
    const syncFooter: TaskbarItem[] = syncSupported()
        ? [
              {
                  id: 'sync',
                  title:
                      syncPhase === 'connected'
                          ? `syncing ${syncFolder}`
                          : syncPhase === 'connecting'
                            ? 'reconciling…'
                            : syncPhase === 'error'
                              ? 'sync error'
                              : 'sync folder to disk',
                  glyph: syncGlyph,
                  // the glyph itself carries the state (spinner / green dot), so
                  // skip the taskbar's left running-bar + active highlight.
                  running: false,
                  isActive: false,
                  // idle → pick a folder; a live/errored session → open the status
                  // modal (which carries Close / Stop syncing).
                  onClick: () => {
                      if (useSync.getState().phase === 'idle') useSync.getState().beginChoose();
                      else useSync.getState().openPanel();
                  },
                  menu:
                      syncPhase === 'connected'
                          ? [
                                { label: 'Sync status', onClick: () => useSync.getState().openPanel() },
                                { label: 'Stop syncing', onClick: () => void disconnect() },
                            ]
                          : undefined,
              },
          ]
        : [];

    // when embedded under a platform, the "editing X" window (PlatformWindow) owns
    // the save/build+publish actions. The LOCAL, computer-file tools (download /
    // load / build a .zip you keep) live in the AdvancedMenu fold-out in every mode,
    // kept separate so a local download is never confused with uploading to bongle.
    const embedded = usePlatform((s) => s.embedded);
    // multiplayer co-editing applies to a shared game/project scene — offered when
    // embedded on a project (not avatar, which is Blockbench-only). It rides the
    // platform bridge, so it's embedded-only, same as where it lived before.
    const intent = usePlatform((s) => s.intent);
    // the host-side "open to multiplayer" control — host only (a guest is already
    // in someone's session; a guest-side "connected/leave" view is a later polish).
    const host = useSession((s) => s.host);
    const showMultiplayer = host && embedded && !!intent && intent.kind !== 'avatar';

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
    // "visible" = open and not minimized; clicking 'logs' toggles all of them.
    const logsVisible = LOG_WINDOWS.some((id) => !closed[id] && geom[id]?.mode !== 'minimized');
    const openLogs = () => {
        for (const id of LOG_WINDOWS) openSystem(id);
    };
    const closeLogs = () => {
        for (const id of LOG_WINDOWS) closeSystem(id);
    };
    const minimizeLogs = () => {
        for (const id of LOG_WINDOWS) if (!closed[id]) useWindows.getState().setMode(id, 'minimized');
    };
    // blockbench is pinned (always in the taskbar); running = its window is open.
    const bbRunning = launched.some((w) => w.appId === 'blockbench');
    const openBlockbench = () => useLaunched.getState().launch(blockbenchApp, '');

    const items: TaskbarItem[] = [
        // the platform "editing X" window pins first when embedded — clicking
        // restores it if minimized (it can't be closed).
        ...(embedded
            ? [{ id: 'platform', title: 'platform', glyph: <Hammer size={16} />, onClick: () => useWindows.getState().focus('platform') }]
            : []),
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
                      // guests get ONE play window — the relay game/bundler lanes are
                      // singular, so a second would collide. Reopening when none are
                      // open (the launcher below) is fine.
                      ...(host ? [{ label: 'New client window', onClick: openClient }] : []),
                      ...(host && clients.length > 1
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
        // docs launcher: opens the seeded engine markdown (node_modules/bongle/docs)
        // in the markdown viewer app. Pinned (never a running window itself).
        {
            id: 'docs',
            title: 'docs',
            glyph: <BookOpen size={16} />,
            running: false,
            onClick: () => openPath('node_modules/bongle/docs/docs.md', MAIN_PANE),
            menu: [
                { label: 'Guide', onClick: () => openPath('node_modules/bongle/docs/docs.md', MAIN_PANE) },
                { label: 'API reference', onClick: () => openPath('node_modules/bongle/docs/api.md', MAIN_PANE) },
            ],
        },
        {
            id: 'logs',
            title: 'logs',
            glyph: <Logs size={18} />,
            running: logsOpen,
            isActive: logsOpen && focused != null && LOG_IDS.has(focused),
            onClick: () => (logsVisible ? minimizeLogs() : openLogs()),
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
            {/* faint brand watermark behind the windows — the same Geist Pixel
                wordmark as the boot screen, monochrome (not rainbow). */}
            <div className="desktop-wordmark" aria-hidden>
                bongle
            </div>
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
            <PlatformWindow fs={fs} />
            {bootReady && (
                <Taskbar
                    items={items}
                    footer={syncFooter}
                    footerExtra={<AdvancedMenu fs={fs} />}
                    presence={
                        // multiplayer is its own footer section: the open/stop control
                        // sits right above the guest presence dots, divided off from the
                        // utility tools above.
                        showMultiplayer ? (
                            <div className="flex flex-col items-center gap-1.5 border-t border-border pt-1.5">
                                <MultiplayerMenu />
                                <Presence />
                            </div>
                        ) : null
                    }
                />
            )}
            <SyncChooser fs={fs} />
            <SyncPanel />
            {quickOpen && <QuickOpen fs={fs} onClose={() => setQuickOpen(false)} />}
            {palette && <CommandPalette fs={fs} onClose={() => setPalette(false)} />}
            <BuildModal />
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
