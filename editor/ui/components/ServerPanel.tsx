// editor/ui/components/ServerPanel.tsx — the "server" window: its log stream plus
// server actions. The realm stack (server + client preview) is started lazily —
// project mode boots it at load, avatar mode on demand — so this shows "start
// server" until it's running, then "restart server" (reboots the worker, flushing
// edits to disk first, and reconnects any open client windows). A failed first
// boot also offers "restart server" — the manager exists, so recovery is in place.

import { Play, RefreshCw } from '../../../icons';
import { useMultiplayer } from '../../stores/multiplayer';
import { useServer } from '../../stores/server';
import { LogView } from './LogView';
import { ActionBar, ActionButton, ClearLogsButton } from './RealmControls';

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
    // "start" is the first boot (runs the starter); once the manager exists — running,
    // restarting, or a failed first boot — recovery is an in-place "restart".
    const canRestart = status === 'running' || status === 'restarting' || status === 'failed';

    return (
        <div className="flex h-full flex-col">
            <ActionBar>
                {canRestart ? (
                    <ActionButton
                        icon={<RefreshCw size={13} className={restarting ? 'animate-spin' : undefined} />}
                        label="restart server"
                        busy={restarting}
                        disabled={restarting || hosting}
                        title={
                            hosting
                                ? 'Stop multiplayer before restarting the server'
                                : 'Reboot the server worker (saves edits to disk first)'
                        }
                        onClick={() => void restart()}
                    />
                ) : (
                    <ActionButton
                        icon={<Play size={13} className={starting ? 'animate-pulse' : undefined} />}
                        label="start server"
                        busy={starting}
                        disabled={!startable || starting}
                        title={startable ? 'Boot the game preview (server + client realms)' : 'No local server for this session'}
                        onClick={() => void start()}
                    />
                )}
                {hosting && <span className="text-[11px] text-fg-muted">multiplayer is open</span>}
                <ClearLogsButton stream="server" />
            </ActionBar>
            <div className="min-h-0 flex-1">
                <LogView stream="server" />
            </div>
        </div>
    );
}
