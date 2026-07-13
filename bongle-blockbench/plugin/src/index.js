// The bongle Blockbench plugin — one bundle (esbuild iife -> bongle.js) shipping
// two layers:
//
//   generic.js  the platform-agnostic authoring plugin: registers the bongle
//               character/model formats, rig validation, and the window.Bongle
//               API (loadBbmodel / compileArtifacts / newCharacter / ...).
//   bridge.js   the postMessage bridge, active only when framed. It wraps
//               window.Bongle for the embedding parent — the bongle editor —
//               so the editor can seed/open a project and pull authored
//               artefacts (glb + bbmodel) back out. Inert when standalone.
//
// Generic first so window.Bongle exists before the bridge wires onto it.
import './generic.js';
import './bridge.js';
