// lib/editor/fs-open.ts — opens the editor's working `Filesystem`, preferring OPFS
// and falling back to IndexedDB where OPFS is blocked. Every editor context (main
// thread + the bundler / pipeline / server / build workers) opens the project fs
// through here, so the fallback is uniform across the whole stack.
//
// Why the fallback: Firefox denies OPFS (navigator.storage.getDirectory throws
// SecurityError) in private windows and under strict storage settings, which would
// otherwise hang boot. It still provides IndexedDB in those contexts, so we drop to
// the IDB-backed fs — same async contract, ephemeral where OPFS was ephemeral
// anyway (the cloud project_version is the durable store). Only when BOTH are
// blocked (storage fully off) do we surface an actionable error instead of hanging.

import type { Filesystem } from './fs';
import { openIdbFilesystem } from './fs-idb';
import { openOpfsFilesystem } from './fs-opfs';

export async function openProjectFilesystem(projectName: string): Promise<Filesystem> {
    try {
        return await openOpfsFilesystem(projectName);
    } catch (opfsErr) {
        try {
            const fs = await openIdbFilesystem(projectName);
            console.warn('[fs] OPFS unavailable — using the IndexedDB fallback.', opfsErr);
            return fs;
        } catch (idbErr) {
            throw new Error(
                'This browser is blocking the storage the editor needs to run. Exit private browsing or lower tracking protection for this site and reload, or try Chrome.',
                { cause: idbErr },
            );
        }
    }
}
