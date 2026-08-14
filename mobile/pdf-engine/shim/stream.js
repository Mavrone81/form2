// SHIM 5 of 5 — `stream`, enough of `Readable` for a PDFDocument.
//
// Why: `class PDFDocument extends stream.Readable`. The document pushes its
// bytes out as a readable stream and pdf-record.js collects them with
// `doc.on('data')` / `doc.on('end')`; PDFKit itself also emits `pageAdded`
// through the same emitter.
//
// Why not readable-stream (the usual browser polyfill): it drags in a large
// slice of Node's stream machinery for one consumer that uses four methods.
// What DOES have to be right is subtler than size, and it is the reason this
// buffers instead of emitting straight through — renderRecordPdf does:
//
//     doc.end();                     // every byte is pushed HERE
//     return await streamToBuffer(doc);   // the 'data' listener attaches HERE
//
// A naive emitter would fire `data` into the void and hand back an empty PDF.
// Node's Readable is paused until something starts listening and then flows on
// a later tick, so this queues pushes, starts flowing when a `data` listener
// arrives, and drains in a microtask — the same order, the same bytes.

class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }

  addListener(event, fn) { return this.on(event, fn); }

  once(event, fn) {
    const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const list = this._listeners.get(event);
    if (!list) return this;
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
    return this;
  }

  removeListener(event, fn) { return this.off(event, fn); }

  removeAllListeners(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
    return this;
  }

  listenerCount(event) { return (this._listeners.get(event) ?? []).length; }

  emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list || !list.length) return false;
    // Copied before iterating: a `once` listener removes itself while the
    // list is being walked.
    for (const fn of list.slice()) fn.apply(this, args);
    return true;
  }
}

class Readable extends EventEmitter {
  constructor() {
    super();
    this._queue = [];
    this._pushedNull = false;
    this._endEmitted = false;
    this._flowing = false;
    this._draining = false;
  }

  on(event, fn) {
    super.on(event, fn);
    // Attaching a `data` listener resumes the stream, exactly as Node's does.
    if (event === 'data') { this._flowing = true; this._drainLater(); }
    if (event === 'end' && this._pushedNull) this._drainLater();
    return this;
  }

  push(chunk) {
    if (chunk === null) this._pushedNull = true;
    else this._queue.push(chunk);
    this._drainLater();
    return true;
  }

  read() {
    return this._queue.length ? this._queue.shift() : null;
  }

  resume() { this._flowing = true; this._drainLater(); return this; }

  pause() { this._flowing = false; return this; }

  pipe(destination) {
    this.on('data', (chunk) => destination.write(chunk));
    this.on('end', () => destination.end?.());
    return destination;
  }

  _read() {}

  _drainLater() {
    if (!this._flowing || this._draining) return;
    this._draining = true;
    queueMicrotask(() => {
      this._draining = false;
      if (!this._flowing) return;
      while (this._queue.length) this.emit('data', this._queue.shift());
      if (this._pushedNull && !this._endEmitted) {
        this._endEmitted = true;
        this.emit('end');
      }
    });
  }
}

export { Readable, EventEmitter };

export default { Readable };
