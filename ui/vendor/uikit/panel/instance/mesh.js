import { Box3, Mesh, Sphere } from 'three';
import { createPanelGeometry } from '../geometry.js';
import { instancedPanelDepthMaterial, instancedPanelDistanceMaterial } from '../material/depth.js';
import { computeWorldToGlobalMatrix } from '../../utils.js';
export class InstancedPanelMesh extends Mesh {
    root;
    instanceMatrix;
    count = 0;
    isInstancedMesh = true;
    instanceColor = null;
    morphTexture = null;
    boundingBox = new Box3();
    boundingSphere = new Sphere();
    customUpdateMatrixWorld = () => computeWorldToGlobalMatrix(this.root, this.matrixWorld);
    constructor(root, instanceMatrix, instanceData, instanceClipping) {
        const panelGeometry = createPanelGeometry();
        super(panelGeometry);
        this.root = root;
        this.instanceMatrix = instanceMatrix;
        this.pointerEvents = 'none';
        panelGeometry.attributes.aData = instanceData;
        panelGeometry.attributes.aClipping = instanceClipping;
        this.customDepthMaterial = instancedPanelDepthMaterial;
        this.customDistanceMaterial = instancedPanelDistanceMaterial;
        this.frustumCulled = false;
        root.onUpdateMatrixWorldSet.add(this.customUpdateMatrixWorld);
    }
    dispose() {
        this.root.onUpdateMatrixWorldSet.delete(this.customUpdateMatrixWorld);
        this.dispatchEvent({ type: 'dispose' });
        this.geometry.dispose();
    }
    clone() {
        const cloned = new InstancedPanelMesh(this.root, this.instanceMatrix, this.geometry.attributes.aData, this.geometry.attributes.aClipping);
        cloned.count = this.count;
        cloned.material = this.material;
        return cloned;
    }
    copy() {
        throw new Error('InstancedPanelMesh.copy() is not supported. Use clone() instead.');
    }
    // Functions not needed because intersection and morphing are intentionally disabled.
    computeBoundingBox() { }
    computeBoundingSphere() { }
    updateMorphTargets() { }
    raycast() { }
    spherecast() { }
}
