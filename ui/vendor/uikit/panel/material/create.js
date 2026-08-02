import { FrontSide } from 'three';
import { compilePanelMaterial } from './shader.js';
export function createPanelMaterial(MaterialClass, info) {
    const material = new MaterialClass();
    if (material.defines == null) {
        material.defines = {};
    }
    material.side = FrontSide;
    material.clipShadows = true;
    material.transparent = true;
    material.toneMapped = false;
    material.shadowSide = FrontSide;
    material.defines.USE_UV = '';
    material.defines.USE_TANGENT = '';
    const superOnBeforeCompile = material.onBeforeCompile;
    material.onBeforeCompile = (parameters, renderer) => {
        superOnBeforeCompile.call(material, parameters, renderer);
        if (info.type === 'normal') {
            parameters.uniforms.data = { value: info.data };
        }
        compilePanelMaterial(parameters, info.type === 'instanced');
    };
    return material;
}
