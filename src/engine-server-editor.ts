// engine-server-editor, server-side editor-mode boot composition.
//
// Imported only by the edit-mode server realm entries (the cli + editor edit servers).
// Importing it registers the editor's server-side declarations (trait, script,
// commands) into the registry, which the realm does before `EngineServer.load`
// builds the derived indexes. `drainWrites` is what a host awaits after
// `EngineServer.dispose`: the editor is the only thing that writes scene files.
// Pairs with `engine-client-editor` (the client-side counterpart). The HMR re-apply
// loop is `EngineServer.watchRegistry`, the same one every dev realm uses.

import './editor/server';

export { drainWrites } from './editor/persist/scenes';
