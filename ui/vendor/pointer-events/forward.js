import { PointerEvent } from './event.js';
import { ScreenRayIntersector } from './intersections/ray.js';
import { generateUniquePointerId } from './pointer/index.js';
import { Pointer } from './pointer.js';
function htmlEventToCoords(element, e, target) {
    if (!(e instanceof globalThis.MouseEvent)) {
        return target.set(0, 0);
    }
    const { width, height, top, left } = element.getBoundingClientRect();
    const x = e.clientX - left;
    const y = e.clientY - top;
    return target.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
}
/**
 * sets the `pointerTypePrefix` to `"screen-"`. Therefore, a event with pointerType `touch` is forwarded to the scene as `"screen-touch"`
 */
export function forwardHtmlEvents(fromElement, getCamera, scene, options) {
    return forwardEvents(fromElement, 
    //backwards compatibility
    typeof getCamera === 'function' ? getCamera : () => getCamera, scene, htmlEventToCoords.bind(null, fromElement), fromElement.setPointerCapture.bind(fromElement), (pointerId) => {
        if (fromElement.hasPointerCapture(pointerId)) {
            fromElement.releasePointerCapture(pointerId);
        }
    }, {
        pointerTypePrefix: 'screen-',
        ...options,
    });
}
function portalEventToCoords(e, target) {
    if (!(e instanceof PointerEvent)) {
        return target.set(0, 0);
    }
    if (e.uv == null) {
        return target.set(0, 0);
    }
    return target.copy(e.uv).multiplyScalar(2).addScalar(-1);
}
export function forwardObjectEvents(fromPortal, getCamera, scene, options) {
    return forwardEvents(fromPortal, getCamera, scene, portalEventToCoords, fromPortal.setPointerCapture.bind(fromPortal), fromPortal.releasePointerCapture.bind(fromPortal), options);
}
/**
 * @returns cleanup function
 */
function forwardEvents(from, getCamera, scene, toCoords, setPointerCapture, releasePointerCapture, options = {}) {
    const forwardPointerCapture = options?.forwardPointerCapture ?? true;
    const pointerMap = new Map();
    const pointerTypePrefix = options.pointerTypePrefix ?? 'forward-';
    const getInnerPointer = (event, eventType) => {
        let innerPointer = pointerMap.get(event.pointerId);
        if (innerPointer != null) {
            return innerPointer;
        }
        innerPointer = new Pointer(generateUniquePointerId(), `${pointerTypePrefix}${event.pointerType}`, event.pointerState, new ScreenRayIntersector((nativeEvent, coords) => {
            toCoords(nativeEvent, coords);
            return getCamera();
        }, options), getCamera, undefined, forwardPointerCapture ? setPointerCapture.bind(null, event.pointerId) : undefined, forwardPointerCapture ? releasePointerCapture.bind(null, event.pointerId) : undefined, options);
        if (eventType != 'move' && eventType != 'wheel') {
            //if we start with a non-move event no, we intersect and commit
            //this allows enter, down, ... events to be forwarded to the scene even when they dont come with a move event
            innerPointer.setIntersection(innerPointer.computeIntersection('pointer', scene, event));
            innerPointer.commit(event, false);
        }
        pointerMap.set(event.pointerId, innerPointer);
        return innerPointer;
    };
    const latestWheelEventMap = new Map();
    const latestMoveEventMap = new Map();
    const movedPointerList = [];
    const eventList = [];
    const emitEvent = (type, event, pointer) => {
        switch (type) {
            case 'move':
                pointer.move(scene, event);
                return;
            case 'over':
                pointer.move(scene, event);
                return;
            case 'wheel':
                pointer.wheel(scene, event);
                return;
            case 'cancel':
                pointer.cancel(event);
                return;
            case 'down':
                if (!hasButton(event)) {
                    return;
                }
                pointer.down(event);
                return;
            case 'up':
                if (!hasButton(event)) {
                    return;
                }
                pointer.up(event);
                return;
            case 'exit':
                latestMoveEventMap.delete(pointer);
                latestWheelEventMap.delete(pointer);
                pointer.exit(event);
                return;
        }
    };
    const onEvent = (type, event) => {
        const pointer = getInnerPointer(event, type);
        if (type === 'move') {
            latestMoveEventMap.set(pointer, event);
        }
        if (type === 'wheel') {
            latestWheelEventMap.set(pointer, event);
        }
        if (options.batchEvents ?? true) {
            eventList.push({ type, event });
        }
        else {
            emitEvent(type, event, pointer);
        }
    };
    const pointerMoveListener = onEvent.bind(null, 'move');
    const pointerOverListener = onEvent.bind(null, 'over');
    const pointerCancelListener = onEvent.bind(null, 'cancel');
    const pointerDownListener = onEvent.bind(null, 'down');
    const pointerUpListener = onEvent.bind(null, 'up');
    const wheelListener = onEvent.bind(null, 'wheel');
    const pointerLeaveListener = onEvent.bind(null, 'exit');
    from.addEventListener('pointermove', pointerMoveListener);
    from.addEventListener('pointerover', pointerOverListener);
    from.addEventListener('pointercancel', pointerCancelListener);
    from.addEventListener('pointerdown', pointerDownListener);
    from.addEventListener('pointerup', pointerUpListener);
    from.addEventListener('wheel', wheelListener);
    from.addEventListener('pointerleave', pointerLeaveListener);
    return {
        destroy() {
            from.removeEventListener('pointermove', pointerMoveListener);
            from.removeEventListener('pointerover', pointerOverListener);
            from.removeEventListener('pointercancel', pointerCancelListener);
            from.removeEventListener('pointerdown', pointerDownListener);
            from.removeEventListener('pointerup', pointerUpListener);
            from.removeEventListener('wheel', wheelListener);
            from.removeEventListener('pointerleave', pointerLeaveListener);
            latestMoveEventMap.clear();
            latestWheelEventMap.clear();
        },
        update() {
            const length = eventList.length;
            for (let i = 0; i < length; i++) {
                const { type, event } = eventList[i];
                const pointer = getInnerPointer(event, type);
                if (type === 'move') {
                    movedPointerList.push(pointer);
                    if (latestMoveEventMap.get(pointer) != event) {
                        //not the last move => move wihout recomputing the intersection
                        pointer.emitMove(event);
                        continue;
                    }
                }
                if (type === 'wheel' && latestWheelEventMap.get(pointer) != event) {
                    pointer.emitWheel(event);
                    continue;
                }
                emitEvent(type, event, pointer);
            }
            eventList.length = 0;
            if (options.intersectEveryFrame ?? false) {
                for (const [pointer, event] of latestMoveEventMap.entries()) {
                    if (movedPointerList.includes(pointer)) {
                        continue;
                    }
                    pointer.move(scene, event);
                }
            }
            movedPointerList.length = 0;
        },
    };
}
function hasButton(val) {
    return val.button != null;
}
