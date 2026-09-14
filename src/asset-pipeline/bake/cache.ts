import type { Filesystem } from '../../../os/interface';

/** null if the file is missing, unreadable, or has no string hash field. */
export async function readArtifactHash(fs: Filesystem, filePath: string): Promise<string | null> {
    try {
        const json = JSON.parse(await fs.readText(filePath)) as { hash?: unknown };
        return typeof json.hash === 'string' ? json.hash : null;
    } catch {
        return null;
    }
}
