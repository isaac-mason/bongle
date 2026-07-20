// editor/ui/apps.tsx — the desktop's file-opening "programs". Each app claims a
// set of file extensions and renders a file in its own window. Opening a file
// in the tree routes to the app that handles its extension (via `openPath`),
// falling back to a code-editor tab. Launching is dynamic (one window per
// file) — see the launched store.

import { File, Image, Music, Paintbrush } from "../../icons";
import type { ReactNode } from 'react';
import type { Filesystem } from '../fs';
import { useBlockbench } from '../stores/blockbench';
import { MAIN_PANE, useEditor } from '../stores/editor';
import { useLaunched } from '../stores/launched';
import { useSystemWindows } from '../stores/system-windows';
import { AUDIO_EXTS } from './audio-mime';
import { AudioPlayer } from './components/AudioPlayer';
import { Blockbench } from './components/Blockbench';
import { ImageEditor } from './components/ImageEditor';
import { ImageViewer } from './components/ImageViewer';
import { MarkdownView } from './components/MarkdownView';

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
    /** singleton apps get ONE window (keyed by app id) and manage multiple files
     *  themselves — e.g. Blockbench with its own tabs. Opening a file focuses the
     *  single window; the app receives the path out-of-band (see `openPath`). */
    singleton?: boolean;
    /** the window body for a given file; `windowId` lets an app report state
     *  (e.g. unsaved) back to its window chrome. */
    render: (fs: Filesystem, path: string, windowId: string) => ReactNode;
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
    initial: { w: 660, h: 560 },
    render: (fs, path, windowId) => <ImageEditor fs={fs} path={path} windowId={windowId} />,
};

export const audioPlayerApp: AppDef = {
    id: 'audio-player',
    title: 'audio',
    glyph: <Music size={18} />,
    handles: AUDIO_EXTS,
    initial: { w: 380, h: 210 },
    render: (fs, path) => <AudioPlayer fs={fs} path={path} />,
};

export const markdownViewerApp: AppDef = {
    id: 'markdown-viewer',
    title: 'markdown',
    glyph: <File size={18} />,
    handles: ['md', 'markdown'],
    initial: { w: 720, h: 640 },
    // MarkdownView is `absolute inset-0` (built for the code editor's preview
    // pane); wrap it in a positioned, full-height box so it fills the WINDOW BODY
    // rather than the whole window (which would cover the draggable title bar).
    render: (fs, path) => (
        <div className="relative h-full">
            <MarkdownView fs={fs} path={path} />
        </div>
    ),
};

export const blockbenchApp: AppDef = {
    id: 'blockbench',
    title: 'blockbench',
    // the real Blockbench logo from the embedded static build (base-relative so it
    // resolves under the deployed /static/bongle-editor/ subpath too).
    glyph: <img src={`${import.meta.env.BASE_URL}static/blockbench/favicon.png`} alt="" className="h-[18px] w-[18px]" />,
    handles: ['bbmodel'],
    initial: { w: 960, h: 640 },
    singleton: true,
    render: (fs, _path, windowId) => <Blockbench fs={fs} windowId={windowId} />,
};

export const APPS: AppDef[] = [imageViewerApp, imageEditorApp, audioPlayerApp, markdownViewerApp, blockbenchApp];

/** the app that opens this extension, or null → the code editor. */
export function appForFile(path: string): AppDef | null {
    const dot = path.lastIndexOf('.');
    const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    return APPS.find((a) => a.handles.includes(ext)) ?? null;
}

export function appById(id: string): AppDef | undefined {
    return APPS.find((a) => a.id === id);
}

/** force a file into the code editor as text, regardless of its default app —
 *  e.g. inspect a .bbmodel's JSON. This is `openPath`'s fallback, exposed so the
 *  tree's "Open in code editor" action can override the extension routing. */
export function openInCode(path: string, pane: string): void {
    useEditor.getState().open(pane, path);
    // the main pane lives in the closable 'code' system window; opening a file
    // while it's closed would drop the tab into an invisible window, so reopen
    // (+ raise) it. Torn-off panes render their own always-visible windows.
    if (pane === MAIN_PANE) useSystemWindows.getState().open('code');
}

/** open a file from a pane's tree: hand it to its app (own window), or open a
 *  code-editor tab in that pane's active group. */
export function openPath(path: string, pane: string): void {
    const app = appForFile(path);
    if (app) {
        useLaunched.getState().launch(app, path);
        // singleton apps manage their own files; hand the path over out-of-band
        // (only Blockbench is singleton today, so route to its store).
        if (app.singleton) useBlockbench.getState().open(path);
        return;
    }
    openInCode(path, pane);
}
