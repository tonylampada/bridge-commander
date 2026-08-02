import { MeshPhongMaterial, MeshPhysicalMaterial } from 'three';
export class PlasticMaterial extends MeshPhongMaterial {
    constructor() {
        super({
            specular: '#111',
            shininess: 100,
        });
    }
}
export class GlassMaterial extends MeshPhysicalMaterial {
    constructor() {
        super({
            roughness: 0.1,
            reflectivity: 0.5,
            iridescence: 0.001,
            thickness: 0.05,
            metalness: 0.3,
            ior: 2,
        });
    }
}
export class MetalMaterial extends MeshPhysicalMaterial {
    constructor() {
        super({
            iridescence: 0.001,
            metalness: 0.8,
            roughness: 0.1,
        });
    }
}
export const materialClasses = {
    glass: GlassMaterial,
    metal: MetalMaterial,
    plastic: PlasticMaterial,
};
export function resolvePanelMaterialClassProperty(input) {
    if (typeof input != 'string') {
        return input;
    }
    return materialClasses[input];
}
