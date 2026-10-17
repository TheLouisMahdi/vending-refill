"""Refresh data in the branded workbook without third-party dependencies."""
import csv
import io
import re
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', NS)
ET.register_namespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')


def tag(name):
    return f'{{{NS}}}{name}'


def refresh(path=ROOT / 'data/unicafe-history.xlsx', csv_path=ROOT / 'data/unicafe-history.csv'):
    with csv_path.open(encoding='utf-8-sig', newline='') as source:
        rows = [row for row in csv.reader(source) if row][1:]
    with ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    sheet = ET.fromstring(files['xl/worksheets/sheet1.xml'])
    data = sheet.find(tag('sheetData'))
    # Reuse the two alternating row styles authored in the original template.
    styles = [[cell.get('s', '0') for cell in data.find(f"{tag('row')}[@r='{r}']")] for r in (6, 7)]
    for row in list(data):
        if int(row.get('r')) >= 6:
            data.remove(row)
    # Latest operations appear first, preserving the original sequence within each save.
    ordered = sorted(enumerate(rows), key=lambda item: -int(item[1][0]))
    while len(ordered) < 2:
        ordered.append((0, [''] * 10))
    for offset, (_, values) in enumerate(ordered):
        number = offset + 6
        height = min(120, max(28, 16 * max((len(str(v)) // 32 + str(v).count('\n') + 1) for v in values[5:8])))
        row = ET.SubElement(data, tag('row'), {'r': str(number), 'ht': str(height), 'customHeight': '1'})
        for column, value in enumerate(values):
            attrs = {'r': f'{chr(65 + column)}{number}', 's': styles[offset % 2][column]}
            numeric = column in (0, 8) or (column in (6, 7) and values[3] in ('ثبت آمار', 'شارژ و خروج از انبار'))
            if numeric and value != '':
                cell = ET.SubElement(row, tag('c'), attrs)
                ET.SubElement(cell, tag('v')).text = str(int(value))
            else:
                # inlineStr keeps text safe even when it starts with '='.
                if value.startswith("'") and (value.startswith("''") or re.match(r"^[\s\ufeff]*[=+@-]", value[1:]) or value[1:2] in ('\t', '\r', '\n')):
                    value = value[1:]
                cell = ET.SubElement(row, tag('c'), {**attrs, 't': 'inlineStr'})
                text = ET.SubElement(ET.SubElement(cell, tag('is')), tag('t'), {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})
                text.text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', value)
    end = max(7, len(rows) + 5)
    dimension = sheet.find(tag('dimension'))
    if dimension is not None:
        dimension.set('ref', f'A1:J{end}')
    for view in sheet.findall(f"{tag('sheetViews')}/{tag('sheetView')}"):
        view.set('rightToLeft', '1')
    autofilter = sheet.find(tag('autoFilter'))
    if autofilter is not None:
        autofilter.set('ref', f'A5:J{end}')
    files['xl/worksheets/sheet1.xml'] = ET.tostring(sheet, encoding='utf-8', xml_declaration=True)
    for name in files:
        if name.startswith('xl/tables/') and name.endswith('.xml'):
            table = ET.fromstring(files[name])
            table.set('ref', f'A5:J{end}')
            table.find(tag('autoFilter')).set('ref', f'A5:J{end}')
            files[name] = ET.tostring(table, encoding='utf-8', xml_declaration=True)
    # Fixed ZIP timestamps make repeated exports byte-for-byte reproducible.
    output = io.BytesIO()
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for name, content in files.items():
            entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            archive.writestr(entry, content)
    path.write_bytes(output.getvalue())
    print(f'Updated workbook: {len(rows)} detail rows.')


if __name__ == '__main__':
    refresh()
