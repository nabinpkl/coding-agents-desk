export interface DesktopControlOwnershipChange<Owner> {
  changed: boolean;
  epoch: number;
  previous: Owner | null;
  current: Owner | null;
}

/** One non-replayable controller authority for the Mac, across every capture helper. */
export class DesktopControlOwnership<Owner> {
  private currentOwner: Owner | null = null;
  private currentEpoch = 0;

  get owner(): Owner | null { return this.currentOwner; }
  get epoch(): number { return this.currentEpoch; }

  acquire(owner: Owner): DesktopControlOwnershipChange<Owner> {
    if (this.currentOwner === owner) {
      return {
        changed: false, epoch: this.currentEpoch,
        previous: owner, current: owner,
      };
    }
    const previous = this.currentOwner;
    this.currentOwner = owner;
    this.currentEpoch += 1;
    return { changed: true, epoch: this.currentEpoch, previous, current: owner };
  }

  release(owner: Owner): DesktopControlOwnershipChange<Owner> {
    if (this.currentOwner !== owner) {
      return {
        changed: false, epoch: this.currentEpoch,
        previous: this.currentOwner, current: this.currentOwner,
      };
    }
    this.currentOwner = null;
    this.currentEpoch += 1;
    return { changed: true, epoch: this.currentEpoch, previous: owner, current: null };
  }
}
