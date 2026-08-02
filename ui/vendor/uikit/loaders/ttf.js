import { FileLoader, Loader } from 'three';
const DEFAULT_OPTIONS = Object.freeze({
    charset: ' \tABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?.,;:\'"()-[]{}@#$%&*+=/\\<>',
    fontSize: 48,
    textureSize: [512, 512],
    fieldRange: 4,
    padding: 4,
    fixOverlaps: true,
});
function normalizeInput(input) {
    const items = Array.isArray(input) ? input : [input];
    return items.map((item, index) => {
        if (typeof item === 'string')
            return { url: item };
        if (!item.url)
            throw new Error(`TTFLoader: Font at index ${index} is missing 'url'`);
        return { ...item, url: item.url };
    });
}
export class TTFLoader extends Loader {
    constructor(manager) {
        super(manager);
    }
    load(input, onLoad, onProgress, onError) {
        this.loadAsync(input, onProgress)
            .then(onLoad)
            .catch((err) => {
            if (onError) {
                onError(err);
            }
            else {
                console.error('TTFLoader:', err);
            }
        });
    }
    async loadAsync(input, onProgress) {
        const fonts = normalizeInput(input);
        const arrayBuffers = await this._loadFontFiles(fonts, onProgress);
        return this._generate(arrayBuffers, fonts);
    }
    async _loadFontFiles(fonts, onProgress) {
        const loader = new FileLoader(this.manager);
        loader.setResponseType('arraybuffer');
        loader.setPath(this.path);
        loader.setRequestHeader(this.requestHeader);
        loader.setWithCredentials(this.withCredentials);
        const loadPromises = fonts.map((font) => loader.loadAsync(font.url, onProgress));
        return Promise.all(loadPromises);
    }
    async _generate(arrayBuffers, fonts) {
        const { MSDF } = await import('@zappar/msdf-generator');
        const generator = new MSDF();
        try {
            await generator.initialize();
            const fontConfigs = arrayBuffers.map((arrayBuffer, index) => {
                const opts = fonts[index];
                return {
                    font: new Uint8Array(arrayBuffer),
                    charset: opts?.charset ?? DEFAULT_OPTIONS.charset,
                    fontSize: opts?.fontSize ?? DEFAULT_OPTIONS.fontSize,
                    textureSize: opts?.textureSize ?? DEFAULT_OPTIONS.textureSize,
                    fieldRange: opts?.fieldRange ?? DEFAULT_OPTIONS.fieldRange,
                    padding: opts?.padding ?? DEFAULT_OPTIONS.padding,
                    fixOverlaps: opts?.fixOverlaps ?? DEFAULT_OPTIONS.fixOverlaps,
                };
            });
            if (fontConfigs.length === 1) {
                const [config] = fontConfigs;
                const [font] = fonts;
                return await generator.generate({ ...config, onProgress: font?.onProgress });
            }
            return await generator.generate({ fonts: fontConfigs });
        }
        catch (err) {
            const urls = fonts.map((f) => f.url).join(', ');
            throw new Error(`TTFLoader: MSDF generation failed for ${urls}: ${err instanceof Error ? err.message : err}`);
        }
        finally {
            generator.dispose();
        }
    }
}
