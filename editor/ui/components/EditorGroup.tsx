// editor/ui/components/EditorGroup.tsx — one editor group: a tab strip + a Monaco
// instance, with the Markdown preview/source toggle. Groups are the split unit —
// a pane renders a row of them; a torn-off window hosts one pane of them. While a
// tab is dragging, the editor area shows a left/right split drop zone.

import { Code, Eye } from "../../../icons";
import { useState } from 'react';
import type { Filesystem } from '../../fs';
import { useEditor } from '../../stores/editor';
import { useTabDrag } from '../../stores/tab-drag';
import { MarkdownView } from './MarkdownView';
import { Monaco } from './Monaco';
import { Tabs } from './Tabs';

type MdMode = 'preview' | 'edit';

export function EditorGroup({ fs, group, pane, index }: { fs: Filesystem; group: string; pane: string; index: number }) {
    const active = useEditor((s) => s.groups[group]?.active ?? null);
    const drag = useTabDrag((s) => s.drag);
    const isMd = !!active && /\.(md|markdown)$/i.test(active);
    const [mdMode, setMdMode] = useState<Record<string, MdMode>>({});
    const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null);
    const mode: MdMode = active ? (mdMode[active] ?? 'preview') : 'preview'; // rendered by default

    return (
        <div className="flex min-w-0 flex-1 flex-col" onPointerDown={() => useEditor.getState().focusGroup(group)}>
            <Tabs group={group} />
            <div className="relative min-h-0 flex-1">
                <Monaco fs={fs} group={group} />
                {isMd && mode === 'preview' && active && <MarkdownView fs={fs} path={active} />}
                {isMd && (
                    // floating preview/source toggle, top-right over the editor area
                    // (right-4 clears Monaco's scrollbar / MarkdownView's overflow gutter).
                    <div className="absolute top-2 right-4 z-[5] flex gap-0.5">
                        <button
                            type="button"
                            className={mdBtn(mode === 'preview')}
                            title="Preview"
                            onClick={() => active && setMdMode((m) => ({ ...m, [active]: 'preview' }))}
                        >
                            <Eye size={14} />
                        </button>
                        <button
                            type="button"
                            className={mdBtn(mode === 'edit')}
                            title="Source"
                            onClick={() => active && setMdMode((m) => ({ ...m, [active]: 'edit' }))}
                        >
                            <Code size={14} />
                        </button>
                    </div>
                )}
                {drag && (
                    // split drop zone: drop a dragged tab on the left/right half to open
                    // it in a new group before / after this one.
                    // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only drop target.
                    <div
                        className="absolute inset-0 z-[6]"
                        onDragOver={(e) => {
                            e.preventDefault();
                            const r = e.currentTarget.getBoundingClientRect();
                            setDropSide(e.clientX < r.left + r.width / 2 ? 'left' : 'right');
                        }}
                        onDragLeave={() => setDropSide(null)}
                        onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const d = useTabDrag.getState().drag;
                            const side = dropSide;
                            setDropSide(null);
                            useTabDrag.getState().setDrag(null);
                            if (d && side)
                                useEditor.getState().splitGroup(pane, side === 'left' ? index : index + 1, d.path, d.group);
                        }}
                    >
                        {dropSide && (
                            <div
                                className={`pointer-events-none absolute inset-y-0 w-1/2 bg-accent/30 ${dropSide === 'left' ? 'left-0' : 'right-0'}`}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

function mdBtn(active: boolean): string {
    return `grid h-[22px] w-[26px] cursor-pointer place-items-center border border-border ${
        active ? 'bg-accent text-on-accent' : 'bg-surface text-fg'
    }`;
}
