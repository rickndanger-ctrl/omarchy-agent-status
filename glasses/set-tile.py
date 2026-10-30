#!/usr/bin/env python3
"""Change one slot of a Tiles layout. Usage: set-tile.py <page 1-based> <left|right> <widget>
Reads the layout JSON from stdin; prints the new {"pages": [...]} on stdout and before/after on stderr."""
import json
import sys

if len(sys.argv) != 4:
    sys.exit('usage: set-tile.py <page> <left|right> <widget>')
page, side, widget = sys.argv[1], sys.argv[2], sys.argv[3]
layout = json.load(sys.stdin)
i = int(page) - 1
if side not in ('left', 'right'):
    sys.exit('side must be left or right')
if not 0 <= i < len(layout['pages']):
    sys.exit('page %s does not exist (the layout has %d pages)' % (page, len(layout['pages'])))
print('before: page %s %s = %s' % (page, side, layout['pages'][i][side]), file=sys.stderr)
layout['pages'][i][side] = widget
print('after:  page %s %s = %s' % (page, side, widget), file=sys.stderr)
print(json.dumps({'pages': layout['pages']}))
