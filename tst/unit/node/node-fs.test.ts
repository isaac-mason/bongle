import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openNodeFs } from '../../../src/node/node-fs';
import { SCENES_DIR, sceneIdFromPath, scenePath } from '../../../src/server/content-manager';

// Exercises the node host fs + the engine's scene path conventions at runtime — the
// core new code the deployed play-room (M2) and the async load() seed (M1) rely on.
describe('openNodeFs + scene conventions', () => {
    let root: string;
    const dec = new TextDecoder();

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'bongle-node-fs-'));
        mkdirSync(join(root, 'content', 'scenes', 'sub'), { recursive: true });
        mkdirSync(join(root, 'resources', 'server', 'models'), { recursive: true });
        writeFileSync(join(root, 'content', 'scenes', 'main.scene.json'), '{"main":true}');
        writeFileSync(join(root, 'content', 'scenes', 'sub', 'nested.scene.json'), '{"nested":true}');
        writeFileSync(join(root, 'content', 'scenes', 'notascene.txt'), 'ignore me');
        writeFileSync(join(root, 'resources', 'server', 'models', 'm.bin'), new Uint8Array([1, 2, 3]));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('lists scenes recursively with root-relative paths + kind', async () => {
        const fs = openNodeFs(root);
        const entries = await fs.list(SCENES_DIR, { recursive: true });
        const files = entries.filter((e) => e.kind === 'file').map((e) => e.path);
        expect(files).toContain('content/scenes/main.scene.json');
        expect(files).toContain('content/scenes/sub/nested.scene.json');
        // the sub dir is surfaced as a 'dir' entry
        expect(entries.some((e) => e.kind === 'dir' && e.path === 'content/scenes/sub')).toBe(true);
    });

    it('round-trips sceneId ↔ path against listed entries', async () => {
        const fs = openNodeFs(root);
        const ids = (await fs.list(SCENES_DIR, { recursive: true }))
            .filter((e) => e.kind === 'file')
            .map((e) => sceneIdFromPath(e.path))
            .filter((id): id is string => id !== null)
            .sort();
        expect(ids).toEqual(['main', 'sub/nested']);
        expect(scenePath('sub/nested')).toBe('content/scenes/sub/nested.scene.json');
        expect(sceneIdFromPath('content/scenes/notascene.txt')).toBeNull();
    });

    it('reads scene JSON + a model bin by root-relative path', async () => {
        const fs = openNodeFs(root);
        expect(dec.decode(await fs.read('content/scenes/main.scene.json'))).toBe('{"main":true}');
        expect([...(await fs.read('resources/server/models/m.bin'))]).toEqual([1, 2, 3]);
    });

    it('write + remove round-trip (edit-host path)', async () => {
        const fs = openNodeFs(root);
        await fs.write('content/scenes/created.scene.json', new TextEncoder().encode('{"x":1}'));
        expect(dec.decode(await fs.read('content/scenes/created.scene.json'))).toBe('{"x":1}');
        await fs.remove('content/scenes/created.scene.json');
        await expect(fs.read('content/scenes/created.scene.json')).rejects.toThrow();
    });

    it('list of a missing dir is empty, not a throw', async () => {
        const fs = openNodeFs(root);
        expect(await fs.list('content/nope', { recursive: true })).toEqual([]);
    });
});
