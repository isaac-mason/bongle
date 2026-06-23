// Bundled humanoid avatars shipped with the engine, registered via `model()`
// just like the base avatar. The dev / edit / offline `ServerDriver.avatars`
// driver samples these so NPCs get real variety without a backend; a deployed
// host swaps that driver for its own backend-backed source.
//
// Assets live under lib/avatars/<name>/ alongside the base avatar. Codegen
// scans these declarations into the shared models barrel, so both client and
// server register them — same as `baseAvatar`.

import { model } from '../models/models';

export const bundledAvatars = [
    model('avatar:boy', { name: 'Boy', src: new URL('../../../avatars/boy/boy.glb', import.meta.url) }),
    model('avatar:girl', { name: 'Girl', src: new URL('../../../avatars/girl/girl.glb', import.meta.url) }),
    model('avatar:penguin', {
        name: 'Penguin',
        src: new URL('../../../avatars/blindfoldedpenguin/blindfoldedpenguin.glb', import.meta.url),
    }),
    model('avatar:pigeon', { name: 'Pigeon', src: new URL('../../../avatars/pigeon/pigeon.glb', import.meta.url) }),
];
