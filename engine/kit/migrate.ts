import fs from 'node:fs';
import path from 'node:path';
import { checkContent, migrateContent } from './migrations';

export type MigrateOptions = { check?: boolean };

export async function migrate(projectDir: string, opts: MigrateOptions = {}) {
    const resolved = path.resolve(projectDir);

    if (!fs.existsSync(resolved)) {
        console.error(`Project directory does not exist: ${resolved}`);
        process.exit(1);
    }

    if (opts.check) {
        const behind = checkContent(resolved);
        if (behind.length === 0) {
            console.log('content is up to date');
            return;
        }
        console.error(`content out of date (${behind.length} file(s)):`);
        for (const m of behind) {
            console.error(`  ${path.relative(resolved, m.file)}: v${m.from} → v${m.to}`);
        }
        console.error('run `bongle migrate` to update.');
        process.exit(1);
    }

    const migrated = migrateContent(resolved);
    if (migrated.length === 0) {
        console.log('content is up to date');
        return;
    }
    for (const m of migrated) {
        console.log(`  ${path.relative(resolved, m.file)}: v${m.from} → v${m.to}`);
    }
    console.log(`migrated ${migrated.length} file(s).`);
}
