import { RayIntersector } from '../intersections/index.js';
import { Pointer } from '../pointer.js';
import { generateUniquePointerId } from './index.js';
export function createRayPointer(getCamera, space, pointerState, options = {}, pointerType = 'ray') {
    return new Pointer(generateUniquePointerId(), pointerType, pointerState, new RayIntersector(space, options), getCamera, undefined, undefined, undefined, options);
}
