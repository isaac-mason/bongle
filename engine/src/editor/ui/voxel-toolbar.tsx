import { useMemo } from 'react';
import { useEditor } from '../editor-store';
import { useEditRoom } from '../edit-room-store';
import { activeBlockKeyOf } from '../inventory';
import * as Selection from '../../core/scene/selection';

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
                run: () => fill(activeBlockKey),
            },
            {
                label: 'Replace',
                kbd: 'G',
                enabled: () => hasSelection && hasBlock,
                run: () => replace(activeBlockKey),
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
                        className={`flex items-center justify-between gap-3 px-2.5 py-1.5 text-[11px] font-mono rounded border shadow-sm bg-white ${
                            on
                                ? 'border-neutral-200 text-neutral-700 hover:bg-neutral-50 cursor-pointer'
                                : 'border-neutral-100 text-neutral-300 cursor-not-allowed'
                        }`}
                    >
                        <span>{a.label}</span>
                        <kbd
                            className={`text-[9px] px-1 py-0.5 rounded border font-mono ${
                                on
                                    ? 'border-neutral-300 text-neutral-400 bg-neutral-50'
                                    : 'border-neutral-200 text-neutral-300 bg-white'
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
