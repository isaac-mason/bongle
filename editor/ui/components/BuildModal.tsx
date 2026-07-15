// editor/ui/components/BuildModal.tsx — live progress for a prod build. Shows the
// phase checklist while rolldown bundles, then the result (size + download) or the
// error. Driven by stores/build-progress (runBuild in Desktop feeds it).

import { AlertCircle, Check, Hammer, Loader2, X } from 'lucide-react';
import { useBuildProgress } from '../../stores/build-progress';

export function BuildModal() {
    const open = useBuildProgress((s) => s.open);
    const status = useBuildProgress((s) => s.status);
    const steps = useBuildProgress((s) => s.steps);
    const error = useBuildProgress((s) => s.error);
    const sizeBytes = useBuildProgress((s) => s.sizeBytes);
    if (!open) return null;

    const done = status !== 'running';
    const close = () => useBuildProgress.getState().close();
    const title = status === 'done' ? 'Build complete' : status === 'error' ? 'Build failed' : 'Building bundle';

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismiss backdrop.
        <div className="fixed inset-0 z-[2000000] grid place-items-center bg-black/40" onPointerDown={close}>
            <div
                className="w-[380px] border border-border bg-surface p-4 font-mono text-fg shadow-[4px_4px_0_rgba(0,0,0,0.5)]"
                onPointerDown={(e) => e.stopPropagation()}
            >
                <div className="mb-3 flex items-center gap-2 text-sm">
                    <Hammer size={16} />
                    <span>{title}</span>
                </div>

                <div className="flex flex-col gap-1.5">
                    {steps.map((s) => (
                        <div key={s.label} className="flex items-center gap-2 text-xs">
                            {s.state === 'active' && <Loader2 size={13} className="shrink-0 animate-spin" />}
                            {s.state === 'done' && <Check size={13} className="shrink-0 text-fg-muted" />}
                            {s.state === 'error' && <X size={13} className="shrink-0" />}
                            <span className={s.state === 'done' ? 'text-fg-muted' : ''}>{s.label}</span>
                        </div>
                    ))}
                </div>

                {status === 'done' && sizeBytes != null && (
                    <div className="mt-3 text-xs text-fg-muted">bundle.zip — {(sizeBytes / 1024).toFixed(0)} KB, downloaded</div>
                )}
                {status === 'error' && (
                    <div className="mt-3 flex items-start gap-2 text-xs">
                        <AlertCircle size={13} className="mt-0.5 shrink-0" />
                        <span className="break-words">{error}</span>
                    </div>
                )}

                {/* always dismissable — a stuck/failed build must never trap the
                    user (they may need to get out and save). Cancel just closes
                    the modal; the background build is abandoned. */}
                <div className="mt-3 flex justify-end">
                    <button
                        type="button"
                        className="cursor-pointer border border-border bg-surface px-3 py-1 text-xs hover:bg-hover"
                        onClick={close}
                    >
                        {done ? 'Close' : 'Cancel'}
                    </button>
                </div>
            </div>
        </div>
    );
}
