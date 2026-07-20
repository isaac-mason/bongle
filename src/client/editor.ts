/**
 * Client-side editor orchestration, the page-level glue between UI
 * toggles (Eye icon, mode pill, Shift+`) and the trait-driven editor
 * lifecycle.
 *
 * The editor activates wherever an `EditorTrait` attaches to a node:
 *   - in edit rooms, the server seeds it on `room.playerNode`; the
 *     replicated trait spins up the script on the owning client.
 *   - in play rooms with a Shift+` peek lens, we addTrait locally on
 *     the lens's editorNode so the script runs only on this client.
 *
 * Toggling means adding or removing that trait. For edit rooms it's a
 * server roundtrip via `AddTraitCommand`/`RemoveTraitCommand`; for play
 * rooms it rides on lens creation/teardown.
 */
import { CameraTrait } from '../builtins/camera';
import { FlyControllerTrait } from '../builtins/fly-controller';
import { setWorldPosition, setWorldQuaternion, TransformTrait } from '../builtins/transform';
import { registry } from '../core/registry';
import * as Rpc from '../core/rpc';
import * as SceneTree from '../core/scene/scene-tree';
import { getTrait } from '../core/scene/scene-tree';
import { AddTraitCommand, RemoveTraitCommand } from '../editor/commands';
import { useEditor } from '../editor/editor-store';
import { EditorTrait } from '../editor/editor-trait';
import { buildRoomViews, type ClientRoom, getRenderCamera } from './rooms';

/**
 * Toggle the editor for `room`. The mechanism depends on room type:
 *   - play room + enable: spawn a local lens (which adds EditorTrait to its editorNode)
 *   - play room + disable: tear down the lens (trait dies with the destroyed node)
 *   - edit room + enable: server roundtrip to add EditorTrait to playerNode
 *   - edit room + disable: server roundtrip to remove it
 *
 * In edit rooms the server already seeds EditorTrait on join, so enable
 * is normally a no-op; this path matters mainly when re-enabling after
 * an explicit disable.
 */
export function setEditorEnabledForRoom(room: ClientRoom, enabled: boolean): void {
    if (room.playerMode === 'play') {
        if (enabled && !room.editor) enterLocalEditorView(room);
        else if (!enabled && room.editor) exitLocalEditorView(room);
        return;
    }
    const { rpc, roomId } = room.scriptRuntime;
    if (enabled) {
        Rpc.send(
            rpc,
            registry.commandWireIndex,
            AddTraitCommand,
            {
                id: room.playerNode.id,
                traitId: EditorTrait._id,
                props: undefined,
            },
            roomId,
        );
    } else {
        Rpc.send(
            rpc,
            registry.commandWireIndex,
            RemoveTraitCommand,
            {
                id: room.playerNode.id,
                traitId: EditorTrait._id,
            },
            roomId,
        );
    }
}

/* ── local editor lens ──────────────────────────────────────────── */

/**
 * Spawn a local-only editor node on `room` (realm: 'client', persist: false)
 * plus a lens-private camera node, point the client state's subject + active
 * camera at them, seed the lens camera from the outgoing view, attach
 * FlyControllerTrait and EditorTrait (the trait is what activates the editor
 * script), and set `room.editor`. The editor's controller-swap reconcile (in
 * editor/index.ts) may swap to the user's chosen control mode on its next
 * tick. No-op when a lens is already up.
 *
 * The lens camera is separate from `room.cameraNode` so the lens's pose
 * survives play↔edit tab toggles, the player controller keeps driving
 * the shared default camera while the lens's own camera holds wherever
 * the editor was last flown to.
 */
