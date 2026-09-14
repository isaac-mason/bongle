import { type TraitType } from '../core/scene/traits';
import { trait } from '../core/registry';

/** per-player editor activation marker; carries no controls, its presence is the activation.
 *  attached to a player's server-owned room.playerNode in an edit room, or the client-local
 *  lens node (lens.ts) for Shift+` peek into play rooms. */
export const EditorTrait = trait('editor.state', {}, { persist: false });

export type EditorTrait = TraitType<typeof EditorTrait>;
