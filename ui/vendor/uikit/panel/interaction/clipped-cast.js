import { Matrix4, Plane } from 'three';
import { computeWorldToGlobalMatrix } from '../../utils.js';
const planeHelper = new Plane();
const worldToGlobalMatrixHelper = new Matrix4();
export function makeClippedCast(component, fn, root, parent, orderInfoSignal) {
    return (raycaster, intersects) => {
        const oldLength = intersects.length;
        const fnResult = fn.call(component, raycaster, intersects);
        if (oldLength === intersects.length) {
            return fnResult;
        }
        const orderInfo = orderInfoSignal.peek();
        if (orderInfo == null) {
            return fnResult;
        }
        const clippingPlanes = parent.peek()?.clippingRect?.peek()?.planes;
        root.peek().component.updateMatrix();
        computeWorldToGlobalMatrix(root.peek(), worldToGlobalMatrixHelper);
        outer: for (let i = intersects.length - 1; i >= oldLength; i--) {
            const intersection = intersects[i];
            intersection.distance -=
                orderInfo.majorIndex * 0.01 +
                    orderInfo.minorIndex * 0.0001 +
                    orderInfo.elementType * 0.00001 +
                    orderInfo.patchIndex * 0.0000001;
            if (clippingPlanes == null) {
                continue;
            }
            for (let ii = 0; ii < 4; ii++) {
                planeHelper.copy(clippingPlanes[ii]).applyMatrix4(worldToGlobalMatrixHelper);
                if (planeHelper.distanceToPoint(intersection.point) < 0) {
                    intersects.splice(i, 1);
                    continue outer;
                }
            }
        }
        return fnResult;
    };
}
