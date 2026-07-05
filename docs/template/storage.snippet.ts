// Typechecked snippets for Persistence.
// Compiles against `bongle`; regions are pulled into guide.md by build.js.

import type { ClientId } from 'bongle';
import { clientToUser, onJoin, system, userStorage } from 'bongle';
import type { JsonValue } from 'bongle/interface';

/* SNIPPET_START: store */
type PlayerSave = { version: number; coins: number; level: number };
const SAVE_VERSION = 1;

// normalize whatever was stored into the current shape: fill defaults, and
// migrate older versions forward as SAVE_VERSION grows.
function loadSave(stored: JsonValue | undefined): PlayerSave {
    const data = (stored ?? {}) as Partial<PlayerSave>;
    return { version: SAVE_VERSION, coins: data.coins ?? 0, level: data.level ?? 1 };
}

// userStorage is server-only and per-player; onJoin runs on the server.
system('profiles', (ctx) => {
    async function onPlayerJoin(client: ClientId) {
        const user = clientToUser(ctx, client);

        const entry = await userStorage.get(ctx, user.id, 'save');
        const save = loadSave(entry?.value);

        // award a daily login bonus, then persist (the version travels with it)
        await userStorage.set(ctx, user.id, 'save', {
            version: save.version,
            coins: save.coins + 100,
            level: save.level,
        });
    }

    onJoin(ctx, ({ client }) => {
        void onPlayerJoin(client);
    });
});
/* SNIPPET_END: store */
