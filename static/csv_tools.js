// CSVの読み込み・書き出し補助（施設検索テンプレート / XRScale用現場一覧）。
// ブラウザでは window.xrdsCsv、Node（テスト）では module.exports として公開する。
(function (root) {
    // 施設検索テンプレートとXRScale取込CSVで共通のヘッダー（A-C列は従来のテンプレートと同じ）
    const XRSCALE_HEADER = ['施設名', '年度', '業務名', '種別', '径間数'];

    // xROAD APIの shisetsu_kubun（実APIで確認: bridges=1 / tunnels=2 / sheds=3 / culverts=4）
    // 橋梁→橋梁、シェッド（洞門を含む）→シェッド。トンネル等はXRScaleの対象外。
    const SHUBETSU_BY_KUBUN = { 1: '橋梁', 3: 'シェッド' };

    // RFC 4180 のパーサ。引用符内の , 改行 "" を扱い、行区切りは CRLF / LF / CR を受け付ける。
    function parseCSV(text) {
        let src = String(text ?? '');
        if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
        const rows = [];
        let row = [];
        let field = '';
        let inQuotes = false;
        let fieldWasQuoted = false;
        const endField = () => { row.push(field); field = ''; fieldWasQuoted = false; };
        const endRow = () => { endField(); rows.push(row); row = []; };
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
                } else {
                    field += ch;
                }
            } else if (ch === '"' && field === '' && !fieldWasQuoted) {
                inQuotes = true;
                fieldWasQuoted = true;
            } else if (ch === ',') {
                endField();
            } else if (ch === '\r') {
                if (src[i + 1] === '\n') i++;
                endRow();
            } else if (ch === '\n') {
                endRow();
            } else {
                field += ch;
            }
        }
        // 末尾が改行で終わる場合は空の最終行を作らない
        if (field !== '' || fieldWasQuoted || row.length > 0) endRow();
        return rows;
    }

    function encodeField(value) {
        const text = value === undefined || value === null ? '' : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    // 行の配列をCSV文字列（CRLF区切り・末尾改行あり）にする。BOMは付けない（保存時に付与）。
    function encodeCSV(rows) {
        return rows.map(row => row.map(encodeField).join(',') + '\r\n').join('');
    }

    // バイト列をUTF-8として読み、不正な並びや置換文字(U+FFFD)があればShift_JISで読み直す。
    function decodeCSVBytes(bytes, TextDecoderImpl) {
        const Decoder = TextDecoderImpl || root.TextDecoder;
        let utf8Text = null;
        try {
            utf8Text = new Decoder('utf-8', { fatal: true }).decode(bytes);
        } catch (error) {
            utf8Text = null;
        }
        if (utf8Text !== null && !utf8Text.includes('�')) return utf8Text;
        return new Decoder('shift_jis').decode(bytes);
    }

    function normalizeHeaderCell(value) {
        return String(value ?? '').replace(/^﻿/, '').normalize('NFKC').trim();
    }

    // 先頭行の先頭セルが「施設名」ならテンプレート形式のCSV（ファイル名は問わない）
    function isTemplateRows(rows) {
        return Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])
            && normalizeHeaderCell(rows[0][0]) === '施設名';
    }

    function sanitizeFileName(value) {
        const cleaned = String(value ?? '')
            .normalize('NFC')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .trim()
            .replace(/[. ]+$/, '');
        return cleaned || '_';
    }

    function xrscaleFileName(nendo, gyomuLabel) {
        return `XRScale_現場一覧_${sanitizeFileName(nendo)}_${sanitizeFileName(gyomuLabel)}.csv`;
    }

    // 施設(Feature)の種別。橋梁/シェッド以外・判別不能は null。
    function shubetsuOf(feature) {
        const props = feature?.properties || {};
        const raw = props.shisetsu_kubun ?? props.RSDB_shisetsu_kubun;
        const code = Number(raw);
        return Number.isInteger(code) ? (SHUBETSU_BY_KUBUN[code] || null) : null;
    }

    function facilityNameOf(feature) {
        const props = feature?.properties || {};
        return String(props.XRDS_display_name || props.DPF_title || props.syogen_shisetsu_meisyou || '').trim();
    }

    // projects: [{ nendo, gyomu, features }]。橋梁・シェッドのみ1施設1行で出力し、除外件数を内訳付きで返す。
    function buildXRScaleCsv(projects) {
        const rows = [XRSCALE_HEADER.slice()];
        const excluded = { total: 0, byKubun: {}, unknown: 0, noName: 0 };
        let included = 0;
        (projects || []).forEach(project => {
            (project.features || []).forEach(feature => {
                const shubetsu = shubetsuOf(feature);
                const name = facilityNameOf(feature);
                if (!shubetsu) {
                    excluded.total++;
                    const props = feature?.properties || {};
                    const code = props.shisetsu_kubun ?? props.RSDB_shisetsu_kubun;
                    if (code === undefined || code === null || code === '') {
                        excluded.unknown++;
                    } else {
                        excluded.byKubun[code] = (excluded.byKubun[code] || 0) + 1;
                    }
                    return;
                }
                if (!name) { excluded.total++; excluded.noName++; return; }
                rows.push([name, project.nendo, project.gyomu, shubetsu, '']);
                included++;
            });
        });
        return { csv: encodeCSV(rows), included, excluded };
    }

    // 施設検索テンプレート.csv（A-E列のヘッダー + サンプル1行）
    function buildTemplateCsv() {
        return encodeCSV([XRSCALE_HEADER, ['サンプル橋', '2026年度', 'サンプル橋梁点検業務', '橋梁', '']]);
    }

    const api = {
        XRSCALE_HEADER, parseCSV, encodeCSV, decodeCSVBytes, normalizeHeaderCell, isTemplateRows,
        sanitizeFileName, xrscaleFileName, shubetsuOf, facilityNameOf, buildXRScaleCsv, buildTemplateCsv,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.xrdsCsv = api;
})(typeof window !== 'undefined' ? window : globalThis);
