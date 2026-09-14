import { useCallback, useRef } from 'react';
import { ActiveBlockPane } from './panes/active-block-pane';
import { CollapsiblePane } from './panes/collapsible-pane';
import { HierarchyPane } from './panes/hierarchy-pane';
import { HistoryPane } from './panes/history-pane';
import { ToolSpacePane, useToolPaneTitle } from './panes/tool-space-pane';

type ResizeHandleProps = {
    onResize: (dx: number) => void;
};

// pointer capture keeps the drag live even if the pointer leaves the element.
function ResizeHandle({ onResize }: ResizeHandleProps) {
    const lastX = useRef<number>(0);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        lastX.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const dx = lastX.current - e.clientX; // dragging left = wider
            lastX.current = e.clientX;
            onResize(dx);
        },
        [onResize],
    );

    return (
        <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent hover:opacity-60 z-20"
        />
    );
}

type RightPanelProps = {
    width: number;
    onResize: (dx: number) => void;
};

// to reorder a pane, move its <CollapsiblePane> line.
export function RightPanel({ width, onResize }: RightPanelProps) {
    const toolTitle = useToolPaneTitle();

    return (
        <div
            style={{ width }}
            className="relative flex-shrink-0 flex flex-col overflow-y-auto bg-surface border-l border-border text-sm"
        >
            <ResizeHandle onResize={onResize} />

            <CollapsiblePane title="hierarchy" defaultOpen={true} defaultHeight={440}>
                <HierarchyPane />
            </CollapsiblePane>

            <CollapsiblePane title={toolTitle} defaultOpen={true}>
                <ToolSpacePane />
            </CollapsiblePane>

            <CollapsiblePane title="active block" defaultOpen={true}>
                <ActiveBlockPane />
            </CollapsiblePane>

            <CollapsiblePane title="history" defaultOpen={true} defaultHeight={120}>
                <HistoryPane />
            </CollapsiblePane>
        </div>
    );
}
