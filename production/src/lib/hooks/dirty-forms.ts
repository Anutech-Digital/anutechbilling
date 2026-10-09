/**
 * R-490 (R-472 / R-468): ONLY A FORM THAT IS DIRTY RIGHT NOW WARNS ON CLOSE.
 *
 * The browser "Leave site? Changes you made may not be saved" used to fire whenever ANY
 * workspace tab carried the draft flag — and that flag outlives the form: it is saved in
 * sessionStorage and comes back after a reload with no form behind it. So it popped on
 * /products (a 404), on lists, on every page. The close warning now asks this set instead:
 * one entry per MOUNTED form that is dirty at this moment. Save or unmount → gone.
 */
const liveDirty = new Set<symbol>();

/** Mark one mounted form dirty or clean. */
export function setFormDirty(token: symbol, dirty: boolean): void {
  if (dirty) liveDirty.add(token);
  else liveDirty.delete(token);
}

/** True while at least one mounted form reports unsaved changes. */
export function hasDirtyForm(): boolean {
  return liveDirty.size > 0;
}
