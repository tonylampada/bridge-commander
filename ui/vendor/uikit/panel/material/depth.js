import { MeshDepthMaterial, MeshDistanceMaterial, RGBADepthPacking, } from 'three';
import { compilePanelDepthMaterial } from './shader.js';
export class PanelDistanceMaterial extends MeshDistanceMaterial {
    info;
    constructor(info) {
        super();
        this.info = info;
        if (this.defines == null) {
            this.defines = {};
        }
        this.defines.USE_UV = '';
        this.clipShadows = true;
    }
    onBeforeCompile(parameters, renderer) {
        super.onBeforeCompile(parameters, renderer);
        if (this.info.type === 'normal') {
            parameters.uniforms.data = { value: this.info.data };
        }
        compilePanelDepthMaterial(parameters, this.info.type === 'instanced');
    }
}
export class PanelDepthMaterial extends MeshDepthMaterial {
    info;
    constructor(info) {
        super({ depthPacking: RGBADepthPacking });
        this.info = info;
        if (this.defines == null) {
            this.defines = {};
        }
        this.defines.USE_UV = '';
        this.clipShadows = true;
    }
    onBeforeCompile(parameters, renderer) {
        super.onBeforeCompile(parameters, renderer);
        if (this.info.type === 'normal') {
            parameters.uniforms.data = { value: this.info.data };
        }
        compilePanelDepthMaterial(parameters, this.info.type === 'instanced');
    }
}
export const instancedPanelDepthMaterial = new PanelDepthMaterial({ type: 'instanced' });
export const instancedPanelDistanceMaterial = new PanelDistanceMaterial({ type: 'instanced' });
