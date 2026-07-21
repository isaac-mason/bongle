// editor/ui/components/SaveAsDialog.tsx — the "Save As" file picker, overlaid on
// the Blockbench window when the plugin asks the editor for a path (a never-saved
// project's first save, or an explicit File > Save As). It embeds the real
// FileTree in picker mode, so the whole file viewer comes along: browse folders,
// right-click to make a New Folder / rename / delete, drag, upload — then pick a
// destination folder + name and confirm. Replaces the old window.prompt. The
// chosen path flows back through the bongle:save-as -> bongle:assign-path round-trip.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Save, X } from '../../../icons';
import type { Filesystem } from '../../fs';
import { FileTree, type FileTreePicker } from './FileTree';

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isBbmodel = (p: string) => /\.bbmodel$/i.test(p);

/** ensure a .bbmodel source name: the glb is derived by swapping this suffix, and
 *  the tree opens it as a Blockbench tab, so the extension is load-bearing. */
function normalizeName(raw: string): string {
    const name = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!name) return '';
    return isBbmodel(name) ? name : `${name}.bbmodel`;
}

export function SaveAsDialog({
    fs,
    defaultPath,
    onConfirm,
    onCancel,
}: {
    fs: Filesystem;
    /** seeds the picker: the project's current path (Save As) or a bare name. */
    defaultPath: string;
    onConfirm: (path: string) => void;
    onCancel: () => void;
}) {
    const [dir, setDir] = useState(() => parentOf(defaultPath));
    const [filename, setFilename] = useState(() => defaultPath.split('/').pop() ?? 'untitled.bbmodel');
    const inputRef = useRef<HTMLInputElement>(null);

    // preselect the filename (sans extension) so a name is easy to replace.
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dot = el.value.lastIndexOf('.bbmodel');
        el.setSelectionRange(0, dot === -1 ? el.value.length : dot);
    }, []);

    const normalized = normalizeName(filename);
    const target = normalized ? join(dir, normalized) : '';
    const valid = !!normalized;
    const submit = () => valid && onConfirm(target);

    // drive the embedded FileTree: a folder selection sets the destination dir; a
    // file selection also fills the name (targeting an overwrite); double-click /
    // Enter on an existing .bbmodel commits straight to it.
    const picker = useMemo<FileTreePicker>(
        () => ({
            onSelect: (path, kind) => {
                if (kind === 'dir') setDir(path);
                else {
                    setDir(parentOf(path));
                    setFilename(path.split('/').pop() ?? '');
                }
            },
            onChoose: (path) => {
                if (isBbmodel(path)) onConfirm(path);
                else {
                    setDir(parentOf(path));
                    setFilename(path.split('/').pop() ?? '');
                }
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
                        <Save size={14} /> Save As
                    </span>
                    <button type="button" className="text-fg-muted hover:text-fg" onClick={onCancel}>
                        <X size={14} />
                    </button>
                </div>

                <div className="mx-3 mt-3 h-[260px] overflow-hidden border border-border bg-surface">
                    <FileTree fs={fs} pane="" picker={picker} />
                </div>
                <div className="mx-3 mt-1 text-fg-muted text-xs">Right-click a folder for New Folder, rename, and more.</div>

                <label className="mx-3 mt-3 flex flex-col gap-1 text-xs">
                    <span className="text-fg-muted">File name</span>
                    <input
                        ref={inputRef}
                        value={filename}
                        onChange={(e) => setFilename(e.target.value)}
                        spellCheck={false}
                        className="border border-border bg-surface-muted px-2 py-1 text-fg outline-none focus:border-accent"
                    />
                </label>

                <div className="mx-3 mt-2 truncate text-fg-muted text-xs">
                    Saves to <span className="text-fg">{target || '…'}</span>
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
                        Save
                    </button>
                </div>
            </div>
        </div>
    );
}
