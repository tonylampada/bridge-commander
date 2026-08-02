export class HtmlEvent {
    nativeEvent;
    NONE = 0;
    CAPTURING_PHASE = 1;
    AT_TARGET = 2;
    BUBBLING_PHASE = 3;
    relatedTarget = null;
    get altKey() {
        return this.getFromNative('altKey', false);
    }
    get button() {
        return this.getFromNative('button', 0);
    }
    get buttons() {
        return this.getFromNative('buttons', 0);
    }
    get clientX() {
        return this.getFromNative('clientX', 0);
    }
    get clientY() {
        return this.getFromNative('clientY', 0);
    }
    get ctrlKey() {
        return this.getFromNative('ctrlKey', false);
    }
    get layerX() {
        return this.getFromNative('layerX', 0);
    }
    get layerY() {
        return this.getFromNative('layerY', 0);
    }
    get metaKey() {
        return this.getFromNative('metaKey', false);
    }
    get movementX() {
        return this.getFromNative('movementX', 0);
    }
    get movementY() {
        return this.getFromNative('movementY', 0);
    }
    get offsetX() {
        return this.getFromNative('offsetX', 0);
    }
    get offsetY() {
        return this.getFromNative('offsetY', 0);
    }
    get pageX() {
        return this.getFromNative('pageX', 0);
    }
    get pageY() {
        return this.getFromNative('pageY', 0);
    }
    get screenX() {
        return this.getFromNative('screenX', 0);
    }
    get screenY() {
        return this.getFromNative('screenY', 0);
    }
    get shiftKey() {
        return this.getFromNative('shiftKey', false);
    }
    get x() {
        return this.getFromNative('x', 0);
    }
    get y() {
        return this.getFromNative('y', 0);
    }
    get detail() {
        return this.getFromNative('detail', 0);
    }
    get view() {
        return this.getFromNative('view', null);
    }
    get which() {
        return this.getFromNative('which', 0);
    }
    get cancelBubble() {
        return this.getFromNative('cancelBubble', false);
    }
    get composed() {
        return this.getFromNative('composed', false);
    }
    get eventPhase() {
        return this.getFromNative('eventPhase', 0);
    }
    get isTrusted() {
        return this.getFromNative('isTrusted', false);
    }
    get returnValue() {
        return this.getFromNative('returnValue', false);
    }
    get timeStamp() {
        return this.getFromNative('timeStamp', 0);
    }
    get cancelable() {
        return this.getFromNative('cancelable', false);
    }
    get defaultPrevented() {
        return this.getFromNative('defaultPrevented', false);
    }
    constructor(nativeEvent) {
        this.nativeEvent = nativeEvent;
    }
    getFromNative(key, defaultValue) {
        if (key in this.nativeEvent) {
            return this.nativeEvent[key];
        }
        return defaultValue;
    }
}
