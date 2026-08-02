import { computed } from '@preact/signals-core';
import { toAbsoluteNumber } from '../../text/utils.js';
import { writeColor } from './color.js';
import { materialSetters } from './data.js';
const defaultDefaults = {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    borderBottomLeftRadius: 0,
    borderTopLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopRightRadius: 0,
    borderBend: 0,
};
const defaultOpacity = 1;
let defaultPanelMaterialConfig;
export function getDefaultPanelMaterialConfig() {
    if (defaultPanelMaterialConfig == null) {
        const defaultPanelMaterialKeys = {};
        for (const key in defaultDefaults) {
            defaultPanelMaterialKeys[key] = key;
        }
        defaultPanelMaterialConfig = createPanelMaterialConfig(defaultPanelMaterialKeys);
    }
    return defaultPanelMaterialConfig;
}
const colorArrayHelper = [0, 0, 0, 0];
export function createPanelMaterialConfig(keys, providedDefaults) {
    const defaults = { ...defaultDefaults, ...providedDefaults };
    const setters = {};
    for (const key in keys) {
        const fn = materialSetters[key];
        const defaultValue = defaults[key];
        setters[keys[key]] = (data, offset, value, size, opacity, onUpdate) => fn(data, offset, (value ?? defaultValue), size, opacity, onUpdate);
    }
    const defaultData = new Float32Array(16);
    writeColor(defaultData, 4, defaults.backgroundColor, defaultOpacity, undefined);
    writeColor(defaultData, 9, defaults.borderColor, defaultOpacity, undefined);
    defaultData[13] = defaults.borderBend;
    return {
        hasProperty: (key) => key in setters,
        defaultData,
        setters,
        computedIsVisibile: (properties, borderInset, size, isVisible) => {
            return computed(() => {
                const borderInsetValue = borderInset.value;
                const sizeValue = size.value;
                if (borderInsetValue == null || sizeValue == null) {
                    return false;
                }
                const backgroundColor = keys.backgroundColor == null
                    ? defaults.backgroundColor
                    : (properties.value[keys.backgroundColor] ?? defaults.backgroundColor);
                const borderColor = keys.borderColor == null
                    ? defaults.borderColor
                    : (properties.value[keys.borderColor] ?? defaults.borderColor);
                const opacity = toAbsoluteNumber(properties.value.opacity ?? defaultOpacity, () => 1);
                writeColor(colorArrayHelper, 0, backgroundColor ?? defaults.backgroundColor, opacity);
                const [width, height] = sizeValue;
                const backgroundVisible = width > 0 && height > 0 && colorArrayHelper[3] > 0;
                writeColor(colorArrayHelper, 0, borderColor ?? defaults.borderColor, opacity);
                const borderVisible = borderInsetValue.some((s) => s > 0) && colorArrayHelper[3] > 0;
                if (!backgroundVisible && !borderVisible) {
                    return false;
                }
                return isVisible.value;
            });
        },
    };
}
