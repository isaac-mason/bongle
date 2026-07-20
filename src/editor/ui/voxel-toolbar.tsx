import { useMemo } from 'react';
import * as Selection from '../../core/scene/selection';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { activeBlockKeyOf } from '../inventory';
import { parsePattern } from '../scene/pattern';

type ActionEntry = {
    label: string;
    kbd: string;
    enabled: () => boolean;
    run: () => void;
};

export function VoxelActions() {
    const hasSelection = useEditRoom((s) => !Selection.isEmpty(s.selection));
    const hasHover = useEditRoom((s) => s.hoverVoxel !== null);
    const hotbar = useEditor((s) => s.hotbar);
    const activeSlotIndex = useEditRoom((s) => s.activeSlotIndex);
    const activeBlockKey = useMemo(() => activeBlockKeyOf(hotbar, activeSlotIndex), [hotbar, activeSlotIndex]);
    const fill = useEditRoom((s) => s.fill);
    const del = useEditRoom((s) => s.delete);
    const replace = useEditRoom((s) => s.replace);
    const pick = useEditRoom((s) => s.pick);

    const hasBlock = activeBlockKey !== '';
    const canPick = hasHover || hasSelection;

    const actions = useMemo<ActionEntry[]>(
        () => [
            {
                label: 'Fill',
                kbd: 'F',
                enabled: () => hasSelection && hasBlock,
                run: () => fill(parsePattern(activeBlockKey)),
            },
            {
                label: 'Replace',
                kbd: 'G',
                enabled: () => hasSelection && hasBlock,
                run: () => replace(parsePattern(activeBlockKey)),
            },
            {
                label: 'Delete',
                kbd: '⌫',
                enabled: () => hasSelection,
                run: del,
            },
            {
                label: 'Pick',
                kbd: 'P',
                enabled: () => canPick,
                run: pick,
            },
        ],
        [activeBlockKey, hasSelection, hasBlock, canPick, fill, replace, del, pick],
    );

    return (
        <div className="pointer-events-auto flex flex-row gap-1">
            {actions.map((a) => {
                const on = a.enabled();
                return (
                    <button
                        key={a.label}
                        type="button"
                        disabled={!on}
                        onClick={() => {
                            if (on) a.run();
                        }}
                        className={`flex items-center justify-between gap-3 px-2.5 py-1.5 text-[11px] font-mono rounded border shadow-sm bg-surface ${
                            on
                                ? 'border-border text-fg hover:bg-surface-muted cursor-pointer'
                                : 'border-border-subtle text-fg-muted opacity-50 cursor-not-allowed'
                        }`}
                    >
                        <span>{a.label}</span>
                        <kbd
                            className={`text-[9px] px-1 py-0.5 rounded border font-mono ${
                                on
                                    ? 'border-border text-fg-muted bg-surface-muted'
                                    : 'border-border text-fg-muted bg-surface'
                            }`}
                        >
                            {a.kbd}
                        </kbd>
                    </button>
                );
            })}
        </div>
    );
}
