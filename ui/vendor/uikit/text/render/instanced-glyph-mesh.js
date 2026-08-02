import { Box3, Mesh, PlaneGeometry, Sphere } from 'three';
import { computeWorldToGlobalMatrix } from '../../utils.js';
export class InstancedGlyphMesh extends Mesh {
    root;
    instanceMatrix;
    instanceRGBA;
    instanceUV;
    instanceClipping;
    instanceRenderSolid;
    count = 0;
    isInstancedMesh = true;
    instanceColor = null;
    morphTexture = null;
    boundingBox = new Box3();
    boundingSphere = new Sphere();
    customUpdateMatrixWorld = () => computeWorldToGlobalMatrix(this.root, this.matrixWorld);
    constructor(root, instanceMatrix, instanceRGBA, instanceUV, instanceClipping, instanceRenderSolid, material) {
        const planeGeometry = new PlaneGeometry();
        planeGeometry.translate(0.5, -0.5, 0);
        super(planeGeometry, material);
        this.root = root;
        this.instanceMatrix = instanceMatrix;
        this.instanceRGBA = instanceRGBA;
        this.instanceUV = instanceUV;
        this.instanceClipping = instanceClipping;
        this.instanceRenderSolid = instanceRenderSolid;
        this.pointerEvents = 'none';
        planeGeometry.attributes.instanceUVOffset = instanceUV;
        planeGeometry.attributes.instanceRGBA = instanceRGBA;
        planeGeometry.attributes.instanceClipping = instanceClipping;
        planeGeometry.attributes.instanceRenderSolid = instanceRenderSolid;
        this.frustumCulled = false;
        root.onUpdateMatrixWorldSet.add(this.customUpdateMatrixWorld);
    }
    clone() {
        const cloned = new InstancedGlyphMesh(this.root, this.instanceMatrix, this.instanceRGBA, this.instanceUV, this.instanceClipping, this.instanceRenderSolid, this.material);
        cloned.count = this.count;
        return cloned;
    }
    copy() {
        throw new Error('InstancedGlyphMesh.copy() is not supported. Use clone() instead.');
    }
    dispose() {
        this.root.onUpdateMatrixWorldSet.delete(this.customUpdateMatrixWorld);
        this.dispatchEvent({ type: 'dispose' });
        this.geometry.dispose();
    }
    //functions not needed because intersection (and morphing) is intenionally disabled
    computeBoundingBox() { }
    computeBoundingSphere() { }
    updateMorphTargets() { }
    raycast() { }
    spherecast() { }
}
