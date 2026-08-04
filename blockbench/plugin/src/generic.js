/**
 * Bongle Blockbench plugin
 *
 * Turns a stock Blockbench build into the Bongle authoring tool:
 *
 *  1. Two Bongle formats in the New screen: "Bongle Character" (rigged) and
 *     "Bongle Model" (static).
 *  2. Live, format-scoped rig validation against the engine's canonical 6-bone
 *     contract (shown in Blockbench's validator panel).
 *  3. A one-click "Export Bongle glTF" that exports an engine-ready .glb (fixed
 *     options, no dialog) with a tidy scene name written into the glb.
 *  4. Additive Bongle branding (never removes Blockbench's own).
 *
 * Bundled to bongle.js (esbuild, iife) with the starter model embedded, so the
 * single file works two ways:
 *   - injected into the hosted build by ../../build.sh, and
 *   - loaded into the desktop app via File > Plugins > Load Plugin from URL.
 * It self-registers once the Blockbench bundle (a deferred ES module, in the
 * hosted case) has defined the plugin API.
 *
 * Engine source of truth for the rig contract:
 *   lib/src/core/avatar/rig.ts        (validateRig6Bone, canonical hierarchy)
 *   lib/src/builtins/character.ts     (mountRig, optional sockets)
 *   lib/src/core/models/model-glb.ts  (.glb subset the loader accepts)
 */

// Starter character, inlined at build time (esbuild --loader:.bbmodel=json) so
// the plugin is a single self-contained file.
import starterCharacter from '../../starter/character.bbmodel';

// Avatar rules, shared verbatim with the engine runtime and the upload worker.
// esbuild transpiles the .ts on bundle, so the editor's size guide + export gate
// enforce the exact same numbers the server rejects on. Single source of truth.
import {
	checkAvatarHeight,
	RIG_6BONE_MAX_HEIGHT_M,
	RIG_6BONE_MIN_HEIGHT_M,
} from '../../../avatar/rig';

const PLUGIN_ID = 'bongle';

const FORMAT_IDS = {
	character: 'bongle_character',
	model: 'bongle_model',
};

// Canonical 6-bone rig. All of these must exist by exact name. The engine
// matches bones by name and re-parents to its own hierarchy, so the parent
// chain in the authored model is not enforced for these (only presence is).
const REQUIRED_BONES = [
	'waist',
	'body',
	'head',
	'arm_left',
	'arm_right',
	'leg_left',
	'leg_right',
];

// Canonical parent for each required bone (null = at the root). The engine
// re-parents by name, so a wrong parent is a warning (confusing), not an error.
const REQUIRED_PARENT = {
	waist: null,
	body: 'waist',
	head: 'waist',
	arm_left: 'waist',
	arm_right: 'waist',
	leg_left: null,
	leg_right: null,
};

// Optional attachment sockets -> the bone they must be parented under when
// authored. If absent, the engine derives them from the parent bone geometry.
const OPTIONAL_SOCKETS = {
	hand_left: 'arm_left',
	hand_right: 'arm_right',
	back: 'body',
};

// Wrap the top-level bones under a single named root node. Off: the engine
// re-parents canonical bones by name and wants no wrapper.
const WRAP_IN_ROOT = false;

// Fixed glTF export options for Bongle. These replace Blockbench's "Export
// Options" dialog so the export is one click. compile() merges these over the
// codec's saved defaults.
const BONGLE_EXPORT_OPTIONS = {
	encoding: 'binary', // .glb is what the engine loader reads (model-glb.ts)
	embed_textures: true, // single embedded buffer, images in BIN
	armature: false, // rigid bones, no skinning
	animations: true,
	scale: 16, // canonical Bongle export scale: 16 Blockbench units = 1 metre
};

// Blockbench units per metre. Derived from the export scale so the size guide
// and the exported glb can never disagree about how tall a model is: the codec
// divides positions by `scale` (16 units -> 1 glTF unit) and the engine treats
// 1 glTF unit as 1 world metre.
const UNITS_PER_METER = BONGLE_EXPORT_OPTIONS.scale;

// ---------------------------------------------------------------------------
// Rig validation
// ---------------------------------------------------------------------------

/** Flat list of every group (bone) in the open project. */
function allBones() {
	return typeof Group !== 'undefined' && Group.all ? Group.all : [];
}

function boneByName(name) {
	return allBones().find((g) => g.name === name) || null;
}

function parentBoneName(node) {
	return node && node.parent && typeof Group !== 'undefined' && node.parent instanceof Group
		? node.parent.name
		: null;
}

