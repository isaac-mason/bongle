// editor/ui/apps.tsx — the desktop's file-opening "programs". Each app claims a
// set of file extensions and renders a file in its own window. Opening a file
// in the tree routes to the app that handles its extension (via `openPath`),
// falling back to a code-editor tab. Launching is dynamic (one window per
// file) — see the launched store.

import { Image, Music, Paintbrush } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Filesystem } from '../fs';
import { useLaunched } from '../stores/launched';
import { useOpenFile } from '../stores/open-file';
import { AUDIO_EXTS } from './audio-mime';
import { AudioPlayer } from './components/AudioPlayer';
import { ImageEditor } from './components/ImageEditor';
import { ImageViewer } from './components/ImageViewer';

export type AppDef = {
    /** stable app id; also the window-id prefix (`${id}:${path}`). */
    id: string;
    /** window-title prefix + taskbar tooltip. */
    title: string;
    /** taskbar / title-bar icon. */
    glyph: ReactNode;
    /** extensions (lowercase, no dot) this app opens from the file tree. */
    handles: string[];
    /** initial window size when launched. */
    initial: { w: number; h: number };
    /** the window body for a given file. */
    render: (fs: Filesystem, path: string) => ReactNode;
};

export const imageViewerApp: AppDef = {
    id: 'image-viewer',
    title: 'image',
    glyph: <Image size={18} />,
    handles: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'],
    initial: { w: 420, h: 380 },
    render: (fs, path) => <ImageViewer fs={fs} path={path} />,
};

export const imageEditorApp: AppDef = {
    id: 'image-editor',
    title: 'paint',
    glyph: <Paintbrush size={18} />,
    handles: [], // launched from the viewer's "edit" button, not opened from the tree.
    initial: { w: 540, h: 620 },
    render: (fs, path) => <ImageEditor fs={fs} path={path} />,
};

export const audioPlayerApp: AppDef = {
    id: 'audio-player',
    title: 'audio',
    glyph: <Music size={18} />,
    handles: AUDIO_EXTS,
    initial: { w: 380, h: 210 },
    render: (fs, path) => <AudioPlayer fs={fs} path={path} />,
};

export const APPS: AppDef[] = [imageViewerApp, imageEditorApp, audioPlayerApp];

/** the app that opens this extension, or null → the code editor. */
export function appForFile(path: string): AppDef | null {
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    return APPS.find((a) => a.handles.includes(ext)) ?? null;
}

export function appById(id: string): AppDef | undefined {
    return APPS.find((a) => a.id === id);
}

/** open a file from the tree: hand it to its app, or a code-editor tab. */
export function openPath(path: string): void {
    const app = appForFile(path);
    if (app) {
        useLaunched.getState().launch(app, path);
        return;
    }
    useOpenFile.getState().open(path);
}
