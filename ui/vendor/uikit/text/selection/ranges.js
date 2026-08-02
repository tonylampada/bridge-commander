import { signal } from '@preact/signals-core';
import { setupInstancedPanel } from '../../panel/instance/setup.js';
import { setupOrderInfo, ElementType } from '../../order.js';
import { abortableEffect, computedBorderInset } from '../../utils.js';
import { computedPanelMatrix } from '../../panel/instance/index.js';
import { createPanelMaterialConfig } from '../../panel/material/config.js';
const selectionBorderKeys = [
    'selectionBorderRightWidth',
    'selectionBorderTopWidth',
    'selectionBorderLeftWidth',
    'selectionBorderBottomWidth',
];
let selectionMaterialConfig;
function getSelectionMaterialConfig() {
    selectionMaterialConfig ??= createPanelMaterialConfig({
        backgroundColor: 'selectionColor',
        borderBend: 'selectionBorderBend',
        borderBottomLeftRadius: 'selectionBorderBottomLeftRadius',
        borderBottomRightRadius: 'selectionBorderBottomRightRadius',
        borderColor: 'selectionBorderColor',
        borderTopLeftRadius: 'selectionBorderTopLeftRadius',
        borderTopRightRadius: 'selectionBorderTopRightRadius',
    }, {
        backgroundColor: 0xb4d7ff,
    });
    return selectionMaterialConfig;
}
export function createSelection(properties, root, globalMatrix, selectionTransformations, isVisible, prevOrderInfo, prevPanelDeps, parentClippingRect, abortSignal) {
    const panels = [];
    const orderInfo = signal(undefined);
    setupOrderInfo(orderInfo, properties, 'zIndex', ElementType.Panel, prevPanelDeps, prevOrderInfo, abortSignal);
    const borderInset = computedBorderInset(properties, selectionBorderKeys);
    abortableEffect(() => {
        const selections = selectionTransformations.value;
        const selectionsLength = selections.length;
        for (let i = 0; i < selectionsLength; i++) {
            let panelData = panels[i];
            if (panelData == null) {
                const size = signal([0, 0]);
                const offset = signal([0, 0]);
                const abortController = new AbortController();
                const panelMatrix = computedPanelMatrix(properties, globalMatrix, size, offset);
                setupInstancedPanel(properties, root, orderInfo, prevPanelDeps, panelMatrix, size, borderInset, parentClippingRect, isVisible, getSelectionMaterialConfig(), abortController.signal);
                panels[i] = panelData = {
                    abortController,
                    offset,
                    size,
                };
            }
            const selection = selections[i];
            panelData.size.value = selection.size;
            panelData.offset.value = selection.position;
        }
        const panelsLength = panels.length;
        for (let i = selectionsLength; i < panelsLength; i++) {
            panels[i].abortController.abort();
        }
        panels.length = selectionsLength;
    }, abortSignal);
    abortSignal.addEventListener('abort', () => {
        const panelsLength = panels.length;
        for (let i = 0; i < panelsLength; i++) {
            panels[i].abortController.abort();
        }
    });
}
