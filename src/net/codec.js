// Tiny binary writer/reader for the multiplayer protocol (browser + Node).
// Varints keep small numbers small; zigzag makes small negatives small too.

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Writer {
  constructor(size = 256) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
    this.pos = 0;
  }

  #ensure(n) {
    if (this.pos + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.pos + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }

  u8(v) {
    this.#ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }

  i8(v) {
    this.#ensure(1);
    this.view.setInt8(this.pos, v);
    this.pos += 1;
    return this;
  }

  u16(v) {
    this.#ensure(2);
    this.view.setUint16(this.pos, v);
    this.pos += 2;
    return this;
  }

  u32(v) {
    this.#ensure(4);
    this.view.setUint32(this.pos, v >>> 0);
    this.pos += 4;
    return this;
  }

  f32(v) {
    this.#ensure(4);
    this.view.setFloat32(this.pos, v);
    this.pos += 4;
    return this;
  }

  f64(v) {
    this.#ensure(8);
    this.view.setFloat64(this.pos, v);
    this.pos += 8;
    return this;
  }

  /** Unsigned varint (up to 2^53). */
  uv(v) {
    let n = Math.max(0, Math.floor(v));
    this.#ensure(8);
    while (n >= 0x80) {
      this.bytes[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
      this.#ensure(1);
    }
    this.bytes[this.pos++] = n;
    return this;
  }

  /** Signed varint (zigzag). */
  sv(v) {
    const n = Math.round(v);
    return this.uv(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  str(s) {
    const b = enc.encode(s ?? '');
    this.uv(b.length);
    this.#ensure(b.length);
    this.bytes.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  finish() {
    return this.buf.slice(0, this.pos);
  }
}

export class Reader {
  constructor(buf) {
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    this.view = new DataView(ab);
    this.bytes = new Uint8Array(ab);
    this.pos = 0;
  }

  get left() {
    return this.bytes.length - this.pos;
  }

  #need(n) {
    if (this.pos + n > this.bytes.length) throw new RangeError('message too short');
  }

  u8() {
    this.#need(1);
    return this.view.getUint8(this.pos++);
  }

  i8() {
    this.#need(1);
    return this.view.getInt8(this.pos++);
  }

  u16() {
    this.#need(2);
    const v = this.view.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  u32() {
    this.#need(4);
    const v = this.view.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  f32() {
    this.#need(4);
    const v = this.view.getFloat32(this.pos);
    this.pos += 4;
    return v;
  }

  f64() {
    this.#need(8);
    const v = this.view.getFloat64(this.pos);
    this.pos += 8;
    return v;
  }

  uv() {
    let n = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 0x80;
    }
    throw new RangeError('varint too long');
  }

  sv() {
    const n = this.uv();
    return n % 2 ? -(n + 1) / 2 : n / 2;
  }

  str(max = 4096) {
    const len = this.uv();
    if (len > max) throw new RangeError('string too long');
    this.#need(len);
    const s = dec.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}
