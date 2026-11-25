import { describe, expect, it } from "vitest";

import { mediaTargets } from "./media";
import {
  adjustPixels,
  clampPosition,
  editRanges,
  fitAspect,
  isNeutral,
  minimumZoom,
  minimumZoomFor,
  neutralEdit,
  pictureTransform,
  previewFilter,
  rotatedBounds,
  rotationDegrees,
  turnQuarter,
  type PictureEdit,
} from "./picture-edit";

function apply(matrix: readonly number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number];
  return [a * x + c * y + e, b * x + d * y + f];
}

function close(actual: [number, number], expected: [number, number]) {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
}

describe("turning and straightening", () => {
  it("turns by quarters and wraps around", () => {
    let edit = neutralEdit;
    edit = turnQuarter(edit, 1);
    expect(edit.quarterTurns).toBe(1);
    edit = turnQuarter(turnQuarter(turnQuarter(edit, 1), 1), 1);
    expect(edit.quarterTurns).toBe(0);
    expect(turnQuarter(neutralEdit, -1).quarterTurns).toBe(3);
  });

  it("adds the straighten angle to the whole turns", () => {
    expect(rotationDegrees({ quarterTurns: 1, straighten: -7.5 })).toBe(82.5);
    expect(rotationDegrees(neutralEdit)).toBe(0);
  });

  it("knows an untouched edit from a changed one", () => {
    expect(isNeutral(neutralEdit)).toBe(true);
    expect(isNeutral({ ...neutralEdit, flipped: true })).toBe(false);
    expect(isNeutral({ ...neutralEdit, saturation: 5 })).toBe(false);
  });

  it("measures the box around a turned picture", () => {
    expect(rotatedBounds({ width: 400, height: 200 }, 90).width).toBeCloseTo(200, 6);
    expect(rotatedBounds({ width: 400, height: 200 }, 90).height).toBeCloseTo(400, 6);
    expect(rotatedBounds({ width: 400, height: 200 }, 180).height).toBeCloseTo(200, 6);
    const tilted = rotatedBounds({ width: 400, height: 200 }, 45);
    expect(tilted.width).toBeCloseTo(424.264, 2);
    expect(tilted.height).toBeCloseTo(424.264, 2);
  });
});

describe("zoom that keeps the frame full", () => {
  const picture = { width: 1200, height: 800 };

  it("needs none when the picture is turned by whole quarters", () => {
    for (const degrees of [0, 90, 180, 270]) expect(minimumZoom(picture, 1, degrees)).toBe(1);
    expect(minimumZoom(picture, mediaTargets.business_cover.width / mediaTargets.business_cover.height, 90)).toBe(1);
  });

  it("grows as the picture is tilted, and the frame then lies inside the picture", () => {
    expect(minimumZoom(picture, 1, 10)).toBeGreaterThan(1);
    expect(minimumZoom(picture, 1, 20)).toBeGreaterThan(minimumZoom(picture, 1, 10));
    for (const [aspect, degrees] of [[1, 12], [16 / 9, -9], [4 / 3, 30], [1, 100]] as const) {
      const zoom = minimumZoom(picture, aspect, degrees);
      const frame = fitAspect(rotatedBounds(picture, degrees), aspect);
      const half = { x: frame.width / zoom / 2, y: frame.height / zoom / 2 };
      const radians = (degrees * Math.PI) / 180;
      // Each corner of the frame, turned back into the picture's own axes, stays inside the picture.
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const x = sx * half.x * Math.cos(radians) + sy * half.y * Math.sin(radians);
        const y = -sx * half.x * Math.sin(radians) + sy * half.y * Math.cos(radians);
        expect(Math.abs(x)).toBeLessThanOrEqual(picture.width / 2 + 0.01);
        expect(Math.abs(y)).toBeLessThanOrEqual(picture.height / 2 + 0.01);
      }
    }
  });
});

describe("keeping the frame inside the picture", () => {
  const media = { width: 600, height: 400 };
  const frame = { width: 300, height: 300 };

  it("stops at the edges of an upright picture, and leaves a position that is already inside alone", () => {
    expect(clampPosition({ x: 1000, y: -1000 }, media, frame, 1, 0)).toEqual({ x: 150, y: -50 });
    const inside = { x: 20, y: -10 };
    expect(clampPosition(inside, media, frame, 1, 0)).toBe(inside);
  });

  it("never lets a tilted picture's cut-off corners into the frame, however far it is dragged", () => {
    for (const degrees of [-30, -12.5, 7, 22, 90, 100, -135]) {
      for (const zoom of [minimumZoomFor(media, frame, degrees), 1.5, 3]) {
        for (const [x, y] of [[900, 900], [-900, 700], [400, -900], [-50, 30], [0, 0]] as const) {
          const placed = clampPosition({ x, y }, media, frame, zoom, degrees);
          const radians = (degrees * Math.PI) / 180;
          for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            // The frame's corner, relative to the picture's centre and in the picture's own axes.
            const dx = (sx * frame.width) / 2 - placed.x;
            const dy = (sy * frame.height) / 2 - placed.y;
            const along = dx * Math.cos(radians) + dy * Math.sin(radians);
            const across = -dx * Math.sin(radians) + dy * Math.cos(radians);
            expect(Math.abs(along)).toBeLessThanOrEqual((media.width * zoom) / 2 + 0.001);
            expect(Math.abs(across)).toBeLessThanOrEqual((media.height * zoom) / 2 + 0.001);
          }
        }
      }
    }
  });

  it("leaves no room to move when the frame just fills the picture", () => {
    const placed = clampPosition({ x: 80, y: -60 }, { width: 400, height: 400 }, { width: 400, height: 400 }, 1, 0);
    expect(Math.abs(placed.x)).toBe(0);
    expect(Math.abs(placed.y)).toBe(0);
    // Tilted, the same frame needs the picture grown to cover it, and then it is held in place just the same.
    const zoom = minimumZoomFor({ width: 400, height: 400 }, { width: 400, height: 400 }, 15);
    expect(zoom).toBeGreaterThan(1.2);
    const tilted = clampPosition({ x: 80, y: -60 }, { width: 400, height: 400 }, { width: 400, height: 400 }, zoom, 15);
    expect(Math.hypot(tilted.x, tilted.y)).toBeLessThan(1);
  });
});

