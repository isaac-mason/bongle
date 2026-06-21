import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Icons from 'lucide-react';
import { setEditorEnabledForRoom } from '../../client/editor';
import { useClient } from '../../client/ui/client-store';
import '../../client/ui/editor.css';
import { Viewport } from '../../client/ui/viewport';
import { useEditor } from '../editor-store';
import { useEditRoom } from '../edit-room-store';
import { ChatPanel, useChatPanel } from '../../client/ui/chat-panel';
import { FlySpeedIndicator } from './fly-speed-indicator';
import { Hotbar } from './hotbar';
import { InventoryItemIcon } from './inventory-icon';
import { LeftToolbar } from './left-toolbar';
import { LibraryOverlay } from './library';
import { OrientationCube } from './orientation-cube';
import { RightPanel } from './right-panel';
import { ToastStack } from './toast-stack';
import { ToolActions } from './tool-actions';
import { TopToolbar } from './top-toolbar';
import { ViewportContextMenu } from './viewport-context-menu';

const DebugPanel = lazy(() => import('../../client/ui/debug-panel'));

function isInputFocused(): boolean {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable;
}

// renders the in-progress lasso stroke as an SVG polyline over the canvas.
// the stroke is captured in NDC (x,y ∈ [-1, 1], y up). we use a
// non-uniformly-scaled SVG viewbox (0..100 in both axes) so the polyline
// stretches with the viewport — pixel-perfect alignment with the drawn
// path because the lasso tool's hit-test is done in NDC too.
function LassoOverlay() {
    const points = useEditRoom((s) => s.lasso?.points ?? null);
    if (!points || points.length < 2) return null;
    const path = points.map(([x, y]) => `${50 + x * 50},${50 - y * 50}`).join(' ');
    return (
        <svg
            className="absolute inset-0 pointer-events-none z-20"
            width="100%"
            height="100%"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
        >
            <title>lasso selection</title>
            <polyline
                points={path}
                fill="rgba(96, 165, 250, 0.12)"
                stroke="rgb(96, 165, 250)"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

// simple crosshair shown when in character (first-person) control mode
function Crosshair() {
    return (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-20">
            <div className="relative w-4 h-4">
                {/* horizontal bar */}
                <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 bg-white opacity-80 mix-blend-difference" />
                {/* vertical bar */}
                <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-white opacity-80 mix-blend-difference" />
            </div>
        </div>
    );
}

// fly / orbit / character control mode toggle — floats top-right inside canvas
function ControlModeWidget() {
    const controlMode = useEditRoom((s) => s.controlMode);
    const setControlMode = useEditRoom((s) => s.setControlMode);

    return (
        <div className="absolute top-2 right-2 z-10 pointer-events-auto">
            <div className="flex bg-white border border-neutral-200 rounded-sm shadow-sm text-xs overflow-hidden">
                <button
                    type="button"
                    className={`px-2 py-1.5 ${controlMode === 'fly' ? 'bg-neutral-800 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
                    onClick={() => setControlMode('fly')}
                    title="fly"
                >
                    <Icons.Send size={14} />
                </button>
                <button
                    type="button"
                    className={`px-2 py-1.5 ${controlMode === 'orbit' ? 'bg-neutral-800 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
                    onClick={() => setControlMode('orbit')}
                    title="orbit"
                >
                    <Icons.Orbit size={14} />
                </button>
                <button
                    type="button"
                    className={`px-2 py-1.5 ${controlMode === 'character' ? 'bg-neutral-800 text-white' : 'text-neutral-600 hover:bg-neutral-100'}`}
                    onClick={() => setControlMode('character')}
                    title="character"
                >
                    <Icons.PersonStanding size={14} />
                </button>
            </div>
        </div>
    );
}

/**
 * root editor layout.
 *
 *   ┌─────────────────────────────────────────┐
 *   │  TopToolbar                             │
 *   ├────┬────────────────────────────┬───────┤
 *   │Left│                            │ Right │
 *   │bar │   canvas viewport          │ panel │
 *   │    │   (ToolActions overlay)    │       │
 *   │    │   (ControlMode overlay)    │       │
 *   └────┴────────────────────────────┴───────┘
 *
 * left toolbar and right panel are normal flex siblings — they shrink the
 * actual 3d viewport. overlays (ToolActions, ControlModeWidget, DebugPanel,
 * Crosshair) are absolute-positioned inside the canvas container.
 */
const RIGHT_PANEL_MIN = 180;
const RIGHT_PANEL_MAX = 600;
const RIGHT_PANEL_DEFAULT = 350;

function EditUI() {
    const editorEnabled = useEditor((s) => {
        if (!s.room) return false;
        if (!s.playerEditStores[s.room.playerId]) return false;
        // no lens → the editor script is on the player node itself, so the
        // player POV *is* the editor POV. with a lens, only the 'edit' POV
        // exposes the UI; switching to 'play' POV keeps the lens warm but
        // hides editor chrome.
        if (!s.room.editor) return true;
        return s.playerToView.get(s.room.playerId) === 'edit';
    });
    const controlMode = useEditRoom((s) => s.controlMode);
    const showOrientationCube = useEditRoom((s) => s.showOrientationCube);
    const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_DEFAULT);

    const onRightPanelResize = useCallback((dx: number) => {
        setRightPanelWidth((w) => Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, w + dx)));
    }, []);

    const debugOpen = useClient((s) => s.debugOpen);
    const debugTab = useClient((s) => s.debugTab);

    // global editor hotkeys — must work at the DOM layer because the editor
    // script's per-frame onInput hook only fires when the editor module is
    // active for the room. shift+` toggles the editor UI; TAB toggles
    // play/stop on the active room.
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            // undo/redo routes to the active edit-room history here, at the DOM
            // layer, so cmd/ctrl+z works even while a tool-option input (brush
            // size, pattern, …) holds focus — preventDefault stops the field's
            // native text-undo. handled before the isInputFocused bail for that
            // reason; the game-loop input path leaves mod combos to us.
            if (e.metaKey || e.ctrlKey) {
                const key = e.key.toLowerCase();
                if (key === 'z' || key === 'y') {
                    e.preventDefault();
                    const { room, playerEditStores } = useEditor.getState();
                    const store = room ? playerEditStores[room.playerId] : null;
                    if (store) {
                        if (key === 'y' || e.shiftKey) store.getState().redo();
                        else store.getState().undo();
                    }
                } else if (key === 's') {
                    const { room, roomMode, sceneId, playerEditStores } = useEditor.getState();
                    if (roomMode === 'edit' && room && sceneId) {
                        e.preventDefault();
                        playerEditStores[room.playerId]?.getState().save(sceneId);
                    }
                }
                return;
            }

            if (isInputFocused()) return;

            // plain backtick toggles the debug panel. in EDIT rooms the editor's
            // onInput chord owns it (tap = toggle, hold+digit = switch tab); that
            // input loop runs for edit players only, so play rooms toggle here.
            if (e.key === '`' && !e.shiftKey && useEditor.getState().roomMode === 'play') {
                e.preventDefault();
                useClient.getState().toggleDebugOpen();
                return;
            }

            if (e.key === '`' && e.shiftKey) {
                e.preventDefault();
                const { room, playerEditStores, playerToView } = useEditor.getState();
                if (!room) return;
                const scriptAlive = !!playerEditStores[room.playerId];
                const editPov = !room.editor || playerToView.get(room.playerId) === 'edit';
                setEditorEnabledForRoom(room, !(scriptAlive && editPov));
                return;
            }

            if (e.key === 'Tab') {
                const { room, roomMode, stopRoom } = useEditor.getState();
                if (!room) return;
                e.preventDefault();
                if (roomMode === 'edit') {
                    room.editorStore?.getState().play();
                } else if (roomMode === 'play') {
                    stopRoom(room.roomId);
                }
            }

            // in edit mode, Enter is reserved for inline editing affordances
            // (rename, accept) — only `/` opens chat. in play mode either key
            // works.
            const { roomMode } = useEditor.getState();
            const opensChat = e.key === '/' || (e.key === 'Enter' && roomMode !== 'edit');
            if (opensChat && !useChatPanel.getState().isOpen) {
                e.preventDefault();
                useChatPanel.getState().open({ seed: e.key === '/' ? '/' : '' });
            }
        }
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    return (
        <div className="fixed inset-0 flex flex-col">
            <TopToolbar />

            {/* content area — fills remaining height */}
            <div className="flex-1 flex flex-row overflow-hidden">
                {/* left tool strip */}
                {editorEnabled && <LeftToolbar />}

                {/* canvas viewport — flex-1 so it fills whatever space is left */}
                <div className="flex-1 relative overflow-hidden flex flex-col">
                    <Viewport />

                    {/* debug panel — ` toggles open; top tab strip switches
                        view. 'renderer' tab surfaces the gpucat Inspector
                        overlay (toggled in engine-client.ts) so the panel
                        body is empty in that mode. Whole panel rides a lazy
                        chunk — Suspense renders nothing while it loads. */}
                    {debugOpen && (
                        <Suspense fallback={null}>
                            <DebugPanel tab={debugTab} />
                        </Suspense>
                    )}

                    {/* crosshair — character (fp) mode only */}
                    {controlMode === 'character' && <Crosshair />}

                    {/* in-canvas overlays — editor-enabled rooms only */}
                    {editorEnabled && (
                        <>
                            {/* in-progress lasso stroke */}
                            <LassoOverlay />

                            {/* right-click context menu over the viewport (opened from inspect tool) */}
                            <ViewportContextMenu />

                            {/* HMR / status toasts — top-left, above ToolActions */}
                            <ToastStack />

                            {/* tool-aware action buttons — top-left, below toasts */}
                            <ToolActions />

                            {/* control mode widget — top-right */}
                            <ControlModeWidget />

                            {/* fly-speed indicator — fades in/out on scroll change */}
                            <FlySpeedIndicator />

                            {/* orientation cube — bottom-left, gated by debug pane checkbox */}
                            {showOrientationCube && <OrientationCube />}

                            {/* hotbar — bottom-center */}
                            <Hotbar />

                            {/* library overlay — floating panel, conditional (E toggles) */}
                            <LibraryOverlay />
                        </>
                    )}

                    {/* chat / slash commands — bottom-left, opens on '/' or 't'.
                        rendered outside the editorEnabled gate so it works in
                        play mode too. */}
                    <ChatPanel />
                </div>

                {/* right panel */}
                {editorEnabled && <RightPanel width={rightPanelWidth} onResize={onRightPanelResize} />}
            </div>

            {/* carried-item cursor preview — follows mouse while picking up an inventory item */}
            {editorEnabled && <CarriedItemCursor />}
        </div>
    );
}

