/**
 * source of truth for the editor's tool groupings. consumed by the
 * left toolbar UI (rendering + dividers) and the global keyboard
 * handler (category-key cycle + hold-and-digit slot jump).
 */

import * as Icons from "../../icons";
import type { EditorTool } from './edit-room-store';
import { TOOL_CATEGORY_KEYS, type ToolCategoryId } from './editor-controls';

export type ToolDef = {
    id: EditorTool;
    icon: typeof Icons.BoxSelect;
    label: string;
    hint: string;
};

export type ToolCategory = {
    id: ToolCategoryId;
    label: string;
    icon: typeof Icons.BoxSelect;
    key: string; // KeyboardEvent.code, e.g. 'KeyV'
    tools: ToolDef[];
};

export const TOOL_CATEGORIES: ToolCategory[] = [
    {
        id: 'inspect',
        label: 'inspect',
        icon: Icons.MousePointer2,
        key: TOOL_CATEGORY_KEYS.inspect,
        tools: [{ id: 'inspect', icon: Icons.MousePointer2, label: 'inspect', hint: 'select & inspect scene nodes' }],
    },
    {
        id: 'transform',
        label: 'transform',
        icon: Icons.Move,
        key: TOOL_CATEGORY_KEYS.transform,
        tools: [{ id: 'transform', icon: Icons.Move, label: 'transform', hint: 'move, rotate, scale nodes' }],
    },
    {
        id: 'select',
        label: 'select',
        icon: Icons.LassoSelect,
        key: TOOL_CATEGORY_KEYS.select,
        tools: [
            { id: 'box-select', icon: Icons.BoxSelect, label: 'box select', hint: 'drag to select voxels' },
            { id: 'magic-select', icon: Icons.WandSparkles, label: 'magic select', hint: 'flood-fill select voxels' },
            { id: 'lasso-select', icon: Icons.Lasso, label: 'lasso select', hint: 'draw a freeform region to select' },
            { id: 'brush-select', icon: Icons.Paintbrush, label: 'brush select', hint: 'stamp a shape to select voxels' },
        ],
    },
    {
        id: 'build',
        label: 'build',
        icon: Icons.Hammer,
        key: TOOL_CATEGORY_KEYS.build,
        tools: [
            { id: 'build', icon: Icons.Hammer, label: 'build', hint: 'place and break voxels' },
            { id: 'paint', icon: Icons.Brush, label: 'paint', hint: 'paint voxel faces' },
            { id: 'brush', icon: Icons.Paintbrush, label: 'brush', hint: 'stamp a shape × pattern at the cursor' },
            { id: 'smooth', icon: Icons.MoveDown, label: 'smooth', hint: 'heightmap gaussian — smooth the terrain surface' },
            {
                id: 'elevation',
                icon: Icons.Mountain,
                label: 'elevation',
                hint: 'raise / lower / flatten terrain — heightmap brush',
            },
        ],
    },
];

export function findCategoryByTool(tool: EditorTool): ToolCategory | undefined {
    return TOOL_CATEGORIES.find((c) => c.tools.some((t) => t.id === tool));
}

export function findCategoryByKey(code: string): ToolCategory | undefined {
    return TOOL_CATEGORIES.find((c) => c.key === code);
}
