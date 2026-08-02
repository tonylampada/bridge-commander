import { abortableEffect } from '../../utils.js';
import { InstancedPanel } from './panel.js';
export function setupInstancedPanel(properties, root, orderInfo, panelGroupDependencies, panelMatrix, size, borderInset, clippingRect, isVisible, materialConfig, abortSignal) {
    abortableEffect(() => {
        const isEnabled = properties.enabled.value;
        const currentOrderInfo = orderInfo.value;
        if (!isEnabled || currentOrderInfo == null) {
            return;
        }
        const innerAbortController = new AbortController();
        const group = root.value.panelGroupManager.getGroup(currentOrderInfo, panelGroupDependencies.value);
        new InstancedPanel(properties, group, currentOrderInfo.patchIndex, panelMatrix, size, borderInset, clippingRect, isVisible, materialConfig, innerAbortController.signal);
        return () => innerAbortController.abort();
    }, abortSignal);
}
