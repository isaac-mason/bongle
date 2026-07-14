// editor/upload.ts — read OS drag-and-drop / file-picker uploads into a flat list
// of { relative path, bytes }, recursing any dropped folders. Consumed by the
// file tree's upload paths (drag-in + right-click "Upload").

export type UploadFile = { relPath: string; data: Uint8Array };

const toData = async (file: File): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());

/** a flat file picker (`<input type=file multiple>`) selection → uploads. */
export async function readFileList(list: FileList): Promise<UploadFile[]> {
    return Promise.all([...list].map(async (f) => ({ relPath: f.name, data: await toData(f) })));
}

/** a drag-and-drop DataTransfer → uploads. Uses the entries API so dropped
 *  FOLDERS recurse into their files (relPath keeps the subtree), falling back to
 *  the flat file list where entries aren't available. MUST be called
 *  synchronously in the drop handler (the items are only live during the event). */
export async function readDataTransfer(dt: DataTransfer): Promise<UploadFile[]> {
    // capture entries synchronously — the item list is invalid after the event.
    const entries = [...dt.items]
        .filter((it) => it.kind === 'file')
        .map((it) => it.webkitGetAsEntry?.() ?? null)
        .filter((e): e is FileSystemEntry => e != null);
    if (entries.length === 0) return dt.files ? readFileList(dt.files) : [];
    const out: UploadFile[] = [];
    await Promise.all(entries.map((e) => walk(e, '', out)));
    return out;
}

async function walk(entry: FileSystemEntry, prefix: string, out: UploadFile[]): Promise<void> {
    if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        out.push({ relPath: prefix + entry.name, data: await toData(file) });
    } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (const child of await readEntries(reader)) await walk(child, `${prefix}${entry.name}/`, out);
    }
}

/** readEntries yields children in batches; drain until it returns empty. */
function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => {
        const all: FileSystemEntry[] = [];
        const next = (): void =>
            reader.readEntries((batch) => {
                if (batch.length === 0) resolve(all);
                else {
                    all.push(...batch);
                    next();
                }
            }, reject);
        next();
    });
}
