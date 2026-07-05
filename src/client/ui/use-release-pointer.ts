/**
 * Free the pointer while a React overlay (library, pause menu, dialog) is open,
 * so the cursor works over the panel. Holds a lock-release while `active`; the
 * engine re-locks on the next canvas click. Pass `active` (default true) so a
 * component that stays mounted while hidden only frees the cursor when shown.
 *
 * Note: the cleanup runs after paint, not inside a user gesture, so closing a
 * panel re-locks on the next click rather than instantly. For a seamless
 * in-gesture re-lock (e.g. a game panel closed by a button), use the script-side
 * `releasePointer().restore()` from the close handler instead.
 */

import { useEffect } from 'react';
import { addLockRelease, removeLockRelease } from '../input';
import { useClient } from './client-store';

export function useReleasePointer(id: string, active = true): void {
    useEffect(() => {
        if (!active) return;
        const manager = useClient.getState().inputManager;
        if (!manager) return;
        addLockRelease(manager, id);
        return () => removeLockRelease(manager, id);
    }, [id, active]);
}