/**
 * Validate the current project's rig against the engine contract.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateRig() {
	const errors = [];
	const warnings = [];

	const byName = new Map();
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
				expectedParent
					? `Missing required bone "${bone}" (must be a child of "${expectedParent}").`
					: `Missing required bone "${bone}" (must be at the root).`,
			);
			continue;
		}
		if (matches.length > 1) {
			warnings.push(
				`There are ${matches.length} bones named "${bone}". Bone names must be unique.`,
			);
		}

		const actualParent = parentBoneName(matches[0]);
		if (expectedParent !== actualParent) {
			warnings.push(
				`Bone "${bone}" should be ${expectedParent ? `a child of "${expectedParent}"` : 'at the root'}, ` +
					`but it is ${actualParent ? `under "${actualParent}"` : 'at the root'}.`,
			);
		}
	}

	for (const [socket, expectedParent] of Object.entries(OPTIONAL_SOCKETS)) {
		const node = boneByName(socket);
		if (!node) continue; // optional
		const actualParent = parentBoneName(node);
		if (actualParent !== expectedParent) {
			warnings.push(
				`Optional socket "${socket}" should be a child of "${expectedParent}", ` +
					`but it is ${actualParent ? `under "${actualParent}"` : 'at the root'}.`,
			);
		}
	}

	return { ok: errors.length === 0, errors, warnings };
}

/** The required character hierarchy, as an indented text tree. */
function requiredHierarchyText() {
	const childrenOf = (parent) => [
		...REQUIRED_BONES.filter((bone) => (REQUIRED_PARENT[bone] || null) === parent).map((name) => ({
			name,
			optional: false,
		})),
		...Object.keys(OPTIONAL_SOCKETS)
			.filter((socket) => OPTIONAL_SOCKETS[socket] === parent)
			.map((name) => ({ name, optional: true })),
	];
	const lines = [];
	const walk = (parent, depth) => {
		for (const node of childrenOf(parent)) {
			lines.push('  '.repeat(depth) + node.name + (node.optional ? '  (optional)' : ''));
			walk(node.name, depth + 1);
		}
	};
	walk(null, 0);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// glTF post-processing
// ---------------------------------------------------------------------------

/**
 * Mutate a parsed glTF JSON document in place before it is written.
 * Kept minimal on purpose: the engine matches bones by name and re-parents,
 * so most "format" concerns are just naming + metadata. Applied to both the
 * ASCII (.gltf) and binary (.glb) export paths via the helpers below.
 */
function postProcessGltf(gltf, sceneName) {
	gltf.asset = gltf.asset || {};
	gltf.asset.extras = Object.assign({}, gltf.asset.extras, {
		bongle: { plugin: PLUGIN_ID, scene: sceneName },
	});

	// Replace Blockbench's hardcoded "blockbench_export" scene name (the node
	// viewers and the engine treat as the root) with a tidy Bongle name.
	const sceneIndex = typeof gltf.scene === 'number' ? gltf.scene : 0;
	const scene = gltf.scenes && gltf.scenes[sceneIndex];
	if (scene) {
		scene.name = sceneName;

		// Optional: collapse the multiple top-level bones under one named root
		// node. The engine matches bones by name and needs no avatar-root
		// wrapper, so this is purely cosmetic. Off by default.
		if (WRAP_IN_ROOT && Array.isArray(scene.nodes) && scene.nodes.length > 1) {
			gltf.nodes = gltf.nodes || [];
			const rootIndex =
				gltf.nodes.push({ name: sceneName, children: scene.nodes.slice() }) - 1;
			scene.nodes = [rootIndex];
		}
	}

	// TODO: facing (-Z) / feet-at-y=0 normalisation, if the engine ever needs it.
	return gltf;
}

function postProcessGltfString(str, sceneName) {
	try {
		const gltf = JSON.parse(str);
		postProcessGltf(gltf, sceneName);
		return JSON.stringify(gltf);
	} catch (err) {
		console.warn('[bongle] could not post-process glTF JSON', err);
		return str;
	}
}

// glb (glTF 2.0 binary) container constants.
const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"

/** Pad a byte array up to a 4-byte boundary with `padValue`. */
function padTo4(bytes, padValue) {
	const remainder = bytes.length % 4;
	if (remainder === 0) return bytes;
	const out = new Uint8Array(bytes.length + (4 - remainder));
	out.set(bytes, 0);
	out.fill(padValue, bytes.length);
	return out;
}

/**
 * Rewrite only the JSON chunk of a .glb produced by the codec. The BIN chunk
 * (geometry/animation/textures) is copied through byte-for-byte, so this is a
 * cheap, lossless container edit, not a re-export.
 */
function postProcessGlb(buffer, sceneName) {
	// THREE's GLTFExporter hands back an ArrayBuffer for binary, but coerce a
	// typed-array view defensively. Anything else (e.g. an empty export that
	// yields no binary) can't be post-processed — let the DataView throw so the
	// caller can fall back (still saving the .bbmodel source).
	if (ArrayBuffer.isView(buffer)) {
		buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}
	const view = new DataView(buffer);
	if (view.getUint32(0, true) !== GLB_MAGIC) {
		console.warn('[bongle] export is not a .glb, skipping post-process');
		return buffer;
	}
	const version = view.getUint32(4, true);
	const totalLength = view.getUint32(8, true);

	let offset = 12;
	let jsonBytes = null;
	const trailingChunks = []; // BIN and any others, preserved verbatim
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
		console.warn('[bongle] .glb has no JSON chunk, skipping post-process');
		return buffer;
	}

	const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
	postProcessGltf(gltf, sceneName);
	const newJson = padTo4(new TextEncoder().encode(JSON.stringify(gltf)), 0x20);
	const trailing = trailingChunks.map((c) => ({ type: c.type, bytes: padTo4(c.bytes, 0x00) }));

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

/** Scene name written into the export, by active format. */
function sceneNameForActiveFormat() {
	return typeof Format !== 'undefined' && Format && Format.id === FORMAT_IDS.model
		? 'model'
		: 'character';
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

async function exportBongleGltf() {
	const result = validateRig();
	if (!result.ok) {
		Blockbench.showMessageBox({
			title: 'Bongle rig validation failed',
			message:
				result.errors.map((e) => `- ${e}`).join('\n') +
				'\n\nA Bongle Character needs this bone hierarchy:\n\n```\n' +
				requiredHierarchyText() +
				'\n```',
		});
		return;
	}
	const height = heightIssue();
	if (height) {
		Blockbench.showMessageBox({
			title: 'Bongle avatar size',
			message: `${height}.\n\nResize the model so its total height is within the allowed range, then export again.`,
		});
		return;
	}
	if (result.warnings.length) {
		Blockbench.showQuickMessage(result.warnings.join('  |  '), 4000);
	}

	// Mirror Codecs.gltf.export() but skip promptExportOptions(); compile()
	// merges BONGLE_EXPORT_OPTIONS over the codec defaults, then we post-process
	// the result and save.
	const codec = Codecs.gltf;
	const sceneName = sceneNameForActiveFormat();
	const isBinary = BONGLE_EXPORT_OPTIONS.encoding === 'binary';
	let content = await codec.compile(BONGLE_EXPORT_OPTIONS);
	content = isBinary
		? postProcessGlb(content, sceneName)
		: postProcessGltfString(content, sceneName);

	Blockbench.export(
		{
			resource_id: 'gltf',
			type: codec.name,
			extensions: [isBinary ? 'glb' : 'gltf'],
			name: codec.fileName(),
			startpath: codec.startPath(),
			content,
			custom_writer:
				typeof isApp !== 'undefined' && isApp ? (a, b) => codec.write(a, b) : null,
		},
		(path) => codec.afterDownload && codec.afterDownload(path),
	);
}

function isBongleFormat() {
	return (
		typeof Format !== 'undefined' &&
		Format &&
		(Format.id === FORMAT_IDS.character || Format.id === FORMAT_IDS.model)
	);
}

function isCharacterFormat() {
	return typeof Format !== 'undefined' && Format && Format.id === FORMAT_IDS.character;
}

// ---------------------------------------------------------------------------
// Avatar size guide
//
// A quiet-until-wrong viewport overlay for the min/max avatar height rule. In
// normal editing it stays hidden and only surfaces the offending rail (red)
// with the model's bounding box highlighted when the rest-pose height is out of
// bounds. The "Show avatar size guide" toggle pins both rails visible (neutral)
// for authors who want the reference while they build. The height numbers come
// straight from the shared rig contract — the same bounds the upload worker
// enforces — so the editor never disagrees with the server.
// ---------------------------------------------------------------------------

const GUIDE_COLOR_OK = 0x3fb950; // within bounds / neutral reference rails
const GUIDE_COLOR_BAD = 0xff5c57; // out of bounds

let sizeGuideToggle = null;
let sizeGuideGroup = null; // THREE.Group in Canvas.scene, registered as a gizmo
let sizeGuideParts = null; // { minRail, maxRail, modelBox } meshes + materials

/** Every element that contributes to the exported geometry. */
function allElements() {
	if (typeof Outliner !== 'undefined' && Array.isArray(Outliner.elements)) return Outliner.elements;
	const out = [];
	if (typeof Cube !== 'undefined' && Cube.all) out.push(...Cube.all);
	if (typeof Mesh !== 'undefined' && Mesh.all) out.push(...Mesh.all);
	return out;
}

/** Rest-pose world-space AABB of the model, in Blockbench units, or null when
 *  there's nothing to measure.
 *
 *  We run from edit events, which can fire before THREE's next render recomputes
 *  the world-matrix hierarchy — so a just-moved cube/bone leaves mesh.matrixWorld
 *  stale and the height reads intermittently (the "sometimes fires" bug). Flush
 *  the whole scene's matrices first, then measure each element's OWN geometry
 *  (recomputed fresh) against its current world matrix. We deliberately don't use
 *  expandByObject: it traverses children, and Blockbench parents the pivot/rotation
 *  gizmo onto the selected mesh (withoutGizmos only hides it, which the AABB math
 *  ignores), which would inflate the box. Skipping only `export === false` matches
 *  the exported extent the upload worker validates (hidden-but-exported parts count). */
function modelBoxUnits() {
	if (typeof THREE === 'undefined' || typeof Canvas === 'undefined' || !Canvas.scene) return null;
	Canvas.scene.updateMatrixWorld(true);
	const box = new THREE.Box3();
	const partBox = new THREE.Box3();
	let any = false;
	for (const el of allElements()) {
		if (!el || el.export === false || !el.mesh) continue;
		const geometry = el.mesh.geometry;
		if (!geometry || !geometry.attributes || !geometry.attributes.position) continue;
		geometry.computeBoundingBox();
		box.union(partBox.copy(geometry.boundingBox).applyMatrix4(el.mesh.matrixWorld));
		any = true;
	}
	return any && Number.isFinite(box.min.y) && Number.isFinite(box.max.y) ? box : null;
}

/** Rest-pose model height in metres, or null when unmeasurable. */
function modelHeightMeters() {
	const box = modelBoxUnits();
	return box ? (box.max.y - box.min.y) / UNITS_PER_METER : null;
}

/** The height-rule violation for the current model, or null when in bounds /
 *  unmeasurable. Reuses the shared contract's check + message. */
function heightIssue() {
	const height = modelHeightMeters();
	return height === null ? null : checkAvatarHeight(height);
}

function makeWireBox(color) {
	// Unit cube edges centred on the origin, positioned/scaled per update.
	const material = new THREE.LineBasicMaterial({ color });
	return new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), material);
}

