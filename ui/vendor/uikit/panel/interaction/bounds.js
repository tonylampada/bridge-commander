import { abortableEffect } from '../../utils.js';
export function setupBoundingSphere(target, pixelSize, globalMatrixSignal, size, abortSignal) {
    abortableEffect(() => {
        const sizeValue = size.value;
        const globalMatrix = globalMatrixSignal.value;
        if (sizeValue == null || globalMatrix == null) {
            return;
        }
        target.center.set(0, 0, 0);
        const [w, h] = sizeValue;
        const maxDiameter = Math.sqrt(w * w + h * h);
        target.radius = maxDiameter * 0.5 * pixelSize.value;
        target.applyMatrix4(globalMatrix);
    }, abortSignal);
}
