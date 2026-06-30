import { type TraitType, trait } from '../core/scene/traits';

/**
 * per-player editor activation marker. attached to:
 *   - the server-owned `room.playerNode` of a player in an edit room
 *     (replicated to the owning client; the client script runs there)
 *   - the client-local `room.editor.editorNode` lens spawned by
 *     enterLocalEditorView for Shift+\` peek into play rooms
 *
 * the trait carries no controls, its presence IS the activation. the
 * client script bound via `script(EditorTrait, 'editor', ...)` spins up
 * when the trait attaches and tears down via onDispose when it detaches.
 * env.client gate inside the script body makes server-side replicas no-op.
 */
export const EditorTrait = trait('editor.state', {}, { persist: false });

export type EditorTrait = TraitType<typeof EditorTrait>;

/**
 * server-side editor marker, attached to the room root of edit rooms.
 * carries the server command listeners (voxel edits, node mutations,
 * blueprint save) and the `/relight` chat command. paired with EditorTrait
 * (per-player), this one owns room-wide server concerns, EditorTrait owns
 * per-player client activation.
 */
export const EditorServerTrait = trait('editor.server', {}, { persist: false });

export type EditorServerTrait = TraitType<typeof EditorServerTrait>;
