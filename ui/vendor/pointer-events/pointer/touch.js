import { SphereIntersector } from '../intersections/index.js';
import { Pointer } from '../pointer.js';
import { generateUniquePointerId } from './index.js';
export function createTouchPointer(getCamera, space, pointerState, options = {}, pointerType = 'touch') {
    return new Pointer(generateUniquePointerId(), pointerType, pointerState, new SphereIntersector(space, () => options.hoverRadius ?? 0.1, options), getCamera, createUpdateTouchPointer(options), undefined, undefined, options);
}
function createUpdateTouchPointer(options) {
    let wasPointerDown = false;
    return (pointer) => {
        if (!pointer.getEnabled()) {
            return;
        }
        const intersection = pointer.getIntersection();
        const isPointerDown = computeIsPointerDown(intersection, options.downRadius ?? 0.03);
        if (isPointerDown === wasPointerDown) {
            return;
        }
        const nativeEvent = { timeStamp: performance.now(), button: options.button ?? 0 };
        if (isPointerDown) {
            pointer.down(nativeEvent);
        }
        else {
            pointer.up(nativeEvent);
        }
        wasPointerDown = isPointerDown;
    };
}
function computeIsPointerDown(intersection, downRadius) {
    if (intersection == null) {
        return false;
    }
    return intersection.distance <= downRadius;
}
