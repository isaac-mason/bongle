// editor/ui/components/ServerPanel.tsx — the "server" window: its log stream plus
// server actions. The realm stack (server + client preview) is started lazily —
// project mode boots it at load, avatar mode on demand — so this shows "Start
// server" until it's running, then "Restart server" (reboots the worker, flushing
// edits to disk first, and reconnects any open client windows).

import { Play, RefreshCw } from '../../../icons';
import { useMultiplayer } from '../../stores/multiplayer';
import { useServer } from '../../stores/server';
import { LogView } from './LogView';

export function ServerPanel() {
    const status = useServer((s) => s.status);
    const startable = useServer((s) => s.starter !== null);
    const start = useServer((s) => s.start);
    const restart = useServer((s) => s.restart);
    const mpStatus = useMultiplayer((s) => s.status);

    const starting = status === 'starting';
    const restarting = status === 'restarting';
    // a restart resets server-side state, which would strand connected guests, so
    // it's blocked while a multiplayer session is live.
    const hosting = mpStatus === 'open' || mpStatus === 'opening';

    return (
        <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2 py-1">
                {status === 'idle' || starting ? (
                    <button
                        type="button"
                        disabled={!startable || starting}
                        onClick={() => void start()}
                        title={startable ? 'Boot the game preview (server + client realms)' : 'No local server for this session'}
                        className="flex items-center gap-1 border border-border bg-surface px-2 py-1 text-fg text-xs hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <Play size={13} className={starting ? 'animate-pulse' : undefined} />
                        {starting ? 'starting…' : 'start server'}
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={restarting || hosting}
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
                )}
                {hosting && <span className="text-[11px] text-fg-muted">multiplayer is open</span>}
            </div>
            <div className="min-h-0 flex-1">
                <LogView stream="server" />
            </div>
        </div>
    );
}
