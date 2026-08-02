import { generateUniquePointerId } from './index.js';
import { SphereIntersector } from '../intersections/sphere.js';
import { Pointer } from '../pointer.js';
export function createGrabPointer(getCamera, space, pointerState, options = {}, pointerType = 'grab') {
    return new Pointer(generateUniquePointerId(), pointerType, pointerState, new SphereIntersector(space, () => options.radius ?? 0.07, options), getCamera, undefined, undefined, undefined, options);
}
