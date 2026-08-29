import exifr from 'exifr';

// DateTimeOriginal and CreateDate both represent "when the photo was taken"
// (different camera-maker conventions for essentially the same thing) — when
// they disagree, the earlier one wins. ModifyDate reflects a later edit, so
// it's only used as a fallback when neither of the other two exists.
//
// Deliberately called on the ORIGINAL uploaded/imported file, before any
// HEIC→JPEG conversion: heic-convert's output carries no EXIF at all (bytes
// are fully re-encoded), so extracting after conversion would silently find
// nothing for the iPhone-HEIC photos this is most likely to matter for.
export async function extractPhotoTakenAt(filePath: string): Promise<number | null> {
  let tags: { DateTimeOriginal?: Date; CreateDate?: Date; ModifyDate?: Date } | undefined;
  try {
    tags = await exifr.parse(filePath, ['DateTimeOriginal', 'CreateDate', 'ModifyDate']);
  } catch {
    return null;
  }
  if (!tags) return null;

  const { DateTimeOriginal, CreateDate, ModifyDate } = tags;
  if (DateTimeOriginal && CreateDate) {
    return Math.min(DateTimeOriginal.getTime(), CreateDate.getTime());
  }
  if (DateTimeOriginal) return DateTimeOriginal.getTime();
  if (CreateDate) return CreateDate.getTime();
  if (ModifyDate) return ModifyDate.getTime();
  return null;
}
