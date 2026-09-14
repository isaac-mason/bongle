import { useEffect } from 'react';
import { addLockRelease, removeLockRelease } from '../input';
import { useClient } from './stores/client-store';

export function useReleasePointer(id: string, active = true): void {
    useEffect(() => {
        if (!active) return;
        const manager = useClient.getState().inputManager;
        if (!manager) return;
        addLockRelease(manager, id);
        return () => removeLockRelease(manager, id);
    }, [id, active]);
}
