import { array, boolean, custom, enum as enumSchema, lazy, literal, number, object, string, tuple, union } from 'zod';
import { Signal } from '@preact/signals-core';
import { Color } from 'three';
import { yogaPropertyShape } from '../flex/schema.js';
import { allAliases } from './alias.js';
import { FontFamiliesSchema, FontWeightSchema } from '../text/font.js';
import { isNumberString, isPercentageString, isPixelLengthString, isViewportLengthString, } from './values.js';
export function defineSchema(create) {
    return create();
}
const conditionals = [
    'dark',
    'hover',
    'active',
    'focus',
    'placeholderStyle',
    'important',
    'sm',
    'md',
    'lg',
    'xl',
    '2xl',
];
const isReadonlySignal = (value) => value instanceof Signal ||
    (value != null &&
        typeof value === 'object' &&
        'value' in value &&
        ('peek' in value || 'subscribe' in value || 'notify' in value));
const signalSchema = /* @__PURE__ */ defineSchema(() => custom(isReadonlySignal, 'Expected a signal-like object'));
export const functionSchema = /* @__PURE__ */ defineSchema(() => custom((value) => typeof value === 'function', 'Expected a function'));
const constructorSchema = /* @__PURE__ */ defineSchema(() => custom((value) => typeof value === 'function', 'Expected a constructor'));
export const instanceSchema = (name, ctor) => custom((value) => value instanceof ctor, `Expected ${name}`);
export const numberStringSchema = /* @__PURE__ */ defineSchema(() => custom(isNumberString, 'Expected a number string'));
export const percentageStringSchema = /* @__PURE__ */ defineSchema(() => custom(isPercentageString, 'Expected a percentage string'));
export const pixelLengthStringSchema = /* @__PURE__ */ defineSchema(() => custom(isPixelLengthString, 'Expected a pixel length string'));
export const viewportLengthStringSchema = /* @__PURE__ */ defineSchema(() => custom(isViewportLengthString, 'Expected a viewport length string'));
export const numberValueSchema = /* @__PURE__ */ defineSchema(() => union([number(), numberStringSchema]));
export const absoluteLengthValueSchema = /* @__PURE__ */ defineSchema(() => union([numberValueSchema, pixelLengthStringSchema]));
export const lengthValueSchema = /* @__PURE__ */ defineSchema(() => union([absoluteLengthValueSchema, percentageStringSchema, viewportLengthStringSchema]));
export const numberOrPercentageValueSchema = /* @__PURE__ */ defineSchema(() => union([numberValueSchema, percentageStringSchema]));
const colorTupleSchema = /* @__PURE__ */ defineSchema(() => union([tuple([number(), number(), number()]), tuple([number(), number(), number(), number()])]));
const colorValueSchema = /* @__PURE__ */ defineSchema(() => union([string(), number(), colorTupleSchema, instanceSchema('Color', Color)]));
const materialClassSchema = /* @__PURE__ */ defineSchema(() => union([enumSchema(['glass', 'metal', 'plastic']), constructorSchema]));
function propertyValueSchema(schema) {
    return union([schema, signalSchema, literal('initial')]);
}
export function createInPropertiesSchema(outSchema) {
    const outShape = outSchema.shape;
    const shape = {};
    const valueSchemas = new Map();
    for (const [key, schema] of Object.entries(outShape)) {
        const valueSchema = propertyValueSchema(schema);
        valueSchemas.set(key, valueSchema);
        shape[key] = valueSchema.optional();
    }
    for (const [alias, targets] of Object.entries(allAliases)) {
        const targetSchema = targets
            .map((target) => valueSchemas.get(target))
            .find((schema) => schema != null);
        if (targetSchema != null) {
            shape[alias] = targetSchema.optional();
        }
    }
    let result;
    result = lazy(() => {
        const recursiveShape = { ...shape, '*': result.optional() };
        for (const key of conditionals) {
            recursiveShape[key] = result.optional();
        }
        return object(recursiveShape).strict();
    });
    return result;
}
const eventHandlerShape = /* @__PURE__ */ defineSchema(() => ({
    onClick: functionSchema.optional(),
    onContextMenu: functionSchema.optional(),
    onDblClick: functionSchema.optional(),
    onWheel: functionSchema.optional(),
    onPointerUp: functionSchema.optional(),
    onPointerDown: functionSchema.optional(),
    onPointerOver: functionSchema.optional(),
    onPointerOut: functionSchema.optional(),
    onPointerEnter: functionSchema.optional(),
    onPointerLeave: functionSchema.optional(),
    onPointerMove: functionSchema.optional(),
    onPointerCancel: functionSchema.optional(),
}));
const panelShape = /* @__PURE__ */ defineSchema(() => ({
    borderTopLeftRadius: lengthValueSchema.optional(),
    borderTopRightRadius: lengthValueSchema.optional(),
    borderBottomLeftRadius: lengthValueSchema.optional(),
    borderBottomRightRadius: lengthValueSchema.optional(),
    backgroundColor: colorValueSchema.optional(),
    borderColor: colorValueSchema.optional(),
    borderBend: numberOrPercentageValueSchema.optional(),
}));
const scrollbarPanelShape = /* @__PURE__ */ defineSchema(() => ({
    scrollbarColor: colorValueSchema.optional(),
    scrollbarBorderRightWidth: absoluteLengthValueSchema.optional(),
    scrollbarBorderTopWidth: absoluteLengthValueSchema.optional(),
    scrollbarBorderLeftWidth: absoluteLengthValueSchema.optional(),
    scrollbarBorderBottomWidth: absoluteLengthValueSchema.optional(),
    scrollbarBorderTopLeftRadius: lengthValueSchema.optional(),
    scrollbarBorderTopRightRadius: lengthValueSchema.optional(),
    scrollbarBorderBottomLeftRadius: lengthValueSchema.optional(),
    scrollbarBorderBottomRightRadius: lengthValueSchema.optional(),
    scrollbarBorderColor: colorValueSchema.optional(),
    scrollbarBorderBend: numberOrPercentageValueSchema.optional(),
}));
const caretPanelShape = /* @__PURE__ */ defineSchema(() => ({
    caretColor: colorValueSchema.optional(),
    caretBorderRightWidth: absoluteLengthValueSchema.optional(),
    caretBorderTopWidth: absoluteLengthValueSchema.optional(),
    caretBorderLeftWidth: absoluteLengthValueSchema.optional(),
    caretBorderBottomWidth: absoluteLengthValueSchema.optional(),
    caretBorderTopLeftRadius: lengthValueSchema.optional(),
    caretBorderTopRightRadius: lengthValueSchema.optional(),
    caretBorderBottomLeftRadius: lengthValueSchema.optional(),
    caretBorderBottomRightRadius: lengthValueSchema.optional(),
    caretBorderColor: colorValueSchema.optional(),
    caretBorderBend: numberOrPercentageValueSchema.optional(),
}));
const selectionPanelShape = /* @__PURE__ */ defineSchema(() => ({
    selectionColor: colorValueSchema.optional(),
    selectionBorderRightWidth: absoluteLengthValueSchema.optional(),
    selectionBorderTopWidth: absoluteLengthValueSchema.optional(),
    selectionBorderLeftWidth: absoluteLengthValueSchema.optional(),
    selectionBorderBottomWidth: absoluteLengthValueSchema.optional(),
    selectionBorderTopLeftRadius: lengthValueSchema.optional(),
    selectionBorderTopRightRadius: lengthValueSchema.optional(),
    selectionBorderBottomLeftRadius: lengthValueSchema.optional(),
    selectionBorderBottomRightRadius: lengthValueSchema.optional(),
    selectionBorderColor: colorValueSchema.optional(),
    selectionBorderBend: numberOrPercentageValueSchema.optional(),
}));
const pointerEventsTypeFunctionSchema = /* @__PURE__ */ defineSchema(() => custom((value) => typeof value === 'function', 'Expected a pointer-events filter function'));
export const baseOutPropertyShape = /* @__PURE__ */ defineSchema(() => ({
    ...yogaPropertyShape,
    ...panelShape,
    zIndex: numberValueSchema.optional(),
    zIndexOffset: numberValueSchema.optional(),
    transformTranslateX: lengthValueSchema.optional(),
    transformTranslateY: lengthValueSchema.optional(),
    transformTranslateZ: absoluteLengthValueSchema.optional(),
    transformRotateX: numberValueSchema.optional(),
    transformRotateY: numberValueSchema.optional(),
    transformRotateZ: numberValueSchema.optional(),
    transformScaleX: numberOrPercentageValueSchema.optional(),
    transformScaleY: numberOrPercentageValueSchema.optional(),
    transformScaleZ: numberOrPercentageValueSchema.optional(),
    transformOriginX: enumSchema(['left', 'center', 'middle', 'right']).optional(),
    transformOriginY: enumSchema(['top', 'center', 'middle', 'bottom']).optional(),
    scrollbarWidth: absoluteLengthValueSchema.optional(),
    scrollbarZIndex: numberValueSchema.optional(),
    ...scrollbarPanelShape,
    panelMaterialClass: materialClassSchema.optional(),
    receiveShadow: boolean().optional(),
    castShadow: boolean().optional(),
    depthWrite: boolean().optional(),
    depthTest: boolean().optional(),
    renderOrder: numberValueSchema.optional(),
    visibility: enumSchema(['visible', 'hidden']).optional(),
    pointerEvents: enumSchema(['none', 'auto', 'listener']).optional(),
    pointerEventsType: union([
        literal('all'),
        pointerEventsTypeFunctionSchema,
        object({ allow: union([string(), array(string())]) }).strict(),
        object({ deny: union([string(), array(string())]) }).strict(),
    ]).optional(),
    pointerEventsOrder: numberValueSchema.optional(),
    ...eventHandlerShape,
    onScroll: functionSchema.optional(),
    onHoverChange: functionSchema.optional(),
    onActiveChange: functionSchema.optional(),
    textAlign: enumSchema(['left', 'center', 'middle', 'right', 'justify']).optional(),
    fill: colorValueSchema.optional(),
    color: colorValueSchema.optional(),
    opacity: numberOrPercentageValueSchema.optional(),
    fontFamily: string().optional(),
    fontWeight: FontWeightSchema.optional(),
    fontFamilies: FontFamiliesSchema.optional(),
    letterSpacing: lengthValueSchema.optional(),
    lineHeight: lengthValueSchema.optional(),
    fontSize: lengthValueSchema.optional(),
    wordBreak: enumSchema(['keep-all', 'break-all', 'break-word']).optional(),
    whiteSpace: enumSchema(['normal', 'collapse', 'pre', 'pre-line']).optional(),
    tabSize: numberValueSchema.optional(),
    verticalAlign: enumSchema(['top', 'center', 'middle', 'bottom']).optional(),
    caretWidth: absoluteLengthValueSchema.optional(),
    ...caretPanelShape,
    ...selectionPanelShape,
    pixelSize: numberValueSchema.optional(),
    sizeX: absoluteLengthValueSchema.optional(),
    sizeY: absoluteLengthValueSchema.optional(),
    anchorX: enumSchema(['left', 'center', 'middle', 'right']).optional(),
    anchorY: enumSchema(['top', 'center', 'middle', 'bottom']).optional(),
    cursor: string().optional(),
    id: string().optional(),
}));
export const baseOutPropertiesSchema = /* @__PURE__ */ defineSchema(() => object(baseOutPropertyShape).strict());
