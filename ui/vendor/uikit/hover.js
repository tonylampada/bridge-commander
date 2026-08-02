import { addHandler } from './utils.js';
export function setupCursorCleanup(hoveredSignal, abortSignal) {
    //cleanup cursor effect
    abortSignal.addEventListener('abort', () => unsetCursorType(hoveredSignal));
}
/**
 * must be executed inside effect/computed
 */
export function addHoverHandlers(target, properties, hoveredSignal, hasHoverConditionalInProperties, hasHoverConditionalInStarProperties) {
    const cursor = properties.value.cursor;
    const onHoverChange = properties.value.onHoverChange;
    if (!hasHoverConditionalInStarProperties.value &&
        !hasHoverConditionalInProperties.value &&
        onHoverChange == null &&
        cursor == null) {
        //no need to trigger a "push" by writing to .value because nobody should listen to hoveredSignal anyways
        hoveredSignal.value.length = 0;
        return;
    }
    addHandler('onPointerEnter', target, ({ pointerId }) => {
        if (pointerId == null) {
            return;
        }
        hoveredSignal.value = [pointerId, ...hoveredSignal.value];
        if (hoveredSignal.value.length === 1) {
            onHoverChange?.(true);
        }
        if (cursor != null) {
            setCursorType(hoveredSignal, cursor);
        }
    });
    addHandler('onPointerLeave', target, ({ pointerId }) => {
        hoveredSignal.value = hoveredSignal.value.filter((id) => id != pointerId);
        if (hoveredSignal.value.length === 0) {
            onHoverChange?.(false);
        }
        unsetCursorType(hoveredSignal);
    });
}
const cursorRefStack = [];
const cursorTypeStack = [];
function setCursorType(ref, type) {
    cursorRefStack.push(ref);
    cursorTypeStack.push(type);
    //console.log('set; curent: ', ...cursorTypeStack)
    document.body.style.cursor = type;
}
function unsetCursorType(ref) {
    const index = cursorRefStack.indexOf(ref);
    if (index == -1) {
        return;
    }
    cursorRefStack.splice(index, 1);
    cursorTypeStack.splice(index, 1);
    //console.log('unset; curent: ', ...cursorTypeStack)
    document.body.style.cursor = cursorTypeStack[cursorTypeStack.length - 1] ?? 'default';
}
