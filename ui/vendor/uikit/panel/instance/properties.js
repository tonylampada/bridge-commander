import { computed } from '@preact/signals-core';
import { resolvePanelMaterialClassProperty } from '../material/presets.js';
import { parseNumberValue } from '../../properties/values.js';
export function computedPanelGroupDependencies(properties) {
    return computed(() => {
        return {
            panelMaterialClass: resolvePanelMaterialClassProperty(properties.value.panelMaterialClass),
            castShadow: properties.value.castShadow,
            receiveShadow: properties.value.receiveShadow,
            depthWrite: properties.value.depthWrite ?? false,
            depthTest: properties.value.depthTest,
            renderOrder: parseNumberValue(properties.value.renderOrder ?? 0),
        };
    });
}
