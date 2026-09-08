/**
 * Collapse a compiled .glb so each canonical rig bone carries one merged mesh
 * instead of one mesh node per authored cube.
 *
 * Blockbench emits a node + mesh per cube, so a stock avatar lands as 10-12 mesh
 * nodes over 6 bones. The engine instances per mesh, so that is 10-12 draws per
 * distinct avatar, 10-12 instance slots + world matrices + cull leaves per
 * character, and 10-12 replicated nodes per mount. Merging per bone halves all
 * of them, and it costs nothing at runtime because it is baked into the bytes.
 *
 * Runs inside the save/export path (generic.js), so the .glb persisted next to
 * the .bbmodel is already in its final in-game form, and a test session sees
 * exactly what ships. The .bbmodel beside it keeps every cube, so authoring and
 * remix are untouched.
 *
 * What survives: the nodes named in `keepNames` (the canonical bones + attach
 * sockets) and any node at the scene root. Everything else is baked into its
 * nearest surviving ancestor and dropped. Animation channels aimed at a dropped
 * node go with it, which is the deliberate contract: six bones and three
 * sockets are the addressable surface, decorative bones are not.
 *
 * Merged geometry hangs off a CHILD of the bone rather than the bone itself.
 * The engine's `mountRig` matches canonical bones by name and copies their TRS,
 * and only *clones* their non-canonical children (recording them so `unmountRig`
 * drops exactly those on an avatar swap). Geometry on the bone itself would
 * never be mounted.
 *
 * One merged mesh per material, not one mesh with several primitives: the engine
 * concatenates a mesh's primitives into a single ModelMesh with a single image
 * (model-glb.ts), so a multi-texture model has to stay split by material to
 * render the way it does today.
 */

import {
	type Accessor,
	type Document,
	type Material,
	type Node,
	type Primitive,
	PropertyType,
	type Texture,
	WebIO,
} from '@gltf-transform/core';

// Suffix for the node holding a bone's merged geometry. Must not collide with a
// canonical name, or `mountRig` would treat it as a bone to TRS-match.
const MESH_NODE_SUFFIX = '_mesh';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const TRIANGLES = 4;

/** One source primitive plus the matrix taking it from its own node's space
 *  into the bone it is being merged into. */
type Part = { prim: Primitive; matrix: number[] };

/** Primitives that can legally share one merged primitive: same material, same
 *  draw mode, same attribute semantics and types. */
type Group = { semantics: string[]; parts: Part[] };

/** RGBA8, row-major, `width * height * 4` bytes. */
export type RasterImage = { width: number; height: number; data: Uint8Array };

/** Image decode/encode, injected because the hosts differ: the plugin has
 *  createImageBitmap + OffscreenCanvas, a test runner does not. Omit it and
 *  texture atlasing is skipped (bones still merge, they just stay split by
 *  material). */
export type Raster = {
	decode(bytes: Uint8Array, mimeType: string): Promise<RasterImage>;
	encode(image: RasterImage): Promise<Uint8Array>;
};

export type CollapseOptions = {
	/** image codec for texture atlasing; omitted, textures stay as-is. */
	raster?: Raster;
	/** told whenever the collapse could not go all the way: an atlas it declined
	 *  to pack, or a bone that had to keep more than one mesh, with the reason.
	 *  A caller surfaces these where someone will see them. Silence is the one
	 *  thing that must not happen: it looks exactly like the pass never running. */
	onWarn?: (reason: string) => void;
};

/**
 * @param glb compiled .glb bytes (the codec hands back an ArrayBuffer;
 *   `postProcessGlb` downstream takes either)
 * @param keepNames node names that survive (canonical bones + sockets)
 */
