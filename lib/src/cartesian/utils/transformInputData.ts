import { type ScaleLinear } from "d3-scale";
import {
  DEFAULT_TICK_COUNT,
  downsampleTicks,
  getDomainFromTicks,
} from "../../utils/tickHelpers";
import type {
  AxisProps,
  NumericalFields,
  PrimitiveViewWindow,
  SidedNumber,
  TransformedData,
  InputFields,
  MaybeNumber,
  NonEmptyArray,
} from "../../types";
import { asNumber } from "../../utils/asNumber";
import { makeScale } from "./makeScale";

/**
 * This is a fatty. Takes raw user input data, and transforms it into a format
 *  that's easier for us to consume. End result looks something like:
 *  {
 *    ix: [1, 2, 3], // input x values
 *    ox: [10, 20, 30], // canvas x values
 *    y: {
 *      high: { i: [3, 4, 5], o: [30, 40, 50] },
 *      low: { ... }
 *    }
 *  }
 *  This form allows us to easily e.g. do a binary search to find closest output x index
 *   and then map that into each of the other value lists.
 */
export const transformInputData = <
  RawData extends Record<string, unknown>,
  XK extends keyof InputFields<RawData>,
  YK extends keyof NumericalFields<RawData>,
>({
  data: _data,
  xKey,
  yKeys,
  outputWindow,
  axisOptions,
  domain,
  domainPadding,
}: {
  data: RawData[];
  xKey: XK;
  yKeys: YK[];
  outputWindow: PrimitiveViewWindow;
  axisOptions?: Partial<
    Omit<AxisProps<RawData, XK, YK>, "xScale" | "yScale">
  >[];
  domain?: { x?: [number] | [number, number]; y?: [number] | [number, number] };
  domainPadding?: SidedNumber;
}): TransformedData<RawData, XK, YK> & {
  xScale: ScaleLinear<number, number>;
  isNumericalData: boolean;
  xTicksNormalized: number[];
  yAxes: NonEmptyArray<{
    yScale: ScaleLinear<number, number>;
    yTicksNormalized: number[];
    yData: Record<string, { i: MaybeNumber[]; o: MaybeNumber[] }>;
  }>;
} => {
  const data = [..._data];

  // primary axis (used for x axis) (this may change if we separate x/y axis props)
  const primaryAxisOption = axisOptions?.[0] || {};

  // // Set up our y-output data structure
  const y = yKeys.reduce(
    (acc, k) => {
      acc[k] = { i: [], o: [] };
      return acc;
    },
    {} as TransformedData<RawData, XK, YK>["y"],
  );

  // 1. Set up our y axes first...
  // Transform data for each y-axis configuration
  const yAxes = (axisOptions ?? [{}])?.map((axisConfig) => {
    const fontHeight = axisConfig.font?.getSize?.() ?? 0;
    const tickValues = axisConfig.tickValues;
    const tickCount = axisConfig.tickCount ?? DEFAULT_TICK_COUNT;

    const yTickValues =
      tickValues && typeof tickValues === "object" && "y" in tickValues
        ? tickValues.y
        : tickValues;
    const yTicks = typeof tickCount === "number" ? tickCount : tickCount.y;
    const tickDomainsY = getDomainFromTicks(yTickValues);

    const yKeysForAxis = axisConfig.yKeys ?? yKeys;
    const yMin =
      domain?.y?.[0] ??
      tickDomainsY?.[0] ??
      Math.min(
        ...yKeysForAxis.map((key) => {
          return data.reduce((min, curr) => {
            if (typeof curr[key] !== "number") return min;
            return Math.min(min, curr[key] as number);
          }, Infinity);
        }),
      );
    const yMax =
      domain?.y?.[1] ??
      tickDomainsY?.[1] ??
      Math.max(
        ...yKeysForAxis.map((key) => {
          return data.reduce((max, curr) => {
            if (typeof curr[key] !== "number") return max;
            return Math.max(max, curr[key] as number);
          }, -Infinity);
        }),
      );
    // Set up our y-scale, notice how domain is "flipped" because
    //  we're moving from cartesian to canvas coordinates
    // Also, if single data point, manually add upper & lower bounds so chart renders properly
    const yScaleDomain = (
      yMax === yMin ? [yMax + 1, yMin - 1] : [yMax, yMin]
    ) as [number, number];

    const yScaleRange: [number, number] = (() => {
      const xTickCount =
        (typeof axisConfig?.tickCount === "number"
          ? axisConfig?.tickCount
          : axisConfig?.tickCount?.x) ?? 0;
      const yLabelPosition =
        typeof axisConfig?.labelPosition === "string"
          ? axisConfig.labelPosition
          : axisConfig?.labelPosition?.x;
      const xAxisSide = axisConfig?.axisSide?.x;
      const yLabelOffset =
        (typeof axisConfig?.labelOffset === "number"
          ? axisConfig.labelOffset
          : axisConfig?.labelOffset?.y) ?? 0;
      // bottom, outset
      if (xAxisSide === "bottom" && yLabelPosition === "outset") {
        return [
          outputWindow.yMin,
          outputWindow.yMax +
            (xTickCount > 0 ? -fontHeight - yLabelOffset * 2 : 0),
        ];
      }
      // Top outset
      if (xAxisSide === "top" && yLabelPosition === "outset") {
        return [
          outputWindow.yMin +
            (xTickCount > 0 ? fontHeight + yLabelOffset * 2 : 0),
          outputWindow.yMax,
        ];
      }
      // Inset labels don't need added offsets
      return [outputWindow.yMin, outputWindow.yMax];
    })();

    const yScale = makeScale({
      inputBounds: yScaleDomain,
      outputBounds: yScaleRange,
      isNice: true,
      padEnd:
        typeof domainPadding === "number"
          ? domainPadding
          : domainPadding?.bottom,
      padStart:
        typeof domainPadding === "number" ? domainPadding : domainPadding?.top,
    });

    const yData = yKeysForAxis.reduce(
      (acc, key) => {
        acc[key] = {
          i: data.map((datum) => datum[key] as MaybeNumber),
          o: data.map((datum) =>
            typeof datum[key] === "number"
              ? yScale(datum[key] as number)
              : (datum[key] as number),
          ),
        };
        return acc;
      },
      {} as Record<string, { i: MaybeNumber[]; o: MaybeNumber[] }>,
    );

    const yTicksNormalized = yTickValues
      ? downsampleTicks(yTickValues, yTicks)
      : yScale.ticks(yTicks);

    yKeys.forEach((yKey) => {
      if (yKeysForAxis.includes(yKey)) {
        y[yKey].i = data.map((datum) => datum[yKey] as MaybeNumber);
        y[yKey].o = data.map(
          (datum) =>
            (typeof datum[yKey] === "number"
              ? yScale(datum[yKey] as number)
              : datum[yKey]) as MaybeNumber,
        );
      }
    });

    const maxYLabel = Math.max(
      ...yTicksNormalized.map(
        (yTick) =>
          axisConfig?.font
            ?.getGlyphWidths?.(
              axisConfig.font.getGlyphIDs(
                axisConfig?.formatYLabel?.(yTick as RawData[YK]) ||
                  String(yTick),
              ),
            )
            .reduce((sum, value) => sum + value, 0) ?? 0,
      ),
    );

    return {
      yScale,
      yTicksNormalized,
      yData,
      maxYLabel,
    };
  });

  // 2. Then set up our x axis...
  // Determine the x-output range based on yAxes/label options
  const oRange: [number, number] = (() => {
    let xMinAdjustment = 0;
    let xMaxAdjustment = 0;

    axisOptions?.forEach((axisOption, index) => {
      const yTickCount =
        (typeof axisOption?.tickCount === "number"
          ? axisOption.tickCount
          : axisOption?.tickCount?.y) ?? 0;
      const yLabelPosition =
        typeof axisOption?.labelPosition === "string"
          ? axisOption.labelPosition
          : axisOption?.labelPosition?.y;
      const yAxisSide = axisOption?.axisSide?.y;
      const yLabelOffset =
        (typeof axisOption?.labelOffset === "number"
          ? axisOption.labelOffset
          : axisOption?.labelOffset?.y) ?? 0;

      // Calculate label width for this axis
      const labelWidth = yAxes?.[index]!.maxYLabel ?? 0;

      // Adjust xMin or xMax based on the axis side and label position
      if (yAxisSide === "left" && yLabelPosition === "outset") {
        xMinAdjustment += yTickCount > 0 ? labelWidth + yLabelOffset : 0;
      } else if (yAxisSide === "right" && yLabelPosition === "outset") {
        xMaxAdjustment += yTickCount > 0 ? -labelWidth - yLabelOffset : 0;
      }
    });

    // Return the adjusted output range
    return [
      outputWindow.xMin + xMinAdjustment,
      outputWindow.xMax + xMaxAdjustment,
    ];
  })();

  const tickValues = primaryAxisOption.tickValues;
  const tickCount = primaryAxisOption.tickCount ?? DEFAULT_TICK_COUNT;

  // The user can specify either:
  // custom X tick values
  const xTickValues =
    tickValues && typeof tickValues === "object" && "x" in tickValues
      ? tickValues.x
      : tickValues;
  // OR
  // custom X tick count
  const xTicks = typeof tickCount === "number" ? tickCount : tickCount.x;
  // x tick domain of [number, number]
  const tickDomainsX = getDomainFromTicks(xTickValues);

  // Determine if xKey data is numerical
  const isNumericalData = data.every(
    (datum) => typeof datum[xKey as keyof RawData] === "number",
  );
  // and sort if it is
  if (isNumericalData) {
    data.sort((a, b) => +a[xKey as keyof RawData] - +b[xKey as keyof RawData]);
  }

  // Input x is just extracting the xKey from each datum
  const ix = data.map((datum) => datum[xKey]) as InputFields<RawData>[XK][];
  const ixNum = ix.map((val, i) => (isNumericalData ? (val as number) : i));

  // Generate our x-scale
  // If user provides a domain, use that as our min / max
  // Else if, tickValues are provided, we use that instead
  // Else, we find min / max of y values across all yKeys, and use that for y range instead.
  const ixMin = asNumber(domain?.x?.[0] ?? tickDomainsX?.[0] ?? ixNum.at(0)),
    ixMax = asNumber(domain?.x?.[1] ?? tickDomainsX?.[1] ?? ixNum.at(-1));

  const xScale = makeScale({
    // if single data point, manually add upper & lower bounds so chart renders properly
    inputBounds: ixMin === ixMax ? [ixMin - 1, ixMax + 1] : [ixMin, ixMax],
    outputBounds: oRange,
    padStart:
      typeof domainPadding === "number" ? domainPadding : domainPadding?.left,
    padEnd:
      typeof domainPadding === "number" ? domainPadding : domainPadding?.right,
  });

  // Normalize xTicks values either via the d3 scaleLinear ticks() function or our custom downSample function
  // For consistency we do it here, so we have both y and x ticks to pass to the axis generator
  const xTicksNormalized = xTickValues
    ? downsampleTicks(xTickValues, xTicks)
    : xScale.ticks(xTicks);

  const ox = ixNum.map((x) => xScale(x)!);

  return {
    ix,
    y,
    isNumericalData,
    ox,
    xScale,
    xTicksNormalized,
    // conform to type NonEmptyArray<T>
    yAxes: [yAxes[0]!, ...yAxes.slice(1)],
  };
};
