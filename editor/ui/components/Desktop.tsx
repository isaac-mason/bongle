// editor/ui/components/Desktop.tsx — the desktop: registers the fixed windows,
// renders them + any launched app windows + the taskbar. Windows are absolutely
// positioned over the full desktop; the taskbar overlays the left edge.

import { type ReactNode, useEffect } from 'react';
import type { Filesystem } from '../../fs';
import { useLaunched } from '../../stores/launched';
import { useWindows } from '../../stores/windows';
import { appById } from '../apps';
import { Taskbar, type TaskbarItem } from './Taskbar';
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

    const launched = useLaunched((s) => s.windows);
    const closeLaunched = useLaunched((s) => s.close);

    const items: TaskbarItem[] = [
        ...windows.map((w) => ({ id: w.id, title: w.title, glyph: w.glyph })),
        ...launched.map((w) => ({ id: w.id, title: w.title, glyph: appById(w.appId)?.glyph ?? null })),
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
                    <Window key={w.id} id={w.id} title={w.title} onClose={() => closeLaunched(w.id)}>
                        {app.render(fs, w.path)}
                    </Window>
                );
            })}
            <Taskbar items={items} />
        </div>
    );
}
