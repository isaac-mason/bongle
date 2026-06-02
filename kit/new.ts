import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type NewOptions = {
    /** Skip running the install step after copying. */
    skipInstall?: boolean;
    /** Override the template name (default: "default"). */
    template?: string;
};

export async function newProject(targetDir: string, opts: NewOptions = {}) {
    const target = path.resolve(targetDir);
    const projectName = path.basename(target);
    const templateName = opts.template ?? 'default';

    // templates ship next to kit/ — kit/../templates/<name>.
    const kitDir = path.dirname(fileURLToPath(import.meta.url));
    const templateDir = path.join(kitDir, '..', 'templates', templateName);

    if (!fs.existsSync(templateDir)) {
        console.error(`[bongle] unknown template: ${templateName}`);
        process.exit(1);
    }

    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
        console.error(`[bongle] target directory not empty: ${target}`);
        process.exit(1);
    }

    fs.mkdirSync(target, { recursive: true });
    copyTree(templateDir, target);

    rewritePackageJson(path.join(target, 'package.json'), projectName);

    console.log(`[bongle] created ${path.relative(process.cwd(), target) || '.'}`);

    if (!opts.skipInstall) {
        const pm = detectPackageManager();
        console.log(`[bongle] installing with ${pm}...`);
        const result = spawnSync(pm, ['install'], { cwd: target, stdio: 'inherit' });
        if (result.status !== 0) {
            console.error(`[bongle] ${pm} install failed`);
            process.exit(result.status ?? 1);
        }
    }

    console.log('');
    console.log('Next steps:');
    console.log(`  cd ${path.relative(process.cwd(), target) || '.'}`);
    if (opts.skipInstall) console.log('  (run your package manager install)');
    console.log('  bongle edit');
}

function copyTree(src: string, dst: string) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        // npm strips `.gitignore` during pack; template ships it as
        // `_gitignore` and we rename on copy.
        const toName = entry.name === '_gitignore' ? '.gitignore' : entry.name;
        const to = path.join(dst, toName);
        if (entry.isDirectory()) {
            fs.mkdirSync(to, { recursive: true });
            copyTree(from, to);
        } else {
            fs.copyFileSync(from, to);
        }
    }
}

function rewritePackageJson(file: string, projectName: string) {
    const raw = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, raw.replace('__PROJECT_NAME__', projectName));
}

function detectPackageManager(): 'pnpm' | 'npm' | 'yarn' | 'bun' {
    const ua = process.env.npm_config_user_agent ?? '';
    if (ua.startsWith('pnpm')) return 'pnpm';
    if (ua.startsWith('yarn')) return 'yarn';
    if (ua.startsWith('bun')) return 'bun';
    return 'npm';
}
