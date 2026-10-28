const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const csv = require('../static/csv_tools.js');

// --- パーサ（RFC 4180）---
assert.deepEqual(csv.parseCSV('a,b\r\nc,d\r\n'), [['a', 'b'], ['c', 'd']]);
assert.deepEqual(csv.parseCSV('a,b\nc,d'), [['a', 'b'], ['c', 'd']], 'LF・末尾改行なし');
assert.deepEqual(csv.parseCSV('﻿a,b\r\n'), [['a', 'b']], 'BOMを除く');
assert.deepEqual(csv.parseCSV('"A橋, 下り","2026年度","say ""hi"""\r\n'), [['A橋, 下り', '2026年度', 'say "hi"']], '引用符内のカンマと""');
assert.deepEqual(csv.parseCSV('"line1\r\nline2",x\r\n'), [['line1\r\nline2', 'x']], '引用符内の改行');
assert.deepEqual(csv.parseCSV('a,,c\r\n,,\r\n'), [['a', '', 'c'], ['', '', '']], '空フィールド');
assert.deepEqual(csv.parseCSV(''), []);
assert.deepEqual(csv.parseCSV('a,""\r\n'), [['a', '']], '空の引用フィールド');

// --- エンコード ---
assert.equal(csv.encodeCSV([['a', 'b,c', 'd"e', 'f\ng', '']]), 'a,"b,c","d""e","f\ng",\r\n');
const tricky = [['施設名', 'x'], ['A,B', 'say "hi"'], ['multi\r\nline', '']];
assert.deepEqual(csv.parseCSV(csv.encodeCSV(tricky)), tricky, 'encode→parse が元に戻る');

// --- テンプレート判定 ---
assert.equal(csv.isTemplateRows(csv.parseCSV('﻿施設名,年度,業務名\r\n')), true);
assert.equal(csv.isTemplateRows([['  施設名 ', 'x']]), true, '前後空白');
assert.equal(csv.isTemplateRows([['﻿施設名']]), true, '先頭セルに残ったBOM');
assert.equal(csv.isTemplateRows([['施　設名']]), false, '途中の空白は別物');
assert.equal(csv.isTemplateRows([['橋名', '年度']]), false);
assert.equal(csv.isTemplateRows([]), false);
assert.equal(csv.isTemplateRows([[]]), false);

// --- 文字コード判定 ---
const sjisBytes = new Uint8Array(Buffer.from('824f8250', 'hex')); // Shift_JIS 全角「０１」
assert.equal(csv.decodeCSVBytes(sjisBytes, TextDecoder), '０１');
const utf8Bytes = new Uint8Array(Buffer.from('﻿施設名,年度\r\n', 'utf8'));
assert.equal(csv.decodeCSVBytes(utf8Bytes, TextDecoder), '施設名,年度\r\n', 'UTF-8(BOM)はUTF-8として復号');
assert.equal(csv.decodeCSVBytes(new Uint8Array(Buffer.from('施設名', 'utf8')), TextDecoder), '施設名');
// Shift_JISで保存したテンプレート（施設名,年度,業務名 / "Ａ橋,下り",2026）が丸ごと読める
const sjisTemplate = new Uint8Array(Buffer.from('8e7b90dd96bc2c944e93782c8bc696b196bc0d0a2282608bb42c89ba82e8222c323032360d0a', 'hex'));
const sjisRows = csv.parseCSV(csv.decodeCSVBytes(sjisTemplate, TextDecoder));
assert.equal(csv.isTemplateRows(sjisRows), true);
assert.equal(sjisRows[1][0], 'Ａ橋,下り');

// --- ファイル名 ---
assert.equal(csv.sanitizeFileName('A/B:C*D?"E<F>G|H\\I'), 'A_B_C_D__E_F_G_H_I');
assert.equal(csv.sanitizeFileName('業務名. '), '業務名');
assert.equal(csv.sanitizeFileName(''), '_');
assert.equal(csv.xrscaleFileName('2026年度', '橋梁点検/第1工区'), 'XRScale_現場一覧_2026年度_橋梁点検_第1工区.csv');

// --- 種別の判定 ---
const feat = (name, kubun, extra = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [135, 35] }, properties: { DPF_title: name, ...(kubun === undefined ? {} : { shisetsu_kubun: kubun }), ...extra } });
assert.equal(csv.shubetsuOf(feat('a', 1)), '橋梁');
assert.equal(csv.shubetsuOf(feat('a', '3')), 'シェッド', '文字列でも可');
assert.equal(csv.shubetsuOf(feat('a', 2)), null, 'トンネル');
assert.equal(csv.shubetsuOf(feat('a', 4)), null, 'カルバート');
assert.equal(csv.shubetsuOf(feat('a')), null, '種別なし');
assert.equal(csv.shubetsuOf(null), null);

// --- XRScale用CSVの組み立て ---
const built = csv.buildXRScaleCsv([
    { nendo: '2026年度', gyomu: 'R8橋梁点検', features: [feat('大橋, 上り', 1), feat('第1シェッド', 3), feat('山トンネル', 2), feat('名無し種別', undefined), feat('', 1)] },
    { nendo: '2026年度', gyomu: 'R8 "特"点検', features: [feat('小橋', 1, { XRDS_display_name: '小橋(改)' })] },
]);
assert.equal(built.included, 3);
assert.equal(built.excluded.total, 3);
assert.equal(built.excluded.byKubun[2], 1);
assert.equal(built.excluded.unknown, 1);
assert.equal(built.excluded.noName, 1);
assert.equal(built.csv, [
    '施設名,年度,業務名,種別,径間数',
    '"大橋, 上り",2026年度,R8橋梁点検,橋梁,',
    '第1シェッド,2026年度,R8橋梁点検,シェッド,',
    '小橋(改),2026年度,"R8 ""特""点検",橋梁,',
    '',
].join('\r\n'));
assert.ok(!built.csv.includes('﻿'), 'BOMは保存時に付与する');
assert.ok(!/(^|[^\r])\n/.test(built.csv), '改行はすべてCRLF');
assert.deepEqual(csv.parseCSV(built.csv)[0], ['施設名', '年度', '業務名', '種別', '径間数']);

// --- テンプレートCSV ---
assert.equal(csv.buildTemplateCsv(), '施設名,年度,業務名,種別,径間数\r\nサンプル橋,2026年度,サンプル橋梁点検業務,橋梁,\r\n');

// --- index.html / map.js の配線（文字列レベル）---
const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mapJs = fs.readFileSync(path.join(root, 'static', 'map.js'), 'utf8');
assert.match(indexHtml, /<script src="static\/csv_tools\.js\?v=\d+"><\/script>/);
assert.match(indexHtml, /downloadTemplateCsv\(\)/);
assert.ok(!indexHtml.includes('!file.name.includes("テンプレート")'), 'ファイル名でテンプレート判定しない');
assert.ok(!/split\(','\)/.test(indexHtml), '素朴なsplit(\',\')を使わない');
assert.match(mapJs, /data-action="xrscale-csv"/);
assert.match(mapJs, /data-year-action="xrscale-csv-year"/);

console.log('csv tools smoke test: OK');
