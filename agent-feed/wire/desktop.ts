/** The active display metadata needed to size the first-party desktop viewer. */
export interface DesktopDisplayResponse {
  display: {
    index: number;
    frame: {
      x: number;
      y: number;
      w: number;
      h: number;
    };
  };
}