export function enterLocalEditorView(room: ClientRoom): void {
    if (room.editor) return;

    // snapshot the outgoing view pose BEFORE swapping, so the lens starts where
    // the play camera was and entry is seamless.
    const src = getRenderCamera(room);
    const srcPos = src ? ([src.position[0], src.position[1], src.position[2]] as [number, number, number]) : null;
    const srcQuat = src
        ? ([src.quaternion[0], src.quaternion[1], src.quaternion[2], src.quaternion[3]] as [number, number, number, number])
        : null;

    // lens-private camera node. realm: 'client' so it doesn't replicate; lives
    // for the lifetime of the lens. its TransformTrait pose is what survives
    // play↔edit toggles, the player controller never writes here.
    const cameraNode = SceneTree.createNode({ name: `editor:${room.playerId}:camera`, persist: false, realm: 'client' });
    SceneTree.addTrait(cameraNode, TransformTrait);
    SceneTree.addTrait(cameraNode, CameraTrait);
    SceneTree.addChild(room.nodes.root, cameraNode);

    // seed lens camera pose from the outgoing view so entry is seamless. Play
    // rooms always have a live render camera, so srcPos/srcQuat exist; if they
    // somehow don't, the lens camera just stays at its default pose.
    const cameraTransform = getTrait(cameraNode, TransformTrait)!;
    if (srcPos && srcQuat) {
        setWorldPosition(cameraTransform, srcPos);
        setWorldQuaternion(cameraTransform, srcQuat);
    }

    const editorNode = SceneTree.createNode({ name: `editor:${room.playerId}`, persist: false, realm: 'client' });
    SceneTree.addChild(room.nodes.root, editorNode);

    // publish the lens pointer *before* attaching EditorTrait, addTrait fires
    // the editor script synchronously, and its ownership gate checks
    // `room.editor.subject === ctx.node` to recognise the client-local lens
    // (lens nodes have no owner, so isOwner() always fails for them).
    room.editor = { id: crypto.randomUUID(), subject: editorNode, camera: cameraNode };

    // point the client state at the lens: subject = editorNode, active camera =
    // the lens camera. do this BEFORE adding the fly controller so it captures
    // the lens camera (getCamera(ctx)) as the one it drives.
    room.client.subject = editorNode;
    room.client.camera = cameraNode;

    // Reconcile may swap this on next tick.
    SceneTree.addTrait(editorNode, FlyControllerTrait);
    SceneTree.addTrait(editorNode, EditorTrait);

    const store = useEditor.getState();
    store.setRoomView(room.playerId, 'edit');
    // editor POV now exists, refresh the RoomView snapshot so consumers
    // (toolbar tabs) see the new addressable view.
    store.setRoomViews(buildRoomViews(store.allRooms));
}

/** Tear down the local editor lens, restore the default subject/camera, destroy lens nodes, clear room.editor. */
export function exitLocalEditorView(room: ClientRoom): void {
    const lens = room.editor;
    if (!lens) return;
    room.client.subject = room.client.defaultSubject;
    room.client.camera = room.client.defaultCamera;
    SceneTree.destroyNode(room.nodes, lens.subject);
    SceneTree.destroyNode(room.nodes, lens.camera);
    room.editor = null;
    const store = useEditor.getState();
    store.clearRoomView(room.playerId);
    // editor POV gone, refresh the RoomView snapshot.
    store.setRoomViews(buildRoomViews(store.allRooms));
}

/**
 * Switch which perspective `room` is viewed through. Drives the imperative
 * subject + active-camera swap on the client state and writes the resulting
 * view into the editor store so tab UIs can render active state. No-op on edit
 * rooms (lens doesn't apply, player node already is the editor camera).
 */
export function setRoomView(room: ClientRoom, view: 'edit' | 'play'): void {
    const lens = room.editor;
    if (!lens) return;
    if (view === 'edit') {
        if (room.client.subject === lens.subject) return;
        room.client.subject = lens.subject;
        room.client.camera = lens.camera;
    } else {
        if (room.client.subject === room.client.defaultSubject) return;
        room.client.subject = room.client.defaultSubject;
        room.client.camera = room.client.defaultCamera;
    }
    useEditor.getState().setRoomView(room.playerId, view);
}

/**
 * Page-level clipboard listeners. One set per page; each event
 * dispatches to the active room's handlers (set by the editor script
 * on activate, cleared on deactivate). Rooms whose editor is enabled
 * but not active hold their handlers without firing here.
 */
export function installEditorClientListeners(): void {
    document.addEventListener('copy', (e) => {
        useEditor.getState().room?.editorClipboard?.onCopy(e);
    });
    document.addEventListener('cut', (e) => {
        useEditor.getState().room?.editorClipboard?.onCut(e);
    });
    document.addEventListener('paste', (e) => {
        useEditor.getState().room?.editorClipboard?.onPaste(e);
    });
    document.addEventListener(
        'keydown',
        (e) => {
            useEditor.getState().room?.editorClipboard?.onKeyDown(e);
        },
        true,
    );
}