export async function collapseToRigBones(
	glb: ArrayBuffer | Uint8Array,
	keepNames: string[],
	options: CollapseOptions = {},
): Promise<Uint8Array> {
	const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
	const io = new WebIO();
	const doc = await io.readBinary(bytes);

	// Skinning and morph targets move vertices at runtime, so baking a node
	// transform into them is wrong. Neither can occur under the fixed export
	// options (armature: false), so bail whole rather than half-collapse.
	if (hasDeformedGeometry(doc)) return bytes;

	// Pack every texture into one image first, so a bone whose cubes were painted
	// from different sheets still merges to a single mesh.
	if (options.raster) {
		const skipped = await atlasTextures(doc, options.raster);
		if (skipped) warn(options, `texture atlas skipped: ${skipped}`);
	}

	const keep = new Set(keepNames);
	const collapsed = new Set<Node>();

	for (const scene of doc.getRoot().listScenes()) {
		// scene children are keepers regardless of name: there is no ancestor
		// left to bake them into.
		for (const node of scene.listChildren()) collapseUnder(doc, node, keep, collapsed, options);
	}

	dropChannelsForDroppedNodes(doc, collapsed);
	for (const node of collapsed) node.dispose();
	sweepUnused(doc);

	return await io.writeBinary(doc);
}

/** Gather every mesh at or below `keeper` that isn't under another keeper, merge
 *  per sheet, and hang the result off one child node per sheet. */
function collapseUnder(doc: Document, keeper: Node, keep: Set<string>, collapsed: Set<Node>, options: CollapseOptions): void {
	const parts: Part[] = [];

	const ownMesh = keeper.getMesh();
	if (ownMesh) {
		for (const prim of ownMesh.listPrimitives()) parts.push({ prim, matrix: IDENTITY });
	}

	const descend = (node: Node, matrix: number[]): void => {
		if (keep.has(node.getName())) {
			collapseUnder(doc, node, keep, collapsed, options);
			return;
		}
		collapsed.add(node);
		const mesh = node.getMesh();
		if (mesh) {
			for (const prim of mesh.listPrimitives()) parts.push({ prim, matrix });
		}
		for (const child of node.listChildren()) descend(child, multiply(matrix, [...child.getMatrix()]));
	};
	for (const child of keeper.listChildren()) descend(child, [...child.getMatrix()]);

	if (parts.length === 0) return;

	// the bone's own geometry (if any) moved into the merged child, so the bone
	// itself keeps only its transform.
	keeper.setMesh(null);

	const groups = groupBySheet(doc, parts);
	if (groups.length > 1) {
		// the whole point is one mesh per bone, so say what stopped it rather
		// than quietly emitting `<bone>_mesh_1` and leaving it to be noticed.
		const descriptions = groups.map((group) => describeGroup(doc, group)).join(' vs ');
		warn(options, `"${keeper.getName()}" kept ${groups.length} meshes: ${descriptions}`);
	}

	let index = 0;
	for (const group of groups) {
		const name = mergedName(keeper, index);
		const mesh = doc.createMesh(name).addPrimitive(mergePrimitives(doc, group));
		keeper.addChild(doc.createNode(name).setMesh(mesh));
		index++;
	}
}

function mergedName(keeper: Node, index: number): string {
	const base = `${keeper.getName()}${MESH_NODE_SUFFIX}`;
	return index === 0 ? base : `${base}_${index}`;
}

// ---------------------------------------------------------------------------
// Texture atlasing
// ---------------------------------------------------------------------------

/**
 * Pack every baseColor texture into one image and rewrite the model onto a
 * single material, so a bone whose cubes were painted from different sheets
 * still collapses to one mesh instead of one per sheet.
 *
 * No padding between regions: the engine samples the model atlas with
 * `magFilter`/`minFilter` 'nearest' and no mipmaps (mesh-atlas.ts), so a sample
 * reads exactly one texel and nothing can bleed across a region edge. What does
 * matter is that a remapped uv still selects the texel it selected before, so
 * regions land at integer offsets in a power-of-two atlas and the division is
 * exact.
 *
 * No material difference can block the pack. A baseColor factor is baked into
 * the sheet's pixels rather than compared, and the slots that would have no home
 * in a merge (normal, emissive, metallic-roughness, occlusion) cannot occur:
 * the Bongle formats set `pbr: false`, so Blockbench exports a baseColor texture
 * and nothing else. The renderer reads only baseColor either way.
 *
 * A part with no texture at all (an unpainted cube) is not a bail: it gets a
 * solid tile of its baseColor factor and its uvs pinned to the middle of it.
 * That is already how it renders, since the engine pins a textureless mesh to
 * the reserved white pixel of its own atlas (mesh-resources.ts).
 *
 * Bails (leaving textures split, which still renders correctly) when the model
 * does something an atlas can't represent. Every bail says why on the console:
 * a silent one is indistinguishable from the pass not running.
 */
