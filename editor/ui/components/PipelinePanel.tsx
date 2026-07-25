// editor/ui/components/PipelinePanel.tsx — the "pipeline" window: the asset-bake
// (textures / audio / models / icons) log stream, plus "re-bake" (re-run the bake
// against the current compiler). Split out from the build window so compiler
// errors and bake output don't interleave.

import { Hammer } from '../../../icons';
import { useBuild } from '../../stores/build';
import { LogView } from './LogView';
import { ActionBar, ActionButton, ClearLogsButton } from './RealmControls';

export function PipelinePanel() {
    const status = useBuild((s) => s.status);
    const wired = useBuild((s) => s.pipeline !== null);
    const rebake = useBuild((s) => s.rebake);

    const restarting = status === 'restarting';

    return (
        <div className="flex h-full flex-col">
            <ActionBar>
                <ActionButton
                    icon={<Hammer size={13} className={restarting ? 'animate-pulse' : undefined} />}
                    label="re-bake"
                    busy={restarting}
                    disabled={!wired || restarting}
                    title="Re-run the asset bake (textures, audio, models, icons)"
                    onClick={() => void rebake()}
                />
                <ClearLogsButton stream="pipeline" />
            </ActionBar>
            <div className="min-h-0 flex-1">
                <LogView stream="pipeline" />
            </div>
        </div>
    );
}