function buildSizeGuide() {
	if (sizeGuideGroup || typeof THREE === 'undefined' || typeof Canvas === 'undefined' || !Canvas.scene) {
		return;
	}
	const group = new THREE.Group();
	group.name = 'bongle_size_guide';
	const minCage = makeWireBox(GUIDE_COLOR_OK);
	const maxCage = makeWireBox(GUIDE_COLOR_OK);
	const modelBox = makeWireBox(GUIDE_COLOR_BAD);
	group.add(minCage, maxCage, modelBox);
	Canvas.scene.add(group);
	// Register as a gizmo so screenshots (Canvas.withoutGizmos) exclude it.
	if (Array.isArray(Canvas.gizmos)) Canvas.gizmos.push(group);
	sizeGuideGroup = group;
	sizeGuideParts = { minCage, maxCage, modelBox };
}

/** Size a cage box to span the ground (y=0) up to `heightMeters`, with a
 *  footprint that brackets the model, so it reads as the allowed envelope. */
function placeCage(cage, heightMeters, halfExtentUnits, color, visible) {
	cage.visible = visible;
	if (!visible) return;
	const h = heightMeters * UNITS_PER_METER;
	cage.scale.set(2 * halfExtentUnits, h, 2 * halfExtentUnits);
	cage.position.set(0, h / 2, 0);
	cage.material.color.setHex(color);
}

