import { getVoidObject } from './intersector.js';
import { listenerNames } from '../event.js';
export function computeIntersectionWorldPlane(target, intersection, objectMatrixWorld) {
    const normal = intersection.normal ?? intersection.face?.normal;
    if (normal == null) {
        return false;
    }
    target.setFromNormalAndCoplanarPoint(normal, intersection.localPoint);
    target.applyMatrix4(objectMatrixWorld);
    return true;
}
function isPointerEventsAllowed(hasListener, pointerEvents, pointerEventsType) {
    if (pointerEvents === 'none') {
        return false;
    }
    if (pointerEvents === 'listener' && !hasListener) {
        return false;
    }
    if (pointerEventsType === 'all') {
        return true;
    }
    if (typeof pointerEventsType === 'function') {
        return ({ id, type, state }) => pointerEventsType(id, type, state);
    }
    let value;
    let invert;
    if ('deny' in pointerEventsType) {
        invert = true;
        value = pointerEventsType.deny;
    }
    else {
        invert = false;
        value = pointerEventsType.allow;
    }
    if (Array.isArray(value)) {
        return (pointer) => invertIf(value.includes(pointer.type), invert);
    }
    return (pointer) => invertIf(value === pointer.type, invert);
}
function invertIf(toInvert, ifIsTrue) {
    return ifIsTrue ? !toInvert : toInvert;
}
export function intersectPointerEventTargets(type, object, pointers, parentHasListener = false, parentPointerEvents, parentPointerEventsType, parentPointerEventsOrder) {
    const hasListener = parentHasListener || hasObjectListeners(type, object);
    const pointerEvents = object.pointerEvents ?? parentPointerEvents;
    const pointerEventsOrDefault = pointerEvents ?? object.defaultPointerEvents ?? 'listener';
    const pointerEventsType = object.pointerEventsType ?? parentPointerEventsType ?? 'all';
    const pointerEventsOrder = object.pointerEventsOrder ?? parentPointerEventsOrder ?? 0;
    const isAllowed = isPointerEventsAllowed(hasListener, pointerEventsOrDefault, pointerEventsType);
    const length = pointers.length;
    if (length === 1) {
        if (isAllowed === true || (typeof isAllowed === 'function' && isAllowed(pointers[0]))) {
            filterAndInteresct(pointers[0], object, pointerEventsOrDefault, pointerEventsType, pointerEventsOrder);
        }
    }
    else if (isAllowed === true) {
        for (let i = 0; i < length; i++) {
            filterAndInteresct(pointers[i], object, pointerEventsOrDefault, pointerEventsType, pointerEventsOrder);
        }
    }
    else if (typeof isAllowed === 'function') {
        for (let i = 0; i < length; i++) {
            const pointer = pointers[i];
            if (!isAllowed(pointer)) {
                continue;
            }
            filterAndInteresct(pointer, object, pointerEventsOrDefault, pointerEventsType, pointerEventsOrder);
        }
    }
    if (object.children.length === 0 || object.intersectChildren === false) {
        return;
    }
    const descendants = object.interactableDescendants ?? object.children;
    const descendantsLength = descendants.length;
    for (let i = 0; i < descendantsLength; i++) {
        intersectPointerEventTargets(type, descendants[i], pointers, hasListener, pointerEvents, pointerEventsType, pointerEventsOrder);
    }
}
function hasObjectListeners(type, object) {
    if (object.ancestorsHaveListeners) {
        return true;
    }
    if (type === 'pointer' && object.ancestorsHavePointerListeners) {
        return true;
    }
    if (type === 'wheel' && object.ancestorsHaveWheelListeners) {
        return true;
    }
    if (object.__r3f != null && object.__r3f?.eventCount > 0) {
        if (type === 'wheel' && object.__r3f['handlers']['onWheel'] != null) {
            return true;
        }
        if (type === 'pointer' && Object.keys(object.__r3f['handlers']).some((key) => key != 'onWheel')) {
            return true;
        }
    }
    if (object._listeners == null) {
        return false;
    }
    if (type === 'wheel') {
        const wheelListeners = object._listeners.wheel;
        return wheelListeners != null && wheelListeners.length > 0;
    }
    const entries = Object.entries(object._listeners);
    const length = entries.length;
    for (let i = 0; i < length; i++) {
        const entry = entries[i];
        if (entry[0] === 'wheel') {
            continue;
        }
        if (!listenerNames.includes(entry[0])) {
            continue;
        }
        if (entry[1] != null && entry[1].length > 0) {
            return true;
        }
    }
    return false;
}
function filterAndInteresct({ intersector, options }, object, pointerEvents, pointerEventsType, pointerEventsOrder) {
    if (options.filter?.(object, pointerEvents, pointerEventsType, pointerEventsOrder) === false) {
        return;
    }
    intersector.executeIntersection(object, pointerEventsOrder);
}
/**
 * @returns undefined if `i1` is the dominant intersection
 * @param i2DistanceOffset modifies i2 and adds the i2DistanceOffset to the current distance
 */
export function getDominantIntersectionIndex(intersections, pointerEventsOrders, { customSort: compare = defaultSort } = {}, filter) {
    let intersection = undefined;
    let pointerEventsOrder = undefined;
    let index = undefined;
    const length = intersections.length;
    for (let i = 0; i < length; i++) {
        const newIntersection = intersections[i];
        if (filter?.(newIntersection) === false) {
            continue;
        }
        const newPointerEventsOrder = pointerEventsOrders?.[i];
        if (intersection == null || compare(newIntersection, newPointerEventsOrder, intersection, pointerEventsOrder) < 0) {
            index = i;
            intersection = newIntersection;
            pointerEventsOrder = newPointerEventsOrder;
        }
    }
    return index;
}
/**
 * @returns a negative number if i1 should be sorted before i2
 */
function defaultSort(i1, pointerEventsOrder1 = 0, i2, pointerEventsOrder2 = 0) {
    if (pointerEventsOrder1 != pointerEventsOrder2) {
        //inverted order because order is sorted highest first
        return pointerEventsOrder2 - pointerEventsOrder1;
    }
    //i1 - i2 because negative values mean the sorting i1 before i2 is correct
    return i1.distance - i2.distance;
}
const VoidObjectDistance = 10000000;
export function voidObjectIntersectionFromRay(scene, ray, getDetails, pointerPosition, pointerQuaternion, addToDistance = 0) {
    const point = ray.direction.clone().multiplyScalar(VoidObjectDistance);
    const distanceOnRay = VoidObjectDistance;
    return {
        distance: distanceOnRay + addToDistance,
        object: getVoidObject(scene),
        point,
        normal: ray.origin.clone().sub(point).normalize(),
        details: getDetails(point, distanceOnRay),
        pointerPosition,
        pointerQuaternion,
        pointOnFace: point,
        localPoint: point,
    };
}
export function pushTimes(target, value, times) {
    while (times > 0) {
        target.push(value);
        --times;
    }
}
