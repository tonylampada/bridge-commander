import { effect } from '@preact/signals-core';
import { InstancedGlyph } from './instanced-glyph.js';
import { abortableEffect } from '../../utils.js';
import { toAbsoluteNumber } from '../utils.js';
import { parseNumberValue } from '../../properties/values.js';
export const additionalTextDefaults = {
    verticalAlign: 'middle',
};
export function createInstancedText(text, parentClippingRect, layoutSignal) {
    abortableEffect(() => {
        const font = text.fontSignal.value;
        const orderInfo = text.orderInfo.value;
        if (font == null || orderInfo == null) {
            return;
        }
        const instancedText = new InstancedText(text.root.value.glyphGroupManager.getGroup(orderInfo, text.properties.value.depthTest, text.properties.value.depthWrite ?? false, parseNumberValue(text.properties.value.renderOrder ?? 0), font), text.properties, layoutSignal, text.globalTextMatrix, text.isVisible, parentClippingRect);
        return () => instancedText.destroy();
    }, text.abortSignal);
}
export class InstancedText {
    group;
    properties;
    layoutSignal;
    matrix;
    parentClippingRect;
    glyphLines = [];
    unsubscribeInitialList = [];
    unsubscribeShowList = [];
    constructor(group, properties, layoutSignal, matrix, isVisible, parentClippingRect) {
        this.group = group;
        this.properties = properties;
        this.layoutSignal = layoutSignal;
        this.matrix = matrix;
        this.parentClippingRect = parentClippingRect;
        this.unsubscribeInitialList = [
            effect(() => {
                if (!isVisible.value || toAbsoluteNumber(this.properties.value.opacity, () => 1) < 0.01) {
                    this.hide();
                    return;
                }
                this.show();
            }),
        ];
    }
    show() {
        if (this.unsubscribeShowList.length > 0) {
            return;
        }
        traverseGlyphs(this.glyphLines, (glyph) => glyph.show());
        this.unsubscribeShowList.push(effect(() => {
            const matrix = this.matrix.value;
            if (matrix == null) {
                return;
            }
            traverseGlyphs(this.glyphLines, (glyph) => glyph.updateBaseMatrix(matrix));
        }), effect(() => {
            const clippingRect = this.parentClippingRect?.value;
            traverseGlyphs(this.glyphLines, (glyph) => glyph.updateClippingRect(clippingRect));
        }), effect(() => {
            const color = this.properties.value.color;
            const opacity = toAbsoluteNumber(this.properties.value.opacity, () => 1);
            traverseGlyphs(this.glyphLines, (glyph) => glyph.updateColor(color ?? 0, opacity));
        }), effect(() => {
            const layout = this.layoutSignal.value;
            if (layout == null) {
                return;
            }
            const { lines, fontSize = 16 } = layout;
            const linesLength = lines.length;
            const pixelSize = parseNumberValue(this.properties.value.pixelSize);
            for (let lineIndex = 0; lineIndex < linesLength; lineIndex++) {
                if (lineIndex === this.glyphLines.length) {
                    this.glyphLines.push([]);
                }
                const { entries } = lines[lineIndex];
                const glyphs = this.glyphLines[lineIndex];
                for (let glyphIndex = 0; glyphIndex < entries.length; glyphIndex++) {
                    const entry = entries[glyphIndex];
                    if (entry.type === 'whitespace') {
                        if (typeof glyphs[glyphIndex] === 'number') {
                            glyphs[glyphIndex] = entry.x;
                        }
                        else {
                            glyphs.splice(glyphIndex, 0, entry.x);
                        }
                        continue;
                    }
                    //non space character
                    //delete undefined entries so we find a reusable glyph
                    let glyphOrNumber = glyphs[glyphIndex];
                    while (glyphIndex < glyphs.length && typeof glyphOrNumber == 'number') {
                        glyphs.splice(glyphIndex, 1);
                        glyphOrNumber = glyphs[glyphIndex];
                    }
                    //the prev. loop assures that glyphOrNumber is a InstancedGlyph or undefined
                    let glyph = glyphOrNumber;
                    if (glyph == null) {
                        //no reusable glyph found
                        glyphs[glyphIndex] = glyph = new InstancedGlyph(this.group, this.matrix.peek(), this.properties.peek().color ?? 0, toAbsoluteNumber(this.properties.peek().opacity, () => 1), this.parentClippingRect?.peek());
                    }
                    glyph.updateGlyphAndTransformation(entry.glyphInfo, entry.x, entry.y, fontSize, pixelSize);
                    glyph.show();
                }
                //remove unnecassary glyphs
                const glyphsLength = glyphs.length;
                const newGlyphsLength = entries.length;
                for (let ii = newGlyphsLength; ii < glyphsLength; ii++) {
                    const glyph = glyphs[ii];
                    if (typeof glyph === 'number') {
                        continue;
                    }
                    glyph.hide();
                }
                glyphs.length = newGlyphsLength;
            }
            //remove unnecassary glyph lines
            traverseGlyphs(this.glyphLines, (glyph) => glyph.hide(), linesLength);
            this.glyphLines.length = linesLength;
        }));
    }
    hide() {
        const unsubscribeListLength = this.unsubscribeShowList.length;
        if (unsubscribeListLength === 0) {
            return;
        }
        for (let i = 0; i < unsubscribeListLength; i++) {
            this.unsubscribeShowList[i]();
        }
        this.unsubscribeShowList.length = 0;
        traverseGlyphs(this.glyphLines, (glyph) => glyph.hide());
    }
    destroy() {
        this.hide();
        this.glyphLines.length = 0;
        const length = this.unsubscribeInitialList.length;
        for (let i = 0; i < length; i++) {
            this.unsubscribeInitialList[i]();
        }
    }
}
function traverseGlyphs(glyphLines, fn, offset = 0) {
    const glyphLinesLength = glyphLines.length;
    for (let i = offset; i < glyphLinesLength; i++) {
        const glyphs = glyphLines[i];
        const glyphsLength = glyphs.length;
        for (let ii = 0; ii < glyphsLength; ii++) {
            const glyph = glyphs[ii];
            if (typeof glyph == 'number') {
                continue;
            }
            fn(glyph);
        }
    }
}
