import { computed } from '@preact/signals-core';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseNumberValue } from '../../properties/values.js';
const IdentityMatrix = new Matrix4();
const IdentityQuaternion = new Quaternion();
const IdentityScale = new Vector3(1, 1, 1);
const textMatrixPosition = new Vector3();
export function computedGlobalTextMatrix(target) {
    return computed(() => {
        const paddingInset = target.paddingInset.value;
        const borderInset = target.borderInset.value;
        if (paddingInset == null || borderInset == null) {
            return IdentityMatrix;
        }
        return getGlobalTextMatrix(paddingInset, borderInset, parseNumberValue(target.properties.value.pixelSize), target.globalMatrix.value ?? IdentityMatrix);
    });
}
export function getGlobalTextMatrix(paddingInset, borderInset, pixelSize, globalMatrix = IdentityMatrix) {
    const [pTop, pRight, pBottom, pLeft] = paddingInset;
    const [bTop, bRight, bBottom, bLeft] = borderInset;
    const topInset = pTop + bTop;
    const rightInset = pRight + bRight;
    const bottomInset = pBottom + bBottom;
    const leftInset = pLeft + bLeft;
    textMatrixPosition.set((leftInset - rightInset) * 0.5 * pixelSize, (bottomInset - topInset) * 0.5 * pixelSize, 0);
    return new Matrix4().compose(textMatrixPosition, IdentityQuaternion, IdentityScale).premultiply(globalMatrix);
}
