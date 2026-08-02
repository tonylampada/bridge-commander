import { custom, enum as enumSchema, literal, number, object, union } from 'zod';
import { isNumberString, isPercentageString, isPixelLengthString, isViewportLengthString, } from '../properties/values.js';
function defineSchema(create) {
    return create();
}
const numberStringSchema = /* @__PURE__ */ defineSchema(() => custom(isNumberString, 'Expected a number string'));
const percentageStringSchema = /* @__PURE__ */ defineSchema(() => custom(isPercentageString, 'Expected a percentage string'));
const pixelLengthStringSchema = /* @__PURE__ */ defineSchema(() => custom(isPixelLengthString, 'Expected a pixel length string'));
const viewportLengthStringSchema = /* @__PURE__ */ defineSchema(() => custom(isViewportLengthString, 'Expected a viewport length string'));
const numberValueSchema = /* @__PURE__ */ defineSchema(() => union([number(), numberStringSchema]));
const absoluteLengthValueSchema = /* @__PURE__ */ defineSchema(() => union([numberValueSchema, pixelLengthStringSchema]));
export const yogaLengthValueSchema = /* @__PURE__ */ defineSchema(() => union([numberValueSchema, pixelLengthStringSchema, percentageStringSchema, viewportLengthStringSchema]));
export const yogaLengthValueOrAutoSchema = /* @__PURE__ */ defineSchema(() => union([yogaLengthValueSchema, literal('auto')]));
export const yogaPropertyShape = /* @__PURE__ */ defineSchema(() => ({
    positionType: enumSchema(['static', 'relative', 'absolute']).optional(),
    positionTop: yogaLengthValueOrAutoSchema.optional(),
    positionLeft: yogaLengthValueOrAutoSchema.optional(),
    positionRight: yogaLengthValueOrAutoSchema.optional(),
    positionBottom: yogaLengthValueOrAutoSchema.optional(),
    alignContent: enumSchema([
        'auto',
        'flex-start',
        'center',
        'flex-end',
        'stretch',
        'baseline',
        'space-between',
        'space-around',
        'space-evenly',
    ]).optional(),
    alignItems: enumSchema([
        'auto',
        'flex-start',
        'center',
        'flex-end',
        'stretch',
        'baseline',
        'space-between',
        'space-around',
        'space-evenly',
    ]).optional(),
    alignSelf: enumSchema([
        'auto',
        'flex-start',
        'center',
        'flex-end',
        'stretch',
        'baseline',
        'space-between',
        'space-around',
        'space-evenly',
    ]).optional(),
    flexDirection: enumSchema(['column', 'column-reverse', 'row', 'row-reverse']).optional(),
    flexWrap: enumSchema(['no-wrap', 'wrap', 'wrap-reverse']).optional(),
    justifyContent: enumSchema([
        'flex-start',
        'center',
        'flex-end',
        'space-between',
        'space-around',
        'space-evenly',
    ]).optional(),
    marginTop: yogaLengthValueOrAutoSchema.optional(),
    marginLeft: yogaLengthValueOrAutoSchema.optional(),
    marginRight: yogaLengthValueOrAutoSchema.optional(),
    marginBottom: yogaLengthValueOrAutoSchema.optional(),
    flexBasis: yogaLengthValueOrAutoSchema.optional(),
    flexGrow: numberValueSchema.optional(),
    flexShrink: numberValueSchema.optional(),
    width: yogaLengthValueOrAutoSchema.optional(),
    height: yogaLengthValueOrAutoSchema.optional(),
    minWidth: yogaLengthValueSchema.optional(),
    minHeight: yogaLengthValueSchema.optional(),
    maxWidth: yogaLengthValueSchema.optional(),
    maxHeight: yogaLengthValueSchema.optional(),
    boxSizing: numberValueSchema.optional(),
    aspectRatio: numberValueSchema.optional(),
    borderTopWidth: absoluteLengthValueSchema.optional(),
    borderLeftWidth: absoluteLengthValueSchema.optional(),
    borderRightWidth: absoluteLengthValueSchema.optional(),
    borderBottomWidth: absoluteLengthValueSchema.optional(),
    overflow: enumSchema(['visible', 'hidden', 'scroll']).optional(),
    display: enumSchema(['flex', 'none', 'contents']).optional(),
    paddingTop: yogaLengthValueSchema.optional(),
    paddingLeft: yogaLengthValueSchema.optional(),
    paddingRight: yogaLengthValueSchema.optional(),
    paddingBottom: yogaLengthValueSchema.optional(),
    gapRow: yogaLengthValueSchema.optional(),
    gapColumn: yogaLengthValueSchema.optional(),
    direction: numberValueSchema.optional(),
}));
export const yogaOutPropertiesSchema = /* @__PURE__ */ defineSchema(() => object(yogaPropertyShape).strict());
