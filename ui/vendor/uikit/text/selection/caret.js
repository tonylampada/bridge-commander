import { computed, signal } from '@preact/signals-core';
import { setupOrderInfo, ElementType } from '../../order.js';
import { setupInstancedPanel } from '../../panel/instance/setup.js';
import { abortableEffect, computedBorderInset } from '../../utils.js';
import { computedPanelMatrix } from '../../panel/instance/index.js';
import { createPanelMaterialConfig } from '../../panel/material/config.js';
import { parseAbsoluteLengthValue } from '../../properties/values.js';
const caretBorderKeys = [
    'caretBorderRightWidth',
    'caretBorderTopWidth',
    'caretBorderLeftWidth',
    'caretBorderBottomWidth',
];
let caretMaterialConfig;
function getCaretMaterialConfig() {
    caretMaterialConfig ??= createPanelMaterialConfig({
        backgroundColor: 'caretColor',
        borderBend: 'caretBorderBend',
        borderBottomLeftRadius: 'caretBorderBottomLeftRadius',
        borderBottomRightRadius: 'caretBorderBottomRightRadius',
        borderColor: 'caretBorderColor',
        borderTopLeftRadius: 'caretBorderTopLeftRadius',
        borderTopRightRadius: 'caretBorderTopRightRadius',
    }, {
        backgroundColor: 0x0,
    });
    return caretMaterialConfig;
}
export function setupCaret(properties, globalMatrix, caretTransformation, isVisible, parentOrderInfo, parentGroupDeps, parentClippingRect, root, abortSignal) {
    const orderInfo = signal(undefined);
    setupOrderInfo(orderInfo, properties, 'zIndex', ElementType.Panel, parentGroupDeps, parentOrderInfo, abortSignal);
    const blinkingCaretTransformation = signal(undefined);
    abortableEffect(() => {
        const pos = caretTransformation.value;
        if (pos == null) {
            blinkingCaretTransformation.value = undefined;
            return;
        }
        blinkingCaretTransformation.value = pos;
        const ref = setInterval(() => (blinkingCaretTransformation.value = blinkingCaretTransformation.peek() == null ? pos : undefined), 500);
        return () => clearInterval(ref);
    }, abortSignal);
    const borderInset = computedBorderInset(properties, caretBorderKeys);
    const panelSize = computed(() => {
        const height = blinkingCaretTransformation.value?.height;
        if (height == null) {
            return [0, 0];
        }
        return [parseAbsoluteLengthValue(properties.value.caretWidth ?? 0), height];
    });
    const panelOffset = computed(() => {
        const position = blinkingCaretTransformation.value?.position;
        if (position == null) {
            return [0, 0];
        }
        return [position[0] - parseAbsoluteLengthValue(properties.value.caretWidth ?? 0) / 2, position[1]];
    });
    const panelMatrix = computedPanelMatrix(properties, globalMatrix, panelSize, panelOffset);
    setupInstancedPanel(properties, root, orderInfo, parentGroupDeps, panelMatrix, panelSize, borderInset, parentClippingRect, isVisible, getCaretMaterialConfig(), abortSignal);
}
