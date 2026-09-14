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

export function useToolPaneTitle(): string {
    const activeTool = useEditRoom((s) => s.activeTool);
    return `tool — ${TOOL_LABELS[activeTool]}`;
}

// TODO: the inspect tool can't raycast into the scene yet, so node selection from the 3d
// viewport is unavailable; it's done via the hierarchy panel only until a scene-level raycast lands.
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
