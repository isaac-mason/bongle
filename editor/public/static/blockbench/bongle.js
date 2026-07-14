"use strict";
(() => {
  // starter/character.bbmodel
  var character_default = { meta: { format_version: "5.0", model_format: "bongle_character", box_uv: true }, name: "player", model_identifier: "", visible_box: [1, 1, 0], variable_placeholders: "", multi_file_ruleset: "", variable_placeholder_buttons: [], timeline_setups: [], unhandled_root_fields: {}, resolution: { width: 64, height: 64 }, elements: [{ name: "Body", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-4, 12, -2], to: [4, 24, 2], autouv: 0, color: 0, origin: [0, 0, 0], uv_offset: [16, 16], faces: { north: { uv: [20, 20, 28, 32], texture: 0 }, east: { uv: [16, 20, 20, 32], texture: 0 }, south: { uv: [32, 20, 40, 32], texture: 0 }, west: { uv: [28, 20, 32, 32], texture: 0 }, up: { uv: [28, 20, 20, 16], texture: 0 }, down: { uv: [36, 16, 28, 20], texture: 0 } }, type: "cube", uuid: "7ccc0f1d-69cd-93ef-c6de-d15934cdb3d3" }, { name: "Body Layer", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-4, 12, -2], to: [4, 24, 2], autouv: 0, color: 0, inflate: 0.25, origin: [0, 0, 0], uv_offset: [16, 32], faces: { north: { uv: [20, 36, 28, 48], texture: 0 }, east: { uv: [16, 36, 20, 48], texture: 0 }, south: { uv: [32, 36, 40, 48], texture: 0 }, west: { uv: [28, 36, 32, 48], texture: 0 }, up: { uv: [28, 36, 20, 32], texture: 0 }, down: { uv: [36, 32, 28, 36], texture: 0 } }, type: "cube", uuid: "23f71c3e-db14-7256-4942-1d4d8f79554c" }, { name: "Right Arm", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [4, 12, -2], to: [8, 24, 2], autouv: 0, color: 0, origin: [0, 0, 0], uv_offset: [40, 16], faces: { north: { uv: [44, 20, 48, 32], texture: 0 }, east: { uv: [40, 20, 44, 32], texture: 0 }, south: { uv: [52, 20, 56, 32], texture: 0 }, west: { uv: [48, 20, 52, 32], texture: 0 }, up: { uv: [48, 20, 44, 16], texture: 0 }, down: { uv: [52, 16, 48, 20], texture: 0 } }, type: "cube", uuid: "a6545d31-5bb5-ff7c-99dd-2792840aebf3" }, { name: "Right Arm Layer", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [4, 12, -2], to: [8, 24, 2], autouv: 0, color: 0, inflate: 0.25, origin: [0, 0, 0], uv_offset: [40, 32], faces: { north: { uv: [44, 36, 48, 48], texture: 0 }, east: { uv: [40, 36, 44, 48], texture: 0 }, south: { uv: [52, 36, 56, 48], texture: 0 }, west: { uv: [48, 36, 52, 48], texture: 0 }, up: { uv: [48, 36, 44, 32], texture: 0 }, down: { uv: [52, 32, 48, 36], texture: 0 } }, type: "cube", uuid: "069dbc37-3ea8-7c78-6549-3c1622f204ff" }, { name: "Left Arm", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-8, 12, -2], to: [-4, 24, 2], autouv: 0, color: 0, origin: [0, 0, 0], uv_offset: [32, 48], faces: { north: { uv: [36, 52, 40, 64], texture: 0 }, east: { uv: [32, 52, 36, 64], texture: 0 }, south: { uv: [44, 52, 48, 64], texture: 0 }, west: { uv: [40, 52, 44, 64], texture: 0 }, up: { uv: [40, 52, 36, 48], texture: 0 }, down: { uv: [44, 48, 40, 52], texture: 0 } }, type: "cube", uuid: "62f36d52-35b1-c07b-028e-04c55a49d4d9" }, { name: "Left Arm Layer", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-8, 12, -2], to: [-4, 24, 2], autouv: 0, color: 0, inflate: 0.25, origin: [0, 0, 0], uv_offset: [48, 48], faces: { north: { uv: [52, 52, 56, 64], texture: 0 }, east: { uv: [48, 52, 52, 64], texture: 0 }, south: { uv: [60, 52, 64, 64], texture: 0 }, west: { uv: [56, 52, 60, 64], texture: 0 }, up: { uv: [56, 52, 52, 48], texture: 0 }, down: { uv: [60, 48, 56, 52], texture: 0 } }, type: "cube", uuid: "300e4d99-a77d-0a6b-3903-7dd135c8f046" }, { name: "Right Leg", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-0.1, 0, -2], to: [3.9, 12, 2], autouv: 0, color: 0, origin: [0, 0, 0], uv_offset: [0, 16], faces: { north: { uv: [4, 20, 8, 32], texture: 0 }, east: { uv: [0, 20, 4, 32], texture: 0 }, south: { uv: [12, 20, 16, 32], texture: 0 }, west: { uv: [8, 20, 12, 32], texture: 0 }, up: { uv: [8, 20, 4, 16], texture: 0 }, down: { uv: [12, 16, 8, 20], texture: 0 } }, type: "cube", uuid: "4ec8609c-81e6-c5bb-95f6-383d912c4ac6" }, { name: "Right Leg Layer", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-0.1, 0, -2], to: [3.9, 12, 2], autouv: 0, color: 0, inflate: 0.25, origin: [0, 0, 0], uv_offset: [0, 32], faces: { north: { uv: [4, 36, 8, 48], texture: 0 }, east: { uv: [0, 36, 4, 48], texture: 0 }, south: { uv: [12, 36, 16, 48], texture: 0 }, west: { uv: [8, 36, 12, 48], texture: 0 }, up: { uv: [8, 36, 4, 32], texture: 0 }, down: { uv: [12, 32, 8, 36], texture: 0 } }, type: "cube", uuid: "dd1a16b6-54de-01b6-c8fa-c0181f6f7c6d" }, { name: "Left Leg", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-3.9, 0, -2], to: [0.1, 12, 2], autouv: 0, color: 0, origin: [0, 0, 0], uv_offset: [16, 48], faces: { north: { uv: [20, 52, 24, 64], texture: 0 }, east: { uv: [16, 52, 20, 64], texture: 0 }, south: { uv: [28, 52, 32, 64], texture: 0 }, west: { uv: [24, 52, 28, 64], texture: 0 }, up: { uv: [24, 52, 20, 48], texture: 0 }, down: { uv: [28, 48, 24, 52], texture: 0 } }, type: "cube", uuid: "685c05c4-ce57-9ced-6d44-16e3f07524b4" }, { name: "Left Leg Layer", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-3.9, 0, -2], to: [0.1, 12, 2], autouv: 0, color: 0, inflate: 0.25, origin: [0, 0, 0], uv_offset: [0, 48], faces: { north: { uv: [4, 52, 8, 64], texture: 0 }, east: { uv: [0, 52, 4, 64], texture: 0 }, south: { uv: [12, 52, 16, 64], texture: 0 }, west: { uv: [8, 52, 12, 64], texture: 0 }, up: { uv: [8, 52, 4, 48], texture: 0 }, down: { uv: [12, 48, 8, 52], texture: 0 } }, type: "cube", uuid: "30a965bc-c172-1ee5-f487-9c3a12caebed" }, { name: "Head", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-4, 24, -4], to: [4, 32, 4], autouv: 0, color: 0, origin: [0, 0, 0], faces: { north: { uv: [8, 8, 16, 16], texture: 0 }, east: { uv: [0, 8, 8, 16], texture: 0 }, south: { uv: [24, 8, 32, 16], texture: 0 }, west: { uv: [16, 8, 24, 16], texture: 0 }, up: { uv: [16, 8, 8, 0], texture: 0 }, down: { uv: [24, 0, 16, 8], texture: 0 } }, type: "cube", uuid: "26a44ef2-f33d-a2a0-adb3-3df4f214b2db" }, { name: "Hat Layer", box_uv: true, render_order: "default", locked: false, export: true, scope: 0, allow_mirror_modeling: true, from: [-4, 24, -4], to: [4, 32, 4], autouv: 0, color: 0, inflate: 0.5, origin: [0, 0, 0], uv_offset: [32, 0], faces: { north: { uv: [40, 8, 48, 16], texture: 0 }, east: { uv: [32, 8, 40, 16], texture: 0 }, south: { uv: [56, 8, 64, 16], texture: 0 }, west: { uv: [48, 8, 56, 16], texture: 0 }, up: { uv: [48, 8, 40, 0], texture: 0 }, down: { uv: [56, 0, 48, 8], texture: 0 } }, type: "cube", uuid: "4b229942-3140-5696-e1a2-d2417b1089f0" }], groups: [{ name: "body", uuid: "79f8a4e6-15d2-f368-a37a-3d9b40bf0e37", export: true, locked: false, scope: 0, selected: false, _static: { properties: {}, temp_data: {} }, origin: [0, 12, 0], rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: true, primary_selected: false }, { name: "arm_right", uuid: "f3f67e8b-5bf0-e11a-b3b3-e52fcf167fe5", export: true, locked: false, scope: 0, selected: false, _static: { properties: {}, temp_data: {} }, origin: [5, 22, 0], rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: true, primary_selected: false }, { name: "arm_left", uuid: "0ef4d0ee-6564-716e-a62a-533e6322f0fa", export: true, locked: false, scope: 0, selected: false, _static: { properties: {}, temp_data: {} }, origin: [-5, 22, 0], rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: true, primary_selected: false }, { name: "leg_right", uuid: "636bd8a0-db0d-6e21-e26e-699f4feac839", export: true, locked: false, scope: 0, selected: false, _static: { properties: {}, temp_data: {} }, origin: [1.9, 12, 0], rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: false, primary_selected: false }, { name: "leg_left", uuid: "83683cdd-6120-26ad-4a47-46e5ef7b4c0d", export: true, locked: false, scope: 0, selected: false, _static: { properties: {}, temp_data: {} }, origin: [-1.9, 12, 0], rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: false, primary_selected: false }, { name: "waist", uuid: "b639de34-33ad-380a-97b3-a970e53143ca", export: true, locked: false, scope: 0, selected: false, _static: { properties: {}, temp_data: {} }, origin: [0, 12, 0], rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: true, primary_selected: false }, { name: "head", uuid: "b452967d-4101-428a-f9ca-b9b5cd5c5f3b", export: true, locked: false, scope: 0, selected: false, _static: { properties: {}, temp_data: {} }, origin: [0, 24, 0], rotation: [0, 0, 0], color: 0, children: [], reset: false, shade: true, mirror_uv: false, visibility: true, autouv: 0, isOpen: false, primary_selected: false }], outliner: [{ uuid: "b639de34-33ad-380a-97b3-a970e53143ca", isOpen: true, children: [{ uuid: "79f8a4e6-15d2-f368-a37a-3d9b40bf0e37", isOpen: true, children: ["7ccc0f1d-69cd-93ef-c6de-d15934cdb3d3", "23f71c3e-db14-7256-4942-1d4d8f79554c"] }, { uuid: "b452967d-4101-428a-f9ca-b9b5cd5c5f3b", isOpen: false, children: ["26a44ef2-f33d-a2a0-adb3-3df4f214b2db", "4b229942-3140-5696-e1a2-d2417b1089f0"] }, { uuid: "f3f67e8b-5bf0-e11a-b3b3-e52fcf167fe5", isOpen: true, children: ["a6545d31-5bb5-ff7c-99dd-2792840aebf3", "069dbc37-3ea8-7c78-6549-3c1622f204ff"] }, { uuid: "0ef4d0ee-6564-716e-a62a-533e6322f0fa", isOpen: true, children: ["62f36d52-35b1-c07b-028e-04c55a49d4d9", "300e4d99-a77d-0a6b-3903-7dd135c8f046"] }] }, { uuid: "636bd8a0-db0d-6e21-e26e-699f4feac839", isOpen: false, children: ["4ec8609c-81e6-c5bb-95f6-383d912c4ac6", "dd1a16b6-54de-01b6-c8fa-c0181f6f7c6d"] }, { uuid: "83683cdd-6120-26ad-4a47-46e5ef7b4c0d", isOpen: false, children: ["685c05c4-ce57-9ced-6d44-16e3f07524b4", "30a965bc-c172-1ee5-f487-9c3a12caebed"] }], textures: [{ name: "player.png", path: "", folder: "", namespace: "", id: "0", group: "", scope: 0, width: 64, height: 64, uv_width: 64, uv_height: 64, particle: false, use_as_default: false, layers_enabled: false, sync_to_project: "", file_format: "png", render_mode: "default", render_sides: "auto", wrap_mode: "limited", pbr_channel: "color", fps: 7, frame_time: 1, frame_order_type: "loop", frame_order: "", frame_interpolate: false, visible: true, internal: true, saved: true, uuid: "5578dbf8-7957-f8ff-fa0c-3892ecc8c747", source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAC+ElEQVR4AexavYoUQRCu3UThLlLwFlZEUfEVLtfYQM0u8gnEn+gwMDDVdzBYzIwMFQzvAUwExR9c2BPTwzO5PWq4D5q6mqqZ673rnple+Kjuqa6vu76ug+6ZG5Pze//559LC/YfPlhYc+uRuVwBe4eaNy6SBjn7TjQlpOHJnbRoJkHUGkYsrAkQK2PnwUgGd38LIBBpVwM7X36QBc893F6QB/pzt+Pbi1dLC28VFsvDm5gWysP/tydJCanGqCtjcuEQasLirkzXSAP/atSukAf5z01ukAf6UthIg5QJSz91IgHtTIgYWy20G+l22jQTocoLe2hsJ8G5OxAAZtxnod9k2EqDLCXprrwTY2f1DGhD8Y7FHGuDf+/6LNMD/f/6FNMB/llbONf44eToK8fjvAwqxP3tBIWZ31kch1re3RyE+3d2iEB/+PaIQWy/HFEK+S5ALlH35bqJtvOSrKkA+xN0fz3HXR9+ziJcWceCTFn7PghfjwIN+G6sK0Iag62NVAXDuR3I456PvWcRLizjwSQu/Z8GLceBBv409dheQ5355zpfnenmPkPGyL/lmzw8oRFt+ySfjPTGqCsA9AINx7kcf53z0ca5Hvy4ePLAYX8cHXliMr+OHv44PfstWAlgD+u4rAvR9h738SgV4CvXdXyqg7zvs5VcqwFOo7/6qAvAuAMni7o8+7vro426Pfl08eGAxvo4PvLAYX8cPfx0f+z0cex8Q3vW5Hd71uX3++utRiPBdArc5xgJzhAi5tDZzhpDcIRe3JYcrgDeg7/7qT6DvSVr5FQEsdYbgKxUwhF22ciwVYKkzBF+pgCHsspVjqQBLnSH4SgUMYZetHHtXAVaymm/lAsR+v4+N15K0nq1cAJ4s9vt9bDyvoSlORYCmk+cw7lQEiP1+HxvfRthoAbz/D/C+38fGt0lWGxstAJPGfr+Pjec1nBQrEeCkk+cQVwTIYRdSrqFUQEr1c5i7VEAOu5ByDaUCUqqfw9wrqYDY7/cx8bEiHgIAAP//rCdZDQAAAAZJREFUAwCVozDeWe9Q4QAAAABJRU5ErkJggg==" }], export_options: { gltf: { encoding: "ascii", scale: 16, embed_textures: true, armature: false, animations: true } } };

  // plugin/src/generic.js
  var PLUGIN_ID = "bongle";
  var FORMAT_IDS = {
    character: "bongle_character",
    model: "bongle_model"
  };
  var REQUIRED_BONES = [
    "waist",
    "body",
    "head",
    "arm_left",
    "arm_right",
    "leg_left",
    "leg_right"
  ];
  var REQUIRED_PARENT = {
    waist: null,
    body: "waist",
    head: "waist",
    arm_left: "waist",
    arm_right: "waist",
    leg_left: null,
    leg_right: null
  };
  var OPTIONAL_SOCKETS = {
    hand_left: "arm_left",
    hand_right: "arm_right",
    back: "body"
  };
  var WRAP_IN_ROOT = false;
  var BONGLE_EXPORT_OPTIONS = {
    encoding: "binary",
    // .glb is what the engine loader reads (model-glb.ts)
    embed_textures: true,
    // single embedded buffer, images in BIN
    armature: false,
    // rigid bones, no skinning
    animations: true,
    scale: 16
    // TODO: confirm the canonical Bongle export scale
  };
  function allBones() {
    return typeof Group !== "undefined" && Group.all ? Group.all : [];
  }
  function boneByName(name) {
    return allBones().find((g) => g.name === name) || null;
  }
  function parentBoneName(node) {
    return node && node.parent && typeof Group !== "undefined" && node.parent instanceof Group ? node.parent.name : null;
  }
  function validateRig() {
    const errors = [];
    const warnings = [];
    const byName = /* @__PURE__ */ new Map();
    for (const group of allBones()) {
      const list = byName.get(group.name) || [];
      list.push(group);
      byName.set(group.name, list);
    }
    for (const bone of REQUIRED_BONES) {
      const matches = byName.get(bone) || [];
      const expectedParent = REQUIRED_PARENT[bone] || null;
      if (matches.length === 0) {
        errors.push(
          expectedParent ? `Missing required bone "${bone}" (must be a child of "${expectedParent}").` : `Missing required bone "${bone}" (must be at the root).`
        );
        continue;
      }
      if (matches.length > 1) {
        warnings.push(
          `There are ${matches.length} bones named "${bone}". Bone names must be unique.`
        );
      }
      const actualParent = parentBoneName(matches[0]);
      if (expectedParent !== actualParent) {
        warnings.push(
          `Bone "${bone}" should be ${expectedParent ? `a child of "${expectedParent}"` : "at the root"}, but it is ${actualParent ? `under "${actualParent}"` : "at the root"}.`
        );
      }
    }
    for (const [socket, expectedParent] of Object.entries(OPTIONAL_SOCKETS)) {
      const node = boneByName(socket);
      if (!node) continue;
      const actualParent = parentBoneName(node);
      if (actualParent !== expectedParent) {
        warnings.push(
          `Optional socket "${socket}" should be a child of "${expectedParent}", but it is ${actualParent ? `under "${actualParent}"` : "at the root"}.`
        );
      }
    }
    return { ok: errors.length === 0, errors, warnings };
  }
  function requiredHierarchyText() {
    const childrenOf = (parent) => [
      ...REQUIRED_BONES.filter((bone) => (REQUIRED_PARENT[bone] || null) === parent).map((name) => ({
        name,
        optional: false
      })),
      ...Object.keys(OPTIONAL_SOCKETS).filter((socket) => OPTIONAL_SOCKETS[socket] === parent).map((name) => ({ name, optional: true }))
    ];
    const lines = [];
    const walk = (parent, depth) => {
      for (const node of childrenOf(parent)) {
        lines.push("  ".repeat(depth) + node.name + (node.optional ? "  (optional)" : ""));
        walk(node.name, depth + 1);
      }
    };
    walk(null, 0);
    return lines.join("\n");
  }
  function postProcessGltf(gltf, sceneName) {
    gltf.asset = gltf.asset || {};
    gltf.asset.extras = Object.assign({}, gltf.asset.extras, {
      bongle: { plugin: PLUGIN_ID, scene: sceneName }
    });
    const sceneIndex = typeof gltf.scene === "number" ? gltf.scene : 0;
    const scene = gltf.scenes && gltf.scenes[sceneIndex];
    if (scene) {
      scene.name = sceneName;
      if (WRAP_IN_ROOT && Array.isArray(scene.nodes) && scene.nodes.length > 1) {
        gltf.nodes = gltf.nodes || [];
        const rootIndex = gltf.nodes.push({ name: sceneName, children: scene.nodes.slice() }) - 1;
        scene.nodes = [rootIndex];
      }
    }
    return gltf;
  }
  function postProcessGltfString(str, sceneName) {
    try {
      const gltf = JSON.parse(str);
      postProcessGltf(gltf, sceneName);
      return JSON.stringify(gltf);
    } catch (err) {
      console.warn("[bongle] could not post-process glTF JSON", err);
      return str;
    }
  }
  var GLB_MAGIC = 1179937895;
  var GLB_CHUNK_JSON = 1313821514;
  function padTo4(bytes, padValue) {
    const remainder = bytes.length % 4;
    if (remainder === 0) return bytes;
    const out = new Uint8Array(bytes.length + (4 - remainder));
    out.set(bytes, 0);
    out.fill(padValue, bytes.length);
    return out;
  }
  function postProcessGlb(buffer, sceneName) {
    if (ArrayBuffer.isView(buffer)) {
      buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== GLB_MAGIC) {
      console.warn("[bongle] export is not a .glb, skipping post-process");
      return buffer;
    }
    const version = view.getUint32(4, true);
    const totalLength = view.getUint32(8, true);
    let offset = 12;
    let jsonBytes = null;
    const trailingChunks = [];
    while (offset + 8 <= totalLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      const bytes = new Uint8Array(buffer, dataStart, chunkLength);
      if (chunkType === GLB_CHUNK_JSON && !jsonBytes) {
        jsonBytes = bytes;
      } else {
        trailingChunks.push({ type: chunkType, bytes });
      }
      offset = dataStart + chunkLength;
    }
    if (!jsonBytes) {
      console.warn("[bongle] .glb has no JSON chunk, skipping post-process");
      return buffer;
    }
    const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
    postProcessGltf(gltf, sceneName);
    const newJson = padTo4(new TextEncoder().encode(JSON.stringify(gltf)), 32);
    const trailing = trailingChunks.map((c) => ({ type: c.type, bytes: padTo4(c.bytes, 0) }));
    let size = 12 + 8 + newJson.length;
    for (const c of trailing) size += 8 + c.bytes.length;
    const out = new ArrayBuffer(size);
    const outView = new DataView(out);
    const outBytes = new Uint8Array(out);
    outView.setUint32(0, GLB_MAGIC, true);
    outView.setUint32(4, version, true);
    outView.setUint32(8, size, true);
    let o = 12;
    outView.setUint32(o, newJson.length, true);
    outView.setUint32(o + 4, GLB_CHUNK_JSON, true);
    outBytes.set(newJson, o + 8);
    o += 8 + newJson.length;
    for (const c of trailing) {
      outView.setUint32(o, c.bytes.length, true);
      outView.setUint32(o + 4, c.type, true);
      outBytes.set(c.bytes, o + 8);
      o += 8 + c.bytes.length;
    }
    return out;
  }
  function sceneNameForActiveFormat() {
    return typeof Format !== "undefined" && Format && Format.id === FORMAT_IDS.model ? "model" : "character";
  }
  async function exportBongleGltf() {
    const result = validateRig();
    if (!result.ok) {
      Blockbench.showMessageBox({
        title: "Bongle rig validation failed",
        message: result.errors.map((e) => `- ${e}`).join("\n") + "\n\nA Bongle Character needs this bone hierarchy:\n\n```\n" + requiredHierarchyText() + "\n```"
      });
      return;
    }
    if (result.warnings.length) {
      Blockbench.showQuickMessage(result.warnings.join("  |  "), 4e3);
    }
    const codec = Codecs.gltf;
    const sceneName = sceneNameForActiveFormat();
    const isBinary = BONGLE_EXPORT_OPTIONS.encoding === "binary";
    let content = await codec.compile(BONGLE_EXPORT_OPTIONS);
    content = isBinary ? postProcessGlb(content, sceneName) : postProcessGltfString(content, sceneName);
    Blockbench.export(
      {
        resource_id: "gltf",
        type: codec.name,
        extensions: [isBinary ? "glb" : "gltf"],
        name: codec.fileName(),
        startpath: codec.startPath(),
        content,
        custom_writer: typeof isApp !== "undefined" && isApp ? (a, b) => codec.write(a, b) : null
      },
      (path) => codec.afterDownload && codec.afterDownload(path)
    );
  }
  function isBongleFormat() {
    return typeof Format !== "undefined" && Format && (Format.id === FORMAT_IDS.character || Format.id === FORMAT_IDS.model);
  }
  function isCharacterFormat() {
    return typeof Format !== "undefined" && Format && Format.id === FORMAT_IDS.character;
  }
  function loadBbmodelIntoProject(bbmodel, name) {
    const data = typeof bbmodel === "string" ? JSON.parse(bbmodel) : JSON.parse(JSON.stringify(bbmodel));
    data.meta = data.meta || {};
    if (data.meta.model_format !== FORMAT_IDS.character && data.meta.model_format !== FORMAT_IDS.model) {
      data.meta.model_format = FORMAT_IDS.character;
    }
    Codecs.project.load(data, { path: "", name: name || "character", no_file: true });
    if (typeof Project !== "undefined" && Project && name) Project.name = name;
  }
  async function compileBongleArtifacts() {
    const sceneName = sceneNameForActiveFormat();
    const glb = postProcessGlb(await Codecs.gltf.compile(BONGLE_EXPORT_OPTIONS), sceneName);
    let bbmodel = Codecs.project.compile();
    if (typeof bbmodel !== "string") bbmodel = JSON.stringify(bbmodel);
    const warnings = isCharacterFormat() ? validateRig().warnings : [];
    const name = typeof Project !== "undefined" && Project && Project.name || sceneName;
    return { glb, bbmodel, name, warnings };
  }
  function serializeProjectBbmodel() {
    const s = Codecs.project.compile();
    return typeof s === "string" ? s : JSON.stringify(s);
  }
  function loadStarterCharacter() {
    const data = JSON.parse(JSON.stringify(character_default));
    data.meta = data.meta || {};
    data.meta.model_format = FORMAT_IDS.character;
    Codecs.project.load(data, { path: "", name: "character", no_file: true });
    if (typeof Project !== "undefined" && Project && !Project.name) Project.name = "character";
  }
  var bongleFormats = [];
  function registerFormats() {
    const character = new ModelFormat(FORMAT_IDS.character, {
      name: "Bongle Character",
      description: "Rigged Bongle character with the canonical 6-bone rig.",
      icon: "person",
      category: "bongle",
      target: ["Bongle"],
      // Rigged + animated. forward_direction defaults to '-z', which matches
      // Bongle's facing, so it is left at the default.
      bone_rig: true,
      meshes: true,
      rotate_cubes: true,
      optional_box_uv: true,
      centered_grid: true,
      animation_mode: true,
      pbr: false
    });
    character.new = function() {
      if (character_default) {
        loadStarterCharacter();
        return true;
      }
      return ModelFormat.prototype.new.call(this);
    };
    const model = new ModelFormat(FORMAT_IDS.model, {
      name: "Bongle Model",
      description: "Static Bongle model (props, creatures, anything that isn't a character).",
      icon: "view_in_ar",
      category: "bongle",
      target: ["Bongle"],
      bone_rig: true,
      meshes: true,
      rotate_cubes: true,
      optional_box_uv: true,
      centered_grid: true,
      animation_mode: false
    });
    if (typeof Language !== "undefined" && Language.data) {
      Language.data["format_category.bongle"] = "Bongle";
    }
    bongleFormats = [character, model];
    raiseBongleFormatsToTop();
  }
  function raiseBongleFormatsToTop() {
    const ids = Object.keys(Formats);
    const bongleIds = ids.filter((id) => id === FORMAT_IDS.character || id === FORMAT_IDS.model);
    if (bongleIds.length === 0) return;
    const ordered = bongleIds.concat(ids.filter((id) => !bongleIds.includes(id)));
    const snapshot = {};
    for (const id of ordered) snapshot[id] = Formats[id];
    for (const id of ids) delete Formats[id];
    for (const id of ordered) Formats[id] = snapshot[id];
  }
  function unregisterFormats() {
    bongleFormats.forEach((format) => format.delete && format.delete());
    bongleFormats = [];
  }
  var rigValidatorCheck = null;
  function registerValidator() {
    rigValidatorCheck = new ValidatorCheck("bongle_rig", {
      // Only the character format requires the rig.
      condition: () => typeof Format !== "undefined" && Format && Format.id === FORMAT_IDS.character,
      update_triggers: ["update_selection", "finish_edit", "add_group", "update_group"],
      run() {
        const result = validateRig();
        result.errors.forEach((message) => this.fail({ message }));
        result.warnings.forEach((message) => this.warn({ message }));
        if (!result.ok || result.warnings.length) {
          this.warn({
            message: "A Bongle Character needs this bone hierarchy (bones are matched by name):\n\n```\n" + requiredHierarchyText() + "\n```"
          });
        }
      }
    });
  }
  var BADGE_ID = "bongle_badge";
  var startScreenSection = null;
  var startScreenObserver = null;
  function newBongleProject(formatId) {
    const format = typeof Formats !== "undefined" ? Formats[formatId] : null;
    if (format && typeof format.new === "function") format.new();
  }
  function scrollStartScreenTop() {
    const el = document.getElementById("start_screen");
    if (el) el.scrollTop = 0;
  }
  function watchStartScreen() {
    const wrapper = document.getElementById("page_wrapper");
    if (!wrapper || startScreenObserver) return;
    startScreenObserver = new MutationObserver(() => {
      if (wrapper.classList.contains("start_screen")) scrollStartScreenTop();
    });
    startScreenObserver.observe(wrapper, { attributes: true, attributeFilter: ["class"] });
  }
  function addHeaderBadge() {
    if (document.getElementById(BADGE_ID)) return;
    const badge = document.createElement("div");
    badge.id = BADGE_ID;
    badge.textContent = "Bongle";
    badge.title = "Bongle build of Blockbench";
    const logo = document.getElementById("corner_logo");
    if (logo && logo.parentNode) {
      logo.parentNode.insertBefore(badge, logo.nextSibling);
    } else {
      const header = document.querySelector("header");
      if (header) header.appendChild(badge);
    }
  }
  function installBranding() {
    addHeaderBadge();
    if (typeof addStartScreenSection === "function") {
      startScreenSection = addStartScreenSection("bongle", {
        color: "var(--color-accent)",
        text_color: "#ffffff",
        text: [
          { type: "h1", text: "New Bongle project" },
          {
            type: "p",
            text: "Start a rigged **character** or a static **model**. Or pick a format below to import a Minecraft skin, a generic model, and more."
          },
          { type: "button", text: "New Bongle Character", click: () => newBongleProject(FORMAT_IDS.character) },
          { type: "button", text: "New Bongle Model", click: () => newBongleProject(FORMAT_IDS.model) }
        ]
      });
      decorateBongleButtons();
    }
    scrollStartScreenTop();
    watchStartScreen();
    try {
      document.title = "Bongle \xB7 Blockbench";
    } catch (e) {
    }
  }
  function decorateBongleButtons() {
    const section = document.querySelector('#start_screen .start_screen_section[section_id="bongle"]');
    if (!section) return;
    const icons = ["person", "view_in_ar"];
    section.querySelectorAll("button").forEach((button, i) => {
      button.classList.add("bongle-new-button");
      if (!button.querySelector(".material-icons")) {
        const icon = document.createElement("i");
        icon.className = "material-icons";
        icon.textContent = icons[i] || "add";
        button.insertBefore(icon, button.firstChild);
      }
    });
  }
  function removeBranding() {
    const badge = document.getElementById(BADGE_ID);
    if (badge) badge.remove();
    if (startScreenSection && startScreenSection.delete) startScreenSection.delete();
    startScreenSection = null;
    if (startScreenObserver) startScreenObserver.disconnect();
    startScreenObserver = null;
  }
  var exportAction = null;
  function registerBonglePlugin() {
    const options = {
      title: "Bongle",
      author: "Bongle",
      description: "Bongle character/model formats, rig validation, and glTF export.",
      icon: "person",
      version: "0.1.0",
      variant: "both",
      tags: ["Bongle"],
      onload() {
        registerFormats();
        registerValidator();
        exportAction = new Action("bongle_export_gltf", {
          name: "Export Bongle glTF",
          description: "Validate the rig and export an engine-ready Bongle .glb.",
          icon: "download",
          category: "file",
          condition: () => isBongleFormat(),
          click() {
            exportBongleGltf();
          }
        });
        MenuBar.addAction(exportAction, "file.export.0");
        installBranding();
        if (typeof window !== "undefined" && window.Bongle) window.Bongle.ready = true;
      },
      onunload() {
        if (exportAction) exportAction.delete();
        if (rigValidatorCheck && rigValidatorCheck.delete) rigValidatorCheck.delete();
        unregisterFormats();
        removeBranding();
      }
    };
    if (!Plugins.registered[PLUGIN_ID]) {
      const plugin = new Plugin(PLUGIN_ID);
      plugin.source = "store";
      plugin.installed = true;
      Plugins.registered[PLUGIN_ID] = plugin;
    }
    Plugin.register(PLUGIN_ID, options);
  }
  function pluginApiReady() {
    return typeof Plugin !== "undefined" && Plugin.register && typeof Plugins !== "undefined" && Plugins.registered && typeof ModelFormat !== "undefined" && typeof ValidatorCheck !== "undefined";
  }
  function whenBlockbenchReady(cb) {
    if (pluginApiReady()) return cb();
    let tries = 0;
    const timer = setInterval(() => {
      if (pluginApiReady()) {
        clearInterval(timer);
        cb();
      } else if (++tries > 600) {
        clearInterval(timer);
        console.error("[bongle] Blockbench plugin API never became available");
      }
    }, 50);
  }
  whenBlockbenchReady(registerBonglePlugin);
  if (typeof window !== "undefined") {
    window.Bongle = {
      // Flipped true in the plugin's onload, once the Blockbench API (Codecs,
      // formats) is live — embedders should wait for this before driving.
      ready: false,
      validateRig,
      compileArtifacts: compileBongleArtifacts,
      serializeBbmodel: serializeProjectBbmodel,
      loadBbmodel: loadBbmodelIntoProject,
      newCharacter: loadStarterCharacter,
      isCharacterFormat,
      isBongleFormat,
      FORMAT_IDS,
      REQUIRED_BONES,
      OPTIONAL_SOCKETS
    };
  }

  // plugin/src/bridge.js
  (() => {
    const IS_EMBEDDED = typeof window !== "undefined" && window.parent && window.parent !== window;
    if (!IS_EMBEDDED) return;
    const ORIGIN = window.location.origin;
    const post = (msg, transfer) => window.parent.postMessage(msg, ORIGIN, transfer);
    const api = () => typeof window !== "undefined" ? window.Bongle : void 0;
    const projects = () => typeof ModelProject !== "undefined" ? ModelProject.all : [];
    function projectForPath(path) {
      return projects().find((p) => p.bongle_fs_path === path);
    }
    function projectByUuid(uuid) {
      return projects().find((p) => p.uuid === uuid);
    }
    async function saveActive() {
      const project = typeof Project !== "undefined" ? Project : null;
      if (!project) return;
      const B = api();
      let glb = null;
      let bbmodel;
      let name;
      let warnings = [];
      try {
        const art = await B.compileArtifacts();
        glb = art.glb;
        bbmodel = art.bbmodel;
        name = art.name;
        warnings = art.warnings || [];
      } catch (err) {
        bbmodel = B.serializeBbmodel();
        name = project.name || "model";
        warnings = [`glb export skipped: ${String(err && err.message || err)}`];
      }
      const path = project.bongle_fs_path;
      const transfer = glb ? [glb] : [];
      if (path) {
        post({ type: "bongle:save", path, glb, bbmodel, name, warnings }, transfer);
        project.saved = true;
      } else {
        post({ type: "bongle:save-as", uuid: project.uuid, glb, bbmodel, name, warnings }, transfer);
      }
    }
    function openFile(path, bbmodel) {
      const existing = projectForPath(path);
      if (existing) {
        existing.select();
        return;
      }
      const name = path.split("/").pop();
      api().loadBbmodel(bbmodel, name);
      if (typeof Project !== "undefined" && Project) {
        Project.bongle_fs_path = path;
        Project.name = name;
        Project.saved = true;
      }
    }
    function handle(event) {
      if (event.source !== window.parent || event.origin !== ORIGIN) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "bongle:hello") {
        announceWhenReady();
        return;
      }
      const B = api();
      if (!B || !B.ready) return;
      switch (data.type) {
        case "bongle:open":
          try {
            openFile(data.path, data.bbmodel);
          } catch (err) {
            post({ type: "bongle:open-failed", path: data.path, error: String(err && err.message || err) });
          }
          return;
        case "bongle:save-active":
          void saveActive();
          return;
        case "bongle:assign-path": {
          const p = projectByUuid(data.uuid);
          if (p) {
            p.bongle_fs_path = data.path;
            p.name = data.path.split("/").pop();
            p.saved = true;
          }
          return;
        }
      }
    }
    let wired = false;
    function wire() {
      if (wired) return;
      if (typeof BarItems !== "undefined") {
        for (const id of ["export_over", "save_project"]) {
          if (BarItems[id]) BarItems[id].click = () => void saveActive();
        }
        if (BarItems.bongle_export_gltf && BarItems.bongle_export_gltf.delete) BarItems.bongle_export_gltf.delete();
      }
      if (typeof Blockbench !== "undefined" && Blockbench.on) {
        Blockbench.on("saved_state_changed", ({ project, saved }) => {
          if (project && project.bongle_fs_path) post({ type: "bongle:dirty", path: project.bongle_fs_path, saved });
        });
      }
      window.addEventListener(
        "keydown",
        (e) => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
            e.preventDefault();
            e.stopPropagation();
            void saveActive();
          }
        },
        true
      );
      wired = true;
    }
    function announceWhenReady() {
      const B = api();
      if (B && B.ready) {
        wire();
        post({ type: "bongle:ready" });
        return;
      }
      setTimeout(announceWhenReady, 60);
    }
    window.addEventListener("message", handle);
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", announceWhenReady);
    else announceWhenReady();
  })();
})();
