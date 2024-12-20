import Pbf from 'pbf';
import { GeoBoundingBox } from '@deck.gl/geo-layers';
import { CONFIG_BY_INTERVAL, getTimeRangeKey } from '../helpers/time';
import {
  BBox,
  generateUniqueId,
  getCellCoordinates,
  getCellProperties,
} from '../helpers/cells';
import type {
  FourwingsFeature,
  FourwingsLoaderOptions,
  ParseFourwingsOptions,
  FourwingsRawData,
} from './types';

const NO_DATA_VALUE = 4294967295;
const SCALE_VALUE = 1;
const OFFSET_VALUE = 0;
const CELL_NUM_INDEX = 0;
const CELL_START_INDEX = 1;
const CELL_END_INDEX = 2;
const CELL_VALUES_START_INDEX = 3;

const getCellTimeseries = (
  intArrays: FourwingsRawData[],
  options?: FourwingsLoaderOptions
): FourwingsFeature[] => {
  const {
    bufferedStartDate,
    interval,
    sublayers,
    initialTimeRange,
    aggregationOperation = 'sum',
    scale = SCALE_VALUE,
    offset = OFFSET_VALUE,
    noDataValue = NO_DATA_VALUE,
    tile,
    cols,
    rows,
  } = options?.fourwings || ({} as ParseFourwingsOptions);
  if (!initialTimeRange) {
    return [];
  }
  const tileStartFrame =
    CONFIG_BY_INTERVAL[interval].getIntervalFrame(bufferedStartDate);
  const timeRangeStartFrame =
    CONFIG_BY_INTERVAL[interval].getIntervalFrame(initialTimeRange.start) -
    tileStartFrame;
  const timeRangeEndFrame =
    CONFIG_BY_INTERVAL[interval].getIntervalFrame(initialTimeRange.end) -
    tileStartFrame;

  const timeRangeKey = getTimeRangeKey(timeRangeStartFrame, timeRangeEndFrame);

  const tileBBox: BBox = [
    (tile?.bbox as GeoBoundingBox).west,
    (tile?.bbox as GeoBoundingBox).south,
    (tile?.bbox as GeoBoundingBox).east,
    (tile?.bbox as GeoBoundingBox).north,
  ];
  const features = {} as Record<number, FourwingsFeature>;
  const sublayersLength = intArrays.length;
  for (
    let subLayerIndex = 0;
    subLayerIndex < sublayersLength;
    subLayerIndex++
  ) {
    let cellNum = 0;
    let startFrame = 0;
    let endFrame = 0;
    let startIndex = 0;
    let indexInCell = 0;
    const subLayerIntArray = intArrays[subLayerIndex];
    for (let i = 0; i < subLayerIntArray.length; i++) {
      const value = subLayerIntArray[i];
      if (indexInCell === CELL_NUM_INDEX) {
        // this number defines the cell index
        startIndex = i + CELL_VALUES_START_INDEX;
        cellNum = value;
      } else if (indexInCell === CELL_START_INDEX) {
        // this number defines the cell start frame
        startFrame = value - tileStartFrame;
      } else if (indexInCell === CELL_END_INDEX) {
        // this number defines the cell end frame
        endFrame = value - tileStartFrame;

        // calculate how many values are in the tile
        const numCellValues = (endFrame - startFrame + 1) * sublayers;
        const numValuesBySubLayer = new Array(sublayersLength).fill(0);

        // add the feature if previous sublayers didn't contain data for it
        if (!features[cellNum]) {
          const { col, row } = getCellProperties(tileBBox, cellNum, cols);
          features[cellNum] = {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                getCellCoordinates({
                  cellIndex: cellNum,
                  cols,
                  rows,
                  tileBBox,
                }),
              ],
            },
            properties: {
              col,
              row,
              values: new Array(sublayersLength),
              dates: new Array(sublayersLength),
              cellId: generateUniqueId(tile!.index.x, tile!.index.y, cellNum),
              cellNum,
              startOffsets: new Array(sublayersLength),
              initialValues: { [timeRangeKey]: new Array(sublayersLength) },
            },
          };
        }

        for (let j = 0; j < numCellValues; j++) {
          const cellValue = subLayerIntArray[j + startIndex];
          if (cellValue !== noDataValue) {
            if (!features[cellNum].properties.values[subLayerIndex]) {
              // create properties for this sublayer if the feature dind't have it already
              features[cellNum].properties.values[subLayerIndex] = new Array(
                numCellValues
              );
              features[cellNum].properties.dates[subLayerIndex] = new Array(
                numCellValues
              );
              features[cellNum].properties.startOffsets[subLayerIndex] =
                startFrame;
              features[cellNum].properties.initialValues[timeRangeKey][
                subLayerIndex
              ] = 0;
            }
            // add current value to the array of values for this sublayer
            features[cellNum].properties.values[subLayerIndex][
              Math.floor(j / sublayers)
            ] = cellValue * scale - offset;
            // add current date to the array of dates for this sublayer
            features[cellNum].properties.dates[subLayerIndex][
              Math.floor(j / sublayers)
            ] = CONFIG_BY_INTERVAL[interval].getIntervalTimestamp(
              startFrame + tileStartFrame + j
            );

            // sum current value to the initialValue for this sublayer
            if (
              j + startFrame >= timeRangeStartFrame &&
              j + startFrame < timeRangeEndFrame
            ) {
              features[cellNum].properties.initialValues[timeRangeKey][
                subLayerIndex
              ] += cellValue * scale - offset;
              numValuesBySubLayer[subLayerIndex] =
                numValuesBySubLayer[subLayerIndex] + 1;
            }
          }
        }
        if (aggregationOperation === 'avg') {
          features[cellNum].properties.initialValues[timeRangeKey][
            subLayerIndex
          ] =
            features[cellNum].properties.initialValues[timeRangeKey][
              subLayerIndex
            ] / numValuesBySubLayer[subLayerIndex];
        }
        // set the i to jump to the next step where we know a cell index will be
        i = startIndex + numCellValues - 1;
        // resseting indexInCell to start with the new cell
        indexInCell = -1;
      }
      indexInCell++;
    }
  }

  return Object.values(features);
};

function readData(_: unknown, data: unknown[], pbf: Pbf) {
  data.push(pbf.readPackedVarint());
}

export const parseFourwings = (
  datasetsBuffer: ArrayBuffer,
  options?: FourwingsLoaderOptions
) => {
  const { buffersLength } = options?.fourwings || {};
  if (!buffersLength?.length) {
    return [];
  }
  let start = 0;
  return getCellTimeseries(
    buffersLength.map((length, index) => {
      if (length === 0) {
        return [];
      }
      const buffer = datasetsBuffer.slice(
        start,
        index !== buffersLength.length ? start + length : undefined
      );
      start += length;
      return new Pbf(buffer).readFields(readData, [])[0];
    }),
    options
  );
};