/** Recompute and redraw the guide. Cheap enough to call on every model edit. */
function updateSizeGuide() {
	// The 3D canvas may not have existed when the plugin loaded, so build lazily:
	// the first update once Canvas.scene is up creates the group. Without this the
	// overlay silently never appears.
	if (!sizeGuideGroup) buildSizeGuide();
	if (!sizeGuideGroup) return;
	const on = !!(sizeGuideToggle && sizeGuideToggle.value);
	const box = isCharacterFormat() ? modelBoxUnits() : null;

	// Nothing to show: not a character, no geometry, or in bounds with the
	// reference toggle off. Hide the whole group and bail.
	if (!box) {
		sizeGuideGroup.visible = false;
		requestGuideRedraw();
		return;
	}
	const heightMeters = (box.max.y - box.min.y) / UNITS_PER_METER;
	const issue = checkAvatarHeight(heightMeters);
	if (!issue && !on) {
		sizeGuideGroup.visible = false;
		requestGuideRedraw();
		return;
	}
	sizeGuideGroup.visible = true;

	const { minCage, maxCage, modelBox } = sizeGuideParts;
	const halfX = (box.max.x - box.min.x) / 2;
	const halfZ = (box.max.z - box.min.z) / 2;
	const cageHalf = Math.max(halfX, halfZ, 0.4 * UNITS_PER_METER) + 0.25 * UNITS_PER_METER;
	const tooTall = heightMeters > RIG_6BONE_MAX_HEIGHT_M;
	const tooShort = heightMeters < RIG_6BONE_MIN_HEIGHT_M;

	// Max cage: red when exceeded; otherwise shown only as a neutral reference
	// when the toggle is on. Min cage mirrors it for the too-short case.
	placeCage(maxCage, RIG_6BONE_MAX_HEIGHT_M, cageHalf, tooTall ? GUIDE_COLOR_BAD : GUIDE_COLOR_OK, tooTall || on);
	placeCage(minCage, RIG_6BONE_MIN_HEIGHT_M, cageHalf, tooShort ? GUIDE_COLOR_BAD : GUIDE_COLOR_OK, tooShort || on);

	// Model bounding box: only drawn when out of bounds, in red. (We recolour
	// the box wireframe, never the model meshes — that would fight texture work.)
	modelBox.visible = !!issue;
	if (issue) {
		modelBox.position.set(
			(box.min.x + box.max.x) / 2,
			(box.min.y + box.max.y) / 2,
			(box.min.z + box.max.z) / 2,
		);
		modelBox.scale.set(
			Math.max(box.max.x - box.min.x, 1e-3),
			Math.max(box.max.y - box.min.y, 1e-3),
			Math.max(box.max.z - box.min.z, 1e-3),
		);
		modelBox.material.color.setHex(GUIDE_COLOR_BAD);
	}
	requestGuideRedraw();
}

