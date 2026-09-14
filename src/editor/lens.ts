import { CameraTrait } from '../builtins/camera';
import { FlyControllerTrait } from '../builtins/fly-controller';
import {
    getWorldPosition,
    getWorldQuaternion,
    setWorldPosition,
    setWorldQuaternion,
    TransformTrait,
} from '../builtins/transform';
import type { ClientRoom } from '../client/rooms';
import { registry } from '../core/registry';
import * as Rpc from '../core/rpc';
import type { Node } from '../core/scene/scene-tree';
import * as SceneTree from '../core/scene/scene-tree';
import { getTrait } from '../core/scene/scene-tree';
import { AddTraitCommand, RemoveTraitCommand } from './commands';
import { activeEditRoomStore } from './edit-room-store';
import { useEditor } from './editor-store';
import { EditorTrait } from './editor-trait';

/** a local editor lens on a play room: client-only nodes the editor looks through. subject +
 *  camera become `client.subject` / `client.camera` while active. held in `useEditor.lenses`
 *  keyed by player; `lensOf(room)` is the lookup. an edit room has no lens: the player node is
 *  the editor's subject and the server seeds EditorTrait on it. */
export type Lens = {
    /** stable opaque id so the UI can address the editor POV separately from the player POV. */
    id: string;
    subject: Node;
    /** `realm: 'client'` with TransformTrait + CameraTrait; preserves pose across play/edit tab
     *  toggles independently of `room.cameraNode` (which the player controller drives). */
    camera: Node;
};

export function lensOf(room: ClientRoom): Lens | null {
    return useEditor.getState().lenses.get(room.playerId) ?? null;
}

/** play room: toggling spawns/tears down a local lens. edit room: server roundtrip to
 *  add/remove EditorTrait on playerNode (the server seeds it on join, so enable is usually a
 *  no-op except when re-enabling after an explicit disable). */
export function setEditorEnabledForRoom(room: ClientRoom, enabled: boolean): void {
    if (room.playerMode === 'play') {
        if (enabled && !lensOf(room)) enterLocalEditorView(room);
        else if (!enabled && lensOf(room)) exitLocalEditorView(room);
        return;
    }
    const { rpc, roomId } = room.context;
    if (enabled) {
        Rpc.send(
            rpc,
            registry.protocol.commands,
            AddTraitCommand,
            {
                id: room.playerNode.id,
                traitId: EditorTrait.id,
                props: undefined,
            },
            roomId,
        );
    } else {
        Rpc.send(
            rpc,
            registry.protocol.commands,
            RemoveTraitCommand,
            {
                id: room.playerNode.id,
                traitId: EditorTrait.id,
            },
            roomId,
        );
    }
}

/** spawns a local-only editor node plus a lens-private camera node, points the client state's
 *  subject + active camera at them, attaches FlyControllerTrait and EditorTrait (which activates
 *  the editor script), and publishes the lens. no-op when a lens is already up. the lens camera
 *  is separate from `room.cameraNode` so its pose survives play/edit tab toggles while the
 *  player controller keeps driving the shared default camera. */
export function enterLocalEditorView(room: ClientRoom): void {
    if (lensOf(room)) return;

    // snapshot the outgoing pose before swapping, reading the active camera node's world
    // transform directly since reaching the renderer from client code would be a cycle.
    const srcTransform = room.client.camera ? getTrait(room.client.camera, TransformTrait) : null;
    const srcPos = srcTransform ? (Array.from(getWorldPosition(srcTransform)) as [number, number, number]) : null;
    const srcQuat = srcTransform ? (Array.from(getWorldQuaternion(srcTransform)) as [number, number, number, number]) : null;

    // realm: 'client' so it doesn't replicate; the player controller never writes here.
    const cameraNode = SceneTree.createNode({ name: `editor:${room.playerId}:camera`, persist: false, realm: 'client' });
    SceneTree.addTrait(cameraNode, TransformTrait);
    SceneTree.addTrait(cameraNode, CameraTrait);
    SceneTree.addChild(room.scene.root, cameraNode);

    const cameraTransform = getTrait(cameraNode, TransformTrait)!;
    if (srcPos && srcQuat) {
        setWorldPosition(cameraTransform, srcPos);
        setWorldQuaternion(cameraTransform, srcQuat);
    }

    const editorNode = SceneTree.createNode({ name: `editor:${room.playerId}`, persist: false, realm: 'client' });
    SceneTree.addChild(room.scene.root, editorNode);

    // must publish before attaching EditorTrait: addTrait fires the editor script synchronously,
    // and its ownership gate checks `lensOf(room)?.subject === ctx.node` (lens nodes have no
    // owner, so isOwner() always fails for them).
    useEditor.getState().setLens(room.playerId, { id: crypto.randomUUID(), subject: editorNode, camera: cameraNode });

    // before adding the fly controller so it captures the lens camera as the one it drives.
    room.client.subject = editorNode;
    room.client.camera = cameraNode;

    // the editor's controller-swap reconcile may swap this on the next tick.
    SceneTree.addTrait(editorNode, FlyControllerTrait);
    SceneTree.addTrait(editorNode, EditorTrait);

    useEditor.getState().setRoomView(room.playerId, 'edit');
}

/** restores the default subject/camera, destroys the lens nodes, drops the lens. */
export function exitLocalEditorView(room: ClientRoom): void {
    const lens = lensOf(room);
    if (!lens) return;
    room.client.subject = room.client.defaultSubject;
    room.client.camera = room.client.defaultCamera;
    SceneTree.destroyNode(room.scene, lens.subject);
    SceneTree.destroyNode(room.scene, lens.camera);
    useEditor.getState().setLens(room.playerId, null);
    useEditor.getState().clearRoomView(room.playerId);
}

/** no-op on edit rooms (lens doesn't apply, player node already is the editor camera). */
export function setRoomView(room: ClientRoom, view: 'edit' | 'play'): void {
    const lens = lensOf(room);
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

/** one set per page; each event dispatches to the active room's handlers (set by the editor
 *  script on activate, cleared on deactivate). */
export function installEditorClientListeners(): void {
    const clipboard = () => activeEditRoomStore().getState().clipboard;
    document.addEventListener('copy', (e) => clipboard()?.onCopy(e));
    document.addEventListener('cut', (e) => clipboard()?.onCut(e));
    document.addEventListener('paste', (e) => clipboard()?.onPaste(e));
    document.addEventListener('keydown', (e) => clipboard()?.onKeyDown(e), true);
}
