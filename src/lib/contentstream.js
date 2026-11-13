// Minimal PDF content-stream reader: tokenizes page drawing instructions and tracks
// the text state well enough to locate every text-showing operator on the page.
// Used by "Edit Text" to remove the original text before drawing the replacement.

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/**
 * Tokenize a content stream given as a latin1 string (one char per byte).
 * Yields {t: 'num'|'name'|'str'|'hex'|'op'|'['|']'|'<<'|'>>', v, s, e} with byte offsets.
 */
export function* tokenize(src) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const code = src.charCodeAt(i);
    if (WS.has(code)) { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    const s = i;
    if (c === '(') {
      let depth = 1, out = '';
      i++;
      while (i < n && depth) {
        const ch = src[i];
        if (ch === '\\') {
          const nx = src[i + 1];
          const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[nx];
          if (esc !== undefined) { out += esc; i += 2; continue; }
          if (/[0-7]/.test(nx)) {
            let oct = '';
            i++;
            while (oct.length < 3 && /[0-7]/.test(src[i])) oct += src[i++];
            out += String.fromCharCode(parseInt(oct, 8) & 255);
            continue;
          }
          if (nx === '\r' || nx === '\n') { i += nx === '\r' && src[i + 2] === '\n' ? 3 : 2; continue; }
          i++;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')' && !--depth) { i++; break; }
        out += ch;
        i++;
      }
      yield { t: 'str', v: out, s, e: i };
      continue;
    }
    if (c === '<' && src[i + 1] === '<') { i += 2; yield { t: '<<', s, e: i }; continue; }
    if (c === '>' && src[i + 1] === '>') { i += 2; yield { t: '>>', s, e: i }; continue; }
    if (c === '<') {
      const end = src.indexOf('>', i);
      let hex = src.slice(i + 1, end < 0 ? n : end).replace(/[^0-9A-Fa-f]/g, '');
      if (hex.length % 2) hex += '0';
      let out = '';
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      i = end < 0 ? n : end + 1;
      yield { t: 'hex', v: out, s, e: i };
      continue;
    }
    if (c === '[' || c === ']' || c === '{' || c === '}') { i++; yield { t: c === '{' ? '[' : c === '}' ? ']' : c, s, e: i }; continue; }
    if (c === '/') {
      i++;
      while (i < n && !WS.has(src.charCodeAt(i)) && !DELIM.has(src[i])) i++;
      yield { t: 'name', v: src.slice(s + 1, i), s, e: i };
      continue;
    }
    // Number or operator.
    while (i < n && !WS.has(src.charCodeAt(i)) && !DELIM.has(src[i])) i++;
    if (i === s) { i++; continue; } // stray delimiter
    const word = src.slice(s, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { yield { t: 'num', v: parseFloat(word), s, e: i }; continue; }
    yield { t: 'op', v: word, s, e: i };
    if (word === 'ID') {
      // Inline image data: skip to the EI that ends it.
      const m = /\sEI(?=[\s]|$)/g;
      m.lastIndex = i;
      const r = m.exec(src);
      const end = r ? r.index + 1 : n;
      yield { t: 'op', v: 'EI', s: end, e: Math.min(n, end + 2) };
      i = Math.min(n, end + 2);
    }
  }
}

const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];
const ID = [1, 0, 0, 1, 0, 0];

function cmykToRgb(c, m, y, k) { return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; }

/**
 * Walk a content stream and return every text-showing operator with its position.
 * fontInfo(name) -> {width(code) (1/1000 em), twoByte, baseFont}
 * Returns [{s, e, op, origin:[x,y], dir:[ux,uy], height, end:[x,y], fill:[r,g,b], font, size, replace}]
 * where s..e is the byte range of the operator and its operands, and `replace` is
 * what must remain if the text is removed (line moves done by ' and ").
 */
