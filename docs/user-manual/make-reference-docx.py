"""Builds reference.docx, the style template build-docx.ts hands to pandoc.

    python3 docs/user-manual/make-reference-docx.py

Starts from pandoc's default reference document and sets the DBIM look: Noto
Sans, the Blue colour group, the type scale, an A4 page, the band across the
top of every page after the cover, and page numbers. Rerun it after changing
any style here, then rebuild the manual with build-docx.ts.
"""
import os, re, shutil, subprocess, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'reference.docx')
SRC = tempfile.mkdtemp(prefix='wvs-reference-')
default = os.path.join(SRC, 'default.docx')
subprocess.run(['pandoc', '-o', default, '--print-default-data-file', 'reference.docx'], check=True)
with zipfile.ZipFile(default) as z:
    z.extractall(SRC)
os.remove(default)
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
FONT = '<w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans" w:eastAsia="Noto Sans" w:cs="Noto Sans"/>'
BLUE, KEY, INK = '214AAB', '162F6A', '150202'
TITLE = KEY

def style(sid, name, ppr='', rpr='', based='Normal', kind='paragraph', nxt=None, extra=''):
    n = f'<w:next w:val="{nxt}"/>' if nxt else ''
    return (f'<w:style w:type="{kind}" w:customStyle="1" w:styleId="{sid}"><w:name w:val="{name}"/><w:basedOn w:val="{based}"/>{n}<w:qFormat/>{extra}'
            f'<w:pPr>{ppr}</w:pPr><w:rPr>{rpr}</w:rPr></w:style>')

s = open(f'{SRC}/word/styles.xml').read()
s = re.sub(r'<w:rPrDefault>.*?</w:rPrDefault>', f'<w:rPrDefault><w:rPr>{FONT}<w:color w:val="{INK}"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault>', s, flags=re.S)
s = re.sub(r'<w:pPrDefault>.*?</w:pPrDefault>', '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault>', s, flags=re.S)
replace = {
 'Heading2': ('heading 2', '<w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="1"/>', f'{FONT}<w:b/><w:color w:val="{BLUE}"/><w:sz w:val="36"/><w:szCs w:val="36"/>'),
 'Heading3': ('heading 3', '<w:keepNext/><w:keepLines/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="2"/>', f'{FONT}<w:b/><w:color w:val="{TITLE}"/><w:sz w:val="30"/><w:szCs w:val="30"/>'),
 'Title': ('Title', '<w:spacing w:before="240" w:after="240" w:line="240" w:lineRule="auto"/>', f'{FONT}<w:b/><w:color w:val="{TITLE}"/><w:sz w:val="56"/><w:szCs w:val="56"/>'),
 'Figure': ('Figure', '<w:keepNext/><w:jc w:val="center"/><w:spacing w:before="120" w:after="240"/>', ''),
 'CaptionedFigure': ('Captioned Figure', '<w:keepNext/><w:jc w:val="center"/><w:spacing w:before="120" w:after="240"/>', ''),
 'Compact': ('Compact', '<w:spacing w:before="40" w:after="40"/>', ''),
}
for sid, (name, ppr, rpr) in replace.items():
    based = 'BodyText' if sid == 'Compact' else 'Normal'
    new = (f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/><w:basedOn w:val="{based}"/><w:next w:val="BodyText"/><w:qFormat/>'
           f'<w:pPr>{ppr}</w:pPr><w:rPr>{rpr}</w:rPr></w:style>')
    s = re.sub(rf'<w:style [^>]*w:styleId="{sid}">.*?</w:style>', new, s, count=1, flags=re.S)
grey = 'w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"'
table = (f'<w:style w:type="table" w:default="1" w:styleId="Table"><w:name w:val="Table"/><w:basedOn w:val="TableNormal"/><w:qFormat/>'
         f'<w:pPr><w:spacing w:before="40" w:after="40" w:line="264" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>'
         f'<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblBorders><w:top {grey}/><w:left {grey}/><w:bottom {grey}/><w:right {grey}/><w:insideH {grey}/><w:insideV {grey}/></w:tblBorders>'
         f'<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>'
         f'<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D2DFFF"/></w:tcPr></w:tblStylePr></w:style>')
