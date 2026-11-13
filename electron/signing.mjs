// Certificate-based (PKCS#7 / adbe.pkcs7.detached) PDF signing and verification, plus a
// small store of the user's digital IDs. Runs in the Electron main process (Node).
import { app } from 'electron';
import { createRequire } from 'node:module';
import { randomUUID, generateKeyPairSync, createHash, verify as cryptoVerify } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';

const require = createRequire(import.meta.url);
const forge = require('node-forge');
const signpdf = require('@signpdf/signpdf').default;
const { P12Signer } = require('@signpdf/signer-p12');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const { plainAddPlaceholder } = require('@signpdf/placeholder-plain');
const { PDFDocument } = require('pdf-lib');

const storeDir = () => join(app.getPath('userData'), 'digital-ids');
const indexFile = () => join(storeDir(), 'ids.json');

// ---------- digital ID store ----------

async function readIndex() {
  try { return JSON.parse(await readFile(indexFile(), 'utf8')); } catch { return []; }
}
async function writeIndex(list) {
  await mkdir(storeDir(), { recursive: true });
  await writeFile(indexFile(), JSON.stringify(list, null, 2));
}

const attr = (cert, short) => cert.subject.getField(short)?.value || '';
const issuerAttr = (cert, short) => cert.issuer.getField(short)?.value || '';

function describeCert(cert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    name: attr(cert, 'CN'),
    email: attr(cert, 'E') || cert.subject.getField({ name: 'emailAddress' })?.value || '',
    org: attr(cert, 'O'),
    issuer: issuerAttr(cert, 'CN') || issuerAttr(cert, 'O'),
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    selfSigned: cert.isIssuer(cert),
    fingerprint: createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex').toUpperCase().match(/../g).join(':'),
  };
}

/** Parse a PKCS#12 file; throws a friendly error on a wrong password. */
function openP12(buf, password) {
  try {
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buf.toString('binary'))), false, password);
    const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const keys = [
      ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
      ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
    ];
    if (!keys.length || !certs.length) throw new Error('This file does not contain both a certificate and its private key.');
    // The signing certificate is the one whose public key matches the private key.
    const key = keys[0].key;
    const cert = certs.map((b) => b.cert).find((c) => c.publicKey.n?.equals?.(key.n)) || certs[0].cert;
    return { cert, key };
  } catch (e) {
    if (/MAC could not be verified|Invalid password|decrypt/i.test(e.message)) throw new Error('Incorrect password for this digital ID.');
    throw e;
  }
}

export async function listIds() {
  return readIndex();
}

export async function createId({ name, email, org, password, years = 5 }) {
  if (!name?.trim()) throw new Error('Enter your name.');
  if (!password || password.length < 6) throw new Error('Choose a password of at least 6 characters.');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const key = forge.pki.privateKeyFromPem(privateKey);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + years * 365.25 * 864e5);
  const subject = [{ shortName: 'CN', value: name.trim() }];
  if (org?.trim()) subject.push({ shortName: 'O', value: org.trim() });
  if (email?.trim()) subject.push({ name: 'emailAddress', value: email.trim() });
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(key, forge.md.sha256.create());
  const p12 = forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: '3des', friendlyName: name.trim() })).getBytes();
  return saveId(Buffer.from(p12, 'binary'), cert);
}

export async function importId(bytes, password) {
  const buf = Buffer.from(bytes);
  const { cert } = openP12(buf, password);
  return saveId(buf, cert);
}

async function saveId(buf, cert) {
  const id = randomUUID();
  await mkdir(storeDir(), { recursive: true });
  await writeFile(join(storeDir(), `${id}.p12`), buf);
  const entry = { id, ...describeCert(cert), created: new Date().toISOString() };
  const list = await readIndex();
  list.push(entry);
  await writeIndex(list);
  return entry;
}

export async function deleteId(id) {
  const list = await readIndex();
  await writeIndex(list.filter((x) => x.id !== id));
  await rm(join(storeDir(), `${String(id).replace(/[^\w-]/g, '')}.p12`), { force: true });
}

export async function readIdFile(id) {
  return readFile(join(storeDir(), `${String(id).replace(/[^\w-]/g, '')}.p12`));
}

/** Public certificate (PEM) for sharing, so others can choose to trust this ID. */
export async function certificatePem(id, password) {
  const { cert } = openP12(await readIdFile(id), password);
  return forge.pki.certificateToPem(cert);
}

// ---------- signing ----------

/**
 * bytes: the PDF (with the visible appearance already drawn in, if wanted).
 * widget: {page, rect: [x1, y1, x2, y2]} in PDF user space.
 * The first signature rewrites the file; later ones are appended as incremental
 * updates so existing signatures stay valid.
 */
export async function signPdf({ bytes, id, password, reason, location, contactInfo, widget }) {
  const p12 = await readIdFile(id);
  const { cert } = openP12(p12, password); // validates the password with a friendly error
  const name = attr(cert, 'CN');
  const common = {
    reason: reason || '', location: location || '', contactInfo: contactInfo || '', name,
    signingTime: new Date(), signatureLength: 16384, appName: 'Inkstone', widgetRect: widget?.rect || [0, 0, 0, 0],
  };
  let buf = Buffer.from(bytes);
  if (buf.includes('/ByteRange')) {
    buf = plainAddPlaceholder({ pdfBuffer: buf, ...common });
  } else {
    const pdfDoc = await PDFDocument.load(buf, { updateMetadata: false });
    pdflibAddPlaceholder({ pdfDoc, pdfPage: pdfDoc.getPage(widget?.page || 0), ...common });
    buf = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  }
  const signed = await signpdf.sign(buf, new P12Signer(p12, { passphrase: password }));
  return new Uint8Array(signed);
}

