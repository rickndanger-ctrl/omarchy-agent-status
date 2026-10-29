# Tiles: the tile format

Tiles is a mode of the Home app on the Even G2 glasses, laid out like Omarchy: **5 pages, each split
into two tiles side by side**. Any Home app can go in any tile, and so can your own app, through a
`url:` tile.

## Size

A tile is **27 characters wide and 9 lines tall, title included**. Home wraps and clips to that,
but plan for it: more than 9 lines makes the glasses scroll by themselves and swallow swipes.
Use plain text; emoji and symbols the glasses font can't draw are removed.

## Layout

The layout lives on the hub, so the phone and the glasses agree and it survives reinstalls.

    GET /api/layout
    PUT /api/layout   {"pages":[{"left":"muse","right":"agent:Dell/claude"}, ...]}

Always 5 pages. An id Home doesn't know shows as an empty tile. Edit it from the phone (Home,
"Tiles" section) or on the glasses (long press, "Edit page").

| Tile id | Shows |
|---|---|
| `agent:<machine>/<pane or agent>` | the end of an agent's terminal; reply by voice or a quick reply |
| `muse` | the latest Muse answer; ask by voice |
| `chat:<id>`, `chat:recent` | one Messages thread (`recent` = the newest); reply by voice or a quick text |
| `messages` | the list of threads |
| `approvals` | approvals waiting and agents that need you |
| `studio` | what the studio's workers are doing |
| `clock` | time, weather, glasses battery |
| `reminders` | open Apple Reminders; tick one off, add one by voice |
| `url:<endpoint>` | your app (below) |
| `empty` | nothing |

## Your own tile: `url:<endpoint>`

Put `url:https://example.com/tile` in the layout. The hub fetches it (only endpoints that are in
the layout) and expects:

```json
{
  "title": "Build",
  "lines": ["main: passing", "deploy: 3 min ago", "2 open PRs"],
  "actions": [{ "label": "Redeploy", "id": "redeploy" }]
}
```

The first lines show first; swiping on the tile scrolls the rest. When someone picks an action,
the hub POSTs `{"id":"redeploy"}` to the same endpoint, then fetches the tile again.

A whole tile server in Node:

```js
import http from 'node:http';
let count = 0;
http.createServer((req, res) => {
  if (req.method === 'POST') count++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    title: 'Counter', lines: [`Pressed ${count} times`],
    actions: [{ label: 'Press', id: 'press' }],
  }));
}).listen(8099);
```

## Gestures

Three levels: page, choose, tile. Each double tap goes one level up.

| On a page | |
|---|---|
| swipe up / down | previous / next page (wraps around) |
| tap | choose a tile: the left one is lit, or the side you lit last on this page while Home is open |
| double tap | leave Tiles, back to Home |

| Choosing a tile | |
|---|---|
| swipe (either way) | switch between the left and the right tile |
| tap | go into the lit tile |
| double tap | back to the page |

The lit tile starts its title with `> ` and has a thin border; the left title always carries the page (`1/5`).

| In a tile | |
|---|---|
| swipe | scroll the tile |
| tap | the action list: the tile's actions, plus Full screen |
| double tap | back to choosing, same side lit (closes the action list first) |
