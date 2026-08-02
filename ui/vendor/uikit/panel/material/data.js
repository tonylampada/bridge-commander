import { clamp } from 'three/src/math/MathUtils.js';
import { toAbsoluteNumber } from '../../text/utils.js';
import { writeColor } from './color.js';
export const materialSetters = {
    // 0-3 = border sizes
    // 4-7 = background color
    backgroundColor: (d, o, p, _, op, u) => writeColor(d, o + 4, p, toAbsoluteNumber(op.value, () => 1), u),
    // 8 = border radiuses
    borderBottomLeftRadius: (d, o, p, { value: s }, _, u) => {
        s != null && writeBorderRadius(d, o + 8, 0, p, s[1], u);
    },
    borderBottomRightRadius: (d, o, p, { value: s }, _, u) => s != null && writeBorderRadius(d, o + 8, 1, p, s[1], u),
    borderTopRightRadius: (d, o, p, { value: s }, _, u) => s != null && writeBorderRadius(d, o + 8, 2, p, s[1], u),
    borderTopLeftRadius: (d, o, p, { value: s }, _, u) => s != null && writeBorderRadius(d, o + 8, 3, p, s[1], u),
    // 9-12 = border color
    borderColor: (d, o, p, _, op, u) => writeColor(d, o + 9, p, toAbsoluteNumber(op.value, () => 1), u),
    // 13 = border bend
    borderBend: (d, o, p, _, op, u) => writeComponent(d, o + 13, toAbsoluteNumber(p, () => 1), u),
    // 14 = width
    // 15 = height
};
function writeBorderRadius(data, offset, indexInFloat, value, height, onUpdate) {
    setBorderRadius(data, offset, indexInFloat, toAbsoluteNumber(value, () => height), height);
    onUpdate?.(offset, 1);
}
function writeComponent(data, offset, value, onUpdate) {
    data[offset] = value;
    onUpdate?.(offset, 1);
}
function setComponentInFloat(from, index, value) {
    const x = Math.pow(50, index);
    const currentValue = Math.floor(from / x) % 50;
    return from + (value - currentValue) * x;
}
function setBorderRadius(data, indexInData, indexInFloat, value, height) {
    data[indexInData] = setComponentInFloat(data[indexInData], indexInFloat, height === 0 ? 0 : clamp(Math.ceil(((value ?? 0) / height) * 100), 0, 49));
}
