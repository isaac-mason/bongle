// Default in-process AvatarsServerDriver. Used by `lib/runtime` standalone
// (kit dev `./dev.sh`), the editor, and e2e tests — anywhere there is no
// bongle service to talk to. Always returns the builtin avatar.
//
// Production room servers swap this for an HTTP-backed driver pointed at
// the service's `/api/rooms/user-avatar/:userId` endpoint.

import type { AvatarsServerDriver, ResolvedAvatar } from 'bongle/interface';
import { BUILTIN_BASE_AVATAR_ID } from '../core/player/base-avatar';

export function createInMemoryAvatarsDriver(): AvatarsServerDriver {
    return {
        async resolve(_userId: string): Promise<ResolvedAvatar> {
            return { source: 'bundled', modelId: BUILTIN_BASE_AVATAR_ID };
        },
    };
}
