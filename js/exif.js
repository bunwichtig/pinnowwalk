// Minimaler EXIF-Leser für JPEG: GPS-Position, Blickrichtung, Höhe, Brennweite und Aufnahmedatum.
export function readExif(buffer) {
  const v = new DataView(buffer);
  if (v.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
    if ((marker & 0xff00) !== 0xff00) break;
    off += 2 + len;
  }
  return null;
}

function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const rat = (o) => { const d = u32(o + 4); return d ? u32(o) / d : 0; };

  function ifd(o) {
    const tags = {};
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type] * count;
      const vo = size > 4 ? u32(e + 8) : e + 8;
      if (type === 2) {
        let s = '';
        for (let k = 0; k < count - 1; k++) s += String.fromCharCode(v.getUint8(start + vo + k));
        tags[tag] = s;
      } else if (type === 5 || type === 10) {
        tags[tag] = Array.from({ length: count }, (_, k) => rat(vo + k * 8));
      } else if (type === 3) {
        tags[tag] = count === 1 ? u16(vo) : Array.from({ length: count }, (_, k) => u16(vo + k * 2));
      } else if (type === 4) {
        tags[tag] = u32(vo);
      } else if (type === 1 || type === 7) {
        tags[tag] = v.getUint8(start + vo);
      }
    }
    return tags;
  }

  const ifd0 = ifd(u32(4));
  const exif = ifd0[0x8769] ? ifd(ifd0[0x8769]) : {};
  const gps = ifd0[0x8825] ? ifd(ifd0[0x8825]) : {};
  const dms = (a) => a && a[0] + a[1] / 60 + a[2] / 3600;
  const out = {};
  if (gps[2] && gps[4]) {
    out.lat = dms(gps[2]) * (gps[1] === 'S' ? -1 : 1);
    out.lon = dms(gps[4]) * (gps[3] === 'W' ? -1 : 1);
  }
  if (gps[6]) out.altitude = gps[6][0] * (gps[5] === 1 ? -1 : 1);
  if (gps[0x11]) out.direction = gps[0x11][0];
  if (gps[0x10]) out.directionRef = gps[0x10]; // T = geografisch Nord, M = magnetisch Nord
  if (exif[0xa405]) out.focal35 = exif[0xa405];
  if (exif[0x9003] || ifd0[0x132]) out.date = exif[0x9003] || ifd0[0x132];
  if (ifd0[0x110]) out.camera = ifd0[0x110];
  return out;
}
