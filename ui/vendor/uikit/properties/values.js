const numberStringPattern = String.raw `[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?`;
const numberStringRegex = new RegExp(`^${numberStringPattern}$`);
const percentageRegex = new RegExp(`^${numberStringPattern}%$`);
const pixelLengthRegex = new RegExp(`^${numberStringPattern}px$`);
const viewportLengthRegex = new RegExp(`^${numberStringPattern}(vh|dvh|svh|lvh|vw|dvw|svw|lvw)$`);
export function isNumberString(value) {
    return typeof value === 'string' && numberStringRegex.test(value);
}
export function isPercentageString(value) {
    return typeof value === 'string' && percentageRegex.test(value);
}
export function isPixelLengthString(value) {
    return typeof value === 'string' && pixelLengthRegex.test(value);
}
export function isViewportLengthString(value) {
    return typeof value === 'string' && viewportLengthRegex.test(value);
}
export function isViewportHeightLength(value) {
    return isViewportLengthString(value) && value.endsWith('vh');
}
export function isViewportWidthLength(value) {
    return isViewportLengthString(value) && value.endsWith('vw');
}
export function parseAbsoluteNumber(value, getRelativeValue, viewportWidth, viewportHeight) {
    if (typeof value === 'number') {
        return value;
    }
    if (isPercentageString(value)) {
        const number = Number.parseFloat(value);
        return getRelativeValue == null ? number : (getRelativeValue() * number) / 100;
    }
    if (isViewportHeightLength(value)) {
        const number = Number.parseFloat(value);
        return viewportHeight == null ? number : (viewportHeight * number) / 100;
    }
    if (isViewportWidthLength(value)) {
        const number = Number.parseFloat(value);
        return viewportWidth == null ? number : (viewportWidth * number) / 100;
    }
    if (isNumberString(value)) {
        return Number(value);
    }
    if (isPixelLengthString(value)) {
        return Number(value.slice(0, -2));
    }
    throw new Error(`Invalid number: ${value}`);
}
export function parseNumberValue(value) {
    return typeof value === 'number' ? value : Number(value);
}
export function parseAbsoluteLengthValue(value) {
    return isPixelLengthString(value) ? Number(value.slice(0, -2)) : parseNumberValue(value);
}
export function convertYogaPoint(input, viewportWidth, viewportHeight) {
    if (input == null || typeof input === 'number' || isPercentageString(input)) {
        return input;
    }
    if (isNumberString(input)) {
        return Number(input);
    }
    if (isPixelLengthString(input)) {
        return Number(input.slice(0, -2));
    }
    if (isViewportWidthLength(input)) {
        return (viewportWidth * Number.parseFloat(input)) / 100;
    }
    if (isViewportHeightLength(input)) {
        return (viewportHeight * Number.parseFloat(input)) / 100;
    }
    throw new Error(`Invalid Yoga point: ${input}`);
}
