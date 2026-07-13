// editor/ui/components/FileTree.tsx — VSCode-style project tree. Collapsible
// folders, click a file to open it: images (etc.) launch their app, everything
// else opens a code-editor tab (see `openPath`). The active code tab is
// highlighted and unsaved files show a dirty dot (shared open-file store).

import { useEffect, useMemo, useState } from 'react';
import type { Filesystem, FsStat } from '../../fs';
import { useOpenFile } from '../../stores/open-file';
import { openPath } from '../apps';

type TreeNode = { name: string; path: string; kind: 'file' | 'dir'; children: TreeNode[] };

function buildTree(files: FsStat[]): TreeNode[] {
    const root: TreeNode = { name: '', path: '', kind: 'dir', children: [] };
    const dirs = new Map<string, TreeNode>([['', root]]);
    const ensureDir = (path: string): TreeNode => {
        const existing = dirs.get(path);
        if (existing) return existing;
        const idx = path.lastIndexOf('/');
        const parent = ensureDir(idx === -1 ? '' : path.slice(0, idx));
        const node: TreeNode = { name: path.split('/').pop() ?? path, path, kind: 'dir', children: [] };
        parent.children.push(node);
        dirs.set(path, node);
        return node;
    };
    for (const f of files) {
        if (f.kind === 'dir') {
            ensureDir(f.path);
            continue;
        }
        const parent = f.path.includes('/') ? ensureDir(f.path.slice(0, f.path.lastIndexOf('/'))) : root;
        parent.children.push({ name: f.path.split('/').pop() ?? f.path, path: f.path, kind: 'file', children: [] });
    }
    const sort = (n: TreeNode): void => {
        n.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
        n.children.forEach(sort);
    };
    sort(root);
    return root.children;
}

export function FileTree({ fs }: { fs: Filesystem }) {
    const [files, setFiles] = useState<FsStat[]>([]);

    useEffect(() => {
        let alive = true;
        const refresh = () =>
            fs.list('', { recursive: true }).then((f) => {
                if (alive) setFiles(f);
            });
        void refresh();
        const w = fs.watch(() => void refresh());
        return () => {
            alive = false;
            w.close();
        };
    }, [fs]);

    const tree = useMemo(() => buildTree(files), [files]);

    return (
        <div style={{ padding: '6px 0', font: '12px/1.7 ui-monospace, monospace', userSelect: 'none' }}>
            {tree.length === 0 ? (
                <span style={{ color: '#888', paddingLeft: 8 }}>(empty)</span>
            ) : (
                tree.map((n) => <Node key={n.path} node={n} depth={0} />)
            )}
        </div>
    );
}

function Node({ node, depth }: { node: TreeNode; depth: number }) {
    const [open, setOpen] = useState(true);
    const active = useOpenFile((s) => s.active === node.path);
    const dirty = useOpenFile((s) => !!s.dirty[node.path]);

    const pad = 8 + depth * 12;

    if (node.kind === 'dir') {
        return (
            <div>
                <div
                    onClick={() => setOpen((o) => !o)}
                    style={{ paddingLeft: pad, cursor: 'pointer', whiteSpace: 'nowrap', color: '#555' }}
                >
                    {open ? '▾' : '▸'} {node.name}
                </div>
                {open && node.children.map((c) => <Node key={c.path} node={c} depth={depth + 1} />)}
            </div>
        );
    }

    return (
        <div
            onClick={() => openPath(node.path)}
            style={{
                paddingLeft: pad + 12,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                background: active ? '#000' : 'transparent',
                color: active ? '#fff' : '#000',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
            }}
        >
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
            {dirty && <span style={{ color: active ? '#fff' : '#000' }}>●</span>}
        </div>
    );
}
