'use strict';
/**
 * A PDF's text, page by page, with no dependency: the small extractor OpenVibe.AI uses for files on a turn
 * (OpenVibe.AI server/file-inputs.js pdfText/contentText, MIT, the same organisation), so a statement is read here and
 * never leaves Finance.
 *
 *   pdfText(buffer) → { pages: [text] } | { pages: [], reason }
 *
 * It reads uncompressed and FlateDecode content streams and the text the Tj, TJ, ' and " operators show; a new line at
 * T*, Td, TD and ET. An encrypted PDF, a scanned one (images only) or one with a custom font encoding has no readable
 * text, and says so.
 */
const zlib = require('node:zlib');

const MAX_STREAMS = 500;
const MAX_TEXT_CHARS = 400000;

function pdfText(buffer) {
    const raw = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer || '');
    if (!raw.startsWith('%PDF')) return { pages: [], reason: 'this is not a PDF' };
    if (/\/Encrypt\s/.test(raw)) return { pages: [], reason: 'the PDF is encrypted (password protected)' };
    const pages = [];
    let total = 0;
    let seen = 0;
    const re = /stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
    let m;
    while ((m = re.exec(raw)) && seen < MAX_STREAMS) {
        seen++;
        const before = raw.slice(Math.max(0, m.index - 400), m.index);
        let data = Buffer.from(m[1], 'latin1');
        if (/\/FlateDecode\b/.test(before)) {
            try { data = zlib.inflateSync(data, { maxOutputLength: 8 * 1024 * 1024 }); } catch { continue; }
        } else if (/\/Filter\b/.test(before)) {
            continue;   // an image (DCT) or another filter, not text
        }
        const text = contentText(data.toString('latin1'));
        if (text) { pages.push(text); total += text.length; }
        if (total >= MAX_TEXT_CHARS) break;
    }
    if (!pages.length) return { pages: [], reason: 'the PDF has no readable text (it may be scanned pages, or use a custom font encoding)' };
    return { pages };
}

/** The text the Tj/TJ/'/" operators show in one content stream. */
function contentText(stream) {
    const parts = [];
    let i = 0;
    const n = stream.length;
    const readString = () => {
        let out = '';
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
            const c = stream[i++];
            if (c === '\\') {
                const d = stream[i++];
                if (d === 'n') out += '\n';
                else if (d === 'r') out += '\r';
                else if (d === 't') out += '\t';
                else if (d === 'b' || d === 'f') out += ' ';
                else if (d === '\n' || d === '\r') { if (d === '\r' && stream[i] === '\n') i++; }
                else if (/[0-7]/.test(d)) {
                    let oct = d;
                    while (oct.length < 3 && /[0-7]/.test(stream[i])) oct += stream[i++];
                    out += String.fromCharCode(parseInt(oct, 8));
                } else out += d;
            } else if (c === '(') { depth++; out += c; }
            else if (c === ')') { depth--; if (depth) out += c; }
            else out += c;
        }
        return out;
    };
    while (i < n) {
        const c = stream[i];
        if (c === '(') {
            const s = readString();
            let j = i;
            while (j < n && /\s/.test(stream[j])) j++;
            if (stream.startsWith('Tj', j)) { parts.push(s); i = j + 2; continue; }
            if (stream.startsWith("'", j) || stream.startsWith('"', j)) { parts.push(`\n${s}`); i = j + 1; continue; }
            continue;
        }
        if (c === '[') {
            i++;
            const arr = [];
            while (i < n && stream[i] !== ']') {
                if (stream[i] === '(') arr.push(readString());
                else i++;
            }
            i++;
            const tm = /^\s*TJ/.exec(stream.slice(i, i + 8));
            if (tm) { parts.push(arr.join('')); i += tm[0].length; }
            continue;
        }
        if (stream.startsWith('T*', i) || stream.startsWith('Td', i) || stream.startsWith('TD', i) || stream.startsWith('ET', i)) {
            parts.push('\n'); i += 2; continue;
        }
        i++;
    }
    return parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { pdfText };
