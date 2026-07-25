// editor/ui/components/ClientPanel.tsx — the "client" window: the client-realm log
// stream plus its actions. "reload all" respawns every open client iframe (fresh
// registry + reconnect); individual client windows are killed by closing them.

import { RefreshCw } from '../../../icons';
import { useClients } from '../../stores/clients';
import { LogView } from './LogView';
import { ActionBar, ActionButton, ClearLogsButton } from './RealmControls';

export function ClientPanel() {
    const openCount = useClients((s) => s.windows.length);
    const reloadAll = useClients((s) => s.reloadAll);

    return (
        <div className="flex h-full flex-col">
            <ActionBar>
                <ActionButton
                    icon={<RefreshCw size={13} />}
                    label="reload all"
                    disabled={openCount === 0}
                    title={openCount === 0 ? 'No client windows open' : 'Reload every open client window'}
                    onClick={reloadAll}
                />
                <ClearLogsButton stream="client" />
            </ActionBar>
            <div className="min-h-0 flex-1">
                <LogView stream="client" />
            </div>
        </div>
    );
}
