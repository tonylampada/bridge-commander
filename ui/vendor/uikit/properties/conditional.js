import { isDarkMode } from '../preferred-color-scheme.js';
const breakPoints = {
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    '2xl': 1536,
};
const breakPointKeys = Object.keys(breakPoints);
const breakPointKeysLength = breakPointKeys.length;
function createResponsiveConditionals(root) {
    const conditionals = {};
    for (let i = 0; i < breakPointKeysLength; i++) {
        const key = breakPointKeys[i];
        conditionals[key] = () => {
            const rootWidth = root.value.component.size.value?.[0] ?? 0;
            return rootWidth > breakPoints[key];
        };
    }
    return conditionals;
}
function createHoverConditionals(hoveredSignal) {
    return {
        hover: () => hoveredSignal.value.length > 0,
    };
}
function createActivePropertyTransfomers(activeSignal) {
    return {
        active: () => activeSignal.value.length > 0,
    };
}
const preferredColorSchemeConditionals = {
    dark: () => isDarkMode.value,
};
function createFocusPropertyTransformers(hasFocusSignal) {
    if (hasFocusSignal == null) {
        return {
            focus: () => false,
        };
    }
    return {
        focus: () => hasFocusSignal.value,
    };
}
function createPlaceholderPropertyTransformers(isPlaceholder) {
    if (isPlaceholder == null) {
        return {
            placeholderStyle: () => false,
        };
    }
    return {
        placeholderStyle: () => isPlaceholder.value,
    };
}
export const conditionalKeys = ['dark', 'hover', 'active', 'focus', ...breakPointKeys];
export function createConditionals(root, hoveredSignal, activeSignal, hasFocusSignal, isPlaceholderSignal) {
    return {
        ...preferredColorSchemeConditionals,
        ...createResponsiveConditionals(root),
        ...createHoverConditionals(hoveredSignal),
        ...createActivePropertyTransfomers(activeSignal),
        ...createFocusPropertyTransformers(hasFocusSignal),
        ...createPlaceholderPropertyTransformers(isPlaceholderSignal),
    };
}
