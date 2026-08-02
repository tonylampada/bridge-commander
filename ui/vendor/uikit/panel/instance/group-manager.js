import { ElementType } from '../../order.js';
import { resolvePanelMaterialClassProperty } from '../material/presets.js';
import { InstancedPanelGroup } from './group.js';
export class PanelGroupManager {
    root;
    object;
    map = new Map();
    constructor(root, object) {
        this.root = root;
        this.object = object;
    }
    init(abortSignal) {
        const onFrame = () => this.traverse((group) => group.onFrame());
        this.root.onFrameSet.add(onFrame);
        abortSignal.addEventListener('abort', () => {
            this.root.onFrameSet.delete(onFrame);
            this.traverse((group) => group.destroy());
        });
    }
    traverse(fn) {
        for (const groups of this.map.values()) {
            for (const group of groups.values()) {
                fn(group);
            }
        }
    }
    getGroup({ majorIndex, minorIndex }, properties) {
        const materialClass = resolvePanelMaterialClassProperty(properties.panelMaterialClass);
        let groups = this.map.get(materialClass);
        if (groups == null) {
            this.map.set(materialClass, (groups = new Map()));
        }
        const key = [
            majorIndex,
            minorIndex,
            properties.renderOrder,
            properties.depthTest,
            properties.depthWrite,
            properties.receiveShadow,
            properties.castShadow,
        ].join(',');
        let panelGroup = groups.get(key);
        if (panelGroup == null) {
            groups.set(key, (panelGroup = new InstancedPanelGroup(this.object, this.root, {
                elementType: ElementType.Panel,
                minorIndex,
                majorIndex,
                patchIndex: 0,
            }, properties)));
        }
        return panelGroup;
    }
}