// floats the picked-up inventory item next to the cursor so the user can see
// what they're carrying. clears itself when the store's carriedItem goes null.
function CarriedItemCursor() {
    const carried = useEditRoom((s) => s.carriedItem);
    const setCarried = useEditRoom((s) => s.setCarriedItem);
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

    useEffect(() => {
        if (!carried) {
            setPos(null);
            return;
        }
        const onMove = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY });
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setCarried(null);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('keydown', onKey);
        };
    }, [carried, setCarried]);

    if (!carried || !pos) return null;
    return (
        <div
            className="fixed pointer-events-none z-50"
            style={{ left: pos.x + 12, top: pos.y + 12 }}
        >
            <div className="bg-white/90 rounded shadow-md border border-neutral-200 p-1">
                <InventoryItemIcon item={carried} size={32} />
            </div>
        </div>
    );
}

/**
 * Mount the editor UI shell into `container`. Called from
 * `bongle/engine-editor`'s `setup(state)`, which only the edit-mode boot
 * template imports — so this chunk only ships in editor builds.
 */
export function mountEditUI(container: HTMLElement): Root {
    const root = createRoot(container);
    root.render(<EditUI />);
    return root;
}

// keep these re-exports — script consumers and pane components import the
// stores from here for convenience (matches the prior `client/ui/ui.tsx`
// surface).
export { useEditor } from '../editor-store';
export { useEditRoom } from '../edit-room-store';
export { useClient } from '../../client/ui/client-store';
