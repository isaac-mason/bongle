// editor/ui/components/ServerPanel.tsx — the "server" window: its log stream plus
// server actions. Restart reboots the worker (flushing edits to disk first) and
// reconnects any open client windows to the fresh worker.

import { RefreshCw } from "../../../icons";
import { useMultiplayer } from '../../stores/multiplayer';
import { useServer } from '../../stores/server';
import { LogView } from './LogView';

export function ServerPanel() {
    const status = useServer((s) => s.status);
    const restart = useServer((s) => s.restart);
    const mpStatus = useMultiplayer((s) => s.status);

    const restarting = status === 'restarting';
    // a restart resets server-side state, which would strand connected guests, so
    // it's blocked while a multiplayer session is live.
    const hosting = mpStatus === 'open' || mpStatus === 'opening';
    const disabled = restarting || hosting;

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void restart()}
                    title={
                        hosting
                            ? 'Stop multiplayer before restarting the server'
                            : 'Reboot the server worker (saves edits to disk first)'
                    }
                    className="flex items-center gap-1 border border-border bg-surface px-2 py-1 text-fg text-xs hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <RefreshCw size={13} className={restarting ? 'animate-spin' : undefined} />
                    {restarting ? 'restarting…' : 'restart server'}
                </button>
                {hosting && <span className="text-[11px] text-fg-muted">multiplayer is open</span>}
            </div>
            <div className="min-h-0 flex-1">
                <LogView stream="server" />
            </div>
        </div>
    );
}