describe("the output picture", () => {
  const source = { width: 400, height: 200 };

  it("scales the crop area to exactly the output size and centres it, for every kind", () => {
    for (const target of Object.values(mediaTargets)) {
      // The largest frame of the target's shape, centred on the picture after a quarter turn and a flip.
      const edit = { quarterTurns: 1, straighten: 0, flipped: true };
      const box = rotatedBounds(source, rotationDegrees(edit));
      const frame = fitAspect(box, target.width / target.height);
      const area = { x: (box.width - frame.width) / 2, y: (box.height - frame.height) / 2, width: frame.width, height: frame.height };
      const [a, b, c, d] = pictureTransform(source, area, edit, target);
      // The picture's centre is the frame's centre, so it lands in the middle of the output.
      close(apply(pictureTransform(source, area, edit, target), source.width / 2, source.height / 2), [target.width / 2, target.height / 2]);
      // The frame's width and height become the output's, with no stretching.
      expect(Math.hypot(a, b)).toBeCloseTo(target.width / frame.width, 6);
      expect(Math.hypot(c, d)).toBeCloseTo(target.height / frame.height, 6);
    }
  });

  it("puts the whole picture on the output when the area is the whole picture", () => {
    const matrix = pictureTransform(source, { x: 0, y: 0, width: 400, height: 200 }, { quarterTurns: 0, straighten: 0, flipped: false }, { width: 800, height: 400 });
    close(apply(matrix, 0, 0), [0, 0]);
    close(apply(matrix, 400, 200), [800, 400]);
  });

  it("turns a quarter to the right: the top left corner goes to the top right", () => {
    const matrix = pictureTransform(source, { x: 0, y: 0, width: 200, height: 400 }, { quarterTurns: 1, straighten: 0, flipped: false }, { width: 200, height: 400 });
    close(apply(matrix, 0, 0), [200, 0]);
    close(apply(matrix, 400, 0), [200, 400]);
  });

  it("mirrors left to right as seen, after the turn", () => {
    const matrix = pictureTransform(source, { x: 0, y: 0, width: 200, height: 400 }, { quarterTurns: 1, straighten: 0, flipped: true }, { width: 200, height: 400 });
    close(apply(matrix, 0, 0), [0, 0]);
    close(apply(matrix, 400, 0), [0, 400]);
  });

  it("straightening rotates about the picture's centre", () => {
    const edit = { quarterTurns: 0, straighten: 10, flipped: false };
    const box = rotatedBounds(source, 10);
    const matrix = pictureTransform(source, { x: 0, y: 0, width: box.width, height: box.height }, edit, box);
    close(apply(matrix, 200, 100), [box.width / 2, box.height / 2]);
  });
});

describe("colour sliders", () => {
  function pixel(edit: Partial<PictureEdit>, rgb: [number, number, number]) {
    const data = new Uint8ClampedArray([...rgb, 255]);
    adjustPixels(data, { ...neutralEdit, ...edit });
    return [data[0], data[1], data[2], data[3]];
  }

  it("leaves a picture alone when every slider is at zero", () => {
    expect(pixel({}, [12, 130, 250])).toEqual([12, 130, 250, 255]);
    expect(previewFilter(neutralEdit)).toBe("none");
  });

  it("brightens and darkens", () => {
    expect(pixel({ brightness: 50 }, [100, 100, 100])).toEqual([150, 150, 150, 255]);
    expect(pixel({ brightness: -50 }, [100, 100, 100])).toEqual([50, 50, 50, 255]);
    expect(pixel({ brightness: 50 }, [200, 200, 200])).toEqual([255, 255, 255, 255]);
  });

  it("pivots contrast around mid grey", () => {
    const [low] = pixel({ contrast: 50 }, [64, 64, 64]);
    const [high] = pixel({ contrast: 50 }, [192, 192, 192]);
    expect(low).toBeLessThan(64);
    expect(high).toBeGreaterThan(192);
    expect(pixel({ contrast: 50 }, [128, 128, 128])[0]).toBeCloseTo(128, 0);
  });

  it("turns colour to grey at minus 100 and keeps the alpha", () => {
    const [r, g, b, a] = pixel({ saturation: -100 }, [200, 100, 50]);
    expect(r).toBe(g);
    expect(g).toBe(b);
    expect(r).toBe(118);
    expect(a).toBe(255);
  });

  it("makes colours stronger above zero", () => {
    const [r, , b] = pixel({ saturation: 100 }, [200, 100, 50]);
    expect(r! - b!).toBeGreaterThan(150);
  });

  it("describes the same change to the preview", () => {
    expect(previewFilter({ brightness: 20, contrast: -10, saturation: 0 })).toBe("brightness(1.2) contrast(0.9) saturate(1)");
  });

  it("has slider ranges that stay inside what the maths allows", () => {
    expect(editRanges.saturation.min).toBe(-100);
    expect(editRanges.brightness.min).toBeGreaterThan(-100);
    expect(editRanges.straighten.max).toBeLessThan(45);
  });
});
