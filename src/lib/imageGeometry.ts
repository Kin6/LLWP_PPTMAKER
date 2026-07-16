export type ImageRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function containImageRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  insetRatio = 0,
): ImageRect {
  const safeInset = Math.max(0, Math.min(0.1, insetRatio));
  const availableWidth = targetWidth * (1 - safeInset * 2);
  const availableHeight = targetHeight * (1 - safeInset * 2);
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

export function coverImageRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): ImageRect {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}
