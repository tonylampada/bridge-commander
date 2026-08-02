import { LinesIntersector } from '../intersections/index.js';
import { Pointer } from '../pointer.js';
import { generateUniquePointerId } from './index.js';
export function createLinesPointer(getCamera, space, pointerState, options = {}, pointerType = 'lines') {
    return new Pointer(generateUniquePointerId(), pointerType, pointerState, new LinesIntersector(space, options), getCamera, undefined, undefined, undefined, options);
}
