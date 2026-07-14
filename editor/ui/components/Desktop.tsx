// editor/ui/components/Desktop.tsx — the desktop: registers the fixed windows,
// renders them + any launched app windows + the taskbar. Windows are absolutely
// positioned over the full desktop; the taskbar overlays the left edge.

import { MonitorPlay } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import type { Filesystem } from '../../fs';
import { useClients } from '../../stores/clients';
import { useLaunched } from '../../stores/launched';
import { useWindows } from '../../stores/windows';
import { appById } from '../apps';
import { ClientView } from './ClientView';
import { Taskbar, type TaskbarAction, type TaskbarItem } from './Taskbar';
import { Window } from './Window';

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

    // rescue windows that a viewport shrink would push offscreen — re-clamp each
    // into the new bounds so its title bar stays reachable.
    useEffect(() => {
        const onResize = () => useWindows.getState().rescueAll();
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

    const items: TaskbarItem[] = [
        ...windows.map((w) => ({ id: w.id, title: w.title, glyph: w.glyph })),
        ...launched.map((w) => ({ id: w.id, title: w.title, glyph: appById(w.appId)?.glyph ?? null })),
        ...clients.map((w) => ({ id: w.id, title: w.title, glyph: <MonitorPlay size={16} /> })),
    ];

    const actions: TaskbarAction[] = [
        {
            id: 'new-client',
            title: 'Open a client window',
            glyph: <MonitorPlay size={18} />,
            onClick: openClient,
            menu: [
                { label: 'New client window', onClick: openClient },
                { label: 'Close all clients', onClick: () => clients.forEach((c) => closeClient(c.id)) },
            ],
        },
    ];

    return (
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#e9e9e9' }}>
            {windows.map((w) => (
                <Window key={w.id} id={w.id} title={w.title}>
                    {w.content}
                </Window>
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
                <Window key={w.id} id={w.id} title={w.title} onClose={() => closeClient(w.id)}>
                    <ClientView connection={w.connection} />
                </Window>
            ))}
            <Taskbar items={items} actions={actions} />
        </div>
    );
}
