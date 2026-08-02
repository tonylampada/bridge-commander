import { abortableEffect } from '../../utils.js';
import { parseNumberValue } from '../../properties/values.js';
export function createHtmlInputElement(onChange, multiline, onSelectionChange) {
    const element = document.createElement(multiline ? 'textarea' : 'input');
    const style = element.style;
    style.setProperty('position', 'absolute');
    style.setProperty('left', '-1000vw');
    style.setProperty('top', '0');
    style.setProperty('pointerEvents', 'none');
    style.setProperty('opacity', '0');
    element.addEventListener('input', () => {
        onChange?.(element.value);
        onSelectionChange();
    });
    element.addEventListener('focus', onSelectionChange);
    element.addEventListener('keydown', onSelectionChange);
    element.addEventListener('keyup', onSelectionChange);
    element.addEventListener('blur', onSelectionChange);
    return element;
}
export function setupHtmlInputElement(properties, element, value, abortSignal) {
    document.body.appendChild(element);
    abortSignal.addEventListener('abort', () => element.remove());
    abortableEffect(() => {
        element.value = value.value;
    }, abortSignal);
    abortableEffect(() => {
        element.disabled = properties.value.disabled;
    }, abortSignal);
    abortableEffect(() => {
        element.tabIndex = parseNumberValue(properties.value.tabIndex);
    }, abortSignal);
    abortableEffect(() => {
        element.autocomplete = properties.value.autocomplete;
    }, abortSignal);
    abortableEffect(() => element.setAttribute('type', properties.value.type), abortSignal);
}
export function setupUpdateHasFocus(element, hasFocusSignal, onFocusChange, abortSignal) {
    if (abortSignal.aborted) {
        return;
    }
    hasFocusSignal.value = document.activeElement === element;
    const listener = () => {
        const hasFocus = document.activeElement === element;
        if (hasFocus == hasFocusSignal.value) {
            return;
        }
        hasFocusSignal.value = hasFocus;
        onFocusChange(hasFocus);
    };
    element.addEventListener('focus', listener);
    element.addEventListener('blur', listener);
    abortSignal.addEventListener('abort', () => {
        element.removeEventListener('focus', listener);
        element.removeEventListener('blur', listener);
    });
}
