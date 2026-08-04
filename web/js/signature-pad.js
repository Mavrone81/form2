// Signature pad: one code path for mouse, finger and stylus via Pointer
// Events. Pressure is used for stroke width where the device reports it,
// falling back to a fixed width when the device only ever reports the
// Pointer Events default of 0.5 (most mice and many touchscreens).
//
// Standalone module: knows nothing about the app or the API. It only
// touches the DOM node it is given and the design tokens already defined
// in web/css/app.css (via the `.sig` class family).
//
// Resize safety: canvas.width/height reset the bitmap to blank as a side
// effect of the browser reallocating the backing store. fit() snapshots the
// current drawing to a data URL first and redraws it after resizing, so a
// signature already on the pad survives a window resize or device
// rotation. Without this, rotating a tablet mid-signature would silently
// wipe the stroke and the technician could go on to "sign" a blank pad.
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

  function fit() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    // Snapshot BEFORE touching canvas.width/height — assigning either
    // property clears the bitmap even if the numeric value is unchanged.
    const snapshot = dirty ? canvas.toDataURL() : null;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#16181d';
    if (snapshot) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, rect.width, rect.height);
      img.src = snapshot;
    }
  }
  requestAnimationFrame(fit);
  window.addEventListener('resize', () => requestAnimationFrame(fit));

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
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);

  const clear = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; };
  clearBtn.addEventListener('click', clear);

  return {
    clear,
    isEmpty: () => !dirty,
    // Returns null when nothing has been drawn. The submit workflow relies
    // on this to refuse an unsigned record — an empty-but-non-null data URL
    // (a blank PNG) would defeat that check by looking like a real signature.
    toPNG: () => (dirty ? canvas.toDataURL('image/png') : null)
  };
}
