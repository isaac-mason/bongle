// editor/platform/contract.ts — MOVED. The editor⇄platform contract now lives in
// lib/interface/editor.ts (a peer of the engine⇄host contract), so the editor is
// a CONSUMER of the boundary rather than its owner. This re-export keeps existing
// imports working; point new code at `bongle/interface` (or ../../interface/editor).
export * from '../../interface/editor';
