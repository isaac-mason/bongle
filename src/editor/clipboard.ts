import type { ClientRoom } from '../client/rooms';
import type { ScriptContext } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import * as Blueprint from './blueprint';
import type { EditRoomStoreApi } from './edit-room-store';
import { isInputFocused } from './input';
import type { PlacementTool } from './tools/placement';
import * as Placement from './tools/placement';

export type ClipboardHandlers = {
    onCopy: (e: ClipboardEvent) => void;
    onCut: (e: ClipboardEvent) => void;
    onPaste: (e: ClipboardEvent) => void;
    onKeyDown: (e: KeyboardEvent) => void;
};

function buildCurrentSelection(api: EditRoomStoreApi): Selection.Selection {
    return Selection.clone(api.getState().selection);
}

/** for ui paths outside a native ClipboardEvent (context menus); ctrl+c uses the native handler
 *  below so it can preventDefault and write synchronously. */
export function copySelectionToSystemClipboard(api: EditRoomStoreApi, ctx: ScriptContext): void {
    const selection = buildCurrentSelection(api);
    if (Selection.isEmpty(selection)) return;

    const blueprint = Blueprint.copySelection(ctx.voxels, ctx.scene, selection);
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
    placement: PlacementTool,
): ClipboardHandlers {
    // ClipboardEvent has no modifier-key info, so shift state is sampled from the triggering
    // keydown; holding shift turns the placement into a continuous loop.
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

        const blueprint = Blueprint.copySelection(ctx.voxels, ctx.scene, selection);
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

        const hv = api.getState().lastHoverVoxel;
        if (hv) {
            blueprint.origin[0] = hv[0];
            blueprint.origin[1] = hv[1];
            blueprint.origin[2] = hv[2];
        }

        api.setState({ activeBlueprint: blueprint, placementContinuous: shiftHeldAtTrigger });
        console.log(`[bongle] pasted blueprint from clipboard: ${blueprint.label}${shiftHeldAtTrigger ? ' (continuous)' : ''}`);
        Placement.enterPlacement(placement, blueprint, false, null, room.scene, ctx);
    };

    // one cut: the store's action does the work, the clipboard event only carries the text out.
    const onCut = (e: ClipboardEvent) => {
        if (isInputFocused()) return;
        const blueprint = api.getState().cutMove(shiftHeldAtTrigger);
        if (!blueprint) return;
        e.preventDefault();
        e.clipboardData?.setData('text/plain', Blueprint.toClipboardString(blueprint));
        console.log(`[bongle] cut blueprint: ${blueprint.label}`);
    };

    return { onCopy, onCut, onPaste, onKeyDown };
}
