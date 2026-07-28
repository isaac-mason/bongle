// editor/ui/components/SyncPanel.tsx — the status modal for a live folder sync,
// opened by clicking the (spinning) taskbar sync icon. Shows what's bound, a live
// activity log (reconcile progress + each file crossing), a poll heartbeat, and
// offers Close (keep syncing) or Stop syncing (disconnect).

import { useEffect, useRef } from 'react';
import { RefreshCw } from '../../../icons';
import { type SyncLogKind, useSync } from '../../stores/sync';
import { disconnect } from '../../sync/folder-sync';

// clock stamp for a log line / heartbeat (24h, seconds — no locale AM/PM noise).
const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour12: false });

// only 'warn' gets colour — it's the "something was skipped" signal you want to
// spot at a glance; everything else stays in the minimalist fg/muted palette.
const kindClass = (kind: SyncLogKind): string =>
    kind === 'warn' ? 'text-[#b45309]' : kind === 'info' ? 'text-fg-muted' : 'text-fg';

export function SyncPanel() {
    const panelOpen = useSync((s) => s.panelOpen);
    const phase = useSync((s) => s.phase);
    const folder = useSync((s) => s.folder);
    const error = useSync((s) => s.error);
    const activity = useSync((s) => s.activity);
    const logs = useSync((s) => s.logs);
    const lastPoll = useSync((s) => s.lastPoll);

    const logRef = useRef<HTMLDivElement>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every append.
    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [logs]);

    // only meaningful while a session exists; a disconnect closes it via reset().
    if (!panelOpen || phase === 'idle' || phase === 'choosing') return null;

    const close = () => useSync.getState().closePanel();
    const stop = () => void disconnect();

    const status =
        phase === 'connecting'
            ? 'Reconciling the initial contents...'
            : phase === 'error'
              ? (error ?? 'Sync error.')
              : 'Live. Editor edits write to disk; disk edits load back in.';

    return (
        <div className="fixed inset-0 z-[2000000] grid place-items-center bg-black/40" onPointerDown={close}>
            <div
                className="w-[460px] border border-border bg-surface p-4 font-mono text-fg shadow-[4px_4px_0_rgba(0,0,0,0.5)]"
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
                <div className={`mb-2 text-[11px] ${phase === 'error' ? 'text-fg' : 'text-fg-muted'}`}>{status}</div>

                <div className="mb-1 flex items-center justify-between text-[10px] text-fg-muted">
                    <span>activity log</span>
                    {phase === 'connected' && (
                        <span className="tabular-nums">
                            {activity} file{activity === 1 ? '' : 's'} synced
                            {lastPoll ? ` · last check ${clock(lastPoll)}` : ''}
                        </span>
                    )}
                </div>
                <div
                    ref={logRef}
                    className="mb-3 h-44 overflow-auto border border-border bg-surface-muted p-2 text-[10px] leading-relaxed"
                >
                    {logs.length === 0 ? (
                        <span className="text-fg-muted">waiting for activity...</span>
                    ) : (
                        logs.map((l) => (
                            <div key={l.seq} className="flex gap-2 whitespace-pre-wrap break-all">
                                <span className="shrink-0 text-fg-muted tabular-nums">{clock(l.t)}</span>
                                <span className={kindClass(l.kind)}>{l.message}</span>
                            </div>
                        ))
                    )}
                </div>

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
