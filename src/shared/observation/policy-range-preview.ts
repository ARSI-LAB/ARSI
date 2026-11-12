/** Validates exclusive range bounds and a length representable by an array. */
export function isStructureRangePreviewBounds(
  start: number,
  end: number,
): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end >= start &&
    end - start <= 0xffff_ffff
  );
}