/** Nudge the previews to repaint after mutating the scene. Blockbench renders
 *  on demand, so a scene change outside an interaction needs a manual poke. */
function requestGuideRedraw() {
	if (typeof Preview !== 'undefined' && Array.isArray(Preview.all)) {
		for (const preview of Preview.all) preview.render();
	}
}

function disposeSizeGuide() {
	if (sizeGuideToggle) {
		sizeGuideToggle.delete();
		sizeGuideToggle = null;
	}
	if (sizeGuideGroup) {
		if (typeof Canvas !== 'undefined') {
			if (Canvas.scene) Canvas.scene.remove(sizeGuideGroup);
			if (Array.isArray(Canvas.gizmos)) {
				const i = Canvas.gizmos.indexOf(sizeGuideGroup);
				if (i !== -1) Canvas.gizmos.splice(i, 1);
			}
		}
		sizeGuideGroup.traverse((obj) => {
			if (obj.geometry) obj.geometry.dispose();
			if (obj.material) obj.material.dispose();
		});
		sizeGuideGroup = null;
		sizeGuideParts = null;
	}
}

// Model edits that can change the rest-pose extent. Mirrors the rig validator's
// triggers, plus project switches (which don't emit finish_edit).
const SIZE_GUIDE_EVENTS = [
	'finish_edit',
	'update_selection',
	'add_group',
	'update_group',
	'select_project',
];

function registerSizeGuide() {
	sizeGuideToggle = new Toggle('bongle_size_guide', {
		name: 'Show avatar size guide',
		description:
			'Always show the min/max avatar height rails. When off, the guide only appears if the model is out of bounds.',
		icon: 'straighten',
		category: 'view',
		default: false,
		save_on_restart: true,
		condition: () => isCharacterFormat(),
		onChange() {
			updateSizeGuide();
		},
	});
	if (typeof MenuBar !== 'undefined' && MenuBar.addAction) MenuBar.addAction(sizeGuideToggle, 'view');

	buildSizeGuide();
	if (typeof Blockbench !== 'undefined' && Blockbench.on) {
		for (const event of SIZE_GUIDE_EVENTS) Blockbench.on(event, updateSizeGuide);
	}
	updateSizeGuide();
}

