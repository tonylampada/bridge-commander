export function updateHtmlSelectionRange(target, element) {
    const selectionStart = element?.selectionStart;
    const selectionEnd = element?.selectionEnd;
    const next = selectionStart == null || selectionEnd == null ? undefined : [selectionStart, selectionEnd];
    const current = target.peek();
    if (current?.[0] === next?.[0] && current?.[1] === next?.[1]) {
        return;
    }
    target.value = next;
}
