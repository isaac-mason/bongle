import { useEffect, useState } from 'react';
import { useEditor, type Toast } from '../editor-store';

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

    useEffect(() => {
        const fadeId = window.setTimeout(() => setVisible(false), VISIBLE_MS - FADE_MS);
        const dropId = window.setTimeout(() => dismissToast(toast.id), VISIBLE_MS);
        return () => {
            window.clearTimeout(fadeId);
            window.clearTimeout(dropId);
        };
    }, [toast.id, dismissToast]);

    return (
        <div
            className="bg-white border border-neutral-900 px-2 py-1 text-[11px] font-mono text-neutral-900 transition-opacity"
            style={{ opacity: visible ? 1 : 0, transitionDuration: `${FADE_MS}ms` }}
        >
            {toast.message}
        </div>
    );
}
