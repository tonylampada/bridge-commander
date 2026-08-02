import { parseAbsoluteNumber } from '../properties/values.js';
export function getGlyphOffsetX(glyphInfo, fontSize) {
    return glyphInfo.xoffset * fontSize;
}
export function getKerningOffset(font, fontSize, prevGlyphId, glyphInfo) {
    if (prevGlyphId == null)
        return 0;
    return font.getKerning(prevGlyphId, glyphInfo.id) * fontSize;
}
export function toAbsoluteNumber(value, getRelativeValue, root) {
    const [width, height] = root?.component.size.value ?? [];
    return parseAbsoluteNumber(value, getRelativeValue, width, height);
}
export function getGlyphOffsetY(fontSize, lineHeight, glyphInfo) {
    //glyphInfo undefined for the caret, which has no yoffset
    return (glyphInfo?.yoffset ?? 0) * fontSize + (lineHeight - fontSize) / 2;
}
export function getOffsetToNextGlyph(fontSize, glyphInfo, letterSpacing) {
    return glyphInfo.xadvance * fontSize + letterSpacing;
}
export function getOffsetToNextLine(lineHeight) {
    return lineHeight;
}
export function getGlyphLayoutWidth(layout) {
    return Math.max(...layout.lines.map(({ nonWhitespaceWidth }) => nonWhitespaceWidth));
}
export function getGlyphLayoutHeight(linesAmount, lineHeight) {
    return Math.max(linesAmount, 1) * lineHeight;
}
