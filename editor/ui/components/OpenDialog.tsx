// editor/ui/components/OpenDialog.tsx — the "Open Model" file picker, overlaid on the
// Blockbench window when the plugin intercepts File > Open Model. Embeds the real
// FileTree in picker mode so you browse the project's OPFS and pick a .bbmodel to open
// as a Blockbench tab, instead of the native OS file dialog (which can't see OPFS). The
// chosen path flows through the same bongle:open pipeline the file tree uses.

import { useMemo, useState } from 'react';
import { FolderTree, X } from '../../../icons';
import type { Filesystem } from '../../fs';
import { FileTree, type FileTreePicker } from './FileTree';

const isBbmodel = (p: string) => /\.bbmodel$/i.test(p);

export function OpenDialog({
    fs,
    onConfirm,
    onCancel,
}: {
    fs: Filesystem;
    onConfirm: (path: string) => void;
    onCancel: () => void;
}) {
    // the currently-highlighted file; only a .bbmodel is a valid choice.
    const [selected, setSelected] = useState<string | null>(null);
    const valid = selected !== null && isBbmodel(selected);
    const submit = () => valid && selected && onConfirm(selected);

    // drive the embedded FileTree: a click tracks the selection; a double-click /
    // Enter on a .bbmodel opens it straight away.
    const picker = useMemo<FileTreePicker>(
        () => ({
            onSelect: (path, kind) => setSelected(kind === 'file' ? path : null),
            onChoose: (path) => {
                if (isBbmodel(path)) onConfirm(path);
            },
        }),
        [onConfirm],
    );

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only dismiss backdrop.
        <div className="absolute inset-0 z-[100] grid place-items-center bg-black/40" onPointerDown={onCancel}>
            <div
                className="flex w-[440px] flex-col border border-border bg-surface font-mono text-fg shadow-[4px_4px_0_rgba(0,0,0,0.5)]"
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') onCancel();
                    else if (e.key === 'Enter' && valid) submit();
                }}
            >
                <div className="flex items-center justify-between border-border border-b px-3 py-2 text-sm">
                    <span className="flex items-center gap-2">
                        <FolderTree size={14} /> Open Model
                    </span>
                    <button type="button" className="text-fg-muted hover:text-fg" onClick={onCancel}>
                        <X size={14} />
                    </button>
                </div>

                <div className="mx-3 mt-3 h-[300px] overflow-hidden border border-border bg-surface">
                    <FileTree fs={fs} pane="" picker={picker} />
                </div>
                <div className="mx-3 mt-1 text-fg-muted text-xs">Pick a .bbmodel to open (double-click opens it).</div>

                <div className="mx-3 mt-2 truncate text-fg-muted text-xs">
                    {valid ? (
                        <>
                            Open <span className="text-fg">{selected}</span>
                        </>
                    ) : (
                        'Select a .bbmodel file…'
                    )}
                </div>

                <div className="mt-3 flex justify-end gap-2 border-border border-t px-3 py-2">
                    <button
                        type="button"
                        className="border border-border px-3 py-1 text-xs hover:bg-surface-muted"
                        onClick={onCancel}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={!valid}
                        className="border border-border bg-accent px-3 py-1 text-on-accent text-xs hover:opacity-90 disabled:opacity-40"
                        onClick={submit}
                    >
                        Open
                    </button>
                </div>
            </div>
        </div>
    );
}
