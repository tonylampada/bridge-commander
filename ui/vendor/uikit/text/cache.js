import { TextureLoader } from 'three';
import { Font } from './font.js';
const fontCache = new Map();
const textureLoader = new TextureLoader();
export function loadCachedFont(fontInfoOrUrl, onLoad) {
    let entry = fontCache.get(fontInfoOrUrl);
    if (entry instanceof Set) {
        entry.add(onLoad);
        return;
    }
    if (entry != null) {
        onLoad(entry);
        return;
    }
    const set = new Set();
    set.add(onLoad);
    fontCache.set(fontInfoOrUrl, set);
    loadFont(fontInfoOrUrl)
        .then((font) => {
        for (const fn of set) {
            fn(font);
        }
        fontCache.set(fontInfoOrUrl, font);
    })
        .catch(console.error);
}
async function loadFont(fontInfoOrUrl) {
    const resolvedFontInfoOrUrl = await resolveFontInfoSource(fontInfoOrUrl);
    const info = typeof resolvedFontInfoOrUrl === 'object'
        ? resolvedFontInfoOrUrl
        : await (await fetch(resolvedFontInfoOrUrl)).json();
    if (info.pages.length !== 1) {
        throw new Error('only supporting exactly 1 page');
    }
    const page = await textureLoader.loadAsync(new URL(info.pages[0], typeof resolvedFontInfoOrUrl === 'string' ? new URL(resolvedFontInfoOrUrl, window.location.href) : undefined).href);
    page.flipY = false;
    return new Font(info, page);
}
function resolveFontInfoSource(fontInfoOrUrl) {
    return typeof fontInfoOrUrl === 'function' ? fontInfoOrUrl() : fontInfoOrUrl;
}
