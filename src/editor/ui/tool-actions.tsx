import { useCallback, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import type { TransformMode } from '../edit-room-store';
import { useEditRoom } from '../edit-room-store';
import * as Selection from '../../core/scene/selection';
import { useEditor } from '../editor-store';
import { activeBlockKeyOf } from '../inventory';
import { parsePattern } from '../scene/pattern';
import { INSPECT_KEYS, TRANSFORM_GIZMO_KEYS } from '../editor-controls';
import { formatKeyLabel } from '../editor-controls';

/**
 * context- and tool-aware action buttons.
 * floats as an overlay in the top-left of the canvas area.
 *
 * inspect (with nodes selected):
 *   - translate, rotate, scale (enters transform mode)
 *
 * transform:
 *   - translate, rotate, scale (toggles gizmo mode)
 *
 * selection tools (box-select, magic-select):
 *   - fill, delete, replace, pick (enabled when there is a selection or hover)
 *
 * build / paint:
 *   - pick (enabled when there is a hover)
 */
export function ToolActions() {
    const activeTool = useEditRoom((s) => s.activeTool);
    const hasSelection = useEditRoom((s) => !Selection.isEmpty(s.selection));
    const hasHover = useEditRoom((s) => s.hoverVoxel !== null);
    const nodeCount = useEditRoom((s) => s.selection.nodes.size);
    const transformMode = useEditRoom((s) => s.transformMode);
    const transformHasVoxels = useEditRoom((s) => s.transformHasVoxels);
    const setActiveTool = useEditRoom((s) => s.setActiveTool);
    const setTransformMode = useEditRoom((s) => s.setTransformMode);

    const fill = useEditRoom((s) => s.fill);
    const del = useEditRoom((s) => s.delete);
    const replace = useEditRoom((s) => s.replace);
    const pick = useEditRoom((s) => s.pick);
    const cutMove = useEditRoom((s) => s.cutMove);
    const hotbar = useEditor((s) => s.hotbar);
    const activeSlotIndex = useEditRoom((s) => s.activeSlotIndex);
    const activeBlockKey = useMemo(() => activeBlockKeyOf(hotbar, activeSlotIndex), [hotbar, activeSlotIndex]);
    const onFill = useCallback(() => {
        if (activeBlockKey) fill(parsePattern(activeBlockKey));
    }, [activeBlockKey, fill]);
    const onReplace = useCallback(() => {
        if (activeBlockKey) replace(parsePattern(activeBlockKey));
    }, [activeBlockKey, replace]);

    const isSelectionTool =
        activeTool === 'box-select'
        || activeTool === 'magic-select'
        || activeTool === 'lasso-select'
        || activeTool === 'brush-select';
    const isBuildOrPaint = activeTool === 'build' || activeTool === 'paint' || activeTool === 'brush';
    const isInspect = activeTool === 'inspect';
    const isTransform = activeTool === 'transform';
    const canPick = hasHover || hasSelection;
    const hasNodes = nodeCount > 0;
    const hasSelectionOrHover = hasSelection || hasHover;

    // inspect with no node selection and transform with no nodes — no actions
    if (isInspect && !hasNodes) return null;

    // helper to enter transform mode from inspect or switch gizmo mode in transform
    function gizmoAction(mode: TransformMode) {
        if (isInspect) {
            setTransformMode(mode);
            setActiveTool('transform');
        } else {
            setTransformMode(mode);
        }
    }

    return (
        <div className="absolute top-2 left-2 z-10 pointer-events-auto flex gap-1">
            {/* inspect: show transform shortcuts when nodes are selected (R/T/Y in keyboard order) */}
            {isInspect && hasNodes && (
                <>
                    <ActionBtn
                        label={`rotate (${formatKeyLabel(INSPECT_KEYS.toRotate)})`}
                        icon={Icons.RotateCw}
                        disabled={false}
                        onClick={() => gizmoAction('rotate')}
                    />
                    <ActionBtn
                        label={`translate (${formatKeyLabel(INSPECT_KEYS.toTranslate)})`}
                        icon={Icons.ArrowRightLeft}
                        disabled={false}
                        onClick={() => gizmoAction('translate')}
                    />
                    <ActionBtn
                        label={`scale (${formatKeyLabel(INSPECT_KEYS.toScale)})`}
                        icon={Icons.ScalingIcon}
                        disabled={transformHasVoxels}
                        onClick={() => gizmoAction('scale')}
                    />
                </>
            )}
            {/* transform: gizmo mode toggle (R/T/Y/U/I in keyboard order) */}
            {isTransform && (
                <>
                    <GizmoModeBtn
                        mode="rotate"
                        label={`rotate (${formatKeyLabel(TRANSFORM_GIZMO_KEYS.rotate)})`}
                        icon={Icons.RotateCw}
                        current={transformMode}
                        onClick={gizmoAction}
                    />
                    <GizmoModeBtn
                        mode="translate"
                        label={`translate (${formatKeyLabel(TRANSFORM_GIZMO_KEYS.translate)})`}
                        icon={Icons.ArrowRightLeft}
                        current={transformMode}
                        onClick={gizmoAction}
                    />
                    <GizmoModeBtn
                        mode="scale"
                        label={`scale (${formatKeyLabel(TRANSFORM_GIZMO_KEYS.scale)})`}
                        icon={Icons.ScalingIcon}
                        current={transformMode}
                        disabled={transformHasVoxels}
                        onClick={gizmoAction}
                    />
                    <GizmoModeBtn
                        mode="place"
                        label={`place (${formatKeyLabel(TRANSFORM_GIZMO_KEYS.place)})`}
                        icon={Icons.Crosshair}
                        current={transformMode}
                        onClick={gizmoAction}
                    />
                    <GizmoModeBtn
                        mode="grab"
                        label={`grab (${formatKeyLabel(TRANSFORM_GIZMO_KEYS.grab)})`}
                        icon={Icons.Grab}
                        current={transformMode}
                        onClick={gizmoAction}
                    />
                </>
            )}
            {isSelectionTool && (
                <>
                    <ActionBtn
                        label="transform"
                        icon={Icons.Move}
                        disabled={!hasSelectionOrHover}
                        onClick={() => cutMove && cutMove()}
                        slashCmd="//cut"
                    />
                    <ActionBtn
                        label="fill"
                        icon={Icons.PaintBucket}
                        disabled={!hasSelection || !activeBlockKey}
                        onClick={onFill}
                        slashCmd="//set <block>"
                    />
                    <ActionBtn
                        label="replace"
                        icon={Icons.Shuffle}
                        disabled={!hasSelection || !activeBlockKey}
                        onClick={onReplace}
                        slashCmd="//replace <from> <to>"
                    />
                    <ActionBtn
                        label="delete"
                        icon={Icons.Scissors}
                        disabled={!hasSelection}
                        onClick={del}
                        slashCmd="//set air"
                    />
                </>
            )}
            {(isSelectionTool || isBuildOrPaint) && <ActionBtn label="pick" icon={Icons.Pipette} disabled={!canPick} onClick={pick} />}
        </div>
    );
}

function ActionBtn({
    label,
    icon: Icon,
    disabled,
    onClick,
    slashCmd,
}: {
    label: string;
    icon: React.ElementType;
    disabled: boolean;
    onClick: () => void;
    /** optional WE-style equivalent — shown as a popover below the button on
     *  hover so users can discover the slash form of the same action. */
    slashCmd?: string;
}) {
    const [hovered, setHovered] = useState(false);
    return (
        <div
            className="relative"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            <button
                type="button"
                disabled={disabled}
                onClick={onClick}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono shadow-sm border transition-colors ${
                    disabled
                        ? 'bg-white border-neutral-200 text-neutral-300 cursor-default'
                        : 'bg-white border-neutral-300 text-neutral-700 hover:bg-neutral-100 cursor-pointer'
                }`}
            >
                <Icon size={12} />
                {label}
            </button>
            {hovered && slashCmd && (
                <div className="absolute left-0 top-full mt-1 z-20 pointer-events-none bg-white border border-neutral-900 px-2 py-1 text-[11px] font-mono text-neutral-900 whitespace-nowrap shadow-sm">
                    {slashCmd}
                </div>
            )}
        </div>
    );
}

function GizmoModeBtn({
    mode,
    label,
    icon: Icon,
    current,
    disabled = false,
    onClick,
}: {
    mode: TransformMode;
    label: string;
    icon: React.ElementType;
    current: TransformMode;
    disabled?: boolean;
    onClick: (mode: TransformMode) => void;
}) {
    const active = current === mode;
    return (
        <button
            type="button"
            title={label}
            disabled={disabled}
            onClick={() => onClick(mode)}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono shadow-sm border transition-colors ${
                disabled
                    ? 'bg-neutral-100 border-neutral-200 text-neutral-400 cursor-not-allowed'
                    : active
                    ? 'bg-neutral-800 border-neutral-800 text-white cursor-pointer'
                    : 'bg-white border-neutral-300 text-neutral-700 hover:bg-neutral-100 cursor-pointer'
            }`}
        >
            <Icon size={12} />
            {label}
        </button>
    );
}
