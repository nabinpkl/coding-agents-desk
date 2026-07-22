export function boundedUTF8(value, maximumBytes) {
  return typeof value === 'string' && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

export function bytesFromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function base64FromBinary(value) {
  let binary = '';
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value.charCodeAt(index) & 0xff);
  }
  return btoa(binary);
}

export function normalizeCapacity(proposed) {
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
  const columns = Math.trunc(proposed.cols);
  const rows = Math.trunc(proposed.rows);
  if (columns < 1 || rows < 1) return null;
  return { columns: Math.min(512, columns), rows: Math.min(256, rows) };
}

export function calculatePresentation({
  viewColumns, viewRows, sourceColumns, sourceRows,
  viewportWidth, viewportHeight, cursorColumn, cursorRow,
}) {
  if ([viewColumns, viewRows, sourceColumns, sourceRows, viewportWidth, viewportHeight]
    .some(value => !Number.isFinite(value) || value <= 0)) return null;
  const requiredScale = Math.min(1, viewColumns / sourceColumns, viewRows / sourceRows);
  const scale = Math.max(0.75, requiredScale);
  const naturalWidth = viewportWidth / Math.max(requiredScale, 0.01);
  const naturalHeight = viewportHeight / Math.max(requiredScale, 0.01);
  const visibleWidth = viewportWidth / scale;
  const visibleHeight = viewportHeight / scale;
  const cursorX = (cursorColumn + 0.5) * naturalWidth / sourceColumns;
  const cursorY = (cursorRow + 0.5) * naturalHeight / sourceRows;
  const maximumOffsetX = Math.max(0, naturalWidth - visibleWidth);
  const maximumOffsetY = Math.max(0, naturalHeight - visibleHeight);
  return {
    scale,
    naturalWidth,
    naturalHeight,
    offsetX: Math.min(maximumOffsetX, Math.max(0, cursorX - visibleWidth / 2)),
    offsetY: Math.min(maximumOffsetY, Math.max(0, cursorY - visibleHeight / 2)),
    cropped: maximumOffsetX > 0.5 || maximumOffsetY > 0.5,
  };
}

export class SerializedOperations {
  #tail = Promise.resolve();
  #onFailure;

  constructor(onFailure) {
    this.#onFailure = onFailure;
  }

  enqueue(operation) {
    this.#tail = this.#tail.then(operation).catch(error => this.#onFailure(error));
    return this.#tail;
  }
}
