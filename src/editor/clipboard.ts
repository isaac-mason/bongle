// clipboard.ts, system clipboard copy/cut/paste handlers for the editor.
//
// extracts the clipboard event logic from index.ts so that onInit stays thin.
// handlers are created once on init and registered via document.addEventListener.

import type { ClientRoom } from '../client/rooms';
import type { ScriptContext } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import * as Blueprint from './blueprint';
import type { EditRoomStoreApi } from './edit-room-store';
import { isInputFocused } from './input';
import type { TransformToolState } from './tools/transform';
import * as TransformTool from './tools/transform';
import { commitVoxelOps } from './voxel-edit';

export type ClipboardHandlers = {
    onCopy: (e: ClipboardEvent) => void;
    onCut: (e: ClipboardEvent) => void;
    onPaste: (e: ClipboardEvent) => void;
    onKeyDown: (e: KeyboardEvent) => void;
};

// snapshot the current store selection (voxels + nodes already unified).
function buildCurrentSelection(api: EditRoomStoreApi): Selection.Selection {
    return Selection.clone(api.getState().selection);
}

/**
 * build a blueprint of the current selection and write it to the system
 * clipboard via the async navigator API. used by ui paths that aren't
 * inside a native ClipboardEvent (e.g. context menus). the ctrl+c path
 * uses the native handler so it can preventDefault and write synchronously.
 */
export function copySelectionToSystemClipboard(api: EditRoomStoreApi, ctx: ScriptContext): void {
    const selection = buildCurrentSelection(api);
    if (Selection.isEmpty(selection)) return;

    const blueprint = Blueprint.copySelection(ctx.voxels, ctx.nodes, selection);
    const clipText = Blueprint.toClipboardString(blueprint);

    api.setState({ activeBlueprint: blueprint });
    navigator.clipboard.writeText(clipText).then(
        () => console.log(`[bongle] copied blueprint: ${blueprint.label}`),
        (err) => console.warn('[bongle] clipboard write failed:', err),
    );
}

export function createClipboardHandlers(
    api: EditRoomStoreApi,
    ctx: ScriptContext,
    room: ClientRoom,
    transformToolState: TransformToolState,
): ClipboardHandlers {
    // ClipboardEvent has no modifier-key info, so we sample shift state from the
    // keydown that triggered the paste/cut. holding shift turns the placement
    // into a continuous loop (each commit re-arms with the same blueprint).
    let shiftHeldAtTrigger = false;
    const onKeyDown = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'x' || e.key === 'V' || e.key === 'X')) {
            shiftHeldAtTrigger = e.shiftKey;
        }
    };

    const onCopy = (e: ClipboardEvent) => {
        if (isInputFocused()) return;
        const selection = buildCurrentSelection(api);
        if (Selection.isEmpty(selection)) return;

        const blueprint = Blueprint.copySelection(ctx.voxels, ctx.nodes, selection);
        const clipText = Blueprint.toClipboardString(blueprint);

        e.preventDefault();
        e.clipboardData?.setData('text/plain', clipText);
        api.setState({ activeBlueprint: blueprint });
        console.log(`[bongle] copied blueprint: ${blueprint.label}`);
    };

    const onPaste = (e: ClipboardEvent) => {
        if (isInputFocused()) return;
        const text = e.clipboardData?.getData('text/plain');
        if (!text) return;

        const blueprint = Blueprint.fromClipboardString(text, ctx.blocks);
        if (!blueprint) return;

        e.preventDefault();

        // offset blueprint to last hover voxel if available
        const hv = api.getState().lastHoverVoxel;
        if (hv) {
            blueprint.origin[0] = hv[0];
            blueprint.origin[1] = hv[1];
            blueprint.origin[2] = hv[2];
        }

        api.setState({ activeBlueprint: blueprint, placementContinuous: shiftHeldAtTrigger });
        console.log(`[bongle] pasted blueprint from clipboard: ${blueprint.label}${shiftHeldAtTrigger ? ' (continuous)' : ''}`);
        TransformTool.enterPlacement(transformToolState, blueprint, false, null, room.nodes, ctx);
    };

    const onCut = (e: ClipboardEvent) => {
        if (isInputFocused()) return;
        const sel = buildCurrentSelection(api);
        if (Selection.isEmpty(sel)) return;

        const blueprint = Blueprint.copySelection(ctx.voxels, ctx.nodes, sel);
        const clipText = Blueprint.toClipboardString(blueprint);

        e.preventDefault();
        e.clipboardData?.setData('text/plain', clipText);
        api.setState({ activeBlueprint: blueprint });
        console.log(`[bongle] cut blueprint: ${blueprint.label}`);

        // build reverse ops to restore voxels on cancel, and forward ops to erase them now
        const { forward: cutSourceOps, reverse: cutReverseOps } = Blueprint.buildPasteOps(
            blueprint,
            blueprint.origin,
            ctx.voxels,
        );
        // erase source voxels immediately (set each occupied cell to air)
        const airOps = cutSourceOps.map((op) => ({ ...op, key: 'air' }));
        commitVoxelOps(ctx, airOps);

        api.setState({ placementContinuous: shiftHeldAtTrigger });
        TransformTool.enterPlacement(transformToolState, blueprint, true, cutReverseOps, room.nodes, ctx);
    };

    return { onCopy, onCut, onPaste, onKeyDown };
}