function unregisterSizeGuide() {
	if (typeof Blockbench !== 'undefined' && Blockbench.removeListener) {
		for (const event of SIZE_GUIDE_EVENTS) Blockbench.removeListener(event, updateSizeGuide);
	}
	disposeSizeGuide();
}

// ---------------------------------------------------------------------------
// Bongle API surface (window.Bongle)
//
// Generic authoring capabilities for embedders. The bongle.io platform build
// wraps these in a postMessage bridge; this plugin stays platform-agnostic —
// it knows how to load a .bbmodel and how to compile the engine artefacts, and
// nothing about how they're transported.
// ---------------------------------------------------------------------------

/** Load a .bbmodel (string or object) into a fresh project. Respects the
 *  authored Bongle format; defaults to character when the payload carries no
 *  (or a non-Bongle) model_format. Generalises loadStarterCharacter. */
function loadBbmodelIntoProject(bbmodel, name) {
	const data = typeof bbmodel === 'string' ? JSON.parse(bbmodel) : JSON.parse(JSON.stringify(bbmodel));
	data.meta = data.meta || {};
	if (data.meta.model_format !== FORMAT_IDS.character && data.meta.model_format !== FORMAT_IDS.model) {
		data.meta.model_format = FORMAT_IDS.character;
	}
	Codecs.project.load(data, { path: '', name: name || 'character', no_file: true });
	if (typeof Project !== 'undefined' && Project && name) Project.name = name;
	updateSizeGuide();
}

/** Compile both artefacts an embedder uploads: the engine-ready .glb (same
 *  fixed options + post-process as the menu export) and the .bbmodel source.
 *  Returns the current rig warnings (characters only) and a display name. */
async function compileBongleArtifacts() {
	const sceneName = sceneNameForActiveFormat();
	const glb = postProcessGlb(await Codecs.gltf.compile(BONGLE_EXPORT_OPTIONS), sceneName);
	let bbmodel = Codecs.project.compile();
	if (typeof bbmodel !== 'string') bbmodel = JSON.stringify(bbmodel);
	// Height is surfaced as a warning here (the save still commits the source):
	// the server build is the hard gate, matching how missing-bone errors flow.
	const warnings = isCharacterFormat() ? validateRig().warnings : [];
	if (isCharacterFormat()) {
		const height = heightIssue();
		if (height) warnings.push(height);
	}
	const name = (typeof Project !== 'undefined' && Project && Project.name) || sceneName;
	return { glb, bbmodel, name, warnings };
}

/** The current project serialized as a .bbmodel string — the cheap path for
 *  embedder autosave (no glb compile). */