// ---------- verification ----------

const DIGESTS = {
  '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512',
};

/** Decode a PDF string token: (literal) or <hex>, including UTF-16BE with BOM. */
function pdfString(tok) {
  if (!tok) return '';
  let bytes;
  if (tok.startsWith('<')) {
    bytes = Buffer.from(tok.slice(1, -1).replace(/\s+/g, ''), 'hex');
  } else {
    const s = tok.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c] ?? String.fromCharCode(parseInt(c, 8))));
    bytes = Buffer.from(s, 'latin1');
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le');
  return bytes.toString('latin1');
}

function dictValue(dict, key) {
  const m = dict.match(new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`));
  return m ? pdfString(m[1]) : '';
}

/** PDF date (D:YYYYMMDDHHmmSS+HH'mm') to ISO, best effort. */
function pdfDate(s) {
  const m = s.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', z, oh = '00', om = '00'] = m;
  const tz = !z || z === 'Z' ? 'Z' : `${z}${oh}:${om}`;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${tz}`).toISOString();
}

let roots;
function trustedRoots() {
  if (!roots) roots = rootCertificates.map((pem) => { try { return forge.pki.certificateFromPem(pem); } catch { return null; } }).filter(Boolean);
  return roots;
}

function chainIsTrusted(signer, certs) {
  let cur = signer;
  for (let i = 0; i < 10 && cur; i++) {
    const root = trustedRoots().find((r) => r.subject.hash === cur.issuer.hash);
    if (root) { try { return root.verify(cur); } catch { return false; } }
    if (cur.isIssuer(cur)) return false; // self-signed and not a known root
    cur = certs.find((c) => c !== cur && c.subject.hash === cur.issuer.hash);
  }
  return false;
}

/** Inspect every signature in a PDF. Returns [{name, signedAt, reason, location, status...}] */
export function verifyPdf(bytes) {
  const buf = Buffer.from(bytes);
  const text = buf.toString('latin1');
  const out = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(text))) {
    const [a, b, c, d] = m.slice(1).map(Number);
    // The signature dictionary surrounding this ByteRange.
    const start = text.lastIndexOf('<<', m.index);
    const dictText = text.slice(start, text.indexOf('>>', text.indexOf('/Contents', start) + 1) + 2 || m.index + 400);
    const info = {
      name: dictValue(dictText, 'Name'), reason: dictValue(dictText, 'Reason'), location: dictValue(dictText, 'Location'),
      contactInfo: dictValue(dictText, 'ContactInfo'), signedAt: pdfDate(dictValue(dictText, 'M')),
      coversWholeFile: c + d === buf.length, integrity: false, signatureValid: false, trusted: false, problems: [],
    };
    try {
      if (a !== 0 || b <= 0 || c <= a + b || c + d > buf.length) throw new Error('Malformed byte range.');
      const hex = text.slice(a + b, c).replace(/[<>\s]/g, '');
      const der = Buffer.from(hex, 'hex');
      const asn = forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary')), { parseAllBytes: false });
      const p7 = forge.pkcs7.messageFromAsn1(asn);
      const certs = p7.certificates || [];
      const rc = p7.rawCapture || {};
      const serial = forge.util.bytesToHex(rc.serial || '').replace(/^0+/, '');
      const signer = certs.find((ct) => ct.serialNumber.replace(/^0+/, '') === serial) || certs[0];
      if (!signer) throw new Error('No certificate in signature.');
      Object.assign(info, { certificate: describeCert(signer) });
      if (!info.name) info.name = info.certificate.name;
      const digestAlg = DIGESTS[forge.asn1.derToOid(rc.digestAlgorithm)] || 'sha256';
      const content = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
      const actual = createHash(digestAlg).update(content).digest();
      const attrs = rc.authenticatedAttributes;
      const signature = Buffer.from(rc.signature, 'binary');
      const pubPem = forge.pki.publicKeyToPem(signer.publicKey);
      if (attrs?.length) {
        const mdAttr = attrs.find((x) => forge.asn1.derToOid(x.value[0].value) === forge.pki.oids.messageDigest);
        const expected = mdAttr ? Buffer.from(mdAttr.value[1].value[0].value, 'binary') : null;
        info.integrity = !!expected && expected.equals(actual);
        const timeAttr = attrs.find((x) => forge.asn1.derToOid(x.value[0].value) === forge.pki.oids.signingTime);
        if (timeAttr && !info.signedAt) { try { info.signedAt = forge.asn1.utcTimeToDate(timeAttr.value[1].value[0].value).toISOString(); } catch { /* ignore */ } }
        const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
        const signedAttrs = Buffer.from(forge.asn1.toDer(set).getBytes(), 'binary');
        info.signatureValid = cryptoVerify(digestAlg, signedAttrs, pubPem, signature);
      } else {
        info.signatureValid = cryptoVerify(digestAlg, content, pubPem, signature);
        info.integrity = info.signatureValid;
      }
      info.trusted = chainIsTrusted(signer, certs);
      const when = info.signedAt ? new Date(info.signedAt) : new Date();
      if (when < signer.validity.notBefore || when > signer.validity.notAfter) info.problems.push('The certificate was not valid at signing time.');
    } catch (e) {
      info.problems.push(e.message || String(e));
    }
    if (!info.integrity) info.problems.push('The document has been altered since it was signed.');
    if (info.integrity && !info.signatureValid) info.problems.push('The signature does not match the certificate.');
    out.push(info);
  }
  return out;
}
