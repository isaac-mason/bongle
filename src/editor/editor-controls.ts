import type { ControlMode } from './edit-room-store';

export type EditorControlMode = ControlMode;

export const TRANSFORM_GIZMO_KEYS = {
    translate: 'KeyT',
    rotate: 'KeyR',
    scale: 'KeyY',
    place: 'KeyU',
    grab: 'KeyI',
} as const;

export const TRANSFORM_OTHER_KEYS = {
    toggleSpace: 'KeyX',
    commit: 'Enter', // placement mode only
    cancel: 'Escape', // placement mode + normal
    returnToInspect: 'Escape',
} as const;

export const SELECTION_KEYS = {
    fill: 'KeyF',
    replace: 'Shift+KeyF',
    delete: 'Backspace',
    pick: 'KeyP',
    clearAll: 'KeyR',
    /** works in every tool, unlike `clearAll`, and unlike Escape it survives pointer lock, which the browser eats. */
    deselect: 'KeyQ',
} as const;

export const NUDGE_KEYS = {
    forward: 'ArrowUp',
    backward: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    up: 'BracketRight', // ]
    down: 'BracketLeft', // [
} as const;

export const INSPECT_KEYS = {
    toTranslate: 'KeyT',
    toRotate: 'KeyR',
    toScale: 'KeyY',
} as const;

export const LIBRARY_KEYS = {
    toggleLibrary: 'KeyE',
} as const;

/** cycles the camera control mode: fly -> orbit -> character -> fly. */
export const CONTROL_MODE_KEYS = {
    cycle: 'KeyM',
} as const;

// hold a category key + tap digit 1..9 to jump to a slot in that category; tap-alone cycles through tools.
export const TOOL_CATEGORY_KEYS = {
    inspect: 'KeyV',
    transform: 'KeyG',
    select: 'KeyC',
    build: 'KeyB',
} as const;

export type ToolCategoryId = keyof typeof TOOL_CATEGORY_KEYS;

// digit codes 1..9 map to hotbar slot indices 0..8
export const HOTBAR_NUMBER_KEYS = [
    'Digit1',
    'Digit2',
    'Digit3',
    'Digit4',
    'Digit5',
    'Digit6',
    'Digit7',
    'Digit8',
    'Digit9',
] as const;

export function formatKeyLabel(code: string): string {
    if (code.startsWith('Shift+')) return `⇧${formatKeyLabel(code.slice(6))}`;
    if (code.startsWith('Alt+')) return `⌥${formatKeyLabel(code.slice(4))}`;
    if (code.startsWith('Mod+')) return `⌘${formatKeyLabel(code.slice(4))}`;
    const labels: Record<string, string> = {
        KeyQ: 'Q',
        KeyT: 'T',
        KeyY: 'Y',
        KeyX: 'X',
        KeyP: 'P',
        KeyR: 'R',
        KeyF: 'F',
        KeyG: 'G',
        KeyH: 'H',
        KeyU: 'U',
        KeyI: 'I',
        KeyV: 'V',
        KeyM: 'M',
        KeyB: 'B',
        KeyC: 'C',
        KeyA: 'A',
        Backspace: '⌫',
        Enter: '↵',
        Escape: 'esc',
        ArrowUp: '↑',
        ArrowDown: '↓',
        ArrowLeft: '←',
        ArrowRight: '→',
        BracketRight: ']',
        BracketLeft: '[',
    };
    return labels[code] ?? code.replace('Key', '');
}

export type KeybindGroup = {
    key: string;
    label: string;
    mode?: string;
};

export const EDITOR_KEYBINDINGS: Record<string, KeybindGroup[]> = {
    'tool categories': [
        { key: TOOL_CATEGORY_KEYS.inspect, label: 'inspect' },
        { key: TOOL_CATEGORY_KEYS.transform, label: 'transform' },
        { key: TOOL_CATEGORY_KEYS.select, label: 'select (box/magic)' },
        { key: TOOL_CATEGORY_KEYS.build, label: 'build (build/paint)' },
        { key: 'hold + 1-9', label: 'jump to slot in category' },
    ],
    'transform gizmo': [
        { key: TRANSFORM_GIZMO_KEYS.translate, label: 'translate' },
        { key: TRANSFORM_GIZMO_KEYS.rotate, label: 'rotate' },
        { key: TRANSFORM_GIZMO_KEYS.scale, label: 'scale' },
        { key: TRANSFORM_GIZMO_KEYS.grab, label: 'grab' },
    ],
    transform: [
        { key: 'mode key again', label: 'drag from cursor (click commits, Esc cancels)' },
        { key: 'X / Y / Z', label: 'axis lock while dragging (Shift = plane)' },
        { key: 'hold ctrl/cmd', label: 'flip snapping while dragging' },
        { key: TRANSFORM_OTHER_KEYS.toggleSpace, label: 'world/local' },
    ],
    selection: [
        { key: SELECTION_KEYS.deselect, label: 'deselect (any tool)' },
        { key: 'Mod+Shift+KeyA', label: 'deselect' },
        { key: SELECTION_KEYS.fill, label: 'fill' },
        { key: SELECTION_KEYS.replace, label: 'replace' },
        { key: SELECTION_KEYS.delete, label: 'delete' },
        { key: SELECTION_KEYS.pick, label: 'pick' },
    ],
    nudge: [
        { key: NUDGE_KEYS.forward, label: 'fwd' },
        { key: NUDGE_KEYS.backward, label: 'back' },
        { key: NUDGE_KEYS.left, label: 'left' },
        { key: NUDGE_KEYS.right, label: 'right' },
        { key: NUDGE_KEYS.up, label: 'up' },
        { key: NUDGE_KEYS.down, label: 'down' },
    ],
    inspect: [
        { key: INSPECT_KEYS.toTranslate, label: '→ translate' },
        { key: INSPECT_KEYS.toRotate, label: '→ rotate' },
        { key: INSPECT_KEYS.toScale, label: '→ scale' },
    ],
    library: [
        { key: LIBRARY_KEYS.toggleLibrary, label: 'open/close library' },
        { key: '1-9', label: 'hotbar slot' },
        { key: 'wheel', label: 'cycle slots (build tool)' },
    ],
    camera: [{ key: CONTROL_MODE_KEYS.cycle, label: 'cycle control mode (fly/orbit/character)' }],
};