s = re.sub(r'<w:style [^>]*w:styleId="Table">.*?</w:style>', table, s, count=1, flags=re.S)
custom = [
 style('CoverMark', 'Cover Mark', '<w:spacing w:before="0" w:after="600"/>', f'{FONT}<w:b/><w:color w:val="{KEY}"/><w:spacing w:val="60"/><w:sz w:val="56"/><w:szCs w:val="56"/>'),
 style('CoverTeam', 'Cover Team', '<w:spacing w:before="1200" w:after="120"/>', f'{FONT}<w:color w:val="{BLUE}"/><w:sz w:val="28"/><w:szCs w:val="28"/>'),
 style('CoverMeta', 'Cover Meta', '<w:spacing w:after="60"/>', f'<w:color w:val="606060"/><w:sz w:val="22"/><w:szCs w:val="20"/>'),
 style('IntroLabel', 'Intro Label', '<w:spacing w:before="600" w:after="120"/><w:pBdr><w:top w:val="single" w:sz="18" w:space="12" w:color="' + BLUE + '"/></w:pBdr>', f'<w:b/><w:color w:val="{TITLE}"/>'),
 style('Tip', 'Tip', f'<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="{BLUE}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EBEAEA"/><w:ind w:left="200" w:right="200"/><w:spacing w:before="120" w:after="240"/>', '', based='BodyText'),
]
s = s.replace('</w:styles>', ''.join(custom) + '</w:styles>')
open(f'{SRC}/word/styles.xml', 'w').write(s)

# Header: a blue band across the top of every page except the first. Footer: centred page number.
band = f'<w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="48" w:space="1" w:color="{KEY}"/></w:pBdr><w:spacing w:after="0"/></w:pPr></w:p>'
open(f'{SRC}/word/header1.xml', 'w').write(f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr {W}>{band}</w:hdr>')
open(f'{SRC}/word/header2.xml', 'w').write(f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr {W}><w:p/></w:hdr>')
num = ('<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="606060"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r>'
       '<w:r><w:rPr><w:color w:val="606060"/><w:sz w:val="18"/></w:rPr><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:rPr><w:color w:val="606060"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r>'
       '<w:r><w:rPr><w:color w:val="606060"/><w:sz w:val="18"/></w:rPr><w:t>1</w:t></w:r><w:r><w:rPr><w:color w:val="606060"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p>')
open(f'{SRC}/word/footer1.xml', 'w').write(f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {W}>{num}</w:ftr>')
open(f'{SRC}/word/footer2.xml', 'w').write(f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {W}><w:p/></w:ftr>')
rels = open(f'{SRC}/word/_rels/document.xml.rels').read()
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
rels = rels.replace('</Relationships>', f'<Relationship Id="rIdHdr1" Type="{R}header" Target="header1.xml"/><Relationship Id="rIdHdr2" Type="{R}header" Target="header2.xml"/><Relationship Id="rIdFtr1" Type="{R}footer" Target="footer1.xml"/><Relationship Id="rIdFtr2" Type="{R}footer" Target="footer2.xml"/></Relationships>')
open(f'{SRC}/word/_rels/document.xml.rels', 'w').write(rels)
ct = open(f'{SRC}/[Content_Types].xml').read()
H = 'application/vnd.openxmlformats-officedocument.wordprocessingml.'
ct = ct.replace('</Types>', ''.join(f'<Override PartName="/word/{p}.xml" ContentType="{H}{"header" if p.startswith("h") else "footer"}+xml"/>' for p in ['header1', 'header2', 'footer1', 'footer2']) + '</Types>')
open(f'{SRC}/[Content_Types].xml', 'w').write(ct)
d = open(f'{SRC}/word/document.xml').read()
sect = ('<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr1"/><w:headerReference w:type="first" r:id="rIdHdr2"/>'
        '<w:footerReference w:type="default" r:id="rIdFtr1"/><w:footerReference w:type="first" r:id="rIdFtr2"/>'
        '<w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="340" w:footer="454" w:gutter="0"/><w:titlePg/></w:sectPr>')
d = re.sub(r'<w:sectPr>.*?</w:sectPr>', sect, d, flags=re.S)
if 'xmlns:r=' not in d[:2000]:
    d = d.replace('<w:document ', '<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ', 1)
open(f'{SRC}/word/document.xml', 'w').write(d)
if os.path.exists(OUT): os.remove(OUT)
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(SRC):
        for f in files:
            p = os.path.join(root, f); z.write(p, os.path.relpath(p, SRC))
print('wrote', OUT)
shutil.rmtree(SRC)
