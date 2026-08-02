import { computed } from '@preact/signals-core';
import { PanelGroupManager } from './panel/instance/group-manager.js';
import { abortableEffect, alignmentXMap, alignmentYMap } from './utils.js';
import { Matrix4 } from 'three';
import { GlyphGroupManager } from './text/render/instanced-glyph-group.js';
import { parseNumberValue } from './properties/values.js';
export function buildRootContext(component, renderContext) {
    const root = computed(() => component.parentContainer.value == null
        ? createRootContext(component, renderContext)
        : component.parentContainer.value.root.value);
    abortableEffect(() => {
        const rootValue = root.value;
        if (rootValue.component != component || !component.isAttached.value) {
            return;
        }
        const abortController = new AbortController();
        rootValue.glyphGroupManager.init(abortController.signal);
        rootValue.panelGroupManager.init(abortController.signal);
        rootValue.requestCalculateLayout = createDeferredRequestLayoutCalculation(rootValue, component);
        const onFrame = () => void (rootValue.reversePainterSortStableCache = undefined);
        rootValue.onFrameSet.add(onFrame);
        abortController.signal.addEventListener('abort', () => rootValue.onFrameSet.delete(onFrame));
        return () => abortController.abort();
    }, component.abortSignal);
    return root;
}
function createRootContext(component, renderContext) {
    const ctx = {
        isUpdateRunning: false,
        onFrameSet: new Set(),
        requestFrame: renderContext?.requestFrame,
        requestRender() {
            if (ctx.isUpdateRunning) {
                //request render unnecassary -> while render after updates ran
                return;
            }
            //not updating -> requesting a new frame so we will render after updating
            renderContext?.requestFrame();
        },
        onUpdateMatrixWorldSet: new Set(),
        requestCalculateLayout: () => { },
        component,
    };
    return Object.assign(ctx, {
        glyphGroupManager: new GlyphGroupManager(ctx, component),
        panelGroupManager: new PanelGroupManager(ctx, component),
    });
}
function createDeferredRequestLayoutCalculation(root, component) {
    let requested = true;
    const onFrame = () => {
        if (!requested) {
            return;
        }
        requested = false;
        component.node.calculateLayout();
    };
    root.onFrameSet.add(onFrame);
    component.abortSignal.addEventListener('abort', () => root.onFrameSet.delete(onFrame));
    return () => {
        requested = true;
        root.requestFrame?.();
    };
}
export function buildRootMatrix(properties, size) {
    const sizeValue = size.value;
    if (sizeValue == null) {
        return undefined;
    }
    const [width, height] = sizeValue;
    const pixelSize = parseNumberValue(properties.value.pixelSize);
    return new Matrix4().makeTranslation(alignmentXMap[properties.value.anchorX] * width * pixelSize, alignmentYMap[properties.value.anchorY] * height * pixelSize, 0);
}
