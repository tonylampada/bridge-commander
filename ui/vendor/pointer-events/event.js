import { Ray, Vector2, Vector3 } from 'three';
import { HtmlEvent } from './html-event.js';
const helperVector = new Vector3();
export class PointerEvent extends HtmlEvent {
    type;
    bubbles;
    internalPointer;
    intersection;
    camera;
    currentObject;
    object;
    propagationState;
    //--- pointer events data
    get pointerId() {
        return this.internalPointer.id;
    }
    get pointerType() {
        return this.internalPointer.type;
    }
    get pointerState() {
        return this.internalPointer.state;
    }
    //--- intersection data
    get distance() {
        return this.intersection.distance;
    }
    get distanceToRay() {
        return this.intersection.distanceToRay;
    }
    get point() {
        return this.intersection.point;
    }
    get index() {
        return this.intersection.index;
    }
    get face() {
        return this.intersection.face;
    }
    get faceIndex() {
        return this.intersection.faceIndex;
    }
    get uv() {
        return this.intersection.uv;
    }
    get uv1() {
        return this.intersection.uv1;
    }
    get normal() {
        return this.intersection.normal;
    }
    get instanceId() {
        return this.intersection.instanceId;
    }
    get pointOnLine() {
        return this.intersection.pointOnLine;
    }
    get batchId() {
        return this.intersection.batchId;
    }
    get pointerPosition() {
        return this.intersection.pointerPosition;
    }
    get pointerQuaternion() {
        return this.intersection.pointerQuaternion;
    }
    get pointOnFace() {
        return this.intersection.pointOnFace;
    }
    get localPoint() {
        return this.intersection.localPoint;
    }
    get details() {
        return this.intersection.details;
    }
    /** same as object */
    get target() {
        return this.object;
    }
    /** same as currentObject */
    get currentTarget() {
        return this.currentObject;
    }
    /** same as currentObject */
    get eventObject() {
        return this.currentObject;
    }
    /** same as object */
    get srcElement() {
        return this.currentObject;
    }
    _pointer;
    get pointer() {
        if (this._pointer == null) {
            helperVector.copy(this.intersection.point).project(this.camera);
            this._pointer = new Vector2(helperVector.x, helperVector.y);
        }
        return this._pointer;
    }
    _ray;
    get ray() {
        if (this._ray != null) {
            return this._ray;
        }
        switch (this.intersection.details.type) {
            case 'screen-ray':
            case 'ray':
            case 'sphere':
                return (this._ray = new Ray(this.intersection.pointerPosition, new Vector3(0, 0, -1).applyQuaternion(this.intersection.pointerQuaternion)));
            case 'lines':
                return (this._ray = new Ray(this.intersection.details.line.start, this.intersection.details.line.end.clone().sub(this.intersection.details.line.start).normalize()));
        }
    }
    _intersections = [];
    get intersections() {
        if (this._intersections == null) {
            this._intersections = [{ ...this.intersection, eventObject: this.currentObject }];
        }
        return this._intersections;
    }
    _unprojectedPoint;
    get unprojectedPoint() {
        if (this._unprojectedPoint == null) {
            const p = this.pointer;
            this._unprojectedPoint = new Vector3(p.x, p.y, 0).unproject(this.camera);
        }
        return this._unprojectedPoint;
    }
    get stopped() {
        return this.propagationState.stoppedImmediate || this.propagationState.stopped;
    }
    get stoppedImmediate() {
        return this.propagationState.stoppedImmediate;
    }
    get delta() {
        throw new Error(`not supported`);
    }
    constructor(type, bubbles, nativeEvent, internalPointer, intersection, camera, currentObject = intersection.object, object = currentObject, propagationState = {
        stopped: !bubbles,
        stoppedImmediate: false,
    }) {
        super(nativeEvent);
        this.type = type;
        this.bubbles = bubbles;
        this.internalPointer = internalPointer;
        this.intersection = intersection;
        this.camera = camera;
        this.currentObject = currentObject;
        this.object = object;
        this.propagationState = propagationState;
    }
    stopPropagation() {
        this.propagationState.stopped = true;
    }
    stopImmediatePropagation() {
        this.propagationState.stoppedImmediate = true;
    }
    /**
     * for internal use
     */
    retarget(currentObject) {
        return new PointerEvent(this.type, this.bubbles, this.nativeEvent, this.internalPointer, this.intersection, this.camera, currentObject, this.target, this.propagationState);
    }
}
export class WheelEvent extends PointerEvent {
    get deltaX() {
        return this.nativeEvent.deltaX;
    }
    get deltaY() {
        return this.nativeEvent.deltaY;
    }
    get deltaZ() {
        return this.nativeEvent.deltaZ;
    }
    constructor(nativeEvent, pointer, intersection, camera, currentObject, object) {
        super('wheel', true, nativeEvent, pointer, intersection, camera, currentObject, object);
    }
    /**
     * for internal use
     */
    retarget(currentObject) {
        return new WheelEvent(this.nativeEvent, this.internalPointer, this.intersection, this.camera, currentObject, this.target);
    }
}
export function emitPointerEvent(event) {
    emitPointerEventRec(event, event.currentObject);
}
function emitPointerEventRec(baseEvent, currentObject) {
    if (currentObject == null) {
        return;
    }
    const listeners = getObjectListeners(currentObject, baseEvent.type);
    if (listeners != null && listeners.length > 0) {
        const event = baseEvent.retarget(currentObject);
        const length = listeners.length;
        for (let i = 0; i < length && !event.stoppedImmediate; i++) {
            listeners[i](event);
        }
    }
    if (baseEvent.stopped) {
        return;
    }
    emitPointerEventRec(baseEvent, currentObject.parent);
}
const r3fEventToHandlerMap = {
    click: 'onClick',
    contextmenu: 'onContextMenu',
    dblclick: 'onDoubleClick',
    pointercancel: 'onPointerCancel',
    pointerdown: 'onPointerDown',
    pointerenter: 'onPointerEnter',
    pointerleave: 'onPointerLeave',
    pointermove: 'onPointerMove',
    pointerout: 'onPointerOut',
    pointerover: 'onPointerOver',
    pointerup: 'onPointerUp',
    wheel: 'onWheel',
};
export const listenerNames = Object.keys(r3fEventToHandlerMap);
function getObjectListeners(object, forEvent) {
    if (object._listeners != null && forEvent in object._listeners) {
        return object._listeners[forEvent];
    }
    //R3F compatibility
    let handler;
    if (object.isVoidObject && forEvent === 'click' && object.parent?.__r3f != null) {
        handler = object.parent.__r3f.root.getState().onPointerMissed;
    }
    if (object.__r3f != null) {
        handler = object.__r3f.handlers[r3fEventToHandlerMap[forEvent]];
    }
    if (handler == null) {
        return undefined;
    }
    return [handler];
}
