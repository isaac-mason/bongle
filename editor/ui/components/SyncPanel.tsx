// editor/ui/components/SyncPanel.tsx — the status modal for a live folder sync,
// opened by clicking the (spinning) taskbar sync icon. Shows what's bound and
// offers Close (keep syncing) or Stop syncing (disconnect).

import { RefreshCw } from 'lucide-react';
import { useSync } from '../../stores/sync';
import { disconnect } from '../../sync/folder-sync';

export function SyncPanel() {
    const panelOpen = useSync((s) => s.panelOpen);
    const phase = useSync((s) => s.phase);
    const folder = useSync((s) => s.folder);
    const error = useSync((s) => s.error);
    const activity = useSync((s) => s.activity);

    // only meaningful while a session exists; a disconnect closes it via reset().
    if (!panelOpen || phase === 'idle' || phase === 'choosing') return null;

    const close = () => useSync.getState().closePanel();
    const stop = () => void disconnect();

    const status =
        phase === 'connecting'
            ? 'Reconciling the initial contents…'
            : phase === 'error'
              ? (error ?? 'Sync error.')
              : 'Live. Editor edits write to disk; disk edits load back in.';

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismiss backdrop.
        <div className="fixed inset-0 z-[2000000] grid place-items-center bg-black/40" onPointerDown={close}>
            <div
                className="w-[440px] border border-border bg-surface p-4 font-mono text-fg shadow-[4px_4px_0_rgba(0,0,0,0.5)]"
                onPointerDown={(e) => e.stopPropagation()}
            >
                <div className="mb-2 flex items-center gap-2 text-sm">
                    <span className="relative inline-flex">
                        <RefreshCw size={16} className={phase === 'connecting' ? 'animate-spin' : ''} />
                        {phase === 'connected' && (
                            <span
                                className="absolute -top-1 -right-1 h-2 w-2 rounded-full border border-surface"
                                style={{ background: '#22c55e' }}
                            />
                        )}
                    </span>
                    <span>Folder sync</span>
                </div>
                <div className="mb-1 text-xs">
                    <span className="text-fg-muted">folder </span>
                    <span>{folder ?? '—'}</span>
                </div>
                <div className={`mb-3 text-[11px] ${phase === 'error' ? 'text-fg' : 'text-fg-muted'}`}>{status}</div>
                {phase === 'connected' && (
                    <div className="mb-3 text-[11px] text-fg-muted">{activity} file{activity === 1 ? '' : 's'} synced</div>
                )}
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        className="cursor-pointer border border-border bg-surface px-3 py-1 text-xs hover:bg-hover"
                        onClick={close}
                    >
                        Close
                    </button>
                    <button
                        type="button"
                        className="cursor-pointer border border-border bg-surface px-3 py-1 text-xs hover:bg-hover"
                        onClick={stop}
                    >
                        Stop syncing
                    </button>
                </div>
            </div>
        </div>
    );
}
