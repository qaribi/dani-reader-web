"""Generate copyright-original EPUB 3 fixtures; no network or external books."""
from pathlib import Path
from hashlib import shake_256
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZipInfo, ZIP_STORED, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1] / 'public' / 'fixtures'
SAMPLES = {
    'fa': ('نمونهٔ فارسی', 'این کتاب آزمایشی برای سنجش خواندن فارسی نوشته شده است. می\u200cخوانیم و یادداشت می\u200cکنیم.'),
    'ar': ('نموذج عربي', 'هذا نص تجريبي أصلي لاختبار القراءة العربية. نقرأُ الكتابَ ونكتبُ ملاحظةً.'),
    'prs': ('نمونهٔ دری', 'این متن آزمایشی دری برای بررسی خواندن کتاب است. ما کتاب را می\u200cخوانیم و یک یادداشت می\u200cنویسیم.'),
    'ps': ('د پښتو بېلګه', 'دا اصلي ازمایښتي متن د پښتو کتاب د لوستلو لپاره لیکل شوی دی. موږ کتاب لولو او یادښت لیکو.'),
    'ur': ('اردو نمونہ', 'یہ اصل آزمائشی متن اردو کتاب کی پڑھائی کے لیے لکھا گیا ہے۔ ہم کتاب پڑھتے ہیں اور یادداشت لکھتے ہیں۔ قُرآن، اُردو، جُڑاؤ۔'),
}

class FixtureZip(ZipFile):
    """Fixed timestamps and permissions make the original test inputs repeatable."""
    def writestr(self, path, data, compress_type=None, compresslevel=None):
        info = ZipInfo(path, (2026, 10, 5, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        super().writestr(info, data, compress_type=compress_type, compresslevel=compresslevel)


def generate(language, title, sentence, attack=False, fixed=False, resources=0, long_paths=False, short=False):
    book_id = 'original-' + language + ('-short' if short else '-manifest-limit' if long_paths else '-resources' if resources else '-fixed' if fixed else '-security' if attack else '')
    chapter_count = 1 if short else 3
    resource_paths = [shake_256(str(i).encode()).hexdigest(390) + '.bin' if long_paths else f'resource-{i}.bin' for i in range(resources)]
    items = ''.join(f'<item id="c{i}" href="chapter{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(1, chapter_count + 1))
    items += ''.join(f'<item id="r{i}" href="{path}" media-type="application/octet-stream"/>' for i, path in enumerate(resource_paths))
    if attack:
        items += '<item id="probe-svg" href="probe.svg" media-type="image/svg+xml"/><item id="probe-css" href="probe.css" media-type="text/css"/>'
    spine = ''.join(f'<itemref idref="c{i}"/>' for i in range(1, chapter_count + 1))
    opf = f'''<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">{book_id}</dc:identifier><dc:title>{escape(title)}</dc:title><dc:language>{language}</dc:language><meta property="dcterms:modified">2026-10-05T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>{items}</manifest><spine page-progression-direction="rtl">{spine}</spine></package>'''
    toc = ''.join(f'<li><a href="chapter{i}.xhtml">{escape(title)} {i}</a></li>' for i in range(1, chapter_count + 1))
    if fixed:
        opf = opf.replace('</metadata>', '<meta property="rendition:layout">pre-paginated</meta><meta property="rendition:spread">none</meta></metadata>')
    nav = f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{language}" dir="rtl"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>{toc}</ol></nav></body></html>'
    with FixtureZip(ROOT / (book_id + '.epub'), 'w') as archive:
        archive.writestr('mimetype', 'application/epub+zip', compress_type=ZIP_STORED)
        archive.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', compress_type=ZIP_DEFLATED)
        archive.writestr('EPUB/package.opf', opf, compress_type=ZIP_DEFLATED)
        archive.writestr('EPUB/nav.xhtml', nav, compress_type=ZIP_DEFLATED)
        for path in resource_paths:
            archive.writestr('EPUB/' + path, bytes(range(100)), compress_type=ZIP_DEFLATED)
        if attack:
            archive.writestr('EPUB/probe.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><image id="probe" href="http://127.0.0.1:5188/svg-blob"/><set href="#probe" attributeName="href" to="http://127.0.0.1:5188/svg-animation" begin="0s"/><style>@import url("http://127.0.0.1:5188/svg-style");</style><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="http://127.0.0.1:5188/svg-frame"/></foreignObject></svg>', compress_type=ZIP_DEFLATED)
            archive.writestr('EPUB/probe.css', '@import url("http://127.0.0.1:5188/stylesheet-import"); @font-face{font-family:Probe;src:url("http://127.0.0.1:5188/font")}p{background-image:url("http://127.0.0.1:5188/stylesheet-image")}', compress_type=ZIP_DEFLATED)
        for i in range(1, chapter_count + 1):
            paragraphs = ''.join(f'<p>{escape(sentence)} <bdi dir="ltr">EPUB 3 · build {i} · 2026/10/05 · 123.45</bdi></p>' for _ in range(1 if short else 3 if fixed else 30))
            malicious = ''
            if attack and i == 1:
                malicious = '''<script>parent.document.body.dataset.bookScript='executed';fetch('http://127.0.0.1:5188/script')</script><img src="http://127.0.0.1:5188/image" onerror="parent.document.body.dataset.bookEvent='executed'"/><style>@import url('http://127.0.0.1:5188/import'); body{background-image:url('http://127.0.0.1:5188/css')}</style><svg xmlns="http://www.w3.org/2000/svg"><image href="http://127.0.0.1:5188/svg"/><set attributeName="href" to="http://127.0.0.1:5188/animated"/><foreignObject><iframe xmlns="http://www.w3.org/1999/xhtml" src="http://127.0.0.1:5188/frame"/></foreignObject></svg>'''
            extra_head = '<link rel="stylesheet" href="probe.css"/>' if attack else ''
            if fixed:
                extra_head += '<meta name="viewport" content="width=600,height=800"/><style>html,body{width:600px;height:800px;margin:0;padding:24px;box-sizing:border-box}body{background:#f2f7fb}p{line-height:1.8}</style>'
            extra_body = '<img src="probe.svg" alt="Synthetic security probe"/>' if attack else ''
            text = f'<html xmlns="http://www.w3.org/1999/xhtml" lang="{language}" xml:lang="{language}" dir="rtl"><head><title>{escape(title)} {i}</title>{extra_head}</head><body><h1 id="start">{escape(title)} {i}</h1><p><span dir="ltr">English LTR section: abc 123</span> · <bdi>user@example.invalid</bdi></p>{malicious}{extra_body}{paragraphs}<a href="chapter{1 if i==chapter_count else i+1}.xhtml#start">Next chapter</a></body></html>'
            archive.writestr(f'EPUB/chapter{i}.xhtml', text, compress_type=ZIP_DEFLATED)


if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    for lang, (title, sample) in SAMPLES.items():
        generate(lang, title, sample)
    generate('fa', 'آزمون جداسازی محتوا', SAMPLES['fa'][1], attack=True)
    generate('fa', 'صفحه‌بندی ثابت آزمایشی', SAMPLES['fa'][1], attack=True, fixed=True)
    generate('fa', 'نمونهٔ منابع متعدد', SAMPLES['fa'][1], resources=250)
    generate('fa', 'آزمون سقف فهرست منابع', SAMPLES['fa'][1], resources=201, long_paths=True)
    generate('fa', 'کتاب کوتاه تک‌فصل', 'متن کوتاه تألیفی برای آزمون ذخیرهٔ محل مطالعه.', short=True)