async function atlasTextures(doc: Document, raster: Raster): Promise<string | null> {
	const prims = listPrimitives(doc);
	const textures = doc.getRoot().listTextures();

	// a sheet is a distinct (texture, baseColor factor) pair: the factor is baked
	// into the pixels, so one texture used at two factors needs two regions. A
	// null texture is a sheet too, a solid tile of the factor's colour.
	const sheets = new Map<string, Sheet>();
	const sheetOfMaterial = new Map<Material, string>();
	for (const prim of prims) {
		const material = prim.getMaterial();
		if (!material) return `"${nameOf(prim)}" has no material`;
		const texture = material.getBaseColorTexture();
		const factor = material.getBaseColorFactor();
		const key = `${texture ? textures.indexOf(texture) : 'solid'}|${factor.join(',')}`;
		sheets.set(key, { texture, factor });
		sheetOfMaterial.set(material, key);
	}
	if (sheets.size < 2) return null;

	// one sheet per uv accessor, or a single remap can't serve both.
	const sheetOfUv = new Map<Accessor, string>();
	for (const prim of prims) {
		const uv = prim.getAttribute('TEXCOORD_0');
		if (!uv) return `"${nameOf(prim)}" has no uvs`;
		if (uv.getComponentType() !== 5126) return `"${nameOf(prim)}" has non-float uvs`;
		const key = sheetOfMaterial.get(prim.getMaterial()!)!;
		const seen = sheetOfUv.get(uv);
		if (seen && seen !== key) return `"${nameOf(prim)}" shares uvs across two sheets`;
		sheetOfUv.set(uv, key);
		// a solid tile's uvs get overwritten wholesale, so whatever they say now
		// (an unpainted cube's uvs are arbitrary) doesn't have to be atlas-able.
		if (!sheets.get(key)!.texture) continue;
		const outside = firstUvOutsideUnitSquare(uv);
		if (outside) return `"${nameOf(prim)}" has uvs outside [0,1] (${outside}), which an atlas can't tile`;
	}

	const decoded = new Map<Texture, RasterImage>();
	const images = new Map<string, RasterImage>();
	for (const [key, sheet] of sheets) {
		if (!sheet.texture) {
			images.set(key, solidTile(sheet.factor));
			continue;
		}
		if (!decoded.has(sheet.texture)) {
			const bytes = sheet.texture.getImage();
			if (!bytes) return `texture "${sheet.texture.getName()}" carries no image`;
			decoded.set(sheet.texture, await raster.decode(bytes, sheet.texture.getMimeType()));
		}
		images.set(key, applyFactor(decoded.get(sheet.texture)!, sheet.factor));
	}

	const packed = pack([...images.entries()]);
	if (!packed) return `${images.size} sheets do not fit an 8192px atlas`;

	const atlas = blit(packed);
	const merged = doc.createTexture('atlas').setImage(await raster.encode(atlas)).setMimeType('image/png');

	const materials = [...new Set(prims.map((prim) => prim.getMaterial()!))];
	const [reference, ...rest] = materials;
	for (const [uv, key] of sheetOfUv) {
		const region = packed.regions.get(key)!;
		// a solid tile has no detail to address, so every vertex points at its
		// middle rather than being scaled into it.
		if (sheets.get(key)!.texture) remapUvs(uv, region, packed.size);
		else pinUvs(uv, region, packed.size);
	}
	for (const prim of prims) prim.setMaterial(reference);
	reference.setBaseColorTexture(merged);
	// the factor now lives in the pixels; leaving it would apply it twice.
	reference.setBaseColorFactor([1, 1, 1, 1]);
	// everything is alpha-tested here (a texel is opaque or gone, and the shader
	// cuts at 0.5), so say so rather than inheriting whichever sheet came first.
	if (materials.some((material) => material.getAlphaMode() !== 'OPAQUE')) {
		reference.setAlphaMode('MASK').setAlphaCutoff(0.5);
	}
	for (const material of rest) material.dispose();
	for (const sheet of sheets.values()) sheet.texture?.dispose();
	return null;
}

