import { useEditRoom } from '../../edit-room-store';

/**
 * linear history list. undo stack newest-first, then a divider,
 * then the redo stack (greyed). clicking an entry walks the stack
 * to that position.
 */
export function HistoryPane() {
    const undoStack = useEditRoom((s) => s.undoStack);
    const redoStack = useEditRoom((s) => s.redoStack);
    const undo = useEditRoom((s) => s.undo);
    const redo = useEditRoom((s) => s.redo);

    const isEmpty = undoStack.length === 0 && redoStack.length === 0;

    if (isEmpty) {
        return <div className="px-2 py-2 text-[10px] font-mono text-fg-muted italic">no history</div>;
    }

    // undo stack displayed newest-first: index (len-1) is the top
    const undoItems = [...undoStack].reverse();
    // redo stack displayed next-first: index 0 is the next redo
    const redoItems = [...redoStack].reverse();

    return (
        <div className="flex flex-col py-1">
            {undoItems.map((a, i) => (
                <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: undo history entries are positional (stack index is the identity)
                    key={`undo-${i}`}
                    type="button"
                    onClick={() => {
                        // walk back i+1 steps
                        for (let n = 0; n <= i; n++) undo();
                    }}
                    className="text-left px-3 py-0.5 text-[10px] font-mono text-fg hover:bg-surface-muted cursor-pointer"
                >
                    {a.label}
                </button>
            ))}

            {/* current position marker */}
            <div className="flex items-center gap-2 px-3 py-0.5 my-0.5">
                <div className="flex-1 h-px bg-border" />
                <span className="text-[9px] font-mono text-fg-muted shrink-0">now</span>
                <div className="flex-1 h-px bg-border" />
            </div>

            {redoItems.map((a, i) => (
                <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: redo history entries are positional (stack index is the identity)
                    key={`redo-${i}`}
                    type="button"
                    onClick={() => {
                        // walk forward i+1 steps
                        for (let n = 0; n <= i; n++) redo();
                    }}
                    className="text-left px-3 py-0.5 text-[10px] font-mono text-fg-muted hover:bg-surface-muted cursor-pointer"
                >
                    {a.label}
                </button>
            ))}
        </div>
    );
}
