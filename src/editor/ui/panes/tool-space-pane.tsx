import type { EditorTool } from '../../edit-room-store';
import { useEditRoom } from '../../edit-room-store';
import { InspectorPanel } from '../inspector';
import {
    BoxSelectOptions,
    BrushOptions,
    BrushSelectOptions,
    BuildOptions,
    ElevationOptions,
    InspectOptions,
    LassoSelectOptions,
    MagicSelectOptions,
    PaintOptions,
    SmoothOptions,
    TransformOptions,
} from '../tool-options';

const TOOL_LABELS: Record<EditorTool, string> = {
    inspect: 'inspect',
    transform: 'transform',
    'box-select': 'box select',
    'magic-select': 'magic select',
    'lasso-select': 'lasso select',
    'brush-select': 'brush select',
    build: 'build',
    paint: 'paint',
    brush: 'brush',
    smooth: 'smooth',
    elevation: 'elevation',
};

/** returns the collapsible pane title for the tool section, e.g. "tool, build" */
export function useToolPaneTitle(): string {
    const activeTool = useEditRoom((s) => s.activeTool);
    return `tool — ${TOOL_LABELS[activeTool]}`;
}

/**
 * content slot for the "tool space" pane, renders the active tool's options/inspector.
 * inspect → inspector panel (select node, edit traits/scripts)
 * voxel tools → their respective option panels
 *
 * todo: inspect tool cannot yet raycast into the scene to pick nodes from the 3d viewport.
 * node selection is done via the hierarchy panel only. full viewport picking is deferred
 * until a scene-level raycast is implemented.
 */
export function ToolSpacePane() {
    const activeTool = useEditRoom((s) => s.activeTool);

    switch (activeTool) {
        case 'inspect':
            return (
                <>
                    <InspectOptions />
                    <InspectorPanel />
                </>
            );
        case 'transform':
            return (
                <>
                    <TransformOptions />
                    <InspectorPanel />
                </>
            );
        case 'box-select':
            return <BoxSelectOptions />;
        case 'magic-select':
            return <MagicSelectOptions />;
        case 'lasso-select':
            return <LassoSelectOptions />;
        case 'brush-select':
            return <BrushSelectOptions />;
        case 'build':
            return <BuildOptions />;
        case 'paint':
            return <PaintOptions />;
        case 'brush':
            return <BrushOptions />;
        case 'smooth':
            return <SmoothOptions />;
        case 'elevation':
            return <ElevationOptions />;
    }
}
