import { computed } from '@preact/signals-core';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { alignmentXMap, alignmentYMap } from './utils.js';
import { toAbsoluteNumber } from './text/utils.js';
import { parseNumberValue, } from './properties/values.js';
const tHelper = new Vector3();
const sHelper = new Vector3();
const originVector = new Vector3();
const matrixHelper = new Matrix4();
const eulerHelper = new Euler();
const quaternionHelper = new Quaternion();
const toRad = Math.PI / 180;
function toQuaternion([x, y, z]) {
    return quaternionHelper.setFromEuler(eulerHelper.set(x * toRad, y * toRad, z * toRad));
}
const defaultTransformOriginX = 'center';
const defaultTransformOriginY = 'center';
export function computedTransformMatrix({ relativeCenter, size, properties, root, }) {
    //B * O^-1 * T * O
    //B = bound transformation matrix
    //O = matrix to transform the origin for matrix T
    //T = transform matrix (translate, rotate, scale)
    return computed(() => {
        const relativeCenterValue = relativeCenter.value;
        if (relativeCenterValue == null) {
            return undefined;
        }
        const [x, y] = relativeCenterValue;
        const pixelSize = parseNumberValue(properties.value.pixelSize);
        const result = new Matrix4().makeTranslation(x * pixelSize, y * pixelSize, 0);
        let originCenter = true;
        const tOX = properties.value.transformOriginX ?? defaultTransformOriginX;
        const tOY = properties.value.transformOriginY ?? defaultTransformOriginY;
        if (tOX != 'center' || tOY != 'center') {
            const sizeValue = size.value;
            if (sizeValue == null) {
                return undefined;
            }
            const [width, height] = sizeValue;
            originCenter = false;
            originVector.set(-alignmentXMap[tOX] * width * pixelSize, -alignmentYMap[tOY] * height * pixelSize, 0);
            result.multiply(matrixHelper.makeTranslation(originVector));
            originVector.negate();
        }
        const tTX = properties.value.transformTranslateX ?? 0;
        const tTY = properties.value.transformTranslateY ?? 0;
        const tTZ = properties.value.transformTranslateZ ?? 0;
        const tRX = properties.value.transformRotateX ?? 0;
        const tRY = properties.value.transformRotateY ?? 0;
        const tRZ = properties.value.transformRotateZ ?? 0;
        const tSX = properties.value.transformScaleX ?? 1;
        const tSY = properties.value.transformScaleY ?? 1;
        const tSZ = properties.value.transformScaleZ ?? 1;
        const r = [parseNumberValue(tRX), parseNumberValue(tRY), parseNumberValue(tRZ)];
        const t = [
            toAbsoluteNumber(tTX, () => size.value?.[0] ?? 0, root.value),
            -toAbsoluteNumber(tTY, () => size.value?.[1] ?? 0, root.value),
            toAbsoluteNumber(tTZ),
        ];
        const s = [
            toAbsoluteNumber(tSX, () => 1, root.value),
            toAbsoluteNumber(tSY, () => 1, root.value),
            toAbsoluteNumber(tSZ, () => 1, root.value),
        ];
        if (t.some((v) => v != 0) || r.some((v) => v != 0) || s.some((v) => v != 1)) {
            result.multiply(matrixHelper.compose(tHelper.fromArray(t).multiplyScalar(pixelSize), toQuaternion(r), sHelper.fromArray(s)));
        }
        if (!originCenter) {
            result.multiply(matrixHelper.makeTranslation(originVector));
        }
        return result;
    });
}