type Sheet = { texture: Texture | null; factor: number[] };
type Region = { x: number; y: number; image: RasterImage };
type Packed = { size: number; regions: Map<string, Region> };

/** Bake a material's baseColor factor into its sheet, so the atlas carries the
 *  colour and the merged material needs none. RGB multiplies in linear space,
 *  the space the factor is defined in and the space the GPU decodes the sRGB
 *  texture to; alpha is already linear. Identity returns the source untouched,
 *  which is the normal case (Blockbench exports white) and keeps it lossless. */
function applyFactor(image: RasterImage, factor: number[]): RasterImage {
	if (factor[0] === 1 && factor[1] === 1 && factor[2] === 1 && factor[3] === 1) return image;
	const data = new Uint8Array(image.data);
	for (let i = 0; i < data.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			data[i + c] = Math.round(linearToSrgb(srgbToLinear(data[i + c] / 255) * factor[c]) * 255);
		}
		data[i + 3] = Math.round(data[i + 3] * factor[3]);
	}
	return { width: image.width, height: image.height, data };
}

function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
	return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** Shelf packer into a square power-of-two atlas, tallest first. Sheets are
 *  small and few (one per Blockbench texture), so the packing quality that
 *  matters is "fits at all", not "fits tightest". */
function pack(entries: [string, RasterImage][]): Packed | null {
	const tallestFirst = entries.slice().sort((a, b) => b[1].height - a[1].height);
	let size = 1;
	for (const [, image] of tallestFirst) {
		while (size < image.width || size < image.height) size *= 2;
	}

	for (; size <= 8192; size *= 2) {
		const regions = new Map<string, Region>();
		let x = 0;
		let y = 0;
		let shelfHeight = 0;
		let fits = true;
		for (const [key, image] of tallestFirst) {
			if (x + image.width > size) {
				x = 0;
				y += shelfHeight;
				shelfHeight = 0;
			}
			if (y + image.height > size) {
				fits = false;
				break;
			}
			regions.set(key, { x, y, image });
			x += image.width;
			shelfHeight = Math.max(shelfHeight, image.height);
		}
		if (fits) return { size, regions };
	}
	return null;
}

function blit(packed: Packed): RasterImage {
	const data = new Uint8Array(packed.size * packed.size * 4);
	for (const region of packed.regions.values()) {
		const { image } = region;
		for (let row = 0; row < image.height; row++) {
			const from = row * image.width * 4;
			const to = ((region.y + row) * packed.size + region.x) * 4;
			data.set(image.data.subarray(from, from + image.width * 4), to);
		}
	}
	return { width: packed.size, height: packed.size, data };
}

/**
 * A flat tile for a material with no texture, in the factor's colour.
 *
 * 2x2 rather than 1x1 so the sample point sits where four identical texels meet:
 * exact under the engine's nearest sampling, and still exact under a viewer that
 * filters linearly, which a lone texel would not be.
 *
 * The factor is linear and the atlas is sRGB-encoded, so the colour is encoded
 * on the way in; alpha is already linear.
 */
function solidTile(factor: number[]): RasterImage {
	const data = new Uint8Array(2 * 2 * 4);
	for (let i = 0; i < data.length; i += 4) {
		for (let c = 0; c < 3; c++) data[i + c] = Math.round(linearToSrgb(factor[c]) * 255);
		data[i + 3] = Math.round(factor[3] * 255);
	}
	return { width: 2, height: 2, data };
}

/** Point every uv at the middle of a region, for geometry with no detail to
 *  address (see `solidTile`). */
function pinUvs(uv: Accessor, region: Region, size: number): void {
	const u = (region.x + region.image.width / 2) / size;
	const v = (region.y + region.image.height / 2) / size;
	const element = [u, v];
	for (let i = 0; i < uv.getCount(); i++) uv.setElement(i, element);
}

function remapUvs(uv: Accessor, region: Region, size: number): void {
	const element: number[] = [];
	for (let i = 0; i < uv.getCount(); i++) {
		uv.getElement(i, element);
		element[0] = (element[0] * region.image.width + region.x) / size;
		element[1] = (element[1] * region.image.height + region.y) / size;
		uv.setElement(i, element);
	}
}

