"""PowerPoint of the pattern guide: one 16:9 slide per PNG (tools/pattern-guide/build.js), full-bleed, with the page's
rules as speaker notes. python3 make_pptx.py <png dir> <notes.json> <out.pptx>"""
import json
import os
import sys

from pptx import Presentation
from pptx.util import Emu


def main(png_dir, notes_path, out):
    with open(notes_path, encoding='utf-8') as f:
        notes = json.load(f)
    pngs = sorted(p for p in os.listdir(png_dir) if p.endswith('.png'))
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)   # 13.333 x 7.5 in (16:9)
    blank = prs.slide_layouts[6]
    for i, name in enumerate(pngs):
        s = prs.slides.add_slide(blank)
        s.shapes.add_picture(os.path.join(png_dir, name), 0, 0, width=prs.slide_width, height=prs.slide_height)
        if i < len(notes) and notes[i]:
            s.notes_slide.notes_text_frame.text = notes[i]
    prs.save(out)


if __name__ == '__main__':
    main(*sys.argv[1:4])
