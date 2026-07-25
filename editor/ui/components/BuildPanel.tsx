// editor/ui/components/BuildPanel.tsx — the "build" window: the bundler (code
// compiler) transform + resolution log, plus its action. "restart all" respawns
// the whole realm stack in place (the only in-editor recovery for a wedged
// compiler, the root of the module graph). The asset bake has its own window
// (PipelinePanel), so its log + "re-bake" live there.

import { RotateCw } from '../../../icons';
import { useBuild } from '../../stores/build';
import { LogView } from './LogView';
import { ActionBar, ActionButton, ClearLogsButton } from './RealmControls';

export function BuildPanel() {
    const status = useBuild((s) => s.status);
    const wired = useBuild((s) => s.pipeline !== null);
    const restartAll = useBuild((s) => s.restartAll);

    const restarting = status === 'restarting';

    return (
        <div className="flex h-full flex-col">
            <ActionBar>
                <ActionButton
                    icon={<RotateCw size={13} className={restarting ? 'animate-spin' : undefined} />}
                    label="restart all"
                    busy={restarting}
                    disabled={!wired || restarting}
                    title="Respawn the whole stack: compiler, then bake, server, and clients"
                    onClick={() => void restartAll()}
                />
                <ClearLogsButton stream="build" />
            </ActionBar>
            <div className="min-h-0 flex-1">
                <LogView stream="build" />
            </div>
        </div>
    );
}
