"""Bundle web/ into ONE self-contained HTML file (for previews / sending).

    python tools/bundle_preview.py out.html
"""
import os
import sys

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')


def read(name):
    with open(os.path.join(WEB, name), encoding='utf-8') as f:
        return f.read()


def main(out):
    html = read('index.html')
    html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + read('style.css') + '\n</style>')
    for src in ('config.js', 'data/dashboard.js', 'app.js'):
        tag = '<script src="%s"></script>' % src
        assert tag in html, tag
        body = read(src).replace('</script', '<\\/script')
        html = html.replace(tag, '<script>\n' + body + '\n</script>')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print('wrote', out, '%d KB' % (len(html.encode()) // 1024))


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1])
