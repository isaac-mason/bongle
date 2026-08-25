import { useEffect, useState } from 'react';
import { type Toast, useEditor } from '../editor-store';

const VISIBLE_MS = 2500;
const FADE_MS = 250;

export function ToastStack() {
    const toasts = useEditor((s) => s.toasts);
    return (
        <div className="absolute top-2 left-2 z-20 flex flex-col gap-1 pointer-events-none">
            {toasts.map((t) => (
                <ToastRow key={t.id} toast={t} />
            ))}
        </div>
    );
}

function ToastRow({ toast }: { toast: Toast }) {
    const dismissToast = useEditor((s) => s.dismissToast);
    const [visible, setVisible] = useState(true);

    // keyed on createdAt as well as id: a repeat push refreshes the row in
    // place (same id, new stamp), which restarts the countdown here.
    useEffect(() => {
        setVisible(true);
        const fadeId = window.setTimeout(() => setVisible(false), VISIBLE_MS - FADE_MS);
        const dropId = window.setTimeout(() => dismissToast(toast.id), VISIBLE_MS);
        return () => {
            window.clearTimeout(fadeId);
            window.clearTimeout(dropId);
        };
    }, [toast.id, toast.createdAt, dismissToast]);

    return (
        <div
            className="bg-surface-muted border border-border px-2 py-1 text-[11px] font-mono text-fg transition-opacity"
            style={{ opacity: visible ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
        >
            {toast.message}
            {toast.repeats > 1 && <span className="text-fg-muted"> x{toast.repeats}</span>}
        </div>
    );
}
