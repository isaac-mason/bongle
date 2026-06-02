import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrate';

export type UpgradeOptions = {
    /** Skip the install step. */
    skipInstall?: boolean;
    /** Skip the content migrate step. */
    skipMigrate?: boolean;
};

// bongle is shipped via `github:isaac-mason/bongle#main` rather than npm,
// so "upgrade" just means: re-resolve the github tarball and let the
// project's package manager refetch it. The dep spec in package.json
// stays as-is — `#main` already names a moving target.
export async function upgrade(projectDir: string, opts: UpgradeOptions = {}) {
    const resolved = path.resolve(projectDir);
    const pkgFile = path.join(resolved, 'package.json');

    if (!fs.existsSync(pkgFile)) {
        console.error(`[bongle] no package.json at ${pkgFile}`);
        process.exit(1);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    if (!pkg.dependencies?.bongle) {
        console.error('[bongle] this project does not depend on `bongle`');
        process.exit(1);
    }

    if (!opts.skipInstall) {
        const pm = detectPackageManager(resolved);
        const args = upgradeArgs(pm);
        console.log(`[bongle] ${pm} ${args.join(' ')}`);
        const result = spawnSync(pm, args, { cwd: resolved, stdio: 'inherit' });
        if (result.status !== 0) {
            console.error(`[bongle] ${pm} upgrade failed`);
            process.exit(result.status ?? 1);
        }
    }

    if (!opts.skipMigrate) {
        await migrate(resolved);
    }
}

function upgradeArgs(pm: 'pnpm' | 'npm' | 'yarn' | 'bun'): string[] {
    // each PM has its own "refetch + update lockfile" verb; for a github
    // tarball spec this is what actually pulls in newer HEAD commits.
    switch (pm) {
        case 'pnpm': return ['update', 'bongle'];
        case 'npm':  return ['update', 'bongle'];
        case 'yarn': return ['up', 'bongle'];
        case 'bun':  return ['update', 'bongle'];
    }
}

function detectPackageManager(cwd: string): 'pnpm' | 'npm' | 'yarn' | 'bun' {
    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
    const ua = process.env.npm_config_user_agent ?? '';
    if (ua.startsWith('pnpm')) return 'pnpm';
    if (ua.startsWith('yarn')) return 'yarn';
    if (ua.startsWith('bun')) return 'bun';
    return 'npm';
}