function serializeProjectBbmodel() {
	const s = Codecs.project.compile();
	return typeof s === 'string' ? s : JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Starter model
// ---------------------------------------------------------------------------

function loadStarterCharacter() {
	const data = JSON.parse(JSON.stringify(starterCharacter));
	data.meta = data.meta || {};
	// Load it as a Bongle Character regardless of how the starter was authored.
	data.meta.model_format = FORMAT_IDS.character;
	Codecs.project.load(data, { path: '', name: 'character', no_file: true });
	if (typeof Project !== 'undefined' && Project && !Project.name) Project.name = 'character';
	updateSizeGuide();
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

let bongleFormats = [];

function registerFormats() {
	const character = new ModelFormat(FORMAT_IDS.character, {
		name: 'Bongle Character',
		description: 'Rigged Bongle character with the canonical 6-bone rig.',
		icon: 'person',
		category: 'bongle',
		target: ['Bongle'],
		// Rigged + animated. forward_direction defaults to '-z', which matches
		// Bongle's facing, so it is left at the default.
		bone_rig: true,
		meshes: true,
		rotate_cubes: true,
		optional_box_uv: true,
		centered_grid: true,
		animation_mode: true,
		pbr: false,
	});

	// New > Bongle Character starts from the canonical rig instead of empty.
	character.new = function () {
		if (starterCharacter) {
			loadStarterCharacter();
			return true;
		}
		return ModelFormat.prototype.new.call(this);
	};

	const model = new ModelFormat(FORMAT_IDS.model, {
		name: 'Bongle Model',
		description: "Static Bongle model (props, creatures, anything that isn't a character).",
		icon: 'view_in_ar',
		category: 'bongle',
		target: ['Bongle'],
		bone_rig: true,
		meshes: true,
		rotate_cubes: true,
		optional_box_uv: true,
		centered_grid: true,
		animation_mode: false,
	});

	// Label the custom category and float the Bongle formats to the top of the
	// New screen (the start screen iterates Formats in insertion order).
	if (typeof Language !== 'undefined' && Language.data) {
		Language.data['format_category.bongle'] = 'Bongle';
	}
	bongleFormats = [character, model];
	raiseBongleFormatsToTop();
}

// Reorder the global Formats registry so the Bongle formats come first. The
// New screen groups by category in registry insertion order, so this puts the
// "Bongle" category at the top. Values are untouched; only key order changes.
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

// ---------------------------------------------------------------------------
// Live rig validation (Blockbench validator panel)
// ---------------------------------------------------------------------------

let rigValidatorCheck = null;

function registerValidator() {
	rigValidatorCheck = new ValidatorCheck('bongle_rig', {
		// Only the character format requires the rig.
		condition: () => typeof Format !== 'undefined' && Format && Format.id === FORMAT_IDS.character,
		update_triggers: ['update_selection', 'finish_edit', 'add_group', 'update_group'],
		run() {
			const result = validateRig();
			result.errors.forEach((message) => this.fail({ message }));
			result.warnings.forEach((message) => this.warn({ message }));
			// Height rule (rejected by the upload worker too, so this fails, not warns).
			const height = heightIssue();
			if (height) this.fail({ message: height });
			if (!result.ok || result.warnings.length) {
				this.warn({
					message:
						'A Bongle Character needs this bone hierarchy (bones are matched by name):\n\n```\n' +
						requiredHierarchyText() +
						'\n```',
				});
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Branding (additive: never removes Blockbench's own branding)
// ---------------------------------------------------------------------------

const BADGE_ID = 'bongle_badge';
let startScreenSection = null;
let startScreenObserver = null;

// Start a new project of one of the Bongle formats — what the top start-screen
// buttons do. The character format loads the canonical 6-bone rig starter.
function newBongleProject(formatId) {
	const format = typeof Formats !== 'undefined' ? Formats[formatId] : null;
	if (format && typeof format.new === 'function') format.new();
}

// The start screen can boot scrolled down; keep it pinned to the top whenever
// it's shown (its wrapper toggles the `start_screen` class).
function scrollStartScreenTop() {
	const el = document.getElementById('start_screen');
	if (el) el.scrollTop = 0;
}
function watchStartScreen() {
	const wrapper = document.getElementById('page_wrapper');
	if (!wrapper || startScreenObserver) return;
	startScreenObserver = new MutationObserver(() => {
		if (wrapper.classList.contains('start_screen')) scrollStartScreenTop();
	});
	startScreenObserver.observe(wrapper, { attributes: true, attributeFilter: ['class'] });
}

function addHeaderBadge() {
	if (document.getElementById(BADGE_ID)) return;
	const badge = document.createElement('div');
	badge.id = BADGE_ID;
	badge.textContent = 'Bongle';
	badge.title = 'Bongle build of Blockbench';
	// Sit next to the Blockbench wordmark so it reads "Blockbench · Bongle".
	const logo = document.getElementById('corner_logo');
	if (logo && logo.parentNode) {
		logo.parentNode.insertBefore(badge, logo.nextSibling);
	} else {
		const header = document.querySelector('header');
		if (header) header.appendChild(badge);
	}
}

function installBranding() {
	addHeaderBadge();

	if (typeof addStartScreenSection === 'function') {
		// Take over the top of the start screen with the two things people
		// actually want to make. The format list below stays for imports
		// (Minecraft skins, generic models, …).
		startScreenSection = addStartScreenSection('bongle', {
			color: 'var(--color-accent)',
			text_color: '#ffffff',
			text: [
				{ type: 'h1', text: 'New Bongle project' },
				{
					type: 'p',
					text: 'Start a rigged **character** or a static **model**. Or pick a format below to import a Minecraft skin, a generic model, and more.',
				},
				{ type: 'button', text: 'New Bongle Character', click: () => newBongleProject(FORMAT_IDS.character) },
				{ type: 'button', text: 'New Bongle Model', click: () => newBongleProject(FORMAT_IDS.model) },
			],
		});
		decorateBongleButtons();
	}

	// the start screen can boot scrolled past our section — pin it to the top.
	scrollStartScreenTop();
	watchStartScreen();

	// Initial tab title. Blockbench overwrites this once a project is open.
	try {
		document.title = 'Bongle · Blockbench';
	} catch (e) {
		/* ignore */
	}
}

// Turn the two Bongle start-screen buttons into big, iconed calls to action
// (person = character, view_in_ar = model — matching the format icons).
function decorateBongleButtons() {
	const section = document.querySelector('#start_screen .start_screen_section[section_id="bongle"]');
	if (!section) return;
	const icons = ['person', 'view_in_ar'];
	section.querySelectorAll('button').forEach((button, i) => {
		button.classList.add('bongle-new-button');
		if (!button.querySelector('.material-icons')) {
			const icon = document.createElement('i');
			icon.className = 'material-icons';
			icon.textContent = icons[i] || 'add';
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

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

let exportAction = null;

function registerBonglePlugin() {
	const options = {
		title: 'Bongle',
		author: 'Bongle',
		description: 'Bongle character/model formats, rig validation, and glTF export.',
		icon: 'person',
		version: '0.1.0',
		variant: 'both',
		tags: ['Bongle'],
		onload() {
			registerFormats();
			registerValidator();

			exportAction = new Action('bongle_export_gltf', {
				name: 'Export Bongle glTF',
				description: 'Validate the rig and export an engine-ready Bongle .glb.',
				icon: 'download',
				category: 'file',
				condition: () => isBongleFormat(),
				click() {
					exportBongleGltf();
				},
			});
			MenuBar.addAction(exportAction, 'file.export.0');

			registerSizeGuide();
			installBranding();
			// Signal the API is live so embedders can drive load/new/serialize.
			if (typeof window !== 'undefined' && window.Bongle) window.Bongle.ready = true;
		},
		onunload() {
			if (exportAction) exportAction.delete();
			if (rigValidatorCheck && rigValidatorCheck.delete) rigValidatorCheck.delete();
			unregisterSizeGuide();
			unregisterFormats();
			removeBranding();
		},
	};

	// Blockbench's loader seeds Plugins.registered[id] before evaluating a plugin
	// file, so Plugin.register(id) can adopt that entry. We are injected directly
	// (not through the loader), so seed it ourselves the same way loadFromFile
	// does, then register. Without this, register() falls through to the
	// "failed to load plugin" path. source 'store' keeps it out of the local/url
	// install persistence paths (no StateMemory entry, survives reloads cleanly).
	if (!Plugins.registered[PLUGIN_ID]) {
		const plugin = new Plugin(PLUGIN_ID);
		plugin.source = 'store';
		plugin.installed = true;
		Plugins.registered[PLUGIN_ID] = plugin;
	}
	Plugin.register(PLUGIN_ID, options);
}

// The Blockbench bundle is a deferred ES module, so the plugin API may not be
// defined yet when this classic script runs. Wait for it, then self-register.
function pluginApiReady() {
	return (
		typeof Plugin !== 'undefined' &&
		Plugin.register &&
		typeof Plugins !== 'undefined' &&
		Plugins.registered &&
		typeof ModelFormat !== 'undefined' &&
		typeof ValidatorCheck !== 'undefined'
	);
}

function whenBlockbenchReady(cb) {
	if (pluginApiReady()) return cb();
	let tries = 0;
	const timer = setInterval(() => {
		if (pluginApiReady()) {
			clearInterval(timer);
			cb();
		} else if (++tries > 600) {
			clearInterval(timer); // ~30s; give up rather than spin forever
			console.error('[bongle] Blockbench plugin API never became available');
		}
	}, 50);
}

whenBlockbenchReady(registerBonglePlugin);

// Public API surface for embedders (the bongle.io platform build wraps these
// in a postMessage bridge) — also handy from the devtools console.
if (typeof window !== 'undefined') {
	window.Bongle = {
		// Flipped true in the plugin's onload, once the Blockbench API (Codecs,
		// formats) is live — embedders should wait for this before driving.
		ready: false,
		validateRig,
		// Rest-pose model height in metres (null when unmeasurable) + the current
		// height-rule violation message (null when in bounds). Lets the host show
		// live size feedback next to the editor without re-deriving the rule.
		avatarHeightMeters: modelHeightMeters,
		avatarHeightIssue: heightIssue,
		compileArtifacts: compileBongleArtifacts,
		serializeBbmodel: serializeProjectBbmodel,
		loadBbmodel: loadBbmodelIntoProject,
		newCharacter: loadStarterCharacter,
		isCharacterFormat,
		isBongleFormat,
		FORMAT_IDS,
		REQUIRED_BONES,
		OPTIONAL_SOCKETS,
	};
}