export function findTextOps(src, fontInfo) {
  const out = [];
  const stack = [];
  let gs = { ctm: ID, fill: [0, 0, 0] };
  let ts = { font: null, size: 12, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  let tm = ID, tlm = ID;
  let operands = [];
  let opStart = -1;
  let arrayDepth = 0, arr = null;
  let dictDepth = 0;

  const showText = (strings, tok, extraReplace = '') => {
    const info = fontInfo(ts.font) || { width: () => 500, twoByte: false };
    const m0 = mul(tm, gs.ctm);
    const origin = [m0[4], m0[5]];
    const len = Math.hypot(m0[0], m0[1]) || 1;
    const dir = [m0[0] / len, m0[1] / len];
    const height = ts.size * (Math.hypot(m0[2], m0[3]) || 1);
    for (const part of strings) {
      if (typeof part === 'number') {
        tm = mul([1, 0, 0, 1, (-part / 1000) * ts.size * ts.th, 0], tm);
        continue;
      }
      const step = info.twoByte ? 2 : 1;
      for (let k = 0; k < part.length; k += step) {
        const code = step === 2 ? (part.charCodeAt(k) << 8) | (part.charCodeAt(k + 1) || 0) : part.charCodeAt(k);
        const w = info.width(code) / 1000;
        const tx = (w * ts.size + ts.tc + (step === 1 && code === 32 ? ts.tw : 0)) * ts.th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    }
    const m1 = mul(tm, gs.ctm);
    out.push({ s: opStart, e: tok.e, op: tok.v, origin, dir, height, end: [m1[4], m1[5]], fill: gs.fill, font: ts.font, size: ts.size, replace: extraReplace });
  };

  const gstack = [];
  for (const tok of tokenize(src)) {
    if (opStart < 0) opStart = tok.s;
    if (tok.t === '<<') { dictDepth++; continue; }
    if (tok.t === '>>') { dictDepth--; continue; }
    if (dictDepth > 0) continue; // inline dictionaries (BDC properties) carry no text state
    if (tok.t === '[') { arrayDepth++; if (arrayDepth === 1) arr = []; continue; }
    if (tok.t === ']') { arrayDepth--; if (arrayDepth === 0) { operands.push(arr); arr = null; } continue; }
    if (tok.t !== 'op') {
      const v = tok.t === 'num' ? tok.v : tok.t === 'name' ? { name: tok.v } : tok.v;
      if (arrayDepth > 0) arr.push(v); else operands.push(v);
      continue;
    }
    const o = operands;
    const nums = o.filter((x) => typeof x === 'number');
    switch (tok.v) {
      case 'q': gstack.push({ ...gs }); break;
      case 'Q': gs = gstack.pop() || gs; break;
      case 'cm': if (nums.length >= 6) gs = { ...gs, ctm: mul(nums.slice(-6), gs.ctm) }; break;
      case 'g': gs = { ...gs, fill: [nums[0], nums[0], nums[0]] }; break;
      case 'rg': gs = { ...gs, fill: nums.slice(0, 3) }; break;
      case 'k': gs = { ...gs, fill: cmykToRgb(...nums.slice(0, 4)) }; break;
      case 'sc': case 'scn':
        if (nums.length === 1) gs = { ...gs, fill: [nums[0], nums[0], nums[0]] };
        else if (nums.length === 3) gs = { ...gs, fill: nums.slice(0, 3) };
        else if (nums.length === 4) gs = { ...gs, fill: cmykToRgb(...nums) };
        break;
      case 'BT': tm = tlm = ID; break;
      case 'Tf': ts = { ...ts, font: o[0]?.name ?? ts.font, size: nums[0] ?? ts.size }; break;
      case 'Tc': ts = { ...ts, tc: nums[0] ?? 0 }; break;
      case 'Tw': ts = { ...ts, tw: nums[0] ?? 0 }; break;
      case 'Tz': ts = { ...ts, th: (nums[0] ?? 100) / 100 }; break;
      case 'TL': ts = { ...ts, tl: nums[0] ?? 0 }; break;
      case 'Ts': ts = { ...ts, rise: nums[0] ?? 0 }; break;
      case 'Td': tlm = mul([1, 0, 0, 1, nums[0] ?? 0, nums[1] ?? 0], tlm); tm = tlm; break;
      case 'TD': ts = { ...ts, tl: -(nums[1] ?? 0) }; tlm = mul([1, 0, 0, 1, nums[0] ?? 0, nums[1] ?? 0], tlm); tm = tlm; break;
      case 'Tm': if (nums.length >= 6) { tlm = nums.slice(-6); tm = tlm; } break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -ts.tl], tlm); tm = tlm; break;
      case 'Tj': showText([o[o.length - 1] ?? ''], tok); break;
      case 'TJ': showText(Array.isArray(o[o.length - 1]) ? o[o.length - 1] : [], tok); break;
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -ts.tl], tlm); tm = tlm;
        showText([o[o.length - 1] ?? ''], tok, 'T*');
        break;
      case '"':
        ts = { ...ts, tw: nums[0] ?? ts.tw, tc: nums[1] ?? ts.tc };
        tlm = mul([1, 0, 0, 1, 0, -ts.tl], tlm); tm = tlm;
        showText([o[o.length - 1] ?? ''], tok, `${nums[0] ?? 0} Tw ${nums[1] ?? 0} Tc T*`);
        break;
    }
    operands = [];
    opStart = -1;
  }
  return out;
}

/**
 * Choose the text operators that belong to a line: {origin, dir, height, length} in PDF
 * user space. An operator matches when it sits on that baseline and its run overlaps the
 * line's span — including runs that begin a little earlier, such as leading indent spaces.
 */
export function opsOnLine(ops, line) {
  const [ux, uy] = line.dir;
  return ops.filter((op) => {
    if (op.dir[0] * ux + op.dir[1] * uy < 0.98) return false;
    const dx = op.origin[0] - line.origin[0], dy = op.origin[1] - line.origin[1];
    const along = dx * ux + dy * uy;
    const across = -dx * uy + dy * ux;
    const h = Math.max(line.height, op.height);
    if (Math.abs(across) > 0.35 * h) return false;
    const alongEnd = (op.end[0] - line.origin[0]) * ux + (op.end[1] - line.origin[1]) * uy;
    if (along >= -0.4 * h) return along <= line.length - 0.05 * h;
    // Starts before the line: it must actually reach into it.
    return alongEnd > 0.3 * h && along > -8 * h;
  });
}
