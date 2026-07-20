// editor/ui/components/SyncChooser.tsx — the one-time direction pick shown when
// binding a folder. Each button is a user gesture, so it can open the folder
// picker directly (which the File System Access API requires).

import { FolderInput, FolderOutput } from "../../../icons";
import type { Filesystem } from '../../fs';
import { useSync } from '../../stores/sync';
import { connect, type SyncDirection } from '../../sync/folder-sync';

export function SyncChooser({ fs }: { fs: Filesystem }) {
    const phase = useSync((s) => s.phase);
    if (phase !== 'choosing') return null;

    const cancel = () => useSync.getState().cancel();
    const choose = (dir: SyncDirection) => void connect(fs, dir);

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismiss backdrop.
        <div className="fixed inset-0 z-[2000000] grid place-items-center bg-black/40" onPointerDown={cancel}>
            <div
                className="w-[440px] border border-border bg-surface p-4 font-mono text-fg shadow-[4px_4px_0_rgba(0,0,0,0.5)]"
                onPointerDown={(e) => e.stopPropagation()}
            >
                <div className="mb-1 text-sm">Sync folder</div>
                <div className="mb-3 text-xs text-fg-muted">
                    Bind the editor to a folder on disk and keep them mirrored. Pick which side seeds the other, then it
                    syncs both ways.
                </div>
                <div className="flex flex-col gap-2">
                    <button
                        type="button"
                        className="flex cursor-pointer items-start gap-2.5 border border-border bg-surface p-2.5 text-left hover:bg-hover"
                        onClick={() => choose('publish')}
                    >
                        <FolderOutput size={18} className="mt-0.5 shrink-0" />
                        <span>
                            <span className="block text-xs">Editor to folder</span>
                            <span className="block text-[11px] text-fg-muted">
                                Write the project out to the folder. Leaves node_modules and other unmanaged files
                                intact.
                            </span>
                        </span>
                    </button>
                    <button
                        type="button"
                        className="flex cursor-pointer items-start gap-2.5 border border-border bg-surface p-2.5 text-left hover:bg-hover"
                        onClick={() => choose('import')}
                    >
                        <FolderInput size={18} className="mt-0.5 shrink-0" />
                        <span>
                            <span className="block text-xs">Folder to editor</span>
                            <span className="block text-[11px] text-fg-muted">
                                Load the folder's contents into the editor, then re-apply the engine on top.
                            </span>
                        </span>
                    </button>
                </div>
                <div className="mt-3 flex justify-end">
                    <button type="button" className="cursor-pointer border border-border bg-surface px-3 py-1 text-xs hover:bg-hover" onClick={cancel}>
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}
