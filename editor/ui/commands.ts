// editor/ui/commands.ts — the command palette's action registry (Cmd/Ctrl+Shift+P).
//
// A command is a titled, categorised action with an optional availability guard.
// Adding one is a single entry here — `run` reaches runtime state through the
// stores (useEditor.getState() etc.) and the passed-in context. The palette
// (QuickPalette.tsx, command mode) filters by `when`, fuzzy-matches
// "category: title", and invokes `run` on accept.

import type { Filesystem } from '../fs';
import {
    formatActiveDocument,
    hasActiveEditor,
    hasActiveTsModel,
    organizeActiveImports,
    runEditorAction,
} from './components/Monaco';

export type CommandCtx = { fs: Filesystem };

export type Command = {
    /** stable id, also the palette list key. */
    id: string;
    /** primary label shown in the palette. */
    title: string;
    /** grouping label shown dimmed on the right (also fuzzy-matched). */
    category: string;
    /** availability gate — commands whose guard returns false are hidden. */
    when?: () => boolean;
    run: (ctx: CommandCtx) => void | Promise<void>;
};

/** a palette command that runs a built-in Monaco action on the focused editor —
 *  the multi-cursor / selection / line ops. Gated on an editor being focused;
 *  Monaco no-ops the mutating ones on read-only files. */
function editorAction(id: string, title: string, actionId: string): Command {
    return { id, title, category: 'Editor', when: hasActiveEditor, run: () => runEditorAction(actionId) };
}

export const COMMANDS: Command[] = [
    {
        id: 'editor.formatDocument',
        title: 'Format Document',
        category: 'Editor',
        when: hasActiveTsModel,
        run: () => formatActiveDocument(),
    },
    {
        id: 'editor.organizeImports',
        title: 'Organize Imports',
        category: 'Editor',
        when: hasActiveTsModel,
        run: () => organizeActiveImports(),
    },
    // selection / multi-cursor
    editorAction('editor.selectHighlights', 'Select All Occurrences of Find Match', 'editor.action.selectHighlights'),
    editorAction('editor.expandLineSelection', 'Expand Line Selection', 'expandLineSelection'),
    editorAction(
        'editor.addSelectionToNextFindMatch',
        'Add Selection to Next Find Match',
        'editor.action.addSelectionToNextFindMatch',
    ),
    editorAction('editor.selectAll', 'Select All', 'editor.action.selectAll'),
    // line ops
    editorAction('editor.moveLinesUp', 'Move Line Up', 'editor.action.moveLinesUpAction'),
    editorAction('editor.moveLinesDown', 'Move Line Down', 'editor.action.moveLinesDownAction'),
    editorAction('editor.copyLinesUp', 'Copy Line Up', 'editor.action.copyLinesUpAction'),
    editorAction('editor.copyLinesDown', 'Copy Line Down', 'editor.action.copyLinesDownAction'),
    editorAction('editor.deleteLines', 'Delete Line', 'editor.action.deleteLines'),
    editorAction('editor.indentLines', 'Indent Line', 'editor.action.indentLines'),
    editorAction('editor.outdentLines', 'Outdent Line', 'editor.action.outdentLines'),
    // comments
    editorAction('editor.commentLine', 'Toggle Line Comment', 'editor.action.commentLine'),
    editorAction('editor.blockComment', 'Toggle Block Comment', 'editor.action.blockComment'),
    // folding
    editorAction('editor.foldAll', 'Fold All', 'editor.foldAll'),
    editorAction('editor.unfoldAll', 'Unfold All', 'editor.unfoldAll'),
    // transforms
    editorAction('editor.transformUppercase', 'Transform to Uppercase', 'editor.action.transformToUppercase'),
    editorAction('editor.transformLowercase', 'Transform to Lowercase', 'editor.action.transformToLowercase'),
    editorAction('editor.trimTrailingWhitespace', 'Trim Trailing Whitespace', 'editor.action.trimTrailingWhitespace'),
    // navigation
    editorAction('editor.gotoSymbol', 'Go to Symbol in Editor', 'editor.action.quickOutline'),
];