/** The first uv that can't live in an atlas, as "u, v" for the log, or null. */
function firstUvOutsideUnitSquare(uv: Accessor): string | null {
	const element: number[] = [];
	for (let i = 0; i < uv.getCount(); i++) {
		uv.getElement(i, element);
		if (element[0] < 0 || element[0] > 1 || element[1] < 0 || element[1] > 1) {
			return `${element[0].toFixed(3)}, ${element[1].toFixed(3)}`;
		}
	}
	return null;
}

function nameOf(prim: Primitive): string {
	const mesh = prim.listParents().find((parent) => parent.propertyType === PropertyType.MESH);
	return mesh?.getName() || prim.getName() || 'primitive';
}

function listPrimitives(doc: Document): Primitive[] {
	const prims: Primitive[] = [];
	for (const mesh of doc.getRoot().listMeshes()) prims.push(...mesh.listPrimitives());
	return prims;
}

/**
 * Split the gathered parts into runs that can share one primitive.
 *
 * Keyed on what the parts would LOOK like, not on which material object they
 * point at: the sheet (baseColor texture + factor) plus draw mode and attribute
 * layout. Two distinct glTF materials over one texture paint identically, and
 * the renderer reads nothing else off a material, so they belong in one mesh.
 * Keying on material identity split them into `<bone>_mesh` and
 * `<bone>_mesh_1` with nothing to show for it.
 */
function groupBySheet(doc: Document, parts: Part[]): Group[] {
	const groups = new Map<string, Group>();
	for (const part of parts) {
		const semantics = part.prim.listSemantics().slice().sort();
		const key = groupKey(doc, part.prim, semantics);
		const group = groups.get(key);
		if (group) group.parts.push(part);
		else groups.set(key, { semantics, parts: [part] });
	}
	return [...groups.values()];
}

function groupKey(doc: Document, prim: Primitive, semantics: string[]): string {
	const material = prim.getMaterial();
	const texture = material?.getBaseColorTexture();
	const sheet = texture ? doc.getRoot().listTextures().indexOf(texture) : -1;
	const factor = material?.getBaseColorFactor().join(',') ?? '';
	const signature = semantics.map((s) => `${s}:${prim.getAttribute(s)?.getType()}`).join(',');
	return `${sheet}|${factor}|${prim.getMode()}|${signature}`;
}

/** Why a group is its own group, in words, for the warning a split emits. */
function describeGroup(doc: Document, group: Group): string {
	const prim = group.parts[0].prim;
	const material = prim.getMaterial();
	const texture = material?.getBaseColorTexture();
	const parts = [
		texture ? `texture "${texture.getName() || doc.getRoot().listTextures().indexOf(texture)}"` : 'no texture',
		`factor [${material?.getBaseColorFactor().join(', ') ?? 'none'}]`,
		`mode ${prim.getMode()}`,
		`attrs ${group.semantics.join('+')}`,
		`${group.parts.length} part(s)`,
	];
	return `{ ${parts.join(', ')} }`;
}

function warn(options: CollapseOptions, reason: string): void {
	console.warn(`[bongle] collapse: ${reason}`);
	options.onWarn?.(reason);
}

/** Concatenate a group's primitives into one, baking each part's matrix into
 *  its vertices. Positions transform by the matrix, normals by its
 *  inverse-transpose, tangents by its rotation/scale with w carried through;
 *  everything else copies. A mirroring matrix (negative determinant) inverts
 *  triangle winding, so those indices are reversed to keep back-face culling
 *  showing the same side. */
