import { any as anySchema, custom, enum as enumSchema, number, partialRecord, record, string, union, } from 'zod';
import { computed, effect, signal } from '@preact/signals-core';
import { loadCachedFont } from './cache.js';
import { isNumberString } from '../properties/values.js';
import { defineSchema } from '../properties/schema.js';
export const fontWeightNames = {
    thin: 100,
    'extra-light': 200,
    light: 300,
    normal: 400,
    medium: 500,
    'semi-bold': 600,
    bold: 700,
    'extra-bold': 800,
    black: 900,
    'extra-black': 950,
};
const numberStringSchema = /* @__PURE__ */ defineSchema(() => custom(isNumberString, 'Expected a number string'));
const namedFontWeightSchema = /* @__PURE__ */ defineSchema(() => enumSchema(Object.keys(fontWeightNames)));
const fontWeightKeySchema = /* @__PURE__ */ defineSchema(() => union([namedFontWeightSchema, numberStringSchema]));
export const FontWeightSchema = /* @__PURE__ */ defineSchema(() => union([number(), namedFontWeightSchema, numberStringSchema]));
const fontFamilyWeightMapEntrySchema = /* @__PURE__ */ defineSchema(() => anySchema());
export const FontFamilyWeightMapSchema = /* @__PURE__ */ defineSchema(() => partialRecord(fontWeightKeySchema, fontFamilyWeightMapEntrySchema));
export const FontFamiliesSchema = /* @__PURE__ */ defineSchema(() => record(string(), FontFamilyWeightMapSchema));
const defaultFontFamiles = {
    inter: {
        light: () => import('@pmndrs/msdfonts/inter').then(({ inter }) => inter.light),
        medium: () => import('@pmndrs/msdfonts/inter').then(({ inter }) => inter.medium),
        'semi-bold': () => import('@pmndrs/msdfonts/inter').then(({ inter }) => inter['semi-bold']),
        bold: () => import('@pmndrs/msdfonts/inter').then(({ inter }) => inter.bold),
    },
};
export function computedFontFamilies(properties, parent) {
    return computed(() => {
        const currentFontFamilies = properties.value.fontFamilies;
        const inheritedFontFamilies = parent.value?.fontFamilies.value;
        if (inheritedFontFamilies == null) {
            return currentFontFamilies;
        }
        if (currentFontFamilies == null) {
            return inheritedFontFamilies;
        }
        return {
            ...inheritedFontFamilies,
            ...currentFontFamilies,
        };
    });
}
export function computedFont(properties, fontFamiliesSignal) {
    const result = signal(undefined);
    effect(() => {
        if (!properties.enabled.value) {
            return;
        }
        let fontWeight = properties.value.fontWeight;
        if (typeof fontWeight === 'string') {
            fontWeight = parseFloat(fontWeight);
            if (isNaN(fontWeight)) {
                fontWeight = properties.value.fontWeight;
                if (!(fontWeight in fontWeightNames)) {
                    throw new Error(`unknown font weight "${fontWeight}"`);
                }
                fontWeight = fontWeightNames[fontWeight];
            }
        }
        let fontFamily = properties.value.fontFamily;
        const fontFamilies = fontFamiliesSignal.value ?? defaultFontFamiles;
        fontFamily ??= Object.keys(fontFamilies)[0];
        let fontFamilyWeightMap = fontFamilies[fontFamily];
        if (fontFamilyWeightMap == null) {
            const availableFontFamilyList = Object.keys(fontFamilies);
            fontFamilyWeightMap = fontFamilies[availableFontFamilyList[0]];
            console.error(`unknown font family "${fontFamily}". Available font families are ${availableFontFamilyList.map((name) => `"${name}"`).join(', ')}. Falling back to "${availableFontFamilyList[0]}".`);
        }
        const url = getMatchingFontUrl(fontFamilyWeightMap, fontWeight);
        let aborted = false;
        loadCachedFont(url, (font) => !aborted && (result.value = font));
        return () => (aborted = true);
    });
    return result;
}
function getMatchingFontUrl(fontFamily, weight) {
    let distance = Infinity;
    let result;
    for (const fontWeight of Object.keys(fontFamily)) {
        const d = Math.abs(weight - getWeightNumber(fontWeight));
        if (d === 0) {
            return fontFamily[fontWeight];
        }
        if (d < distance) {
            distance = d;
            result = fontFamily[fontWeight];
        }
    }
    if (result == null) {
        throw new Error(`font family has no entries ${fontFamily}`);
    }
    return result;
}
function getWeightNumber(value) {
    if (value in fontWeightNames) {
        return fontWeightNames[value];
    }
    const number = parseFloat(value);
    if (isNaN(number)) {
        throw new Error(`invalid font weight "${value}"`);
    }
    return number;
}
const MISSING_GLYPH = {
    id: -1,
    index: 0,
    char: '',
    chnl: 0,
    page: 0,
    x: 0,
    y: 0,
    width: 0.5,
    height: 0.5,
    xadvance: 0.6,
    xoffset: 0,
    yoffset: 0.3,
    uvX: 0,
    uvY: 0,
    uvWidth: 0,
    uvHeight: 0,
    renderSolid: true,
};
export class Font {
    page;
    glyphInfoMap = new Map();
    kerningMap = new Map();
    //needed in the shader:
    pageWidth;
    pageHeight;
    distanceRange;
    constructor(info, page) {
        this.page = page;
        const { scaleW, scaleH, lineHeight } = info.common;
        const { size } = info.info;
        this.pageWidth = scaleW;
        this.pageHeight = scaleH;
        this.distanceRange = info.distanceField.distanceRange;
        for (const glyph of info.chars) {
            const normalizedGlyph = {
                ...glyph,
                uvX: glyph.x / scaleW,
                uvY: glyph.y / scaleH,
                uvWidth: glyph.width / scaleW,
                uvHeight: glyph.height / scaleH,
                width: glyph.width / size,
                height: glyph.height / size,
                xadvance: glyph.xadvance / size,
                xoffset: glyph.xoffset / size,
                yoffset: (glyph.yoffset - (lineHeight - size)) / size,
            };
            this.glyphInfoMap.set(normalizedGlyph.char, normalizedGlyph);
        }
        for (const { first, second, amount } of info.kernings) {
            this.kerningMap.set(`${first}/${second}`, amount / size);
        }
    }
    getGlyphInfo(char) {
        const glyph = this.glyphInfoMap.get(char);
        if (glyph)
            return glyph;
        if (char === '\n') {
            const space = this.glyphInfoMap.get(' ');
            if (space)
                return space;
        }
        console.warn(`Missing glyph info for character "${char}"`);
        return MISSING_GLYPH;
    }
    getKerning(firstId, secondId) {
        return this.kerningMap.get(`${firstId}/${secondId}`) ?? 0;
    }
}
export function glyphIntoToUV(info, target, offset) {
    target[offset + 0] = info.uvX;
    target[offset + 1] = info.uvY + info.uvHeight;
    target[offset + 2] = info.uvWidth;
    target[offset + 3] = -info.uvHeight;
}
