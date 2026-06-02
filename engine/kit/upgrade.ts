import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './migrate';

export type UpgradeOptions = {
    /** Pin to this version instead of fetching `latest` from npm. */
    version?: string;
    /** Skip the install step after rewriting package.json. */
    skipInstall?: boolean;
    /** Skip the content migrate step. */
    skipMigrate?: boolean;
};

export async function upgrade(projectDir: string, opts: UpgradeOptions = {}) {
    const resolved = path.resolve(projectDir);
    const pkgFile = path.join(resolved, 'package.json');

    if (!fs.existsSync(pkgFile)) {
        console.error(`[bongle] no package.json at ${pkgFile}`);
        process.exit(1);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const deps = pkg.dependencies ?? {};

    if (!deps.bongle) {
        console.error('[bongle] this project does not depend on `bongle`');
        process.exit(1);
    }

    const target = opts.version ?? (await fetchLatestVersion('bongle'));
    if (deps.bongle === target) {
        console.log(`[bongle] already on ${target}`);
    } else {
        console.log(`[bongle] ${deps.bongle} → ${target}`);
        deps.bongle = target;
        pkg.dependencies = deps;
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 4) + '\n');
    }

    if (!opts.skipInstall) {
        const pm = detectPackageManager(resolved);
        console.log(`[bongle] installing with ${pm}...`);
        const result = spawnSync(pm, ['install'], { cwd: resolved, stdio: 'inherit' });
        if (result.status !== 0) {
            console.error(`[bongle] ${pm} install failed`);
            process.exit(result.status ?? 1);
        }
    }

    if (!opts.skipMigrate) {
        await migrate(resolved);
    }
}

async function fetchLatestVersion(name: string): Promise<string> {
    const url = `https://registry.npmjs.org/${name}/latest`;
    const res = await fetch(url);
    if (!res.ok) {
        console.error(`[bongle] failed to fetch ${url}: ${res.status} ${res.statusText}`);
        process.exit(1);
    }
    const data = (await res.json()) as { version: string };
    return data.version;
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
