import type { PlayerId } from '../core/client';
import type { PlayerMode } from '../core/protocol';
import { addTrait, type Node } from '../core/scene/scene-tree';
import { addCharacter } from './character';
import { CharacterControllerTrait } from './character-controller';
import { PlayerTrait } from './player';
import { PlayerControllerTrait } from './player-controller';
import { setPosition, TransformTrait } from './transform';

export type PlayerNodeSetup = {
    playerId: PlayerId;
    /** the client id that owns the Player. */
    clientId: number;
    mode: PlayerMode;
    /** streaming radius; server uses 24 for edit, 8 for play. */
    viewRadius: number;
    userId?: string;
    username?: string;
    /** default play-mode spawn; games override in onJoin. */
    spawn?: [number, number, number];
};

/**
 * populates a freshly created + parented player node with the standard traits: Transform + Player,
 * the character rig, and, for play mode, the default humanoid controls at a default spawn.
 *
 * shared by the server room join path and client authoritative local/standalone rooms so both
 * build players identically.
 */
export function addPlayerTraits(node: Node, setup: PlayerNodeSetup): void {
    const transform = addTrait(node, TransformTrait);
    const trait = addTrait(node, PlayerTrait);
    trait.playerId = setup.playerId;
    trait.client = setup.clientId;
    trait.viewRadius = setup.viewRadius;
    if (setup.userId !== undefined) trait.userId = setup.userId;
    if (setup.username !== undefined) trait.username = setup.username;
    // mount the rig now, not on the reconciler's first frame, so join hooks can findByName synchronously
    addCharacter(node);
    if (setup.mode === 'play') {
        // spawn slightly above origin so players drop onto ground at y=0 instead of clipping into it
        setPosition(transform, setup.spawn ?? [0, 2, 0]);
        addTrait(node, CharacterControllerTrait);
        addTrait(node, PlayerControllerTrait);
    }
}
