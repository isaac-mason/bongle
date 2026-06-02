import fs from 'node:fs';
import path from 'node:path';
import { migrateScene, SCENE_LATEST } from './scene';

/** A file that needs (or has had) its schema bumped. */
export type Migration = { file: string; from: number; to: number };

/** Read-only pass. Returns files behind latest; does not touch disk. */
export function checkContent(projectDir: string): Migration[] {
    return walk(projectDir, false);
}

/** Read-and-rewrite pass. Returns files that were actually rewritten. */
export function migrateContent(projectDir: string): Migration[] {
    return walk(projectDir, true);
}

function walk(projectDir: string, write: boolean): Migration[] {
    const contentDir = path.join(projectDir, 'content');
    const out: Migration[] = [];
    if (!fs.existsSync(contentDir)) return out;
    walkDir(contentDir, write, out);
    return out;
}

function walkDir(dir: string, write: boolean, out: Migration[]): void {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walkDir(full, write, out); continue; }

        // Dispatch by extension. Each kind is one explicit case — no
        // registry. New content kinds add a new case here + a sibling
        // <kind>.ts. Inline the read/migrate/write per case until a
        // second kind shows up — extract a helper from two concrete
        // examples, not one.
        // TODO: prefabs, particles when persisted.
        if (ent.name.endsWith('.scene.json')) {
            const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
            const before = (raw && typeof raw.version === 'number') ? raw.version : 0;
            if (before === SCENE_LATEST) continue;
            const next = migrateScene(raw);
            if (write) {
                fs.writeFileSync(full, JSON.stringify(next, null, 2) + '\n');
            }
            out.push({ file: full, from: before, to: next.version as number });
        }
    }
}
