import { convertYogaPoint, parseAbsoluteLengthValue } from '../properties/values.js';
function convertEnum(lut, input, defaultValue) {
    if (input == null) {
        return defaultValue;
    }
    const resolvedValue = lut[input];
    if (resolvedValue == null) {
        throw new Error(`unexpected value ${input}, expected ${Object.keys(lut).join(', ')}`);
    }
    return resolvedValue;
}
function convertPoint(input, root) {
    const [width, height] = root.component.size.value ?? [0, 0];
    return convertYogaPoint(input, width, height);
}
function convertNumber(input) {
    return input == null ? undefined : parseAbsoluteLengthValue(input);
}
const POSITION_TYPE_LUT = {
    static: 0,
    relative: 1,
    absolute: 2,
};
const ALIGN_LUT = {
    auto: 0,
    'flex-start': 1,
    center: 2,
    'flex-end': 3,
    stretch: 4,
    baseline: 5,
    'space-between': 6,
    'space-around': 7,
    'space-evenly': 8,
};
const FLEX_DIRECTION_LUT = {
    column: 0,
    'column-reverse': 1,
    row: 2,
    'row-reverse': 3,
};
const WRAP_LUT = {
    'no-wrap': 0,
    wrap: 1,
    'wrap-reverse': 2,
};
const JUSTIFY_LUT = {
    'flex-start': 0,
    center: 1,
    'flex-end': 2,
    'space-between': 3,
    'space-around': 4,
    'space-evenly': 5,
};
const OVERFLOW_LUT = {
    visible: 0,
    hidden: 1,
    scroll: 2,
};
const DISPLAY_LUT = {
    flex: 0,
    none: 1,
    contents: 2,
};
export const setter = {
    positionType: (root, node, input) => {
        node.setPositionType(convertEnum(POSITION_TYPE_LUT, input, 1));
    },
    positionTop: (root, node, input) => {
        if (input === 'auto') {
            node.setPositionAuto(1);
            return;
        }
        node.setPosition(1, convertPoint(input, root));
    },
    positionLeft: (root, node, input) => {
        if (input === 'auto') {
            node.setPositionAuto(0);
            return;
        }
        node.setPosition(0, convertPoint(input, root));
    },
    positionRight: (root, node, input) => {
        if (input === 'auto') {
            node.setPositionAuto(2);
            return;
        }
        node.setPosition(2, convertPoint(input, root));
    },
    positionBottom: (root, node, input) => {
        if (input === 'auto') {
            node.setPositionAuto(3);
            return;
        }
        node.setPosition(3, convertPoint(input, root));
    },
    alignContent: (root, node, input) => {
        node.setAlignContent(convertEnum(ALIGN_LUT, input, 4));
    },
    alignItems: (root, node, input) => {
        node.setAlignItems(convertEnum(ALIGN_LUT, input, 4));
    },
    alignSelf: (root, node, input) => {
        node.setAlignSelf(convertEnum(ALIGN_LUT, input, 0));
    },
    flexDirection: (root, node, input) => {
        node.setFlexDirection(convertEnum(FLEX_DIRECTION_LUT, input, 2));
    },
    flexWrap: (root, node, input) => {
        node.setFlexWrap(convertEnum(WRAP_LUT, input, 0));
    },
    justifyContent: (root, node, input) => {
        node.setJustifyContent(convertEnum(JUSTIFY_LUT, input, 0));
    },
    marginTop: (root, node, input) => {
        if (input === 'auto') {
            node.setMarginAuto(1);
            return;
        }
        node.setMargin(1, convertPoint(input, root));
    },
    marginLeft: (root, node, input) => {
        if (input === 'auto') {
            node.setMarginAuto(0);
            return;
        }
        node.setMargin(0, convertPoint(input, root));
    },
    marginRight: (root, node, input) => {
        if (input === 'auto') {
            node.setMarginAuto(2);
            return;
        }
        node.setMargin(2, convertPoint(input, root));
    },
    marginBottom: (root, node, input) => {
        if (input === 'auto') {
            node.setMarginAuto(3);
            return;
        }
        node.setMargin(3, convertPoint(input, root));
    },
    flexBasis: (root, node, input) => {
        if (input === 'auto') {
            node.setFlexBasisAuto();
            return;
        }
        node.setFlexBasis(convertPoint(input, root) ?? NaN);
    },
    flexGrow: (root, node, input) => {
        node.setFlexGrow(convertNumber(input) ?? 0);
    },
    flexShrink: (root, node, input) => {
        node.setFlexShrink(convertNumber(input) ?? 1);
    },
    width: (root, node, input) => {
        if (input === 'auto') {
            node.setWidthAuto();
            return;
        }
        node.setWidth(convertPoint(input, root) ?? NaN);
    },
    height: (root, node, input) => {
        if (input === 'auto') {
            node.setHeightAuto();
            return;
        }
        node.setHeight(convertPoint(input, root) ?? NaN);
    },
    minWidth: (root, node, input) => {
        node.setMinWidth(convertPoint(input, root));
    },
    minHeight: (root, node, input) => {
        node.setMinHeight(convertPoint(input, root));
    },
    maxWidth: (root, node, input) => {
        node.setMaxWidth(convertPoint(input, root));
    },
    maxHeight: (root, node, input) => {
        node.setMaxHeight(convertPoint(input, root));
    },
    boxSizing: (root, node, input) => {
        node.setBoxSizing(convertNumber(input) ?? 0);
    },
    aspectRatio: (root, node, input) => {
        node.setAspectRatio(convertNumber(input));
    },
    borderTopWidth: (root, node, input) => {
        node.setBorder(1, convertNumber(input));
    },
    borderLeftWidth: (root, node, input) => {
        node.setBorder(0, convertNumber(input));
    },
    borderRightWidth: (root, node, input) => {
        node.setBorder(2, convertNumber(input));
    },
    borderBottomWidth: (root, node, input) => {
        node.setBorder(3, convertNumber(input));
    },
    overflow: (root, node, input) => {
        node.setOverflow(convertEnum(OVERFLOW_LUT, input, 0));
    },
    display: (root, node, input) => {
        node.setDisplay(convertEnum(DISPLAY_LUT, input, 0));
    },
    paddingTop: (root, node, input) => {
        node.setPadding(1, convertPoint(input, root));
    },
    paddingLeft: (root, node, input) => {
        node.setPadding(0, convertPoint(input, root));
    },
    paddingRight: (root, node, input) => {
        node.setPadding(2, convertPoint(input, root));
    },
    paddingBottom: (root, node, input) => {
        node.setPadding(3, convertPoint(input, root));
    },
    gapRow: (root, node, input) => {
        node.setGap(1, convertPoint(input, root));
    },
    gapColumn: (root, node, input) => {
        node.setGap(0, convertPoint(input, root));
    },
    direction: (root, node, input) => {
        node.setDirection(convertNumber(input) ?? 0);
    },
};