function mergePrimitives(doc: Document, group: Group): Primitive {
	const { semantics, parts } = group;

	let vertexCount = 0;
	let indexCount = 0;
	for (const { prim } of parts) {
		const count = positionOf(prim).getCount();
		const indices = prim.getIndices();
		vertexCount += count;
		indexCount += indices ? indices.getCount() : count;
	}

	const first = parts[0].prim;
	const sizes = new Map<string, number>();
	const arrays = new Map<string, Float32Array<ArrayBuffer>>();
	for (const semantic of semantics) {
		const size = attributeOf(first, semantic).getElementSize();
		sizes.set(semantic, size);
		arrays.set(semantic, new Float32Array(vertexCount * size));
	}
	const indexArray = new Uint32Array(indexCount);

	const element: number[] = [];
	let vertexBase = 0;
	let indexCursor = 0;

	for (const { prim, matrix } of parts) {
		const count = positionOf(prim).getCount();
		const normalMatrix = normalMatrixOf(matrix);
		const mirrored = determinant3(matrix) < 0;

		for (const semantic of semantics) {
			const accessor = attributeOf(prim, semantic);
			const size = sizes.get(semantic)!;
			const out = arrays.get(semantic)!;
			for (let i = 0; i < count; i++) {
				accessor.getElement(i, element);
				const at = (vertexBase + i) * size;
				if (semantic === 'POSITION') {
					transformPoint(element, matrix, out, at);
				} else if (semantic === 'NORMAL') {
					transformNormal(element, normalMatrix, out, at);
				} else if (semantic === 'TANGENT') {
					transformNormal(element, normalMatrix, out, at);
					out[at + 3] = element[3];
				} else {
					for (let c = 0; c < size; c++) out[at + c] = element[c];
				}
			}
		}

		const indices = prim.getIndices();
		const sourceCount = indices ? indices.getCount() : count;
		const read = indices ? (i: number): number => indices.getScalar(i) : (i: number): number => i;
		// winding only means anything for triangles; other modes copy in order.
		if (mirrored && prim.getMode() === TRIANGLES) {
			for (let i = 0; i < sourceCount; i += 3) {
				indexArray[indexCursor + i] = vertexBase + read(i + 2);
				indexArray[indexCursor + i + 1] = vertexBase + read(i + 1);
				indexArray[indexCursor + i + 2] = vertexBase + read(i);
			}
		} else {
			for (let i = 0; i < sourceCount; i++) indexArray[indexCursor + i] = vertexBase + read(i);
		}

		vertexBase += count;
		indexCursor += sourceCount;
	}

	const buffer = doc.getRoot().listBuffers()[0] || doc.createBuffer();
	const merged = doc.createPrimitive().setMode(first.getMode()).setMaterial(first.getMaterial());
	for (const semantic of semantics) {
		merged.setAttribute(
			semantic,
			doc
				.createAccessor()
				.setType(attributeOf(first, semantic).getType())
				.setArray(arrays.get(semantic)!)
				.setBuffer(buffer),
		);
	}
	merged.setIndices(doc.createAccessor().setType('SCALAR').setArray(indexArray).setBuffer(buffer));
	return merged;
}

/** A primitive reached here always has the semantic (the group keyed on it) and
 *  always has POSITION (glTF requires it of a renderable primitive). */
function attributeOf(prim: Primitive, semantic: string): Accessor {
	const accessor = prim.getAttribute(semantic);
	if (!accessor) throw new Error(`primitive is missing ${semantic}`);
	return accessor;
}

function positionOf(prim: Primitive): Accessor {
	return attributeOf(prim, 'POSITION');
}

/** A channel aimed at a node we baked away has nothing left to drive; leaving it
 *  would write a dangling target. Animations emptied this way go too. */
function dropChannelsForDroppedNodes(doc: Document, collapsed: Set<Node>): void {
	for (const animation of doc.getRoot().listAnimations()) {
		for (const channel of animation.listChannels()) {
			const target = channel.getTargetNode();
			if (target && !collapsed.has(target)) continue;
			channel.dispose();
		}
		for (const sampler of animation.listSamplers()) {
			const driven = sampler.listParents().some((p) => p.propertyType === PropertyType.ANIMATION_CHANNEL);
			if (!driven) sampler.dispose();
		}
		if (animation.listChannels().length === 0) animation.dispose();
	}
}

/** Drop the meshes, primitives and accessors the collapse orphaned, so their
 *  vertex data leaves the buffer instead of riding along unreferenced. */
