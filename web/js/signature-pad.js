// Signature pad: one code path for mouse, finger and stylus via Pointer
// Events. Pressure is used for stroke width where the device reports it,
// falling back to a fixed width when the device only ever reports the
// Pointer Events default of 0.5 (most mice and many touchscreens).
//
// Standalone module: knows nothing about the app or the API. It only
// touches the DOM node it is given and the design tokens already defined
// in web/css/app.css (via the `.sig` class family).
//
// Resize safety: canvas.width/height reset the visible bitmap to blank as a
// side effect of the browser reallocating the backing store — even when the
// numeric value doesn't change. A resize BURST (dragging a window edge, a
// tablet rotation firing several resize/orientationchange events) can queue
// more than one fit() run. An async restore — snapshot via toDataURL(),
// then redraw once a deferred image-decode callback fires later — is a
// race: a second fit() can run before that earlier callback fires, snapshot
// the now-blank canvas, and the signature is gone forever — while `dirty`
// stays true, so isEmpty() and toPNG() keep lying that a signature is
// present. That is worse than losing the drawing: the app would go on to
// submit a blank-but-"present" signature on a signed quality record.
//
// Fix: keep an offscreen `backing` canvas as the source of truth, updated
// synchronously after every completed stroke segment. fit() restores from
// it with a SYNCHRONOUS ctx.drawImage(backing, ...) — no deferred decode
// step, no data URL, no asynchronous gap for another fit() or a new stroke
// to land in. Repeated/rapid resizes and rotations are safe by
// construction, not by a dedup flag alone (a dedup flag is still applied to
// requestAnimationFrame itself, see scheduleFit(), but the correctness
// guarantee comes from the restore being synchronous).
export function createSignaturePad(container, { name = '' } = {}) {
  container.replaceChildren();
  container.className = 'sig';

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Signature pad — sign with mouse, finger or stylus');
  canvas.tabIndex = 0;

  // Reuse the .sig .bar / .sig .bar button rules already defined in
  // app.css (added in Task 11) instead of introducing a near-duplicate
  // .sig-bar class. Those rules already declare `color` explicitly on the
  // Clear button (var(--stamp)), satisfying the "controls must declare
  // their own colour" rule.
  const bar = document.createElement('div');
  bar.className = 'bar';
  const who = document.createElement('span');
  who.textContent = name;
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  bar.append(who, clearBtn);
  container.append(canvas, bar);

  const ctx = canvas.getContext('2d');
  let dirty = false;

  // Offscreen backing canvas: holds a full copy of the visible canvas's
  // pixels as of the last completed stroke segment. It is never touched by
  // fit() except as a read-only drawImage() source, so it is unaffected by
  // however many times the visible canvas gets resized.
  const backing = document.createElement('canvas');
  const backingCtx = backing.getContext('2d');

  function syncBacking() {
    // Resizing `backing` itself blanks it, same as the visible canvas — but
    // that's safe here because we immediately overwrite it with a full,
    // fresh copy of the (already up to date) visible canvas, all
    // synchronously, in the same call.
    if (backing.width !== canvas.width) backing.width = canvas.width;
    if (backing.height !== canvas.height) backing.height = canvas.height;
    backingCtx.clearRect(0, 0, backing.width, backing.height);
    backingCtx.drawImage(canvas, 0, 0);
  }

  function fit() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const hadContent = dirty;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#16181d';
    if (hadContent) {
      // Synchronous restore, scaling the backing canvas's pixels (whatever
      // size they were captured at) into the newly-sized bitmap. Completes
      // before this function returns — there is no frame in which the
      // canvas is visibly/actually blank while dirty is still true.
      //
      // Scale rule: use a single UNIFORM scale factor — the SMALLER of the
      // two axis ratios (new CSS box size / backing's CSS size) — for both
      // axes, instead of stretching each axis independently. A CSS box that
      // changes SHAPE (tablet rotation, a breakpoint hop between
      // 375/768/1024) must not distort the ink; drawing with two different
      // scale factors per axis is exactly what squashes or elongates a
      // signature. Anchored at (0, 0) — top-left — rather than centred, so
      // the fix never crops the tail of a signature off the edge. Also
      // clamp the scale at 1: if the new box is bigger than the backing's
      // CSS size, the signature stays its natural size (anchored top-left)
      // instead of being blown up into a blurry, pixelated enlargement.
      //
      // Units: rect.{width,height} are CSS px. backing.{width,height} are
      // device px captured at whatever dpr was in effect at the time (this
      // assumes dpr is unchanged since that capture — the same assumption
      // the pre-existing stretch-to-fill code relied on, since backing
      // tracks no dpr of its own). Divide by the CURRENT dpr to get the
      // backing's own CSS size back, so the ratio is a true CSS-to-CSS
      // scale factor and not distorted by device-pixel density.
      const backingCssWidth = backing.width / dpr;
      const backingCssHeight = backing.height / dpr;
      const scale = Math.min(1, rect.width / backingCssWidth, rect.height / backingCssHeight);
      const drawWidth = backingCssWidth * scale;
      const drawHeight = backingCssHeight * scale;
      ctx.drawImage(backing, 0, 0, backing.width, backing.height, 0, 0, drawWidth, drawHeight);
    }
  }

  // Dedup the animation-frame scheduling itself: a burst of resize events
  // (window drag, rotation) only ever has one fit() pending at a time, and
  // it always runs against the most recent rect.
  let fitHandle = null;
  function scheduleFit() {
    if (fitHandle !== null) cancelAnimationFrame(fitHandle);
    fitHandle = requestAnimationFrame(() => { fitHandle = null; fit(); });
  }
  scheduleFit();
  const onResize = () => scheduleFit();
  window.addEventListener('resize', onResize);

  let drawing = false;
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = at(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    // Pointer Events report pressure 0.5 as the "device does not support
    // pressure" default (mice, most touchscreens). Only trust pressure that
    // differs from that default; otherwise fall back to a fixed 0.5 width.
    const p = e.pressure && e.pressure !== 0.5 ? e.pressure : 0.5;
    ctx.lineWidth = 0.6 + p * 2.4;
    const [x, y] = at(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
    dirty = true;
    // Commit this segment to the backing canvas immediately, synchronously,
    // in the same tick as the stroke itself. A resize that lands between
    // this pointermove and the next one restores from an up-to-date
    // backing, so an in-progress signature can never be caught mid-air.
    syncBacking();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  const clear = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    backingCtx.clearRect(0, 0, backing.width, backing.height);
    dirty = false;
  };
  clearBtn.addEventListener('click', clear);

  return {
    clear,
    isEmpty: () => !dirty,
    // Returns null when nothing has been drawn. The submit workflow relies
    // on this to refuse an unsigned record — an empty-but-non-null data URL
    // (a blank PNG) would defeat that check by looking like a real signature.
    toPNG: () => (dirty ? canvas.toDataURL('image/png') : null),
    // Every record open recreates a pad; without this the window resize
    // listener (and everything it closes over — both canvases, contexts,
    // DOM nodes) is retained by `window` forever. Additive: existing
    // callers that only use {clear, isEmpty, toPNG} are unaffected.
    destroy: () => {
      if (fitHandle !== null) cancelAnimationFrame(fitHandle);
      window.removeEventListener('resize', onResize);
    }
  };
}