function sweepUnused(doc: Document): void {
	const root = doc.getRoot();

	const orphanedPrimitives = new Set<Primitive>();
	for (const mesh of root.listMeshes()) {
		if (!isOrphan(mesh)) continue;
		for (const prim of mesh.listPrimitives()) orphanedPrimitives.add(prim);
		mesh.dispose();
	}
	for (const prim of orphanedPrimitives) {
		if (isOrphan(prim)) prim.dispose();
	}
	for (const accessor of root.listAccessors()) {
		if (isOrphan(accessor)) accessor.dispose();
	}
	// materials and textures the atlas replaced, or that only an unpainted part
	// referenced. Left in place they ship their image bytes in the buffer for
	// nothing.
	for (const material of root.listMaterials()) {
		if (isOrphan(material)) material.dispose();
	}
	for (const texture of root.listTextures()) {
		if (isOrphan(texture)) texture.dispose();
	}
}

function isOrphan(property: { listParents(): { propertyType: string }[] }): boolean {
	return property.listParents().every((parent) => parent.propertyType === PropertyType.ROOT);
}

function hasDeformedGeometry(doc: Document): boolean {
	if (doc.getRoot().listSkins().length > 0) return true;
	for (const mesh of doc.getRoot().listMeshes()) {
		for (const prim of mesh.listPrimitives()) {
			if (prim.getAttribute('JOINTS_0')) return true;
			if (prim.listTargets().length > 0) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Matrix helpers (column-major, as glTF stores them)
// ---------------------------------------------------------------------------

function multiply(a: number[], b: number[]): number[] {
	const out = new Array<number>(16);
	for (let col = 0; col < 4; col++) {
		const b0 = b[col * 4];
		const b1 = b[col * 4 + 1];
		const b2 = b[col * 4 + 2];
		const b3 = b[col * 4 + 3];
		for (let row = 0; row < 4; row++) {
			out[col * 4 + row] = a[row] * b0 + a[4 + row] * b1 + a[8 + row] * b2 + a[12 + row] * b3;
		}
	}
	return out;
}

function transformPoint(v: number[], m: number[], out: Float32Array<ArrayBuffer>, at: number): void {
	const x = v[0];
	const y = v[1];
	const z = v[2];
	out[at] = m[0] * x + m[4] * y + m[8] * z + m[12];
	out[at + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
	out[at + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

function transformNormal(v: number[], n: number[], out: Float32Array<ArrayBuffer>, at: number): void {
	const x = v[0];
	const y = v[1];
	const z = v[2];
	const nx = n[0] * x + n[3] * y + n[6] * z;
	const ny = n[1] * x + n[4] * y + n[7] * z;
	const nz = n[2] * x + n[5] * y + n[8] * z;
	const length = Math.hypot(nx, ny, nz);
	const scale = length > 0 ? 1 / length : 0;
	out[at] = nx * scale;
	out[at + 1] = ny * scale;
	out[at + 2] = nz * scale;
}

function determinant3(m: number[]): number {
	return (
		m[0] * (m[5] * m[10] - m[6] * m[9]) -
		m[4] * (m[1] * m[10] - m[2] * m[9]) +
		m[8] * (m[1] * m[6] - m[2] * m[5])
	);
}

/** Inverse-transpose of the upper-left 3x3, the matrix that keeps normals
 *  perpendicular under non-uniform scale. Column-major 3x3. Falls back to the
 *  rotation/scale part itself when the matrix is singular (degenerate scale),
 *  which at least leaves the normals finite. */
function normalMatrixOf(m: number[]): number[] {
	const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
	const det = determinant3(m);
	if (det === 0) return a;
	const invDet = 1 / det;
	// the cofactor matrix over the determinant is the inverse; writing it
	// transposed here gives the inverse-transpose in one step.
	return [
		(a[4] * a[8] - a[5] * a[7]) * invDet,
		(a[5] * a[6] - a[3] * a[8]) * invDet,
		(a[3] * a[7] - a[4] * a[6]) * invDet,
		(a[2] * a[7] - a[1] * a[8]) * invDet,
		(a[0] * a[8] - a[2] * a[6]) * invDet,
		(a[1] * a[6] - a[0] * a[7]) * invDet,
		(a[1] * a[5] - a[2] * a[4]) * invDet,
		(a[2] * a[3] - a[0] * a[5]) * invDet,
		(a[0] * a[4] - a[1] * a[3]) * invDet,
	];
}
